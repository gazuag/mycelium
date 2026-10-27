MYCELIUM_MODE=hoarder \
MYCELIUM_DISPLAY_NAME="Mycelium Cache Peer" \
MYCELIUM_CACHE_MB=4096 \
MYCELIUM_MAX_PEERS=16 \
python -m bot.peer --data-dir /var/lib/mycelium-peer

