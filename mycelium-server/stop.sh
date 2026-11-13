#!/usr/bin/env bash
set -euo pipefail

DIST_DIR=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || {
    printf '%s\n' 'stop.sh: cannot determine distribution directory.' >&2
    exit 1
}
SERVER_FILE=$DIST_DIR/server.py
PID_FILE=$DIST_DIR/runtime/server.pid

if [[ ! -f "$PID_FILE" ]]; then
    printf '%s\n' 'Mycelium server is not running (no PID file).'
    exit 0
fi

SERVER_PID=$(cat "$PID_FILE" 2>/dev/null || true)
case "$SERVER_PID" in
    ''|*[!0-9]*|0)
        rm -f "$PID_FILE"
        printf '%s\n' 'Removed invalid PID file; no server was signaled.'
        exit 0
        ;;
esac

process_is_server() {
    local command_line
    command_line=$(ps -p "$SERVER_PID" -o command= 2>/dev/null || true)
    [[ "$command_line" == *"$SERVER_FILE"* ]]
}

remove_pid_file() {
    if [[ -f "$PID_FILE" && "$(cat "$PID_FILE" 2>/dev/null || true)" == "$SERVER_PID" ]]; then
        rm -f "$PID_FILE"
    fi
}

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    remove_pid_file
    printf 'Mycelium server is not running; removed stale PID %s.\n' "$SERVER_PID"
    exit 0
fi
if ! process_is_server; then
    printf 'stop.sh: PID %s is running a different process; refusing to signal it. Remove the stale PID file manually after verifying it.\n' "$SERVER_PID" >&2
    exit 1
fi

if ! kill -INT "$SERVER_PID" 2>/dev/null; then
    if kill -0 "$SERVER_PID" 2>/dev/null && process_is_server; then
        printf 'stop.sh: could not send SIGINT to server PID %s.\n' "$SERVER_PID" >&2
        exit 1
    fi
fi

elapsed=0
while [[ "$elapsed" -lt 15 ]]; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null || ! process_is_server; then
        remove_pid_file
        printf 'Mycelium server stopped (PID %s).\n' "$SERVER_PID"
        exit 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
done

if process_is_server; then
    printf 'Server PID %s did not stop gracefully; sending SIGKILL.\n' "$SERVER_PID" >&2
    if ! kill -KILL "$SERVER_PID" 2>/dev/null; then
        printf 'stop.sh: could not force-stop server PID %s; PID file was retained.\n' "$SERVER_PID" >&2
        exit 1
    fi
else
    remove_pid_file
    printf 'Mycelium server stopped (PID %s).\n' "$SERVER_PID"
    exit 0
fi

elapsed=0
while [[ "$elapsed" -lt 5 ]]; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null || ! process_is_server; then
        remove_pid_file
        printf 'Mycelium server stopped forcefully (PID %s).\n' "$SERVER_PID"
        exit 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
done

printf 'stop.sh: server PID %s could not be confirmed stopped; PID file was retained.\n' "$SERVER_PID" >&2
exit 1
