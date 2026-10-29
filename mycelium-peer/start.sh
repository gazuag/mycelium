#!/bin/sh
set -eu

DIST_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd -P) || {
    printf '%s\n' 'start.sh: cannot determine distribution directory.' >&2
    exit 1
}
CONFIG_FILE=$DIST_DIR/config.env
VENV_PYTHON=$DIST_DIR/.venv/bin/python
RUNTIME_DIR=$DIST_DIR/runtime
PID_FILE=$RUNTIME_DIR/peer.pid
LOG_FILE=$RUNTIME_DIR/peer.log

if [ ! -r "$CONFIG_FILE" ]; then
    printf 'start.sh: cannot read %s. Restore config.env and try again.\n' "$CONFIG_FILE" >&2
    exit 1
fi
if [ ! -x "$VENV_PYTHON" ]; then
    printf '%s\n' 'start.sh: the peer virtual environment is missing. Run ./install.sh first.' >&2
    exit 1
fi

while IFS= read -r line || [ -n "$line" ]; do
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
        MYCELIUM_MODE|MYCELIUM_DISPLAY_NAME|MYCELIUM_BIO|MYCELIUM_CACHE_MB|MYCELIUM_MAX_PEERS|MYCELIUM_DATA_DIR|MYCELIUM_SIGNAL_URL|MYCELIUM_IDENTITY_FILE|MYCELIUM_AUTO_FOLLOW_BACK|MYCELIUM_LOG_LEVEL|MYCELIUM_ICE_SERVERS)
            export "$key=$value"
            ;;
        *) printf 'start.sh: unsupported config.env setting: %s\n' "$key" >&2; exit 1 ;;
    esac
done < "$CONFIG_FILE"

: "${MYCELIUM_DATA_DIR:=data}"
case "$MYCELIUM_DATA_DIR" in
    /*) ;;
    '~')
        if [ -z "${HOME:-}" ]; then
            printf '%s\n' 'start.sh: HOME is unset; cannot resolve MYCELIUM_DATA_DIR=~.' >&2
            exit 1
        fi
        MYCELIUM_DATA_DIR=$HOME
        ;;
    '~/'*)
        if [ -z "${HOME:-}" ]; then
            printf '%s\n' 'start.sh: HOME is unset; cannot resolve MYCELIUM_DATA_DIR under ~.' >&2
            exit 1
        fi
        MYCELIUM_DATA_DIR=$HOME/${MYCELIUM_DATA_DIR#??}
        ;;
    *) MYCELIUM_DATA_DIR=$DIST_DIR/$MYCELIUM_DATA_DIR ;;
esac
export MYCELIUM_DATA_DIR

mkdir -p "$RUNTIME_DIR" "$MYCELIUM_DATA_DIR"
if [ -f "$PID_FILE" ]; then
    recorded_pid=$(cat "$PID_FILE" 2>/dev/null || true)
    case "$recorded_pid" in
        ''|*[!0-9]*|0)
            rm -f "$PID_FILE"
            ;;
        *)
            if kill -0 "$recorded_pid" 2>/dev/null; then
                process_command=$(ps -p "$recorded_pid" -o command= 2>/dev/null || true)
                case "$process_command" in
                    *" -m bot.peer --data-dir $MYCELIUM_DATA_DIR")
                        printf 'start.sh: this peer is already running (PID %s).\n' "$recorded_pid" >&2
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
cd "$DIST_DIR"
export PYTHONPATH=$DIST_DIR
nohup "$VENV_PYTHON" -c \
    'import os, signal, sys; signal.signal(signal.SIGINT, signal.SIG_DFL); os.execv(sys.argv[1], sys.argv[1:])' \
    "$VENV_PYTHON" -m bot.peer --data-dir "$MYCELIUM_DATA_DIR" \
    >> "$LOG_FILE" 2>&1 </dev/null &
PEER_PID=$!
printf '%s\n' "$PEER_PID" > "$PID_FILE"

sleep 1
if ! kill -0 "$PEER_PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    printf 'start.sh: peer exited during startup. Check %s for details.\n' "$LOG_FILE" >&2
    exit 1
fi
process_command=$(ps -p "$PEER_PID" -o command= 2>/dev/null || true)
case "$process_command" in
    *" -m bot.peer --data-dir $MYCELIUM_DATA_DIR") ;;
    *)
        rm -f "$PID_FILE"
        printf 'start.sh: process %s did not remain the expected bot.peer process. Check %s.\n' "$PEER_PID" "$LOG_FILE" >&2
        exit 1
        ;;
esac

printf 'Mycelium peer started (PID %s).\n' "$PEER_PID"
printf 'Log: %s\n' "$LOG_FILE"