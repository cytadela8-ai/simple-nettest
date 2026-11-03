#!/usr/bin/env python3
"""Serve the dashboard and its two CSV logs over HTTP on a trusted network."""

import argparse
import os
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/dashboard.js": ("dashboard.js", "text/javascript; charset=utf-8"),
    "/echarts.min.js": ("echarts.min.js", "text/javascript; charset=utf-8"),
    "/papaparse.min.js": ("papaparse.min.js", "text/javascript; charset=utf-8"),
}
LOGS = {"/logs/ping.csv": "ping.csv", "/logs/iperf.csv": "iperf.csv"}


class DashboardHandler(BaseHTTPRequestHandler):
    def __init__(self, *args, assets, logs, **kwargs):
        self.assets = assets
        self.logs = logs
        super().__init__(*args, **kwargs)

    def do_HEAD(self):
        self.serve(send_body=False)

    def do_GET(self):
        self.serve(send_body=True)

    def serve(self, send_body):
        route = self.path.partition("?")[0]
        if route in ASSETS:
            name, mime = ASSETS[route]
            path = self.assets / name
        elif route in LOGS:
            path = self.logs / LOGS[route]
            mime = "text/csv; charset=utf-8"
        else:
            self.send_error(404)
            return

        try:
            source = path.open("rb")
        except FileNotFoundError:
            self.send_error(404)
            return
        except OSError as error:
            self.log_error("Cannot open %s: %s", path, error)
            self.send_error(500)
            return

        with source:
            # Bound each response to the size at open, even while the collector appends.
            remaining = os.fstat(source.fileno()).st_size
            try:
                self.send_response(200)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(remaining))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                while send_body and remaining:
                    chunk = source.read(min(remaining, 64 * 1024))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="127.0.0.1", help="IPv4 listen address")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--logs", type=Path, default=Path("/var/log/nettest"))
    args = parser.parse_args()
    handler = partial(DashboardHandler, assets=Path(__file__).resolve().parent / "dashboard",
                      logs=args.logs)
    with ThreadingHTTPServer((args.bind, args.port), handler) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
