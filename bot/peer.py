from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import tempfile
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

import websockets

from .protocol import (
    HEX_SHA256,
    Identity,
    MAX_OBJECT_BYTES,
    MAX_PACKET_BYTES,
    canonicalize,
    fingerprint,
    object_expired,
    is_safe_integer,
    packet_unsigned,
    sign_packet,
    validate_object,
    validate_packet_shape,
    verify_signature,
)
from .store import DEFAULT_OBJECT_CACHE_BYTES, PeerStore

PEER_ID_PATTERN = re.compile(r"^(?:[0-9a-f]{2}:){7}[0-9a-f]{2}$")
FIND_LIFETIME_SECONDS = 5.0
FIND_MAX_TTL = 8
FIND_MAX_IDS = 200
FIND_MAX_QUERY = 500
FIND_FANOUT = 2
FEED_SYNC_PAGE_SIZE = 100
FEED_SYNC_MAX_PAGES = 10
FEED_SYNC_TIMEOUT_SECONDS = 8.0
MAX_FIND_IN_FLIGHT = 64
MAX_PACKET_TASKS = 64
MAX_PEER_PACKETS_PER_MINUTE = 120
MAX_FIND_PER_PEER_PER_MINUTE = 30
MAX_PACKET_CACHE = 2048
MAX_FIND_RESPONSE_BYTES = 512 * 1024
MAX_POST_ANCESTRY_DEPTH = 32
REPLICATION_BUDGET = 3
DEFAULT_MAX_PEERS = 16
HARD_MAX_PEERS = 64
DEFAULT_DISPLAY_NAME = "Mycelium peer"
MAX_DISPLAY_NAME_LENGTH = 80
PEER_MODES = ("social", "hoarder")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _reject_json_constant(_: str) -> None:
    raise ValueError("non-finite JSON number")


