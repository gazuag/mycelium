#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd -P)
cd "$SCRIPT_DIR/mycelium-peer"

MYCELIUM_MODE=hoarder \
MYCELIUM_DISPLAY_NAME="Mycelium Cache Peer" \
MYCELIUM_CACHE_MB=4096 \
MYCELIUM_MAX_PEERS=16 \
python -m bot.peer --data-dir /var/lib/mycelium-peer
