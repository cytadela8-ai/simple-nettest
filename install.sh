#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'HELP'
Usage: sudo ./install.sh [--bind IPv4] [--dashboard-port PORT] [--log-dir DIR]
                         [-- IPERF_HOST [collector options...]]

For a new collector, pass its server and arguments after --.
For an existing nettest.service, omit collector arguments to preserve the unit.
The dashboard defaults to 0.0.0.0:8000 with logs in /var/log/nettest.
HELP
}

die() { printf '%s\n' "$*" >&2; exit 1; }

source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
target=/opt/nettest
unit_dir=/etc/systemd/system
bind=0.0.0.0
dashboard_port=8000
log_dir=/var/log/nettest
dashboard_options=0

while (($#)); do
    case "$1" in
        --help|-h) usage; exit 0 ;;
        --bind|--dashboard-port|--log-dir)
            (($# >= 2)) || die "Missing value for $1"
            case "$1" in
                --bind) bind=$2 ;;
                --dashboard-port) dashboard_port=$2 ;;
                --log-dir) log_dir=$2 ;;
            esac
            dashboard_options=1
            shift 2 ;;
        --) shift; break ;;
        *) die "Unknown installer option: $1 (put collector arguments after --)" ;;
    esac
done

((EUID == 0)) || die "Run the installer as root (sudo ./install.sh)."
[[ $log_dir == /* ]] || die "--log-dir must be an absolute path."
[[ $dashboard_port =~ ^[0-9]{1,5}$ ]] &&
    ((10#$dashboard_port >= 1024 && 10#$dashboard_port <= 65535)) ||
    die "--dashboard-port must be between 1024 and 65535."
command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] ||
    die "This installer requires a running systemd."

new_collector=0
if systemctl cat nettest.service >/dev/null 2>&1; then
    (($# == 0)) ||
        die "nettest.service already exists. Omit collector arguments or edit its systemd configuration."
else
    (($# > 0)) || die "Supply an iperf3 server after -- for a new collector."
    [[ $1 != -* ]] || die "The first argument after -- must be the iperf3 server."
    for argument in "$@"; do
        case "$argument" in
            --output|--output=*|--) die "Use --log-dir before -- to set the output directory." ;;
        esac
    done
    new_collector=1
fi

# Preserve literal arguments in systemd's command syntax, including spaces and percent signs.
write_unit() {
    local template=$1 executable=$2 line argument
    shift 2
    while IFS= read -r line; do
        if [[ $line == ExecStart=* ]]; then
            printf 'ExecStart=:/usr/bin/python3 %s' "$executable"
            for argument in "$@"; do
                [[ $argument != *[[:cntrl:]]* && $argument != ';' ]] ||
                    die "Unsupported character in systemd argument."
                argument=$(printf '%s' "$argument" | sed 's/\\/\\\\/g; s/"/\\"/g; s/%/%%/g')
                printf ' "%s"' "$argument"
            done
            printf '\n'
        else
            printf '%s\n' "$line"
        fi
    done < "$template"
}

staging=$(mktemp -d)
trap 'rm -rf -- "$staging"' EXIT
if ((new_collector)); then
    write_unit "$source_dir/systemd/nettest.service" "$target/nettest.py" \
        "$@" --output "$log_dir" > "$staging/nettest.service"
fi
if ((dashboard_options)) || ! systemctl cat nettest-dashboard.service >/dev/null 2>&1; then
    write_unit "$source_dir/systemd/nettest-dashboard.service" "$target/dashboard_server.py" \
        --bind "$bind" --port "$dashboard_port" --logs "$log_dir" > "$staging/nettest-dashboard.service"
fi

packages=()
for dependency in python3 iputils-ping iperf3 curl ca-certificates; do
    if [[ $(dpkg-query -W -f='${db:Status-Status}' "$dependency" 2>/dev/null || true) != installed ]]; then
        packages+=("$dependency")
    fi
done
if (("${#packages[@]}")); then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${packages[@]}"
fi

download_asset() {
    local file=$1 package_path=$2
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
        --connect-timeout 15 --max-time 120 \
        "https://cdn.jsdelivr.net/npm/$package_path" -o "$staging/$file"
    [[ -s $staging/$file ]] || die "Downloaded an empty $file."
}

download_asset echarts.min.js echarts@5.6.0/dist/echarts.min.js
download_asset papaparse.min.js papaparse@5.5.3/papaparse.min.js

install -d -m755 "$target/dashboard"
install -m755 "$source_dir/nettest.py" "$source_dir/dashboard_server.py" "$target/"
install -m644 "$source_dir/dashboard/"{index.html,style.css,dashboard.js} \
    "$staging/"{echarts.min.js,papaparse.min.js} "$target/dashboard/"
for unit in nettest.service nettest-dashboard.service; do
    if [[ -f $staging/$unit ]]; then
        install -m644 "$staging/$unit" "$unit_dir/$unit"
    fi
done
systemctl daemon-reload
systemctl enable --now nettest.service
systemctl enable nettest-dashboard.service
systemctl restart nettest-dashboard.service
printf 'Installed nettest and nettest-dashboard. See the dashboard listener with:\n'
printf '  systemctl cat nettest-dashboard.service\n'
