"use strict";

const byId = id => document.getElementById(id);
const statusLine = byId("status");
const host = byId("host");
const from = byId("from");
const to = byId("to");
const traffic = ["All traffic", "Idle", "Upload", "Download", "Other iperf"];
const colors = ["#246ab3", "#c45c14", "#137e69", "#7653ab"];
const logs = {ping: [], iperf: []};
const warnings = {};
const charts = {};
let activePreset = 24;
const numberFormat = new Intl.NumberFormat(undefined, {maximumFractionDigits: 3});

function readCSV(file, required, decode) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let skipped = 0;
    let parsed = 0;
    Papa.parse(file, {
      header: true,
      delimiter: ",",
      skipEmptyLines: "greedy",
      chunkSize: 512 * 1024,
      chunk(result, parser) {
        if (!required.every(field => result.meta.fields?.includes(field))) {
          parser.abort();
          reject(new Error("Unexpected CSV columns"));
          return;
        }
        const invalidRows = new Set(result.errors
          .filter(error => error.type === "FieldMismatch")
          .map(error => error.row - parsed));
        result.data.forEach((record, index) => {
          const row = invalidRows.has(index) ? null : decode(record);
          if (row) rows.push(row);
          else skipped++;
        });
        parsed += result.data.length;
      },
      complete(result) {
        if (!result?.meta.aborted) {
          rows.sort((a, b) => a.time - b.time);
          resolve({rows, skipped});
        }
      },
      error: reject,
    });
  });
}

function measurement(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function pingRow(row) {
  const time = Date.parse(row.timestamp_utc);
  if (!Number.isFinite(time) || !["ok", "lost", "error"].includes(row.status)) return null;
  const value = row.status === "ok" ? measurement(row.rtt_ms) : null;
  if (row.status === "ok" && value === null) return null;
  const group = row.during_iperf === "1" ? {upload: 2, download: 3}[row.direction] : 1;
  return {time, value, status: row.status, host: row.host || "(unlabelled host)",
    group: Number.isInteger(group) ? group : 4};
}

function iperfRow(row) {
  const time = Date.parse(row.start_utc);
  if (!Number.isFinite(time) || !["upload", "download"].includes(row.direction)) return null;
  const value = row.status === "ok" ? measurement(row.receiver_mbps) : null;
  if (row.status === "ok" && value === null) return null;
  return {time, value, group: row.direction === "upload" ? 2 : 3};
}

function percentile(sorted, fraction) {
  const rank = (sorted.length - 1) * fraction;
  const index = Math.floor(rank);
  return sorted[index] + (sorted[Math.ceil(rank)] - sorted[index]) * (rank - index);
}

function summarize(rows) {
  const values = [];
  let sum = 0;
  let lost = 0;
  let errors = 0;
  for (const row of rows) {
    if (row.status === "ok") {
      values.push(row.value);
      sum += row.value;
    } else if (row.status === "lost") {
      lost++;
    } else {
      errors++;
    }
  }
  values.sort((a, b) => a - b);
  const count = values.length;
  const attempts = count + lost;
  const rtt = count ? [values[0], sum / count, percentile(values, .9),
    percentile(values, .95), percentile(values, .99), values[count - 1]] : Array(6).fill(null);
  return [count, lost, attempts ? numberFormat.format(100 * lost / attempts) + "%" : "—", errors, ...rtt];
}

function plotPoints(rows, start, end) {
  if (rows.length <= 4000) return rows.map(row => [row.time, row.value]);
  const width = Math.max(1, (end - start + 1) / 2000);
  const buckets = new Map();
  for (const row of rows) {
    const bucket = Math.floor((row.time - start) / width);
    const extremes = buckets.get(bucket);
    if (!extremes) {
      buckets.set(bucket, [row, row]);
      continue;
    }
    if (row.value < extremes[0].value) extremes[0] = row;
    if (row.value > extremes[1].value) extremes[1] = row;
  }
  return [...buckets.values()].flatMap(([min, max]) => {
    if (min === max) return [[min.time, min.value]];
    return [min, max].sort((a, b) => a.time - b.time).map(row => [row.time, row.value]);
  });
}

function draw(id, series, unit, start, end) {
  const chart = charts[id] ??= echarts.init(byId(id), null, {renderer: "canvas"});
  chart.resize();
  chart.setOption({
    animation: false,
    grid: {top: 48, left: 18, right: 22, bottom: 62, containLabel: true},
    legend: {top: 0},
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      formatter: ({seriesName, value: [time, value]}) =>
        new Date(time).toLocaleString() + "\n" + seriesName + " · " + numberFormat.format(value) + " " + unit,
    },
    xAxis: {type: "time", min: start, max: Math.max(start + 1000, end)},
    yAxis: {type: "value", name: unit},
    dataZoom: [{type: "slider", bottom: 10}, {type: "inside", zoomOnMouseWheel: "ctrl"}],
    series: series.map(({group, data}) => ({
      name: traffic[group], type: "scatter", symbolSize: 5,
      itemStyle: {color: colors[group - 1]}, data,
    })),
  }, {notMerge: true});
}