def parse_time(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except ValueError:
        return None


def new_packet(sender: str, recipient: str | None, packet_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "protocol": "mycelium",
        "version": 1,
        "id": str(uuid.uuid4()),
        "type": packet_type,
        "timestamp": utc_now(),
        "sender": sender,
        "recipient": recipient,
        "payload": payload,
    }


def write_identity(path: Path) -> Identity:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass
    if path.exists():
        if path.is_symlink():
            raise ValueError("identity file must not be a symbolic link")
        if path.stat().st_mode & 0o077:
            logging.warning("Identity file permissions are broader than owner-only: %s", path)
        raw = json.loads(path.read_text(encoding="utf-8"))
        if (not isinstance(raw, dict) or not isinstance(raw.get("public_key"), str)
                or not isinstance(raw.get("private_key"), str)):
            raise ValueError("identity file has an invalid shape")
        identity = Identity.load(raw["public_key"], raw["private_key"])
        if raw.get("node_id") != identity.node_id:
            raise ValueError("identity Node ID does not match its public key")
        path.chmod(0o600)
        return identity

    identity = Identity.create()
    encoded = json.dumps(
        {
            "public_key": identity.public_key,
            "private_key": identity.private_key,
            "node_id": identity.node_id,
        },
        separators=(",", ":"),
    ).encode("utf-8")
    fd, temporary_name = tempfile.mkstemp(prefix=".identity-", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        path.chmod(0o600)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    logging.info("Created persistent Mycelium identity %s", identity.node_id)
    return identity


@dataclass
class FindState:
    request_id: str
    upstream: str
    expires_at: float
    origin: str
    response_object_id: str
    object_ids: set[str]
    query: dict[str, Any] | None
    objects: dict[str, dict[str, Any]]
    pending_children: set[str] = field(default_factory=set)
    responded_children: set[str] = field(default_factory=set)
    failed_children: set[str] = field(default_factory=set)
    children_pagination_supported: bool = True
    has_more: bool = False
    timer: asyncio.Task[None] | None = None


@dataclass
class ParentLookup:
    request_id: str
    peer_id: str
    object_id: str
    expires_at: float
    future: asyncio.Future[dict[str, Any] | None]


@dataclass
class FeedSyncState:
    cursor: dict[str, str]
    request_id: str
    pages: int = 0
    received: int = 0
    rejected: int = 0
    stored: int = 0
    duplicates: int = 0
    timer: asyncio.Task[None] | None = None


class PeerNode:
    def __init__(
        self,
        identity: Identity,
        store: PeerStore,
        max_peers: int = DEFAULT_MAX_PEERS,
        display_name: str | None = None,
        mode: str = "social",
        auto_follow_back: bool | None = None,
    ):
        if max_peers < 1 or max_peers > HARD_MAX_PEERS:
            raise ValueError(f"maximum peer connections must be between 1 and {HARD_MAX_PEERS}")
        if mode not in PEER_MODES:
            raise ValueError(f"mode must be one of: {', '.join(PEER_MODES)}")
        self.identity = identity
        self.store = store
        self.max_peers = max_peers
        self.display_name = self._load_display_name(display_name)
        self.mode = mode
        self.auto_follow_back = mode == "social" if auto_follow_back is None else auto_follow_back
        self.links: dict[str, PeerLink] = {}
        self.online_peers: set[str] = set()
        self.pool_peers: set[str] = set()
        self.authenticated: set[str] = set()
        self.remote_keys: dict[str, str] = {}
        self.find_states: dict[str, FindState] = {}
        self.parent_lookups: dict[str, ParentLookup] = {}
        self.parent_lookup_cache: dict[str, tuple[float, asyncio.Task[dict[str, Any] | None]]] = {}
        self.find_sources: dict[str, str] = {}
        self.find_newly_cached: set[str] = set()
        self.feed_syncs: dict[str, FeedSyncState] = {}
        self.feed_sync_started: set[str] = set()
        self.seen_requests: dict[str, float] = {}
        self.rate_windows: dict[str, deque[float]] = {}
        self.find_rate_windows: dict[str, deque[float]] = {}
        self.packet_tasks: set[asyncio.Task[Any]] = set()
        self.attempts: dict[str, tuple[int, float]] = {}
        self._candidate_rotation = 0
        self.find_semaphore = asyncio.Semaphore(MAX_FIND_IN_FLIGHT)
        self.stopping = False
        self.signalling: Any = None

    def _load_display_name(self, configured: str | None) -> str:
        value = configured if configured is not None else self.store.get_setting("display_name")
        value = value if value is not None else DEFAULT_DISPLAY_NAME
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > MAX_DISPLAY_NAME_LENGTH:
            raise ValueError(f"display name must contain 1 to {MAX_DISPLAY_NAME_LENGTH} characters")
        value = value.strip()
        self.store.set_setting("display_name", value)
        return value

    def connected_peers(self) -> list[str]:
        return [
            peer_id for peer_id, link in self.links.items()
            if link.is_open and peer_id in self.authenticated
        ]

    def spawn_packet_task(
        self,
        peer_id: str,
        raw: Any,
        source_link: PeerLink | None = None,
    ) -> None:
        if len(self.packet_tasks) >= MAX_PACKET_TASKS:
            logging.warning("Dropping packet from %s: packet processing limit reached", peer_id)
            return
        task = asyncio.create_task(self.handle_data(peer_id, raw, source_link))
        self.packet_tasks.add(task)
        task.add_done_callback(self._packet_task_done)

    def _packet_task_done(self, task: asyncio.Task[Any]) -> None:
        self.packet_tasks.discard(task)
        if task.cancelled():
            return
        error = task.exception()
        if error:
            logging.warning("Packet processing failed: %s", error)

    async def send(self, peer_id: str, packet: dict[str, Any]) -> None:
        link = self.links.get(peer_id)
        if link is None or not link.is_open:
            raise ConnectionError(f"peer {peer_id} is unavailable")
        packet = sign_packet(self.identity, packet)
        encoded = json.dumps(packet, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        if len(encoded.encode("utf-8")) > MAX_PACKET_BYTES:
            raise ValueError("outgoing packet exceeds size limit")
        link.channel.send(encoded)

    async def send_packet(
        self,
        peer_id: str,
        packet_type: str,
        payload: dict[str, Any],
    ) -> None:
        await self.send(
            peer_id,
            new_packet(self.identity.node_id, peer_id, packet_type, payload),
        )

    async def handle_data(
        self,
        peer_id: str,
        raw: Any,
        source_link: PeerLink | None = None,
    ) -> None:
        if source_link is not None and (
            source_link.closed or self.links.get(peer_id) is not source_link
        ):
            logging.debug("Ignoring packet received on stale connection for %s", peer_id)
            return
        if not isinstance(raw, str):
            logging.warning("Dropping malformed or oversized packet from %s", peer_id)
            return
        try:
            if len(raw.encode("utf-8")) > MAX_PACKET_BYTES:
                logging.warning("Dropping malformed or oversized packet from %s", peer_id)
                return
        except UnicodeEncodeError:
            logging.warning("Dropping malformed text packet from %s", peer_id)
            return
        window = self.rate_windows.setdefault(peer_id, deque())
        now = time.monotonic()
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= MAX_PEER_PACKETS_PER_MINUTE:
            logging.warning("Rate limit reached for peer %s", peer_id)
            return
        window.append(now)
        try:
            packet = json.loads(raw, parse_constant=_reject_json_constant)
        except (json.JSONDecodeError, UnicodeError, RecursionError, ValueError):
            logging.warning("Dropping invalid JSON packet from %s", peer_id)
            return
        if not validate_packet_shape(packet):
            if isinstance(packet, dict) and "protocol" not in packet:
                logging.debug("Ignoring non-Mycelium data-channel message from %s", peer_id)
            else:
                logging.warning(
                    "Dropping malformed Mycelium packet from %s (invalid fields: %s)",
                    peer_id,
                    ", ".join(self._packet_shape_errors(packet)),
                )
            return
        if packet["sender"] != peer_id or packet["recipient"] not in (None, self.identity.node_id):
            logging.warning(
                "Dropping packet with mismatched sender or recipient from %s: "
                "type=%s id=%s sender=%r expected_sender=%r recipient=%r "
                "expected_recipient=null or %r",
                peer_id,
                packet["type"],
                packet["id"],
                packet["sender"],
                peer_id,
                packet["recipient"],
                self.identity.node_id,
            )
            return

        if packet["type"] in ("PROFILE_UPDATE", "PROFILE_RESPONSE"):
            if not self._authenticate_profile(peer_id, packet):
                return
            await self._start_feed_sync(peer_id)
            profile = packet["payload"].get("profile", packet["payload"].get("metadata"))
            following = profile.get("following") if isinstance(profile, dict) else None
            if (self.auto_follow_back and isinstance(following, bool)
                    and self.store.set_following(peer_id, following)):
                await self._send_profile(peer_id, "PROFILE_UPDATE")
        elif peer_id not in self.authenticated:
            logging.debug("Ignoring pre-authentication packet %s from %s", packet["type"], peer_id)
            return
        elif not self._verify_packet_if_signed(peer_id, packet):
            logging.warning("Rejected packet signature from %s", peer_id)
            return

        packet_type = packet["type"]
        if packet_type == "PROFILE_REQUEST":
            await self._send_profile(peer_id, "PROFILE_RESPONSE")
        elif packet_type == "PING":
            await self.send_packet(peer_id, "PONG", {
                "pingId": packet["payload"].get("pingId", packet["id"]),
                "sentAt": packet["payload"].get("sentAt", packet["timestamp"]),
            })
        elif packet_type == "PONG":
            link = self.links.get(peer_id)
            if link:
                link.record_pong(packet["payload"].get("pingId"))
        elif packet_type == "FIND":
            await self._handle_find(peer_id, packet)
        elif packet_type == "FIND_RESPONSE":
            await self._handle_find_response(peer_id, packet)
        elif packet_type == "POST_REQUEST":
            await self._handle_post_request(peer_id, packet)
        elif packet_type == "OBJECT_STORE":
            result = await self.receive_object_from(peer_id, packet["payload"].get("object"))
            logging.info(
                "Object packet from %s: received=1 stored=%d rejected=%d duplicates=%d",
                peer_id,
                int(result == "stored"),
                int(result == "rejected"),
                int(result == "duplicate"),
            )
        elif packet_type == "OBJECT_BATCH":
            objects = packet["payload"].get("objects")
            if not isinstance(objects, list) or len(objects) > 50:
                logging.warning("Rejected OBJECT_BATCH from %s: objects must be an array of at most 50", peer_id)
                return
            state = self.feed_syncs.get(peer_id)
            received = stored = rejected = duplicates = 0
            for value in objects:
                received += 1
                result = await self.receive_object_from(peer_id, value)
                stored += int(result == "stored")
                rejected += int(result == "rejected")
                duplicates += int(result == "duplicate")
                if state:
                    state.received += 1
                    state.stored += int(result == "stored")
                    state.rejected += int(result == "rejected")
                    state.duplicates += int(result == "duplicate")
            page = packet["payload"].get("page")
            if state and isinstance(page, dict) and page.get("request_id") == state.request_id:
                self._cancel_feed_sync_timer(state)
                await self._handle_feed_sync_page(peer_id, state, page)
            elif received:
                logging.info(
                    "Object batch from %s: received=%d stored=%d rejected=%d duplicates=%d",
                    peer_id,
                    received,
                    stored,
                    rejected,
                    duplicates,
                )
        elif packet_type == "GOODBYE":
            link = self.links.get(peer_id)
            if link:
                await link.close()

    async def _handle_post_request(self, peer_id: str, packet: dict[str, Any]) -> None:
        payload = packet["payload"]
        request_id = payload.get("requestId")
        limit = payload.get("limit")
        cursor = payload.get("after")
        if (
            (request_id is not None and (
                not isinstance(request_id, str) or not request_id or len(request_id) > 128
            ))
            or (limit is not None and (
                not is_safe_integer(limit) or limit < 1 or limit > 200
            ))
            or (cursor is not None and (
                not isinstance(cursor, dict)
                or not isinstance(cursor.get("created_at"), str)
                or parse_time(cursor["created_at"]) is None
                or not isinstance(cursor.get("object_id"), str)
                or (cursor["object_id"] and not HEX_SHA256.fullmatch(cursor["object_id"]))
            ))
        ):
            logging.warning("Rejected POST_REQUEST from %s: malformed cursor, limit, or request ID", peer_id)
            return
        # The bot is a relay/cache identity and has no authored feed objects.
        logging.info("Responding to POST_REQUEST from %s: objects=0", peer_id)
        await self.send_packet(peer_id, "OBJECT_BATCH", {
            "objects": [],
            "page": {
                "request_id": request_id,
                "next_cursor": cursor,
                "has_more": False,
            },
        })

    def _verify_packet_if_signed(self, peer_id: str, packet: dict[str, Any]) -> bool:
        signature = packet["signature"]
        if signature == "unsigned-v1":
            return True
        public_key = self.remote_keys.get(peer_id)
        try:
            return bool(public_key and verify_signature(
                public_key, canonicalize(packet_unsigned(packet)), signature
            ))
        except (TypeError, ValueError, RecursionError, UnicodeError):
            return False

    @staticmethod
    def _packet_shape_errors(packet: Any) -> list[str]:
        if not isinstance(packet, dict):
            return ["top-level"]
        checks = (
            ("protocol", packet.get("protocol") == "mycelium"),
            ("version", type(packet.get("version")) is int and packet.get("version") == 1),
            ("id", isinstance(packet.get("id"), str)),
            ("type", isinstance(packet.get("type"), str)),
            ("timestamp", isinstance(packet.get("timestamp"), str)),
            ("sender", isinstance(packet.get("sender"), str)),
            ("recipient", packet.get("recipient") is None or isinstance(packet.get("recipient"), str)),
            ("payload", isinstance(packet.get("payload"), dict)),
            ("signature", isinstance(packet.get("signature"), str)),
        )
        errors = [name for name, valid in checks if not valid]
        return errors or ["unknown"]

    def _authenticate_profile(self, peer_id: str, packet: dict[str, Any]) -> bool:
        if (packet.get("sender") != peer_id
                or packet.get("type") not in ("PROFILE_UPDATE", "PROFILE_RESPONSE")):
            logging.warning("Rejected profile from %s: sender or packet type mismatch", peer_id)
            return False
        payload = packet["payload"]
        metadata = payload.get("profile", payload.get("metadata"))
        if not isinstance(metadata, dict) or not isinstance(metadata.get("publicKey"), str):
            logging.warning("Rejected profile from %s: missing profile public key", peer_id)
            return False
        public_key = metadata["publicKey"]
        try:
            key_fingerprint = fingerprint(public_key)
        except (TypeError, ValueError):
            logging.warning("Rejected profile from %s: invalid profile public key", peer_id)
            return False
        if key_fingerprint != peer_id:
            logging.warning("Rejected profile from %s: public-key fingerprint mismatch", peer_id)
            return False
        if packet["signature"] == "unsigned-v1":
            logging.warning("Rejected profile from %s: unsigned profile packet", peer_id)
            return False
        try:
            verified = verify_signature(
                public_key, canonicalize(packet_unsigned(packet)), packet["signature"]
            )
        except (TypeError, ValueError, RecursionError, UnicodeError):
            logging.warning("Rejected profile from %s: malformed signed packet", peer_id)
            return False
        if not verified:
            logging.warning("Rejected profile from %s: signature verification failed", peer_id)
            return False
        self.remote_keys[peer_id] = public_key
        was_authenticated = peer_id in self.authenticated
        self.authenticated.add(peer_id)
        self.store.add_peer(peer_id, time.time())
        if not was_authenticated:
            logging.info("Authenticated peer %s via %s", peer_id, packet["type"])
        return True

    async def _start_feed_sync(self, peer_id: str) -> None:
        if peer_id in self.feed_sync_started or peer_id not in self.authenticated:
            return
        cursor = self.store.get_feed_cursor(peer_id) or {
            "created_at": "0001-01-01T00:00:00.000Z",
            "object_id": "",
        }
        self.feed_sync_started.add(peer_id)
        state = FeedSyncState(cursor=cursor, request_id="")
        await self._send_feed_sync_page(peer_id, state)

    async def _send_feed_sync_page(self, peer_id: str, state: FeedSyncState) -> None:
        state.request_id = str(uuid.uuid4())
        self.feed_syncs[peer_id] = state
        state.timer = asyncio.create_task(self._expire_feed_sync(peer_id, state.request_id))
        logging.info(
            "Feed sync started with %s: mode=%s request=POST_REQUEST requestId=%s page=%d cursor=%s/%s",
            peer_id,
            self.mode,
            state.request_id,
            state.pages + 1,
            state.cursor["created_at"],
            state.cursor["object_id"] or "start",
        )
        try:
            await self.send_packet(peer_id, "POST_REQUEST", {
                "since": None,
                "after": state.cursor,
                "limit": FEED_SYNC_PAGE_SIZE,
                "requestId": state.request_id,
            })
        except (ConnectionError, ValueError) as error:
            self._finish_feed_sync(peer_id, state)
            logging.warning("Feed sync request to %s failed: %s", peer_id, error)

    async def _expire_feed_sync(self, peer_id: str, request_id: str) -> None:
        await asyncio.sleep(FEED_SYNC_TIMEOUT_SECONDS)
        state = self.feed_syncs.get(peer_id)
        if state and state.request_id == request_id:
            logging.warning(
                "Feed sync with %s timed out: received=%d stored=%d rejected=%d duplicates=%d",
                peer_id,
                state.received,
                state.stored,
                state.rejected,
                state.duplicates,
            )
            self._finish_feed_sync(peer_id, state)

    async def _handle_feed_sync_page(
        self,
        peer_id: str,
        state: FeedSyncState,
        page: dict[str, Any],
    ) -> None:
        has_more = page.get("has_more")
        cursor = page.get("next_cursor")
        if not isinstance(has_more, bool):
            logging.warning("Rejected feed page metadata from %s: invalid has_more", peer_id)
            self._finish_feed_sync(peer_id, state)
            return
        if cursor is not None and (
            not isinstance(cursor, dict)
            or not isinstance(cursor.get("created_at"), str)
            or not isinstance(cursor.get("object_id"), str)
            or (cursor["object_id"] and not HEX_SHA256.fullmatch(cursor["object_id"]))
            or parse_time(cursor["created_at"]) is None
        ):
            logging.warning("Rejected feed page metadata from %s: invalid next_cursor", peer_id)
            self._finish_feed_sync(peer_id, state)
            return
        state.pages += 1
        advanced = cursor is not None and self._feed_cursor_advances(cursor, state.cursor)
        if advanced:
            state.cursor = {
                "created_at": cursor["created_at"],
                "object_id": cursor["object_id"],
            }
            self.store.set_feed_cursor(peer_id, state.cursor)
        logging.info(
            "Feed sync page from %s: page=%d received=%d stored=%d rejected=%d duplicates=%d has_more=%s",
            peer_id,
            state.pages,
            state.received,
            state.stored,
            state.rejected,
            state.duplicates,
            has_more,
        )
        if not has_more:
            logging.info(
                "Feed sync completed with %s: pages=%d received=%d stored=%d rejected=%d duplicates=%d",
                peer_id,
                state.pages,
                state.received,
                state.stored,
                state.rejected,
                state.duplicates,
            )
            self._finish_feed_sync(peer_id, state)
        elif not advanced:
            logging.warning("Feed sync stopped for %s: page cursor did not advance", peer_id)
            self._finish_feed_sync(peer_id, state)
        elif state.pages >= FEED_SYNC_MAX_PAGES:
            logging.info(
                "Feed sync paused with %s after %d pages; more objects are available for the next connection",
                peer_id,
                state.pages,
            )
            self._finish_feed_sync(peer_id, state)
        else:
            await self._send_feed_sync_page(peer_id, state)

    @staticmethod
    def _feed_cursor_advances(next_cursor: dict[str, str], current: dict[str, str]) -> bool:
        next_time = parse_time(next_cursor.get("created_at"))
        current_time = parse_time(current.get("created_at"))
        if next_time is None or current_time is None:
            return False
        return next_time > current_time or (
            next_time == current_time and next_cursor["object_id"] > current["object_id"]
        )

    def _finish_feed_sync(self, peer_id: str, state: FeedSyncState) -> None:
        if self.feed_syncs.get(peer_id) is state:
            self.feed_syncs.pop(peer_id, None)
        self._cancel_feed_sync_timer(state)

    @staticmethod
    def _cancel_feed_sync_timer(state: FeedSyncState) -> None:
        if state.timer and state.timer is not asyncio.current_task():
            state.timer.cancel()
        state.timer = None

    async def on_link_open(self, peer_id: str) -> None:
        previous_sync = self.feed_syncs.pop(peer_id, None)
        if previous_sync:
            self._cancel_feed_sync_timer(previous_sync)
        self.feed_sync_started.discard(peer_id)
        self.authenticated.discard(peer_id)
        self.remote_keys.pop(peer_id, None)
        await self.send_packet(peer_id, "HELLO", {
            "nodeId": self.identity.node_id,
            "nickname": "bootstrap-peer",
            "softwareVersion": "mycelium-python-peer/0.1",
            "protocolVersion": 1,
            "capabilities": ["profiles", "posts", "relay-v1"],
        })
        await self.send_packet(peer_id, "PROFILE_REQUEST", {})
        await self._send_profile(peer_id, "PROFILE_UPDATE")
        link = self.links.get(peer_id)
        if link:
            link.start_liveness()
        logging.info("Data channel opened with %s", peer_id)

    async def _send_profile(self, peer_id: str, packet_type: str) -> None:
        await self.send_packet(peer_id, packet_type, {
            "profile": {
                "author": self.identity.node_id,
                "publicKey": self.identity.public_key,
                "displayName": self.display_name,
                "following": self.store.is_following(peer_id),
                "timestamp": utc_now(),
            },
        })

    async def receive_object_from(
        self,
        peer_id: str,
        value: Any,
    ) -> Literal["stored", "duplicate", "rejected"]:
        if not isinstance(value, dict):
            logging.debug("Rejected object from %s: object is not a JSON object", peer_id)
            return "rejected"
        if not self._object_within_limit(value):
            logging.info("Rejected object from %s: object exceeds the size limit or is not JSON-safe", peer_id)
            return "rejected"
        if value.get("object_type") == "mycelium.delete-request":
            accepted = await self._accept_delete_request(value)
        else:
            if not validate_object(value):
                logging.info(
                    "Rejected object from %s: validation failed (shape, object ID, or signature)",
                    peer_id,
                )
                return "rejected"
            accepted = self.store.put_object(value)
        is_post = value.get("object_type") == "mycelium.post"
        if not accepted and not is_post:
            if value.get("object_type") == "mycelium.delete-request":
                logging.info("Rejected delete request from %s: invalid, unauthorized, expired, or duplicate", peer_id)
            else:
                target = value.get("object_id")
                payload = value.get("payload")
                parent_id = payload.get("reply_to") if isinstance(payload, dict) else None
                if (isinstance(target, str) and self.store.is_tombstoned(target)) or (
                    isinstance(parent_id, str) and self.store.is_tombstoned(parent_id)
                ):
                    logging.info("Rejected object from %s: object or parent is tombstoned", peer_id)
                    return "rejected"
                logging.debug("Object already stored on peer %s: %s", peer_id, target)
            return "rejected" if value.get("object_type") == "mycelium.delete-request" else "duplicate"
        if accepted:
            logging.info("Stored validated object %s", value["object_id"])
        objects_to_replicate: list[dict[str, Any]]
        if is_post and validate_object(value) and not object_expired(value):
            chain, newly_cached = await self._collect_post_chain(value, accepted)
            if accepted:
                objects_to_replicate = chain
            else:
                objects_to_replicate = [
                    item for item in chain
                    if item["object_id"] != value["object_id"]
                    and item["object_id"] in newly_cached
                ]
        elif accepted:
            objects_to_replicate = [value]
        else:
            objects_to_replicate = []

        for item in objects_to_replicate:
            source = self.find_sources.pop(item["object_id"], peer_id if item is value else None)
            await self._replicate_object(item, source)
        return "stored" if accepted else "duplicate"

    async def _collect_post_chain(
        self,
        original: dict[str, Any],
        original_newly_cached: bool,
    ) -> tuple[list[dict[str, Any]], set[str]]:
        newest_first = [original]
        newly_cached = {original["object_id"]} if original_newly_cached else set()
        visited = {original["object_id"]}
        current = original
        for _ in range(MAX_POST_ANCESTRY_DEPTH):
            payload = current.get("payload")
            if not isinstance(payload, dict) or "reply_to" not in payload:
                break
            parent_id = payload["reply_to"]
            if not isinstance(parent_id, str) or not HEX_SHA256.fullmatch(parent_id):
                logging.debug("Post %s has an invalid reply_to ID", current["object_id"])
                break
            if parent_id in visited:
                logging.debug("Post ancestry cycle at %s", parent_id)
                break
            visited.add(parent_id)
            parent = self.store.get_object(parent_id)
            if (not parent or parent.get("object_type") != "mycelium.post"
                    or not validate_object(parent) or object_expired(parent)):
                parent = await self._find_post_parent(parent_id)
            if (not parent or parent.get("object_id") != parent_id
                    or parent.get("object_type") != "mycelium.post"
                    or not validate_object(parent) or object_expired(parent)
                    or self.store.is_tombstoned(parent_id)):
                break
            if self.store.put_object(parent) or parent_id in self.find_newly_cached:
                newly_cached.add(parent_id)
            self.find_newly_cached.discard(parent_id)
            newest_first.append(parent)
            current = parent
        return list(reversed(newest_first)), newly_cached

    async def _find_post_parent(self, object_id: str) -> dict[str, Any] | None:
        if self.store.is_tombstoned(object_id):
            return None
        cached = self.store.get_object(object_id)
        if cached:
            return cached if cached.get("object_type") == "mycelium.post" and validate_object(cached) else None
        now = time.monotonic()
        previous = self.parent_lookup_cache.get(object_id)
        if previous and now - previous[0] < 10:
            return await previous[1]
        task = asyncio.create_task(self._fetch_post_parent(object_id))
        self.parent_lookup_cache[object_id] = (now, task)
        while len(self.parent_lookup_cache) > 256:
            oldest = min(self.parent_lookup_cache, key=lambda key: self.parent_lookup_cache[key][0])
            self.parent_lookup_cache.pop(oldest, None)
        return await task

    async def _fetch_post_parent(self, object_id: str) -> dict[str, Any] | None:
        for peer_id in self.connected_peers()[:4]:
            if len(self.parent_lookups) + len(self.find_states) >= MAX_FIND_IN_FLIGHT:
                return None
            find_window = self.find_rate_windows.setdefault(peer_id, deque())
            now_monotonic = time.monotonic()
            while find_window and now_monotonic - find_window[0] > 60:
                find_window.popleft()
            if len(find_window) >= MAX_FIND_PER_PEER_PER_MINUTE:
                continue
            find_window.append(now_monotonic)
            request_id = str(uuid.uuid4())
            expires_at = time.time() + FIND_LIFETIME_SECONDS
            future: asyncio.Future[dict[str, Any] | None] = asyncio.get_running_loop().create_future()
            lookup = ParentLookup(request_id, peer_id, object_id, expires_at, future)
            self.parent_lookups[request_id] = lookup
            expires_text = datetime.fromtimestamp(expires_at, timezone.utc).isoformat(
                timespec="milliseconds"
            ).replace("+00:00", "Z")
            try:
                await self.send_packet(peer_id, "FIND", {
                    "requested_objects": [object_id],
                    "object_id": object_id,
                    "requestId": request_id,
                    "ttl": 2,
                    "expiresAt": expires_text,
                    "origin": self.identity.node_id,
                })
                result = await asyncio.wait_for(future, FIND_LIFETIME_SECONDS)
                if result and result.get("object_type") == "mycelium.post":
                    self.find_sources[object_id] = peer_id
                    return result
            except (ConnectionError, ValueError, asyncio.TimeoutError):
                logging.debug("Post-parent FIND via %s failed for %s", peer_id, object_id)
            finally:
                self.parent_lookups.pop(request_id, None)
                if not future.done():
                    future.cancel()
        return None

    async def _replicate_object(self, value: dict[str, Any], source_peer: str | None) -> None:
        raw_policy = value.get("replication_policy")
        policy = raw_policy if isinstance(raw_policy, dict) else {}
        raw_budget = policy.get("replication_budget", REPLICATION_BUDGET)
        budget = int(raw_budget) if is_safe_integer(raw_budget) else REPLICATION_BUDGET
        targets = [peer for peer in self.connected_peers() if peer != source_peer]
        for target in targets[:max(0, min(64, budget) - 1)]:
            try:
                await self.send_packet(target, "OBJECT_STORE", {"object": value})
            except (ConnectionError, ValueError):
                continue

    @staticmethod
    def _object_within_limit(value: Any) -> bool:
        if not isinstance(value, dict):
            return False
        try:
            encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            return len(encoded.encode("utf-8")) <= MAX_OBJECT_BYTES
        except (TypeError, ValueError, RecursionError, UnicodeEncodeError):
            return False

    def _fail_parent_lookups(self, peer_id: str | None = None) -> None:
        for lookup in self.parent_lookups.values():
            if (peer_id is None or lookup.peer_id == peer_id) and not lookup.future.done():
                lookup.future.set_result(None)

    async def _accept_delete_request(self, request: dict[str, Any]) -> bool:
        if not validate_object(request) or request.get("object_type") != "mycelium.delete-request":
            return False
        created = parse_time(request.get("created_at"))
        expires = parse_time(request.get("expires_at"))
        now = time.time()
        if (created is None or expires is None or expires <= created
                or expires > created + 3 * 24 * 60 * 60 or expires <= now):
            return False
        payload = request.get("payload")
        if not isinstance(payload, dict):
            return False
        target_id = payload.get("target_object_id")
        target_type = payload.get("target_object_type")
        target_author = payload.get("target_author")
        target_created = payload.get("target_created_at")
        if (payload.get("command") != "delete" or not isinstance(target_id, str)
                or not HEX_SHA256.fullmatch(target_id)
                or target_type not in ("mycelium.post", "mycelium.dm")
                or target_author != request.get("author")
                or not isinstance(target_created, str)
                or parse_time(target_created) is None):
            return False
        recipient = payload.get("target_recipient")
        if ((target_type == "mycelium.dm" and (not isinstance(recipient, str) or not recipient))
                or (target_type == "mycelium.post" and recipient is not None)):
            return False
        version = payload.get("target_object_id_version")
        content_hash = payload.get("target_content_hash")
        target_proof = payload.get("target_author_proof")
        if version is not None and version not in (2, 3):
            return False
        if version in (2, 3) and content_hash is None:
            return False
        if (content_hash is None) != (target_proof is None):
            return False
        authorized = False
        if content_hash is not None or target_proof is not None:
            if (not isinstance(content_hash, str) or not HEX_SHA256.fullmatch(content_hash)
                    or not isinstance(target_proof, str) or not target_proof):
                return False
            if version == 3:
                proof = {
                    "domain": "mycelium.object-signature.v3",
                    "object_id": target_id,
                    "content_hash": content_hash,
                }
                authorized = verify_signature(
                    target_author,
                    _canonicalize_v3(proof),
                    target_proof,
                )
            elif version in (None, 2):
                expected_id = hashlib.sha256(canonicalize({
                    "domain": "mycelium.object-id.v2",
                    "author": target_author,
                    "content_hash": content_hash,
                }).encode("utf-8")).hexdigest()
                proof = canonicalize({
                    "domain": "mycelium.object-author-proof.v2",
                    "author": target_author,
                    "content_hash": content_hash,
                })
                authorized = expected_id == target_id and verify_signature(target_author, proof, target_proof)
            else:
                return False
        else:
            target = self.store.get_object(target_id)
            authorized = bool(
                target
                and target.get("object_type") == target_type
                and target.get("author") == request["author"]
                and target.get("created_at") == target_created
                and target.get("recipient") == recipient
            )
        if not authorized:
            return False
        return self.store.apply_tombstone({
            "target_object_id": target_id,
            "target_object_type": target_type,
            "target_author": target_author,
            "target_created_at": target_created,
            **({"target_recipient": recipient} if recipient is not None else {}),
            "delete_request_id": request["object_id"],
            "deleted_at": utc_now(),
        }, request)

    async def _handle_find(self, peer_id: str, packet: dict[str, Any]) -> None:
        if len(self.find_states) + len(self.parent_lookups) >= MAX_FIND_IN_FLIGHT:
            return
        find_window = self.find_rate_windows.setdefault(peer_id, deque())
        now_monotonic = time.monotonic()
        while find_window and now_monotonic - find_window[0] > 60:
            find_window.popleft()
        if len(find_window) >= MAX_FIND_PER_PEER_PER_MINUTE:
            logging.warning("FIND rate limit reached for peer %s", peer_id)
            return
        find_window.append(now_monotonic)
        payload = packet["payload"]
        request_id = payload.get("requestId")
        ttl = payload.get("ttl")
        expires = parse_time(payload.get("expiresAt"))
        ids = payload.get("requested_objects")
        if ids is None and isinstance(payload.get("object_id"), str):
            ids = [payload["object_id"]]
        if (not isinstance(request_id, str) or not request_id or len(request_id) > 128
                or not is_safe_integer(ttl) or ttl < 0 or ttl > FIND_MAX_TTL
                or expires is None or expires <= time.time()
                or expires > time.time() + FIND_LIFETIME_SECONDS + 2
                or not isinstance(ids, list) or len(ids) > FIND_MAX_IDS
                or any(not isinstance(item, str) or not HEX_SHA256.fullmatch(item) for item in ids)):
            return
        self._prune_request_cache()
        if request_id in self.seen_requests or request_id in self.find_states:
            return
        if len(self.seen_requests) >= MAX_PACKET_CACHE:
            oldest = min(self.seen_requests, key=self.seen_requests.get)
            self.seen_requests.pop(oldest, None)
        self.seen_requests[request_id] = expires

        query = self._find_query(payload)
        if query is False:
            return
        query_value = query if isinstance(query, dict) else None
        object_ids = set(ids)
        if query_value is not None:
            local_objects, local_has_more = self.store.query_objects(
                query_value, query_value.get("limit", FIND_MAX_QUERY)
            )
            local_objects = [obj for obj in local_objects if validate_object(obj)]
        else:
            local_objects = []
            for object_id in object_ids:
                if self.store.is_tombstoned(object_id):
                    continue
                obj = self.store.get_object(object_id)
                if obj is not None and validate_object(obj):
                    local_objects.append(obj)
            local_has_more = False

        state = FindState(
            request_id=request_id,
            upstream=peer_id,
            expires_at=expires,
            origin=payload.get("origin") if isinstance(payload.get("origin"), str) else packet["sender"],
            response_object_id=ids[0] if query_value is None and len(ids) == 1 else "",
            object_ids=object_ids,
            query=query_value,
            objects={obj["object_id"]: obj for obj in local_objects},
            has_more=local_has_more,
        )
        self.find_states[request_id] = state
        should_forward = ttl > 0 and (
            query_value is not None or any(object_id not in state.objects for object_id in object_ids)
        )
        children = [
            candidate for candidate in self.connected_peers()
            if candidate != peer_id
        ][:FIND_FANOUT] if should_forward else []
        if query_value and query_value.get("order") == "created_at_desc":
            local_objects.sort(
                key=lambda obj: (parse_time(obj["created_at"]) or 0, obj["object_id"]),
                reverse=True,
            )
            state.objects = {obj["object_id"]: obj for obj in local_objects}
        state.pending_children.update(children)
        if children:
            state.timer = asyncio.create_task(self._expire_find(state))
            for child in children:
                forwarded = new_packet(self.identity.node_id, child, "FIND", {
                    **{
                        key: value for key, value in payload.items()
                        if key in {
                            "requested_objects", "object_id", "requestId", "expiresAt",
                            "origin", "object_type", "author", "recipient",
                            "created_after", "created_before", "page_before", "since",
                            "limit", "order",
                        }
                    },
                    "ttl": ttl - 1,
                })
                try:
                    await self.send(child, forwarded)
                except (ConnectionError, ValueError):
                    state.pending_children.discard(child)
                    state.failed_children.add(child)
            if state.pending_children:
                return
        complete = not state.failed_children and not (
            ttl == 0 and query_value is None and len(ids) == 1 and not local_objects
        )
        await self._complete_find(state, complete=complete)

    def _find_query(self, payload: dict[str, Any]) -> dict[str, Any] | None | bool:
        keys = (
            "object_type", "author", "recipient", "created_after",
            "created_before", "page_before", "since", "limit", "order",
        )
        if not any(key in payload for key in keys):
            return None
        query: dict[str, Any] = {}
        for key in ("object_type", "author"):
            if key in payload:
                if not isinstance(payload[key], str) or not payload[key]:
                    return False
                query[key] = payload[key]
        if "recipient" in payload:
            if not isinstance(payload["recipient"], str) or not payload["recipient"].strip():
                return False
            query["recipient"] = payload["recipient"]
        for key in ("created_after", "created_before", "since"):
            if key in payload:
                if parse_time(payload[key]) is None:
                    return False
                query[key] = payload[key]
        if "page_before" in payload:
            cursor = payload["page_before"]
            if (not isinstance(cursor, dict) or parse_time(cursor.get("created_at")) is None
                    or not isinstance(cursor.get("object_id"), str)
                    or not HEX_SHA256.fullmatch(cursor["object_id"])):
                return False
            query["page_before"] = cursor
        if "limit" in payload:
            limit = payload["limit"]
            query["limit"] = (
                min(int(limit), FIND_MAX_QUERY)
                if is_safe_integer(limit) and limit > 0 else FIND_MAX_QUERY
            )
        else:
            query["limit"] = FIND_MAX_QUERY
        if "order" in payload:
            if payload["order"] != "created_at_desc":
                return False
            query["order"] = payload["order"]
        return query

    async def _handle_find_response(self, peer_id: str, packet: dict[str, Any]) -> None:
        payload = packet["payload"]
        request_id = payload.get("requestId")
        if not isinstance(request_id, str):
            return
        lookup = self.parent_lookups.get(request_id)
        if lookup:
            if peer_id != lookup.peer_id or time.time() >= lookup.expires_at:
                return
            candidates = payload.get("objects")
            if not isinstance(candidates, list) or not candidates:
                candidate = payload.get("object")
                candidates = [candidate] if isinstance(candidate, dict) else []
            for candidate in candidates:
                if (not isinstance(candidate, dict)
                        or candidate.get("object_id") != lookup.object_id
                        or not self._object_within_limit(candidate)
                        or not validate_object(candidate)
                        or object_expired(candidate)
                        or self.store.is_tombstoned(lookup.object_id)):
                    continue
                if candidate.get("object_type") == "mycelium.delete-request":
                    if await self._accept_delete_request(candidate):
                        await self._replicate_object(candidate, peer_id)
                    if not lookup.future.done():
                        lookup.future.set_result(None)
                    return
                if candidate.get("object_type") != "mycelium.post":
                    continue
                if self.store.put_object(candidate):
                    self.find_newly_cached.add(lookup.object_id)
                    if len(self.find_newly_cached) > 256:
                        self.find_newly_cached.pop()
                self.find_sources[lookup.object_id] = peer_id
                if len(self.find_sources) > 256:
                    self.find_sources.pop(next(iter(self.find_sources)))
                if not lookup.future.done():
                    lookup.future.set_result(candidate)
                return
            if payload.get("object_id") == lookup.object_id and not lookup.future.done():
                lookup.future.set_result(None)
            return
        state = self.find_states.get(request_id)
        if not state or peer_id not in state.pending_children or time.time() >= state.expires_at:
            return
        candidates = payload.get("objects")
        if not isinstance(candidates, list) or not candidates:
            candidate = payload.get("object")
            candidates = [candidate] if isinstance(candidate, dict) else []
        for candidate in candidates:
            if not self._object_within_limit(candidate) or not validate_object(candidate):
                continue
            object_id = candidate["object_id"]
            if state.object_ids and object_id not in state.object_ids:
                continue
            if self.store.is_tombstoned(object_id):
                continue
            if state.query and not self._matches_find_query(candidate, state.query):
                continue
            state.objects.setdefault(object_id, candidate)
            if candidate.get("object_type") == "mycelium.delete-request":
                if await self._accept_delete_request(candidate):
                    await self._replicate_object(candidate, peer_id)
            elif not self.store.is_tombstoned(object_id):
                self.store.put_object(candidate)
        state.has_more |= payload.get("has_more") is True
        requires_pagination = bool(
            state.query
            and state.query.get("order") == "created_at_desc"
            and state.query.get("limit") is not None
        )
        if requires_pagination and payload.get("pagination_supported") is not True:
            state.children_pagination_supported = False
        if payload.get("complete") is not True:
            state.failed_children.add(peer_id)
        state.pending_children.discard(peer_id)
        state.responded_children.add(peer_id)
        if self._find_is_satisfied(state) or not state.pending_children:
            await self._complete_find(
                state,
                complete=(
                    self._find_is_satisfied(state)
                    or (
                        not state.pending_children
                        and not state.failed_children
                        and (
                            not requires_pagination
                            or state.children_pagination_supported
                        )
                    )
                ),
            )

    def _matches_find_query(self, value: dict[str, Any], query: dict[str, Any]) -> bool:
        if query.get("object_type") and value.get("object_type") != query["object_type"]:
            return False
        if query.get("author") and value.get("author") != query["author"]:
            return False
        if "recipient" in query and value.get("recipient") != query["recipient"]:
            return False
        created = parse_time(value.get("created_at"))
        if created is None:
            return False
        if "created_after" in query and created < parse_time(query["created_after"]):
            return False
        if "created_before" in query and created > parse_time(query["created_before"]):
            return False
        if "since" in query and created <= parse_time(query["since"]):
            return False
        cursor = query.get("page_before")
        if cursor:
            cursor_time = parse_time(cursor["created_at"])
            if created > cursor_time or (
                created == cursor_time and value["object_id"] >= cursor["object_id"]
            ):
                return False
        return True

    def _find_is_satisfied(self, state: FindState) -> bool:
        if state.query is not None:
            return False
        return bool(state.object_ids) and state.object_ids.issubset(state.objects)

    async def _expire_find(self, state: FindState) -> None:
        await asyncio.sleep(max(0, state.expires_at - time.time()))
        if self.find_states.get(state.request_id) is state:
            await self._complete_find(state, complete=False)

    async def _complete_find(self, state: FindState, complete: bool) -> None:
        if self.find_states.get(state.request_id) is not state:
            return
        self.find_states.pop(state.request_id, None)
        if state.timer and state.timer is not asyncio.current_task():
            state.timer.cancel()
        objects = list(state.objects.values())
        if state.query and state.query.get("order") == "created_at_desc":
            objects.sort(
                key=lambda obj: (parse_time(obj["created_at"]) or 0, obj["object_id"]),
                reverse=True,
            )
        limit = state.query.get("limit", FIND_MAX_QUERY) if state.query else None
        overflow = limit is not None and len(objects) > limit
        if limit is not None:
            objects = objects[:limit]
        await self._send_find_response(
            state.upstream,
            state.request_id,
            state.origin,
            state.expires_at,
            objects,
            complete,
            response_object_id=state.response_object_id,
            pagination_supported=(
                state.children_pagination_supported
                if state.query and state.query.get("order") == "created_at_desc" else None
            ),
            has_more=state.has_more or overflow if state.query else None,
        )

    async def _send_find_response(
        self,
        peer_id: str,
        request_id: str,
        origin: str,
        expires: float,
        objects: list[dict[str, Any]],
        complete: bool,
        response_object_id: str = "",
        pagination_supported: bool | None = None,
        has_more: bool | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "objects": objects,
            "object_id": response_object_id or (objects[0]["object_id"] if objects else ""),
            "requestId": request_id,
            "complete": complete,
            "origin": origin,
            "expiresAt": datetime.fromtimestamp(expires, timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        if len(objects) == 1:
            payload["object"] = objects[0]
        if pagination_supported is not None:
            payload["pagination_supported"] = pagination_supported
        if has_more is not None:
            payload["has_more"] = has_more
        while objects:
            candidate = new_packet(self.identity.node_id, peer_id, "FIND_RESPONSE", payload)
            if len(json.dumps(candidate, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) <= MAX_FIND_RESPONSE_BYTES - 256:
                break
            objects.pop()
            payload["objects"] = objects
            if has_more is not None:
                payload["has_more"] = True
            else:
                payload["complete"] = False
        try:
            await self.send_packet(peer_id, "FIND_RESPONSE", payload)
        except (ConnectionError, ValueError):
            pass

    def _prune_request_cache(self) -> None:
        now = time.time()
        self.seen_requests = {
            request_id: expiry for request_id, expiry in self.seen_requests.items()
            if expiry > now
        }

    def handle_peer_list(self, peers: Any) -> None:
        if not isinstance(peers, list):
            return
        online = {
            peer for peer in peers
            if isinstance(peer, str) and PEER_ID_PATTERN.fullmatch(peer)
            and peer != self.identity.node_id
        }
        online = set(sorted(online)[:512])
        self.online_peers = online
        for peer_id in online:
            self.store.add_peer(peer_id, time.time())

    async def maintain_connections(self) -> None:
        candidates = list(dict.fromkeys(
            list(self.online_peers) + self.store.known_peers() + list(self.pool_peers)
        ))
        candidate_ids = set(candidates)
        self.attempts = {
            peer_id: attempt for peer_id, attempt in self.attempts.items()
            if peer_id in candidate_ids
        }
        connected_or_connecting = {
            peer_id for peer_id, link in self.links.items()
            if not link.closed
        }
        slots = max(0, self.max_peers - len(connected_or_connecting))
        candidates = sorted(
            peer_id for peer_id in candidates
            if peer_id != self.identity.node_id and peer_id not in connected_or_connecting
        )
        if candidates:
            rotation = self._candidate_rotation % len(candidates)
            candidates = candidates[rotation:] + candidates[:rotation]
            self._candidate_rotation = (rotation + max(1, slots)) % len(candidates)
        for peer_id in candidates:
            if slots <= 0:
                break
            if self.identity.node_id > peer_id:
                continue
            count, next_attempt = self.attempts.get(peer_id, (0, 0))
            if time.monotonic() < next_attempt:
                continue
            try:
                await self._create_offer(peer_id)
                self.attempts[peer_id] = (count + 1, time.monotonic() + min(300, 2 ** min(count, 8)))
                slots -= 1
            except Exception as error:
                self.attempts[peer_id] = (count + 1, time.monotonic() + min(300, 2 ** min(count, 8)))
                logging.warning("Could not start connection to %s: %s", peer_id, error)

    async def _create_offer(self, peer_id: str) -> None:
        from aiortc import RTCConfiguration, RTCPeerConnection

        config = _ice_configuration()
        pc = RTCPeerConnection(RTCConfiguration(iceServers=config))
        link = PeerLink(self, peer_id, pc, outgoing=True)
        self.links[peer_id] = link
        try:
            link.channel = pc.createDataChannel("chat")
            link.bind_channel(link.channel)
            offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            await self._send_signal({
                "type": "offer",
                "from": self.identity.node_id,
                "to": peer_id,
                "payload": {
                    "type": pc.localDescription.type,
                    "sdp": pc.localDescription.sdp,
                    "negotiationId": link.negotiation_id,
                },
            })
        except Exception:
            await link.close()
            raise

    async def _send_signal(self, message: dict[str, Any]) -> None:
        socket = self.signalling
        if socket is None:
            raise ConnectionError("signalling is unavailable")
        await socket.send(json.dumps(message, separators=(",", ":")))

    async def handle_signal(self, message: Any) -> None:
        if not isinstance(message, dict):
            return
        sender = message.get("from")
        if (not isinstance(sender, str) or not PEER_ID_PATTERN.fullmatch(sender)
                or sender == self.identity.node_id or message.get("to") != self.identity.node_id):
            return
        kind = message.get("type")
        if kind not in ("offer", "answer", "ice-candidate"):
            return
        payload = message.get("payload")
        if not isinstance(payload, dict):
            return
        try:
            if len(json.dumps(message, separators=(",", ":")).encode("utf-8")) > MAX_PACKET_BYTES:
                return
        except (TypeError, ValueError, RecursionError, UnicodeEncodeError):
            return
        self.store.add_peer(sender, time.time())
        link = self.links.get(sender)
        if kind == "offer":
            if (link is None or link.closed) and sum(
                not existing.closed for existing in self.links.values()
            ) >= self.max_peers:
                logging.info("Ignoring incoming offer from %s: peer limit reached", sender)
                return
            if link and link.outgoing and link.negotiation_id:
                # The browser's deterministic ID election makes this uncommon. Yield
                # safely rather than applying simultaneous offers to one connection.
                await link.close()
                link = None
            if link is None or link.closed:
                link = await self._new_incoming_link(sender)
            try:
                await link.handle_signal(kind, payload)
            except Exception as error:
                logging.warning("Rejected signalling offer from %s: %s", sender, error)
                await link.close()
        elif link:
            try:
                await link.handle_signal(kind, payload)
            except Exception as error:
                logging.warning("Rejected signalling packet from %s: %s", sender, error)
                await link.close()

    async def _new_incoming_link(self, peer_id: str) -> PeerLink:
        from aiortc import RTCConfiguration, RTCPeerConnection

        pc = RTCPeerConnection(RTCConfiguration(iceServers=_ice_configuration()))
        link = PeerLink(self, peer_id, pc, outgoing=False)
        self.links[peer_id] = link
        return link

    async def _handle_discovery_packet(self, packet: Any) -> None:
        if not validate_packet_shape(packet):
            return
        if packet.get("type") == "PEER_POOL_RESULT":
            peers = packet["payload"].get("peers")
            if isinstance(peers, list):
                candidates = {
                    peer for peer in peers
                    if isinstance(peer, str) and PEER_ID_PATTERN.fullmatch(peer)
                    and peer != self.identity.node_id
                }
                self.pool_peers = set(sorted(candidates)[:512])

    async def run(self, signal_url: str) -> None:
        delay = 1.0
        while not self.stopping:
            try:
                logging.info("Connecting to signalling service %s", signal_url)
                async with websockets.connect(
                    signal_url,
                    max_size=MAX_PACKET_BYTES,
                    ping_interval=20,
                    ping_timeout=20,
                    close_timeout=5,
                ) as socket:
                    self.signalling = socket
                    await socket.send(json.dumps({"type": "register", "id": self.identity.node_id}))
                    delay = 1.0
                    maintenance = asyncio.create_task(self._maintenance_loop())
                    pool_refresh = asyncio.create_task(self._peer_pool_loop())
                    try:
                        async for raw in socket:
                            if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_PACKET_BYTES:
                                continue
                            try:
                                message = json.loads(raw)
                            except (json.JSONDecodeError, UnicodeError, RecursionError):
                                continue
                            if isinstance(message, dict) and message.get("type") == "peer-list":
                                self.handle_peer_list(message.get("peers"))
                            elif isinstance(message, dict) and message.get("type") in (
                                "offer", "answer", "ice-candidate",
                            ):
                                await self.handle_signal(message)
                            else:
                                await self._handle_discovery_packet(message)
                    finally:
                        self.signalling = None
                        maintenance.cancel()
                        pool_refresh.cancel()
                        await asyncio.gather(maintenance, pool_refresh, return_exceptions=True)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                if not self.stopping:
                    logging.warning("Signalling unavailable: %s", error)
            if self.stopping:
                break
            await asyncio.sleep(delay)
            delay = min(60.0, delay * 2)

    async def _maintenance_loop(self) -> None:
        while True:
            await self.maintain_connections()
            await asyncio.sleep(5)

    async def _peer_pool_loop(self) -> None:
        while True:
            await asyncio.sleep(60)
            if self.signalling:
                packet = sign_packet(self.identity, new_packet(
                    self.identity.node_id, "discovery-server", "PEER_POOL_GET", {}
                ))
                try:
                    await self.signalling.send(json.dumps(packet, separators=(",", ":")))
                except Exception as error:
                    logging.warning("Peer-pool request failed: %s", error)

    async def close(self) -> None:
        self.stopping = True
        self._fail_parent_lookups()
        for peer_id, state in list(self.feed_syncs.items()):
            self._finish_feed_sync(peer_id, state)
        self.feed_sync_started.clear()
        lookup_tasks = [task for _, task in self.parent_lookup_cache.values()]
        self.parent_lookup_cache.clear()
        for task in lookup_tasks:
            task.cancel()
        if lookup_tasks:
            await asyncio.gather(*lookup_tasks, return_exceptions=True)
        for state in list(self.find_states.values()):
            if state.timer:
                state.timer.cancel()
        links = list(self.links.values())
        await asyncio.gather(*(
            link.close() for link in links if callable(getattr(link, "close", None))
        ), return_exceptions=True)
        tasks = list(self.packet_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


class PeerLink:
    def __init__(self, node: PeerNode, peer_id: str, pc: Any, outgoing: bool):
        self.node = node
        self.peer_id = peer_id
        self.pc = pc
        self.outgoing = outgoing
        self.channel: Any = None
        self.negotiation_id = str(uuid.uuid4())
        self.closed = False
        self.open_handled = False
        self.candidate_queue: list[tuple[str, int | None, str]] = []
        self.signal_lock = asyncio.Lock()
        self.pending_ping: tuple[str, float] | None = None
        self.liveness_task: asyncio.Task[None] | None = None
        self.disconnect_task: asyncio.Task[None] | None = None
        self.connection_deadline = asyncio.create_task(self._connection_deadline())
        self.pc.on("datachannel", self._on_datachannel)
        self.pc.on("connectionstatechange", self._on_connection_state)

    @property
    def is_open(self) -> bool:
        return bool(self.channel and self.channel.readyState == "open" and not self.closed)

    def _on_datachannel(self, channel: Any) -> None:
        self.channel = channel
        self.bind_channel(channel)

    def bind_channel(self, channel: Any) -> None:
        self.channel = channel
        channel.on("open", self._on_open)
        channel.on(
            "message",
            lambda message: self.node.spawn_packet_task(self.peer_id, message, self),
        )
        channel.on("close", lambda: asyncio.create_task(self.close()))
        if channel.readyState == "open":
            self._on_open()

    def _on_open(self) -> None:
        if self.open_handled:
            return
        self.open_handled = True
        if self.connection_deadline:
            self.connection_deadline.cancel()
        asyncio.create_task(self.node.on_link_open(self.peer_id))

    def start_liveness(self) -> None:
        if self.liveness_task is None or self.liveness_task.done():
            self.liveness_task = asyncio.create_task(self._liveness_loop())

    def record_pong(self, ping_id: Any) -> None:
        if self.pending_ping and ping_id == self.pending_ping[0]:
            self.pending_ping = None

    async def _connection_deadline(self) -> None:
        await asyncio.sleep(45)
        if not self.is_open:
            logging.info("Connection to %s timed out before opening", self.peer_id)
            await self.close()

    async def _liveness_loop(self) -> None:
        await asyncio.sleep(15)
        if self.peer_id not in self.node.authenticated:
            logging.warning("Peer %s did not authenticate before deadline", self.peer_id)
            await self.close()
            return
        while self.is_open:
            await asyncio.sleep(30)
            if not self.is_open:
                return
            if self.pending_ping:
                if time.monotonic() - self.pending_ping[1] >= 60:
                    logging.warning("Peer %s did not answer PING", self.peer_id)
                    await self.close()
                    return
                continue
            ping_id = str(uuid.uuid4())
            self.pending_ping = (ping_id, time.monotonic())
            try:
                await self.node.send_packet(self.peer_id, "PING", {
                    "pingId": ping_id,
                    "sentAt": utc_now(),
                })
            except (ConnectionError, ValueError):
                await self.close()
                return

    async def handle_signal(self, kind: str, payload: dict[str, Any]) -> None:
        async with self.signal_lock:
            from aiortc import RTCSessionDescription

            negotiation_id = payload.get("negotiationId")
            if not isinstance(negotiation_id, str) or len(negotiation_id) > 128:
                return
            if kind == "offer":
                self.negotiation_id = negotiation_id
                sdp, session_type = payload.get("sdp"), payload.get("type")
                if not isinstance(sdp, str) or len(sdp) > 100_000 or session_type != "offer":
                    return
                await self.pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="offer"))
                await self._flush_candidates()
                answer = await self.pc.createAnswer()
                await self.pc.setLocalDescription(answer)
                await self.node._send_signal({
                    "type": "answer",
                    "from": self.node.identity.node_id,
                    "to": self.peer_id,
                    "payload": {
                        "type": self.pc.localDescription.type,
                        "sdp": self.pc.localDescription.sdp,
                        "negotiationId": self.negotiation_id,
                    },
                })
            elif kind == "answer":
                if negotiation_id != self.negotiation_id:
                    return
                sdp, session_type = payload.get("sdp"), payload.get("type")
                if not isinstance(sdp, str) or len(sdp) > 100_000 or session_type != "answer":
                    return
                await self.pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="answer"))
                await self._flush_candidates()
            elif kind == "ice-candidate":
                if negotiation_id != self.negotiation_id:
                    return
                candidate_value = payload.get("candidate")
                if candidate_value is None:
                    await self._flush_candidates(end=True)
                    return
                if not isinstance(candidate_value, dict):
                    return
                candidate_sdp = candidate_value.get("candidate")
                mid = candidate_value.get("sdpMid")
                line = candidate_value.get("sdpMLineIndex")
                if (not isinstance(candidate_sdp, str) or len(candidate_sdp) > 2048
                        or (mid is not None and not isinstance(mid, str))
                        or (line is not None and (not isinstance(line, int) or isinstance(line, bool) or line < 0))):
                    return
                if self.pc.remoteDescription is None:
                    self.candidate_queue.append((candidate_sdp, line, mid))
                else:
                    await _add_candidate(self.pc, candidate_sdp, line, mid)

    async def _flush_candidates(self, end: bool = False) -> None:
        for candidate, line, mid in self.candidate_queue:
            await _add_candidate(self.pc, candidate, line, mid)
        self.candidate_queue.clear()
        if end:
            await self.pc.addIceCandidate(None)

    async def _on_connection_state(self) -> None:
        if self.pc.connectionState in ("failed", "closed"):
            await self.close()
        elif self.pc.connectionState == "disconnected":
            if self.disconnect_task is None or self.disconnect_task.done():
                self.disconnect_task = asyncio.create_task(self._disconnect_grace_period())
        elif self.pc.connectionState == "connected":
            if self.disconnect_task:
                self.disconnect_task.cancel()
                self.disconnect_task = None

    async def _disconnect_grace_period(self) -> None:
        await asyncio.sleep(20)
        if self.pc.connectionState == "disconnected":
            logging.info("Peer %s remained disconnected", self.peer_id)
            await self.close()

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self.node.authenticated.discard(self.peer_id)
        self.node.remote_keys.pop(self.peer_id, None)
        self.node.feed_sync_started.discard(self.peer_id)
        feed_sync = self.node.feed_syncs.pop(self.peer_id, None)
        if feed_sync:
            self.node._cancel_feed_sync_timer(feed_sync)
        self.node.rate_windows.pop(self.peer_id, None)
        self.node.find_rate_windows.pop(self.peer_id, None)
        self.node._fail_parent_lookups(self.peer_id)
        for task in (
            getattr(self, "connection_deadline", None),
            getattr(self, "liveness_task", None),
            getattr(self, "disconnect_task", None),
        ):
            if task and task is not asyncio.current_task():
                task.cancel()
        if self.node.links.get(self.peer_id) is self:
            self.node.links.pop(self.peer_id, None)
        try:
            await self.pc.close()
        except Exception:
            pass


async def _add_candidate(pc: Any, raw_candidate: str, line: int | None, mid: str | None) -> None:
    from aiortc.sdp import candidate_from_sdp

    if raw_candidate.startswith("candidate:"):
        raw_candidate = raw_candidate[len("candidate:"):]
    candidate = candidate_from_sdp(raw_candidate)
    candidate.sdpMid = mid
    candidate.sdpMLineIndex = line
    await pc.addIceCandidate(candidate)


def _canonicalize_v3(value: Any) -> str:
    from .protocol import canonicalize_v3

    return canonicalize_v3(value)


def _ice_configuration() -> list[Any]:
    from aiortc import RTCIceServer

    raw = os.environ.get("MYCELIUM_ICE_SERVERS", "").strip()
    if not raw:
        return [RTCIceServer(urls="stun:stun.l.google.com:19302")]
    try:
        entries = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError("MYCELIUM_ICE_SERVERS must be a JSON array") from error
    if not isinstance(entries, list) or len(entries) > 16:
        raise ValueError("MYCELIUM_ICE_SERVERS must be an array of at most 16 entries")
    servers = []
    for item in entries:
        if not isinstance(item, dict) or not isinstance(item.get("urls"), (str, list)):
            raise ValueError("invalid ICE server entry")
        urls = item["urls"]
        if isinstance(urls, list) and (not urls or not all(isinstance(url, str) for url in urls)):
            raise ValueError("invalid ICE server URLs")
        username = item.get("username")
        credential = item.get("credential")
        if username is not None and not isinstance(username, str):
            raise ValueError("ICE server username must be a string")
        if credential is not None and not isinstance(credential, str):
            raise ValueError("ICE server credential must be a string")
        servers.append(RTCIceServer(urls=urls, username=username, credential=credential))
    return servers


def _environment_bool(name: str) -> bool | None:
    value = os.environ.get(name)
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in ("1", "true", "yes", "on"):
        return True
    if normalized in ("0", "false", "no", "off"):
        return False
    raise ValueError(f"{name} must be a boolean (true/false, yes/no, on/off, or 1/0)")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a persistent Mycelium bootstrap peer")
    try:
        auto_follow_back_default = _environment_bool("MYCELIUM_AUTO_FOLLOW_BACK")
    except ValueError as error:
        parser.error(str(error))
    parser.add_argument(
        "--signal-url",
        default=os.environ.get("MYCELIUM_SIGNAL_URL", "wss://discover.unfilter.ing:8443"),
        help="Existing Mycelium signalling/discovery WebSocket URL",
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path(os.environ.get("MYCELIUM_DATA_DIR", "~/.local/share/mycelium-peer")).expanduser(),
        help="directory for SQLite state and, unless overridden, identity.json",
    )
    parser.add_argument(
        "--identity-file",
        type=Path,
        default=Path(os.environ["MYCELIUM_IDENTITY_FILE"]).expanduser()
        if os.environ.get("MYCELIUM_IDENTITY_FILE") else None,
        help="persistent identity file (default: <data-dir>/identity.json)",
    )
    parser.add_argument(
        "--max-peers",
        type=int,
        default=int(os.environ.get("MYCELIUM_MAX_PEERS", str(DEFAULT_MAX_PEERS))),
        help=f"target and hard maximum for authenticated WebRTC peers (1-{HARD_MAX_PEERS})",
    )
    parser.add_argument(
        "--cache-mb",
        type=int,
        default=int(os.environ.get("MYCELIUM_CACHE_MB", str(DEFAULT_OBJECT_CACHE_BYTES // (1024 * 1024)))),
        help="maximum serialized object JSON bytes to retain, in MiB (default: 2048)",
    )
    parser.add_argument(
        "--display-name",
        default=os.environ.get("MYCELIUM_DISPLAY_NAME"),
        help="profile display name; persisted in SQLite and overridden by this option when supplied",
    )
    parser.add_argument(
        "--mode",
        choices=PEER_MODES,
        default=os.environ.get("MYCELIUM_MODE", "social"),
        help="peer operating mode (default: social; hoarder disables automatic follow-back by default)",
    )
    follow_back_group = parser.add_mutually_exclusive_group()
    follow_back_group.add_argument(
        "--auto-follow-back",
        dest="auto_follow_back",
        action="store_true",
        help="automatically follow authenticated peers that follow the bot",
    )
    follow_back_group.add_argument(
        "--no-auto-follow-back",
        dest="auto_follow_back",
        action="store_false",
        help="do not automatically follow peers back",
    )
    parser.set_defaults(auto_follow_back=auto_follow_back_default)
    parser.add_argument(
        "--log-level",
        default=os.environ.get("MYCELIUM_LOG_LEVEL", "INFO"),
        choices=("DEBUG", "INFO", "WARNING", "ERROR"),
        help="logging threshold; logs are written to standard output/error",
    )
    return parser.parse_args()


def validate_signal_url(value: str) -> str:
    from urllib.parse import urlsplit

    parsed = urlsplit(value)
    if parsed.scheme not in ("ws", "wss") or not parsed.hostname:
        raise ValueError("signalling URL must be a ws:// or wss:// URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("signalling URL must not contain embedded credentials")
    hostname = parsed.hostname.lower().strip("[]")
    if parsed.scheme == "ws" and hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("insecure ws:// signalling is allowed only for loopback")
    return value


async def async_main(args: argparse.Namespace) -> None:
    args.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    identity_path = args.identity_file or args.data_dir / "identity.json"
    if args.cache_mb < 1:
        raise ValueError("cache capacity must be at least 1 MiB")
    store = PeerStore(
        args.data_dir / "peer.sqlite3",
        object_cache_limit_bytes=args.cache_mb * 1024 * 1024,
    )
    node = PeerNode(
        write_identity(identity_path),
        store,
        args.max_peers,
        args.display_name,
        args.mode,
        args.auto_follow_back,
    )
    usage = store.usage()
    counts = store.counts()
    logging.info(
        "Persistent peer database: %s; mode=%s automatic_follow_back=%s; "
        "records objects=%d tombstones=%d peers=%d settings=%d following=%d feed_cursors=%d",
        store.path.resolve(),
        node.mode,
        node.auto_follow_back,
        counts["objects"],
        counts["tombstones"],
        counts["peers"],
        counts["settings"],
        counts["following"],
        counts["feed_cursors"],
    )
    logging.info(
        "Object cache: %d/%d serialized bytes; tombstones and retained delete requests use %d bytes; "
        "SQLite files currently use %d bytes",
        usage["object_bytes"],
        usage["object_limit_bytes"],
        usage["tombstone_bytes"],
        usage["disk_bytes"],
    )
    try:
        await node.run(validate_signal_url(args.signal_url))
    finally:
        await node.close()
        store.close()


def _configure_logging(log_level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, log_level),
        format="[%(asctime)s] %(levelname)s %(message)s",
    )
    dependency_log_level = logging.DEBUG if log_level == "DEBUG" else logging.INFO
    for logger_name in ("aiortc", "aioice"):
        logging.getLogger(logger_name).setLevel(dependency_log_level)


def main() -> None:
    args = parse_args()
    _configure_logging(args.log_level)
    try:
        asyncio.run(async_main(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
