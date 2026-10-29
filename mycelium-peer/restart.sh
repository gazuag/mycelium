#!/bin/sh
set -eu

DIST_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd -P) || {
    printf '%s\n' 'restart.sh: cannot determine distribution directory.' >&2
    exit 1
}

if ! "$DIST_DIR/stop.sh"; then
    printf '%s\n' 'restart.sh: stop failed; the peer was not started again.' >&2
    exit 1
fi
exec "$DIST_DIR/start.sh"