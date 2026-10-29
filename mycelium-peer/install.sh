#!/bin/sh
set -eu

DIST_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd -P) || {
    printf '%s\n' 'install.sh: cannot determine distribution directory.' >&2
    exit 1
}
VENV_DIR=$DIST_DIR/.venv
REQUIREMENTS=$DIST_DIR/requirements.txt

python_is_suitable() {
    "$1" -c 'import sys; sys.exit(0 if sys.implementation.name == "cpython" and sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1
}

if [ "${PYTHON:-}" ]; then
    PYTHON_CANDIDATE=$(command -v "$PYTHON" 2>/dev/null || true)
    if [ -z "$PYTHON_CANDIDATE" ] || ! python_is_suitable "$PYTHON_CANDIDATE"; then
        printf '%s\n' 'install.sh: PYTHON must name an available CPython 3.10 or newer interpreter.' >&2
        exit 1
    fi
else
    PYTHON_CANDIDATE=
    for candidate in python3 python3.14 python3.13 python3.12 python3.11 python3.10; do
        candidate_path=$(command -v "$candidate" 2>/dev/null || true)
        if [ -n "$candidate_path" ] && python_is_suitable "$candidate_path"; then
            PYTHON_CANDIDATE=$candidate_path
            break
        fi
    done
    if [ -z "$PYTHON_CANDIDATE" ]; then
        printf '%s\n' 'install.sh: CPython 3.10 or newer was not found. Install Python 3 and rerun this script.' >&2
        exit 1
    fi
fi

if [ -e "$VENV_DIR" ] && {
    [ ! -x "$VENV_DIR/bin/python" ] ||
    ! python_is_suitable "$VENV_DIR/bin/python" ||
    ! "$VENV_DIR/bin/python" -c 'import aiortc, av, cryptography, websockets; from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection' >/dev/null 2>&1
}; then
    printf '%s\n' 'install.sh: replacing an unusable, incompatible, or incomplete .venv copied from another environment.' >&2
    rm -rf "$VENV_DIR"
fi

if [ ! -x "$VENV_DIR/bin/python" ]; then
    printf 'Creating virtual environment with %s...\n' "$PYTHON_CANDIDATE"
    if ! "$PYTHON_CANDIDATE" -m venv "$VENV_DIR"; then
        printf '%s\n' 'install.sh: could not create .venv; verify that this Python installation includes venv support.' >&2
        exit 1
    fi
fi

PYTHON=$VENV_DIR/bin/python
printf '%s\n' 'Upgrading pip, setuptools, and wheel...'
if ! "$PYTHON" -m pip install --upgrade pip setuptools wheel; then
    printf '%s\n' 'install.sh: failed to upgrade packaging tools. Check network access and Python package index availability.' >&2
    exit 1
fi

printf '%s\n' 'Installing peer dependencies (including aiortc and its PyAV dependency)...'
if ! "$PYTHON" -m pip install --upgrade -r "$REQUIREMENTS"; then
    printf '%s\n' 'install.sh: dependency installation failed. See pip output above; this platform may not have compatible wheels.' >&2
    exit 1
fi

if ! "$PYTHON" -m pip check; then
    printf '%s\n' 'install.sh: installed dependencies have conflicts; see pip output above.' >&2
    exit 1
fi
if ! "$PYTHON" -c 'import aiortc, av, cryptography, websockets; from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection'; then
    printf '%s\n' 'install.sh: required runtime imports failed, including aiortc/PyAV. See the error above.' >&2
    exit 1
fi
if ! PYTHONPATH=$DIST_DIR "$PYTHON" -m bot.peer --help >/dev/null; then
    printf '%s\n' 'install.sh: bot.peer startup/import sanity check failed.' >&2
    exit 1
fi

mkdir -p "$DIST_DIR/data" "$DIST_DIR/runtime"
chmod 755 "$DIST_DIR/install.sh" "$DIST_DIR/start.sh" "$DIST_DIR/stop.sh" "$DIST_DIR/restart.sh"

printf '\n%s\n' 'Mycelium peer installed successfully.'
printf '%s\n' 'Edit config.env if needed, then run ./start.sh to start the peer.'