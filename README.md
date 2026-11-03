# simple-nettest

Continuous ICMP pings (one per second **per host**) and periodic `iperf3` TCP upload/download tests. Logs to `ping.csv` and `iperf.csv`; each ping includes its `host`, `during_iperf` flag, and matching `test_id`/direction.

## Install (Debian LXC / VM)

```sh
apt update && apt install -y git python3 iputils-ping iperf3
git clone https://github.com/cytadela8-ai/simple-nettest.git
cd simple-nettest
```

The dashboard needs only a browser. See [View results](#view-results) below.

On the **iperf3 server**, run `iperf3 -s` (allow TCP port 5201).

## Run

```sh
python3 nettest.py 192.168.1.100 \
  --ping-host 192.168.1.1 --ping-host 1.1.1.1 --ping-host 8.8.8.8 \
  --output ./logs
```

`192.168.1.100` is the iperf3 server. Repeat `--ping-host` for each ping target; without it, the iperf3 server is pinged. Press Ctrl+C to stop.

## Options

| Option | Default | Meaning |
|---|---|---|
| `--ping-host HOST` | iperf3 server | Ping target; repeat to add hosts |
| `--ping-interval SEC` | `1` | Seconds between pings **per host** |
| `--period SEC` | `600` | Seconds between iperf test cycles |
| `--duration SEC` | `20` | Seconds per iperf direction |
| `--direction` | `both` | `upload`, `download` or `both` |
| `--port PORT` | `5201` | iperf3 server port |
| `--output DIR` | `./nettest-logs` | Directory for CSV logs |

## Start on boot (optional)

```sh
install -Dm755 nettest.py /opt/nettest/nettest.py
install -Dm644 systemd/nettest.service /etc/systemd/system/nettest.service
nano /etc/systemd/system/nettest.service  # edit ExecStart: server IP and --ping-host flags
systemctl daemon-reload && systemctl enable --now nettest
```

CSV timestamps are UTC; `ping.csv` has one row per ping attempt, and `iperf.csv` has one row per speed test.

## View results

Open `dashboard/index.html` in your browser and select `ping.csv` and optionally
`iperf.csv` from your `--output` directory. If the collector is remote, copy
the CSVs to your workstation first. Select the files again to load fresh data.

The page loads pinned ECharts and Papa Parse scripts from jsDelivr. CSVs are
processed in your browser. No Flask, package install, or build step is required.
To serve the dashboard locally instead of opening the file directly, run:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory dashboard
```

Open <http://localhost:8000>. Pick a host and time range in your browser's local
time zone. The latency table uses all matching successful pings and splits
results by idle, upload, and download. Percentiles use linear interpolation.
The plot retains the minimum and maximum in each time bucket on dense views.
The chart slider zooms the plot. Use the date controls to recalculate the table.

## Upgrade

In your existing checkout, run `git pull --ff-only` and open
`dashboard/index.html`. Use your existing CSVs directly. The running collector
and any systemd installation can keep running during this upgrade.
