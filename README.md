# Proxmox Network Test

Lightweight, long-running network diagnostics for a Debian LXC or VM. Runs ICMP ping continuously while measuring TCP upload/download throughput with `iperf3` at a fixed interval. Writes append-only CSV logs.

No Python dependencies beyond the standard library.

## Requirements

On the **client** (Proxmox LXC / VM):

```bash
apt update
apt install -y python3 iputils-ping iperf3
```

On the **remote server** (where you want to measure throughput):

```bash
iperf3 -s
```

You must allow the default TCP port 5201 between client and server. The client also requires ICMP echo access to its chosen ping host.

## Run

```bash
python3 nettest.py 192.168.1.100 --output ./nettest-logs
```

Defaults:

- One ping attempt per second, including while throughput tests run.
- Every 600 seconds, a 20-second **upload** test followed by a 20-second **download** test.
- Results are appended to `ping.csv` and `iperf.csv`.
- Each ping row has `during_iperf=0` or `1`; if active, it also records the `test_id` and `direction` (`upload` / `download`).
- Timestamps are in UTC ISO-8601 format.

Customize the test:

```bash
python3 nettest.py 192.168.1.100 \
  --ping-host 1.1.1.1 \
  --port 5201 \
  --period 600 \
  --duration 20 \
  --direction both \
  --ping-interval 1 \
  --output ./nettest-logs
```

The script starts the first iperf test immediately and schedules the next cycle based on the previous cycle's start, provided tests fit within the interval. If a cycle overruns, the next cycle starts immediately, without overlapping tests.

## CSV output

`ping.csv`: `timestamp_utc`, `host`, `status`, `rtt_ms`, `during_iperf`, `test_id`, `direction`, `error`.

- `status`: `ok`, `lost`, or `error` (e.g., no ping executable or DNS failure).
- `rtt_ms` is empty if the probe did not succeed.
- The active test is recorded at the time a ping attempt begins.

`iperf.csv`: `test_id`, `start_utc`, `end_utc`, `direction`, `status`, `sender_mbps`, `receiver_mbps`, `retransmits`, `test_duration_s`, `wall_duration_s`, `error`.

- The `test_id` connects throughput records with concurrent ping records.
- `sender_mbps` and `receiver_mbps` are reported by iperf3; sender/receiver depend on test direction.
- Errors are recorded rather than stopping the monitoring loop.

## Run as a systemd service

```bash
install -Dm755 nettest.py /opt/nettest/nettest.py
install -Dm644 systemd/nettest.service /etc/systemd/system/nettest.service
# Set your iperf3 host in /etc/systemd/system/nettest.service
systemctl daemon-reload
systemctl enable --now nettest
journalctl -u nettest -f
```

CSV files are stored in `/var/log/nettest/` using the sample unit file. The service restarts after failures and on VM/LXC reboot.

## Inspect results

```bash
tail -n 10 /var/log/nettest/ping.csv
tail -n 10 /var/log/nettest/iperf.csv
```

## Notes

- This is a TCP throughput test; it can saturate your link for ~40 seconds per cycle, by design.
- In some unprivileged LXC configurations, ICMP requires allowing `ping` or setting the necessary capabilities on the container. Test `ping -c 1 YOUR_HOST` directly if all pings show `error`.
- The generated `*.csv` files can grow over a multi-day run; a 1 Hz ping is about 86,400 rows/day.
- During iperf startup/shutdown, `during_iperf` is an approximation of test process activity, not a precise indication of when network traffic started.