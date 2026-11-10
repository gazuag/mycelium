from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "mycelium-peer"))

from bot.peer import MAX_PACKET_BYTES, PeerNode, write_identity
from bot.store import PeerStore

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(levelname)s %(message)s")


def prepare(data_dir: Path, browser_id: str) -> str:
    data_dir.mkdir(parents=True, exist_ok=True)
    identity_path = data_dir / "identity.json"
    identity = write_identity(identity_path)
    while identity.node_id >= browser_id:
        identity_path.unlink()
        identity = write_identity(identity_path)
    store = PeerStore(data_dir / "objects.sqlite3")
    try:
        store.add_peer(browser_id, time.time())
    finally:
        store.close()
    return identity.node_id


async def run(data_dir: Path, browser_id: str, signal_url: str) -> None:
    identity = write_identity(data_dir / "identity.json")
    if identity.node_id >= browser_id:
        raise ValueError("the test bot identity must be lower than the browser identity")
    store = PeerStore(data_dir / "objects.sqlite3")
    node = PeerNode(identity, store)
    try:
        async with websockets.connect(
            signal_url,
            max_size=MAX_PACKET_BYTES,
            ping_interval=20,
            ping_timeout=20,
            close_timeout=5,
        ) as socket:
            node.signalling = socket
            await socket.send(json.dumps({"type": "register", "id": identity.node_id}))
            await node.maintain_connections()
            async for raw in socket:
                if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_PACKET_BYTES:
                    continue
                try:
                    message = json.loads(raw)
                except (json.JSONDecodeError, UnicodeError, RecursionError):
                    continue
                if not isinstance(message, dict):
                    continue
                if message.get("type") == "peer-list":
                    node.handle_peer_list(message.get("peers"))
                elif message.get("type") in ("offer", "answer", "ice-candidate"):
                    await node.handle_signal(message)
                else:
                    await node._handle_discovery_packet(message)
    finally:
        node.signalling = None
        await node.close()
        store.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--browser-id", required=True)
    parser.add_argument("--signal-url", default="wss://localhost:8443")
    args = parser.parse_args()
    if args.prepare:
        print(prepare(args.data_dir, args.browser_id))
        return
    asyncio.run(run(args.data_dir, args.browser_id, args.signal_url))


if __name__ == "__main__":
    main()