function render(start, end) {
  const inRange = row => row.time >= start && row.time <= end;
  const selected = logs.ping.filter(row => row.host === host.value && inRange(row));
  const tests = logs.iperf.filter(inRange);
  const visibleGroups = traffic.map((_, index) => index).filter(group => group < 4 ||
    selected.some(row => row.group === group));
  const table = byId("stats");
  table.replaceChildren();
  const pingSeries = [];
  for (const group of visibleGroups) {
    const rows = group ? selected.filter(row => row.group === group) : selected;
    const tr = table.insertRow();
    const label = document.createElement("th");
    label.scope = "row";
    label.textContent = traffic[group];
    tr.append(label);
    for (const value of summarize(rows)) {
      tr.insertCell().textContent = typeof value === "number" ? numberFormat.format(value) : value ?? "—";
    }
    if (group) {
      pingSeries.push({group, data: plotPoints(rows.filter(row => row.value !== null), start, end)});
    }
  }

  byId("results").hidden = false;
  byId("ping-results").hidden = !logs.ping.length;
  byId("iperf-results").hidden = !logs.iperf.length;
  if (logs.ping.length) draw("latency", pingSeries, "ms", start, end);
  if (logs.iperf.length) {
    const failed = tests.filter(row => row.value === null).length;
    byId("throughput-info").textContent =
      `Receiver Mbps · ${tests.length - failed} successful · ${failed} failed · all iperf tests in range`;
    const series = [2, 3].map(group => ({
      group,
      data: plotPoints(tests.filter(row => row.group === group && row.value !== null), start, end),
    }));
    draw("throughput", series, "Mbps", start, end);
  }

  statusLine.textContent = [`${numberFormat.format(selected.length)} ping attempts · ${tests.length} iperf tests in range.`,
    ...Object.values(warnings).filter(Boolean)].join(" ");
}

function localInput(time) {
  const offset = new Date(time).getTimezoneOffset() * 60_000;
  return new Date(time - offset).toISOString().slice(0, 19);
}

function applyPreset(hours) {
  activePreset = hours;
  const populated = Object.values(logs).filter(rows => rows.length);
  const first = Math.min(...populated.map(rows => rows[0].time));
  const last = Math.max(...populated.map(rows => rows[rows.length - 1].time));
  const start = Math.floor((hours ? Math.max(first, last - hours * 3_600_000) : first) / 1000) * 1000;
  const end = Math.ceil(last / 1000) * 1000;
  from.value = localInput(start);
  to.value = localInput(end);
  render(start, end);
}

function applyRange() {
  const start = new Date(from.value).getTime();
  const end = new Date(to.value).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    statusLine.textContent = "Enter a valid start and end time.";
    return;
  }
  render(start, end);
}

async function loadLog(input, fields, decode) {
  const kind = input.id;
  const file = input.files[0];
  if (!file) return;
  const inputs = [byId("ping"), byId("iperf")];
  inputs.forEach(control => { control.disabled = true; });
  byId("range").disabled = true;
  statusLine.textContent = `Reading ${file.name}…`;
  try {
    const {rows, skipped} = await readCSV(file, fields, decode);
    logs[kind] = rows;
    warnings[kind] = skipped ? `${file.name}: skipped ${skipped} invalid rows.` :
      rows.length ? "" : `${file.name}: no data rows.`;
  } catch (error) {
    logs[kind] = [];
    warnings[kind] = `${file.name}: ${error.message || "unable to read CSV"}.`;
  } finally {
    input.value = "";
    inputs.forEach(control => { control.disabled = false; });
  }

  const previousHost = host.value;
  const hosts = [...new Set(logs.ping.map(row => row.host))].sort();
  host.replaceChildren(...hosts.map(name => new Option(name, name)));
  if (hosts.includes(previousHost)) host.value = previousHost;
  host.disabled = !hosts.length;
  const hasData = Boolean(hosts.length || logs.iperf.length);
  byId("range").disabled = !hasData;
  byId("results").hidden = !hasData;
  if (hasData) {
    if (activePreset === null && from.value && to.value) applyRange();
    else applyPreset(activePreset ?? 24);
  } else {
    from.value = "";
    to.value = "";
    statusLine.textContent = Object.values(warnings).filter(Boolean).join(" ") || "No data rows.";
  }
}

if (typeof Papa === "undefined" || typeof echarts === "undefined") {
  statusLine.textContent = "Could not load the dashboard libraries. Check access to cdn.jsdelivr.net and reload.";
  byId("ping").disabled = true;
  byId("iperf").disabled = true;
} else {
  byId("ping").addEventListener("change", event =>
    loadLog(event.target, ["timestamp_utc", "status", "rtt_ms", "during_iperf"], pingRow));
  byId("iperf").addEventListener("change", event =>
    loadLog(event.target, ["start_utc", "direction", "status", "receiver_mbps"], iperfRow));
  byId("filters").addEventListener("submit", event => {
    event.preventDefault();
    activePreset = null;
    applyRange();
  });
  host.addEventListener("change", () => {
    if (activePreset === null) applyRange();
    else applyPreset(activePreset);
  });
  document.querySelectorAll("[data-hours]").forEach(button =>
    button.addEventListener("click", () => applyPreset(Number(button.dataset.hours))));
  new ResizeObserver(() => Object.values(charts).forEach(chart => chart.resize())).observe(byId("results"));
}
