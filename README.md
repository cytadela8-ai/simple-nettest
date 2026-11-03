# simple-nettest

Continuous ICMP pings and periodic iperf3 tests. The dashboard compares latency
and packet loss during idle, upload, and download, and plots iperf3 throughput.

## Install on Debian / Ubuntu (systemd)

On the remote iperf3 endpoint, run `iperf3 -s` and allow TCP port 5201.

On the collector (for example, a Proxmox LXC or VM):

```sh
sudo apt-get install -y git
git clone https://github.com/cytadela8-ai/simple-nettest.git
cd simple-nettest
sudo ./install.sh -- 192.168.1.100 --ping-host 192.168.1.1 --ping-host 1.1.1.1
```

Open **http://COLLECTOR_IP:8000/** from your other machine. The dashboard loads
both CSVs automatically. Use **Refresh logs** to pick up new measurements. Pick a
host and time range to see min, mean (avg), p90, p95, p99, max and loss. The time
range uses your browser's local time zone. The chart slider zooms the plot.
Use the date controls to recalculate the summary.

The installer enables `nettest.service` and `nettest-dashboard.service` at boot.
It installs missing dependencies and downloads the pinned chart libraries from
jsDelivr at install or upgrade time. The browser loads the libraries and logs
from the collector. The dashboard server uses Python's standard library.

The dashboard serves unauthenticated HTTP. Use it on a trusted LAN or VPN.
Pass `--bind 192.168.1.50 --dashboard-port 8080` **before** `--` to change the
listener. Pass `--log-dir /path/to/logs` before `--` to change the CSV directory.
The default directory is `/var/log/nettest`.

## Upgrade

```sh
git pull --ff-only
sudo ./install.sh
```

An existing `nettest.service` keeps its command line and continues logging. If
its `--output` differs from `/var/log/nettest`, run the first dashboard install
with `sudo ./install.sh --log-dir /path/to/logs` instead. The dashboard service
needs read access to both CSVs and traversal access to their directory. On later
upgrades, omit dashboard options to keep its listener and log directory. When
changing settings, pass all non-default dashboard options together.

For a manually started collector, stop that process before installing a
collector service using the install command above. Pass its existing log
directory to the installer with `--log-dir` to keep using the same CSVs.

## Collector options

Pass these after the server address. Repeat `--ping-host` for each ping target.

| Option | Default | Meaning |
|---|---|---|
| `--ping-host HOST` | iperf3 server | Ping target |
| `--ping-interval SEC` | `1` | Interval per ping target |
| `--period SEC` | `600` | Interval between iperf3 cycles |
| `--duration SEC` | `20` | Test length per direction |
| `--direction` | `both` | `upload`, `download`, or `both` |
| `--port PORT` | `5201` | iperf3 server port |

Use `python3 nettest.py --help` for standalone collector usage. To inspect the
services, run `systemctl status nettest nettest-dashboard` or
`journalctl -u nettest -u nettest-dashboard -n 50`.
