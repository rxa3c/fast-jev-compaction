#!/usr/bin/env bash
# Starts the local web viewer for the real Codex hook trace.
# It never creates a fake transcript; it only serves events emitted by the
# Codex lifecycle hook.
set -euo pipefail

cd "$(dirname "$0")"
port="${FAST_JEV_VIEWER_PORT:-4317}"
launch=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-launch) launch=false; shift ;;
    --port)
      [[ $# -ge 2 ]] || { echo "--port requires a value" >&2; exit 2; }
      port="$2"
      shift 2
      ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  echo "invalid port: $port" >&2
  exit 2
fi

if command -v lsof >/dev/null 2>&1; then
  while lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do
    port=$((port + 1))
    (( port <= 65535 )) || { echo "no free local port found" >&2; exit 1; }
  done
fi

url="http://127.0.0.1:$port"

if [[ "$launch" == false ]]; then
  exec node server.mjs --port "$port"
fi

node server.mjs --port "$port" &
server_pid=$!
cleanup() {
  kill "$server_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

for _ in {1..40}; do
  if curl --silent --fail "$url/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

echo "fast-jev-codex web viewer: $url"
if command -v open >/dev/null 2>&1; then
  open "$url"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$url" >/dev/null 2>&1 || true
fi

wait "$server_pid"
