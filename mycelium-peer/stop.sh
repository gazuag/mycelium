#!/bin/sh
set -eu

DIST_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd -P) || {
    printf '%s\n' 'stop.sh: cannot determine distribution directory.' >&2
    exit 1
}
PID_FILE=$DIST_DIR/runtime/peer.pid
DATA_DIR=data

if [ -r "$DIST_DIR/config.env" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            ''|'#'*|*=*) ;;
            *) continue ;;
        esac
        key=${line%%=*}
        value=${line#*=}
        key=$(printf '%s' "$key" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        if [ "$key" = MYCELIUM_DATA_DIR ]; then
            DATA_DIR=$(printf '%s' "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
            case "$DATA_DIR" in
                \"*\") DATA_DIR=${DATA_DIR#\"}; DATA_DIR=${DATA_DIR%\"} ;;
                \'*\') DATA_DIR=${DATA_DIR#\'}; DATA_DIR=${DATA_DIR%\'} ;;
            esac
            break
        fi
    done < "$DIST_DIR/config.env"
fi

case "$DATA_DIR" in
    /*) ;;
    '~')
        if [ -z "${HOME:-}" ]; then
            printf '%s\n' 'stop.sh: HOME is unset; cannot resolve MYCELIUM_DATA_DIR=~.' >&2
            exit 1
        fi
        DATA_DIR=$HOME
        ;;
    '~/'*)
        if [ -z "${HOME:-}" ]; then
            printf '%s\n' 'stop.sh: HOME is unset; cannot resolve MYCELIUM_DATA_DIR under ~.' >&2
            exit 1
        fi
        DATA_DIR=$HOME/${DATA_DIR#??}
        ;;
    *) DATA_DIR=$DIST_DIR/$DATA_DIR ;;
esac

if [ ! -f "$PID_FILE" ]; then
    printf '%s\n' 'Mycelium peer is not running (no PID file).'
    exit 0
fi

PEER_PID=$(cat "$PID_FILE" 2>/dev/null || true)
case "$PEER_PID" in
    ''|*[!0-9]*|0)
        rm -f "$PID_FILE"
        printf '%s\n' 'Removed invalid PID file; no peer was signaled.'
        exit 0
        ;;
esac

process_is_peer() {
    command_line=$(ps -p "$PEER_PID" -o command= 2>/dev/null || true)
    case "$command_line" in
        *" -m bot.peer --data-dir $DATA_DIR") return 0 ;;
        *) return 1 ;;
    esac
}

remove_pid_file() {
    if [ -f "$PID_FILE" ] && [ "$(cat "$PID_FILE" 2>/dev/null || true)" = "$PEER_PID" ]; then
        rm -f "$PID_FILE"
    fi
}

if ! kill -0 "$PEER_PID" 2>/dev/null; then
    remove_pid_file
    printf 'Mycelium peer is not running; removed stale PID %s.\n' "$PEER_PID"
    exit 0
fi
if ! process_is_peer; then
    printf 'stop.sh: PID %s is running a different process; refusing to signal it. Remove the stale PID file manually after verifying it.\n' "$PEER_PID" >&2
    exit 1
fi

if ! kill -INT "$PEER_PID" 2>/dev/null; then
    if kill -0 "$PEER_PID" 2>/dev/null && process_is_peer; then
        printf 'stop.sh: could not send SIGINT to peer PID %s.\n' "$PEER_PID" >&2
        exit 1
    fi
fi

elapsed=0
while [ "$elapsed" -lt 15 ]; do
    if ! kill -0 "$PEER_PID" 2>/dev/null || ! process_is_peer; then
        remove_pid_file
        printf 'Mycelium peer stopped (PID %s).\n' "$PEER_PID"
        exit 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
done

if process_is_peer; then
    printf 'Peer PID %s did not stop gracefully; sending SIGKILL.\n' "$PEER_PID" >&2
    if ! kill -KILL "$PEER_PID" 2>/dev/null; then
        printf 'stop.sh: could not force-stop peer PID %s; PID file was retained.\n' "$PEER_PID" >&2
        exit 1
    fi
else
    remove_pid_file
    printf 'Mycelium peer stopped (PID %s).\n' "$PEER_PID"
    exit 0
fi

elapsed=0
while [ "$elapsed" -lt 5 ]; do
    if ! kill -0 "$PEER_PID" 2>/dev/null || ! process_is_peer; then
        remove_pid_file
        printf 'Mycelium peer stopped forcefully (PID %s).\n' "$PEER_PID"
        exit 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
done

printf 'stop.sh: peer PID %s could not be confirmed stopped; PID file was retained.\n' "$PEER_PID" >&2
exit 1