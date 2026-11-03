#!/usr/bin/env python3
"""Log continuous ICMP latency and periodic iperf3 TCP tests to CSV.

Requires only Python 3, iputils-ping, and iperf3 (Debian/Ubuntu).
"""

import argparse
import csv
import json
import re
import signal
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

PING_FIELDS = (
    "timestamp_utc", "host", "status", "rtt_ms", "during_iperf",
    "test_id", "direction", "error"
)
IPERF_FIELDS = (
    "test_id", "start_utc", "end_utc", "direction", "status",
    "sender_mbps", "receiver_mbps", "retransmits", "test_duration_s",
    "wall_duration_s", "error"
)
RTT_RE = re.compile(r"\btime[=<]\s*([0-9.]+)\s*ms\b")


def now_utc():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def clean_error(value):
    return " ".join(str(value).split())[:300]


def csv_file(path, fields):
    f = path.open("a", encoding="utf-8", newline="", buffering=1)
    writer = csv.DictWriter(f, fieldnames=fields)
    if f.tell() == 0:
        writer.writeheader()
        f.flush()
    return f, writer


def mbps(section):
    value = section.get("bits_per_second")
    return round(float(value) / 1_000_000, 3) if value is not None else ""


def ping_worker(args, stop, lock, active):
    f, writer = csv_file(args.output / "ping.csv", PING_FIELDS)
    try:
        due = time.monotonic()
        while not stop.is_set():
            timestamp = now_utc()
            # Classify by when the ICMP request is sent, not when its reply arrives.
            with lock:
                test_id = active["id"]
                direction = active["direction"]
            row = dict(timestamp_utc=timestamp, host=args.ping_host,
                       status="lost", rtt_ms="", during_iperf=int(bool(test_id)),
                       test_id=test_id, direction=direction, error="")
            try:
                result = subprocess.run(
                    ["ping", "-n", "-c", "1", "-W", "1", args.ping_host],
                    capture_output=True, text=True, timeout=3,
                )
                match = RTT_RE.search(result.stdout)
                if result.returncode == 0 and match:
                    row["status"] = "ok"
                    row["rtt_ms"] = match.group(1)
                elif result.returncode != 1:
                    row["status"] = "error"
                    row["error"] = clean_error(result.stderr or result.stdout)
            except (OSError, subprocess.TimeoutExpired) as exc:
                row["status"] = "error"
                row["error"] = clean_error(exc)
            writer.writerow(row)
            f.flush()
            due += args.ping_interval
            if due < time.monotonic():
                due = time.monotonic()  # Never build up a backlog.
            stop.wait(max(0, due - time.monotonic()))
    finally:
        f.close()


def iperf_worker(args, stop, lock, active):
    f, writer = csv_file(args.output / "iperf.csv", IPERF_FIELDS)
    directions = ["upload", "download"] if args.direction == "both" else [args.direction]
    try:
        due = time.monotonic()
        while not stop.is_set():
            if stop.wait(max(0, due - time.monotonic())):
                break
            for direction in directions:
                if stop.is_set():
                    break
                start = now_utc()
                test_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + "-" + direction
                cmd = ["iperf3", "-c", args.host, "-p", str(args.port),
                       "-t", str(args.duration), "--json"]
                if direction == "download":
                    cmd.append("-R")
                row = dict(test_id=test_id, start_utc=start, end_utc="",
                           direction=direction, status="error", sender_mbps="",
                           receiver_mbps="", retransmits="", test_duration_s="",
                           wall_duration_s="", error="")
                with lock:
                    active["id"] = test_id
                    active["direction"] = direction
                start_mono = time.monotonic()
                try:
                    result = subprocess.run(
                        cmd, capture_output=True, text=True,
                        timeout=args.duration + 30,
                    )
                    data = json.loads(result.stdout) if result.stdout.strip() else {}
                    end = data.get("end", {})
                    sent = end.get("sum_sent") or {}
                    received = end.get("sum_received") or {}
                    if result.returncode == 0 and received.get("bits_per_second") is not None:
                        row["status"] = "ok"
                        row["sender_mbps"] = mbps(sent)
                        row["receiver_mbps"] = mbps(received)
                        row["retransmits"] = sent.get("retransmits", "")
                        row["test_duration_s"] = round(received.get("seconds", 0), 2)
                    else:
                        row["error"] = clean_error(data.get("error") or result.stderr or result.stdout)
                except (OSError, subprocess.TimeoutExpired, ValueError) as exc:
                    row["error"] = clean_error(exc)
                finally:
                    row["end_utc"] = now_utc()
                    row["wall_duration_s"] = round(time.monotonic() - start_mono, 3)
                    with lock:
                        active["id"] = ""
                        active["direction"] = ""
                writer.writerow(row)
                f.flush()
            due += args.period
            if due < time.monotonic():
                due = time.monotonic()
    finally:
        f.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host", help="iperf3 server hostname or IP")
    parser.add_argument("--ping-host", help="ICMP target (default: iperf3 host)")
    parser.add_argument("--output", type=Path, default=Path("./nettest-logs"))
    parser.add_argument("--port", type=int, default=5201)
    parser.add_argument("--period", type=float, default=600, help="seconds between test cycles")
    parser.add_argument("--duration", type=int, default=20, help="seconds per iperf3 direction")
    parser.add_argument("--direction", choices=["upload", "download", "both"], default="both")
    parser.add_argument("--ping-interval", type=float, default=1, help="seconds between pings")
    args = parser.parse_args()
    if args.period <= 0 or args.duration <= 0 or args.ping_interval <= 0:
        parser.error("period, duration and ping-interval must be positive")
    args.ping_host = args.ping_host or args.host
    args.output.mkdir(parents=True, exist_ok=True)

    stop = threading.Event()
    lock = threading.Lock()
    active = {"id": "", "direction": ""}
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    threads = [
        threading.Thread(target=ping_worker, args=(args, stop, lock, active)),
        threading.Thread(target=iperf_worker, args=(args, stop, lock, active)),
    ]
    for thread in threads:
        thread.start()
    print(f"Logging to {args.output.resolve()} (Ctrl+C to stop)", flush=True)
    for thread in threads:
        thread.join()


if __name__ == "__main__":
    main()