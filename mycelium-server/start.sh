#!/usr/bin/env bash
set -euo pipefail

DIST_DIR=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || {
    printf '%s\n' 'start.sh: cannot determine distribution directory.' >&2
    exit 1
}
SERVER_FILE=$DIST_DIR/server.py
VENV_PYTHON=$DIST_DIR/.venv/bin/python
RUNTIME_DIR=$DIST_DIR/runtime
PID_FILE=$RUNTIME_DIR/server.pid
LOG_FILE=$RUNTIME_DIR/server.log

cd "$DIST_DIR"
CONFIG_FILE=$DIST_DIR/config.env
if [[ ! -r "$CONFIG_FILE" ]]; then
    printf 'start.sh: cannot read %s. Restore config.env and try again.\n' "$CONFIG_FILE" >&2
    exit 1
fi

while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
        ''|'#'*) continue ;;
        *=*) key=${line%%=*}; value=${line#*=} ;;
        *) printf 'start.sh: invalid config.env line: %s\n' "$line" >&2; exit 1 ;;
    esac
    key=$(printf '%s' "$key" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    value=$(printf '%s' "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    case "$value" in
        \"*\") value=${value#\"}; value=${value%\"} ;;
        \'*\') value=${value#\'}; value=${value%\'} ;;
        \"*|\'*) printf 'start.sh: unmatched quote in config.env value for %s.\n' "$key" >&2; exit 1 ;;
    esac
    case "$key" in
        TLS_CERT_PATH|TLS_KEY_PATH|SIGNAL_HOST|SIGNAL_PORT|DISCOVERY_DB_PATH|MAX_DISCOVERY_POSTS|MAX_DISCOVERY_PROFILES|MAX_POST_SIZE|MAX_IDENTITY_PROFILE_SIZE|MAX_DISCOVERY_BATCH_SIZE|SIGNAL_QUEUE_TTL_SECONDS|MAX_QUEUED_SIGNALS_PER_CLIENT|PEER_DISCOVERY_WINDOW_DAYS)
            if [[ ! ${!key+x} ]]; then
                export "$key=$value"
            fi
            ;;
        *) printf 'start.sh: unsupported config.env setting: %s\n' "$key" >&2; exit 1 ;;
    esac
done < "$CONFIG_FILE"

if [[ -z "${TLS_CERT_PATH:-}" || -z "${TLS_KEY_PATH:-}" ]]; then
    printf 'start.sh: set TLS_CERT_PATH and TLS_KEY_PATH in %s before starting the server.\n' "$CONFIG_FILE" >&2
    exit 1
fi
if [[ ! -r "$TLS_CERT_PATH" || ! -r "$TLS_KEY_PATH" ]]; then
    printf '%s\n' 'start.sh: TLS_CERT_PATH and TLS_KEY_PATH must point to readable certificate and key files.' >&2
    exit 1
fi
if [[ ! -x "$VENV_PYTHON" ]]; then
    printf '%s\n' 'start.sh: the server virtual environment is missing. Run ./install.sh first.' >&2
    exit 1
fi

mkdir -p "$RUNTIME_DIR"
if [[ -f "$PID_FILE" ]]; then
    recorded_pid=$(cat "$PID_FILE" 2>/dev/null || true)
    case "$recorded_pid" in
        ''|*[!0-9]*|0)
            rm -f "$PID_FILE"
            ;;
        *)
            if kill -0 "$recorded_pid" 2>/dev/null; then
                process_command=$(ps -p "$recorded_pid" -o command= 2>/dev/null || true)
                case "$process_command" in
                    *"$SERVER_FILE"*)
                        printf 'start.sh: the server is already running (PID %s).\n' "$recorded_pid" >&2
                        exit 1
                        ;;
                    *)
                        printf 'start.sh: PID file points to a different running process (%s); refusing to overwrite it.\n' "$recorded_pid" >&2
                        exit 1
                        ;;
                esac
            else
                printf 'Removing stale PID file for process %s.\n' "$recorded_pid"
                rm -f "$PID_FILE"
            fi
            ;;
    esac
fi

umask 077
nohup "$VENV_PYTHON" -c \
    'import os, signal, sys; signal.signal(signal.SIGINT, signal.SIG_DFL); os.execv(sys.argv[1], sys.argv[1:])' \
    "$VENV_PYTHON" "$SERVER_FILE" \
    >> "$LOG_FILE" 2>&1 </dev/null &
SERVER_PID=$!
printf '%s\n' "$SERVER_PID" > "$PID_FILE"

sleep 1
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    printf 'start.sh: server exited during startup. Check %s for details.\n' "$LOG_FILE" >&2
    exit 1
fi
process_command=$(ps -p "$SERVER_PID" -o command= 2>/dev/null || true)
case "$process_command" in
    *"$SERVER_FILE"*) ;;
    *)
        rm -f "$PID_FILE"
        printf 'start.sh: process %s did not remain the expected server process. Check %s.\n' "$SERVER_PID" "$LOG_FILE" >&2
        exit 1
        ;;
esac

printf 'Mycelium server started (PID %s).\n' "$SERVER_PID"
printf 'Log: %s\n' "$LOG_FILE"
