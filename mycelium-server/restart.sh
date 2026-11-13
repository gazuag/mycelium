#!/usr/bin/env bash
set -euo pipefail

DIST_DIR=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || {
    printf '%s\n' 'restart.sh: cannot determine distribution directory.' >&2
    exit 1
}

if ! "$DIST_DIR/stop.sh"; then
    printf '%s\n' 'restart.sh: stop failed; the server was not started again.' >&2
    exit 1
fi
exec "$DIST_DIR/start.sh"
