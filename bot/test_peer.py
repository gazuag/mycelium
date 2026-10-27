from __future__ import annotations

import asyncio
import base64
import hashlib
import importlib.util
import json
import logging
import os
import tempfile
import time
import unittest
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

from .peer import (
    DEFAULT_MAX_PEERS,
    FEED_SYNC_PAGE_SIZE,
    HARD_MAX_PEERS,
    MAX_POST_ANCESTRY_DEPTH,
    MAX_PACKET_TASKS,
    PeerLink,
    PeerNode,
    _configure_logging,
    new_packet,
    parse_args,
    sign_packet,
    write_identity,
)
from .protocol import (
    Identity,
    MAX_OBJECT_BYTES,
    canonicalize,
    canonicalize_v3,
    fingerprint,
    validate_object,
    verify_signature,
    validate_packet_shape,
)
from .store import PeerStore


LEGACY_FIXTURE = {
    "object_type": "mycelium.legacy-fixture",
    "created_at": "2026-09-30T12:34:56.000Z",
    "payload": {"content": "legacy bytes", "tags": ["compat"]},
    "replication_policy": {},
    "author": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEJbTHH9ia4mvJfV9JPoq9gLazHXQAGfBq1xJCO9ud/2pI5l2qYgwI86d3z1ze8uc1ZtrajPIsCUHdvhm+ubJvGA==",
    "object_id": "12b2412070faf86f46e92c2e6a53f678cefc933a8bf6e44217dd28e7cdd6b7c9",
    "signature": "iapp4rNI1EoVh4Et1XED0N0FQB6/VfgYMQB0YbikrAZtg9HsBrqydLKrUHkgzS4afwpMC170bMuGi7smL34w6A==",
}
LEGACY_CANONICAL = (
    '{"author":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEJbTHH9ia4mvJfV9JPoq9gLazHXQAGfBq1xJCO9ud/2pI5l2qYgwI86d3z1ze8uc1ZtrajPIsCUHdvhm+ubJvGA==",'
    '"created_at":"2026-09-30T12:34:56.000Z","object_type":"mycelium.legacy-fixture",'
    '"payload":{"content":"legacy bytes","tags":["compat"]},"replication_policy":{}}'
)


class StubLink:
    def __init__(self, channel=None):
        self.is_open = True
        self.closed = False
        self.channel = channel

    async def close(self):
        self.closed = True
        self.is_open = False


class StubChannel:
    def __init__(self):
        self.readyState = "open"
        self.packets = []

    def send(self, raw):
        self.packets.append(json.loads(raw))


def make_legacy_object(identity: Identity, object_type: str, payload: dict, policy: dict | None = None) -> dict:
    immutable = {
        "object_type": object_type,
        "author": identity.public_key,
        "created_at": "2026-10-20T12:34:56.000Z",
        "payload": payload,
        "replication_policy": policy or {},
    }
    canonical = canonicalize(immutable)
    return {
        **immutable,
        "object_id": hashlib.sha256(canonical.encode()).hexdigest(),
        "signature": identity.sign(canonical),
    }


class TestPeerStoreConfiguration(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "objects.sqlite3"
        self.identity = Identity.create()

    def tearDown(self) -> None:
        self.temp.cleanup()

    @staticmethod
    def encoded_size(value: dict) -> int:
        return len(json.dumps(
            value, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8"))

    def test_cache_limit_evicts_oldest_and_reports_logical_footprint(self) -> None:
        first = make_legacy_object(self.identity, "mycelium.note", {"content": "first"})
        second = make_legacy_object(self.identity, "mycelium.note", {"content": "second"})
        limit = max(self.encoded_size(first), self.encoded_size(second)) + 1
        store = PeerStore(self.path, object_cache_limit_bytes=limit)
        self.assertTrue(store.put_object(first))
        self.assertTrue(store.put_object(second))
        usage = store.usage()
        self.assertLessEqual(usage["object_bytes"], limit)
        self.assertEqual(usage["object_limit_bytes"], limit)
        self.assertGreater(usage["disk_bytes"], 0)
        self.assertIsNone(store.get_object(first["object_id"]))
        self.assertEqual(store.get_object(second["object_id"]), second)
        store.close()

    def test_eviction_removes_reply_family_and_tombstone_blocks_reintroduction(self) -> None:
        root = make_legacy_object(self.identity, "mycelium.post", {"content": "root " * 20})
        reply = make_legacy_object(
            self.identity, "mycelium.post",
            {"content": "reply", "reply_to": root["object_id"]},
        )
        limit = max(self.encoded_size(root), self.encoded_size(reply)) + 1
        store = PeerStore(self.path, object_cache_limit_bytes=limit)
        self.assertTrue(store.put_object(root))
        self.assertTrue(store.put_object(reply))
        self.assertIsNone(store.get_object(root["object_id"]))
        self.assertIsNone(store.get_object(reply["object_id"]))
        self.assertLessEqual(store.usage()["object_bytes"], limit)

        store.put_object(root)
        store.put_object(reply)
        store.apply_tombstone({"target_object_id": root["object_id"]})
        self.assertIsNone(store.get_object(root["object_id"]))
        self.assertIsNone(store.get_object(reply["object_id"]))
        self.assertFalse(store.put_object(reply))
        store.close()

    def test_display_and_follow_state_survive_store_restart(self) -> None:
        peer = Identity.create().node_id
        store = PeerStore(self.path)
        store.set_setting("display_name", "Cache Peer")
        self.assertTrue(store.set_following(peer, True))
        self.assertFalse(store.set_following(peer, True))
        store.close()

        reopened = PeerStore(self.path)
        self.assertEqual(reopened.get_setting("display_name"), "Cache Peer")
        self.assertTrue(reopened.is_following(peer))
        self.assertTrue(reopened.set_following(peer, False))
        self.assertFalse(reopened.is_following(peer))
        reopened.close()


def make_v3_object(identity: Identity) -> dict:
    import os

    immutable = {
        "object_type": "mycelium.post",
        "author": identity.public_key,
        "created_at": "2026-10-20T12:34:56.000Z",
        "payload": {"content": "v3 target"},
        "replication_policy": {},
    }
    content_hash = hashlib.sha256(canonicalize_v3(immutable).encode()).hexdigest()
    object_id = os.urandom(32).hex()
    proof = canonicalize_v3({
        "domain": "mycelium.object-signature.v3",
        "object_id": object_id,
        "content_hash": content_hash,
    })
    return {
        **immutable,
        "object_id": object_id,
        "object_id_version": 3,
        "content_hash": content_hash,
        "signature": identity.sign(proof),
    }


def make_v2_object(identity: Identity) -> dict:
    immutable = {
        "object_type": "mycelium.post",
        "author": identity.public_key,
        "created_at": "2026-10-20T12:34:56.000Z",
        "payload": {"content": "v2 object"},
        "replication_policy": {},
    }
    content_hash = hashlib.sha256(canonicalize(immutable).encode()).hexdigest()
    object_id = hashlib.sha256(canonicalize({
        "domain": "mycelium.object-id.v2",
        "author": identity.public_key,
        "content_hash": content_hash,
    }).encode()).hexdigest()
    author_proof = canonicalize({
        "domain": "mycelium.object-author-proof.v2",
        "author": identity.public_key,
        "content_hash": content_hash,
    })
    return {
        **immutable,
        "object_id": object_id,
        "object_id_version": 2,
        "content_hash": content_hash,
        "author_proof": identity.sign(author_proof),
        "signature": identity.sign(canonicalize(immutable)),
    }


class TestProtocolPrimitives(unittest.TestCase):
    def test_identity_creation_loading_and_node_id(self) -> None:
        identity = Identity.create()
        loaded = Identity.load(identity.public_key, identity.private_key)
        self.assertEqual(loaded.node_id, identity.node_id)
        self.assertEqual(fingerprint(identity.public_key), identity.node_id)
        self.assertRegex(identity.node_id, r"^(?:[0-9a-f]{2}:){7}[0-9a-f]{2}$")
        self.assertEqual(
            fingerprint(LEGACY_FIXTURE["author"]),
            "75:87:7d:f5:ca:53:ff:49",
        )

    def test_javascript_canonicalization_and_legacy_cross_check(self) -> None:
        immutable = {
            "object_type": LEGACY_FIXTURE["object_type"],
            "author": LEGACY_FIXTURE["author"],
            "created_at": LEGACY_FIXTURE["created_at"],
            "payload": LEGACY_FIXTURE["payload"],
            "replication_policy": LEGACY_FIXTURE["replication_policy"],
        }
        self.assertEqual(canonicalize(immutable), LEGACY_CANONICAL)
        self.assertEqual(hashlib.sha256(LEGACY_CANONICAL.encode()).hexdigest(), LEGACY_FIXTURE["object_id"])
        self.assertTrue(validate_object(LEGACY_FIXTURE))

    def test_v3_unicode_key_order_matches_typescript_vector(self) -> None:
        self.assertEqual(
            canonicalize_v3({
                "z": 1,
                "ä": 2,
                "2": "two",
                "10": "ten",
                "A": 3,
                "a": {"é": True, "b": False},
            }),
            '{"10":"ten","2":"two","A":3,"a":{"b":false,"é":true},"z":1,"ä":2}',
        )

    def test_version_2_object_id_and_target_proof(self) -> None:
        identity = Identity.create()
        obj = make_v2_object(identity)
        self.assertTrue(validate_object(obj))
        self.assertFalse(validate_object({**obj, "object_id": "0" * 64}))

    def test_packet_signature_uses_wire_canonicalization_and_p1363(self) -> None:
        identity = Identity.create()
        packet = sign_packet(identity, new_packet(
            identity.node_id, None, "PING", {"pingId": "test", "sentAt": "2026-10-20T00:00:00.000Z"}
        ))
        serialized = json.dumps(packet, ensure_ascii=False, separators=(",", ":"))
        round_tripped = json.loads(serialized)
        unsigned = {key: value for key, value in round_tripped.items() if key != "signature"}
        self.assertTrue(verify_signature(identity.public_key, canonicalize(unsigned), packet["signature"]))
        self.assertFalse(verify_signature(identity.public_key, canonicalize(unsigned), base64.b64encode(b"bad").decode()))

    def test_browser_packet_shape_is_accepted_and_boolean_version_rejected(self) -> None:
        packet = new_packet(
            "01:02:03:04:05:06:07:08",
            None,
            "PROFILE_UPDATE",
            {"profile": {"author": "01:02:03:04:05:06:07:08", "following": True}},
        )
        packet["signature"] = "browser-signature"
        self.assertTrue(validate_packet_shape(packet))
        self.assertFalse(validate_packet_shape({**packet, "version": True}))

    def test_rejects_invalid_object_signature(self) -> None:
        self.assertTrue(validate_object(LEGACY_FIXTURE))
        tampered = {**LEGACY_FIXTURE, "payload": {"content": "tampered"}}
        self.assertFalse(validate_object(tampered))


class TestBootstrapPeer(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.identity = Identity.create()
        self.store = PeerStore(self.root / "objects.sqlite3")
        self.node = PeerNode(self.identity, self.store)

    async def asyncTearDown(self) -> None:
        await self.node.close()
        self.store.close()
        self.temp.cleanup()

    async def test_identity_is_created_persistently_and_loaded_without_replacement(self) -> None:
        path = self.root / "keys" / "identity.json"
        created = write_identity(path)
        loaded = write_identity(path)
        self.assertEqual(created.node_id, loaded.node_id)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        key_data = json.loads(path.read_text())
        self.assertEqual(key_data["public_key"], created.public_key)
        self.assertEqual(key_data["node_id"], created.node_id)

    async def test_follow_back_cli_defaults_and_explicit_overrides(self) -> None:
        with patch.dict(os.environ, {}, clear=True), patch("sys.argv", ["peer"]):
            social_args = parse_args()
        self.assertIsNone(social_args.auto_follow_back)
        self.assertTrue(PeerNode(self.identity, self.store, mode=social_args.mode,
                                 auto_follow_back=social_args.auto_follow_back).auto_follow_back)

        with patch.dict(os.environ, {}, clear=True), patch(
            "sys.argv", ["peer", "--mode", "hoarder"]
        ):
            hoarder_args = parse_args()
        self.assertIsNone(hoarder_args.auto_follow_back)
        self.assertFalse(PeerNode(
            self.identity,
            self.store,
            mode=hoarder_args.mode,
            auto_follow_back=hoarder_args.auto_follow_back,
        ).auto_follow_back)

        with patch.dict(os.environ, {}, clear=True), patch(
            "sys.argv", ["peer", "--mode", "hoarder", "--auto-follow-back"]
        ):
            explicitly_enabled = parse_args()
        self.assertTrue(explicitly_enabled.auto_follow_back)

        with patch.dict(os.environ, {}, clear=True), patch(
            "sys.argv", ["peer", "--mode", "social", "--no-auto-follow-back"]
        ):
            explicitly_disabled = parse_args()
        self.assertFalse(explicitly_disabled.auto_follow_back)

    async def test_follow_back_environment_override_and_invalid_value(self) -> None:
        with patch.dict(
            os.environ, {"MYCELIUM_AUTO_FOLLOW_BACK": "off"}, clear=True
        ), patch("sys.argv", ["peer", "--mode", "social"]):
            self.assertFalse(parse_args().auto_follow_back)

        with patch.dict(
            os.environ, {"MYCELIUM_AUTO_FOLLOW_BACK": "yes"}, clear=True
        ), patch("sys.argv", ["peer", "--mode", "hoarder"]):
            self.assertTrue(parse_args().auto_follow_back)

        with patch.dict(
            os.environ, {"MYCELIUM_AUTO_FOLLOW_BACK": "maybe"}, clear=True
        ), patch("sys.argv", ["peer"]):
            with self.assertRaises(SystemExit) as error:
                parse_args()
        self.assertEqual(error.exception.code, 2)

    async def test_logging_limits_webrtc_dependencies_unless_debug_is_explicit(self) -> None:
        aiortc_logger = logging.getLogger("aiortc")
        aioice_logger = logging.getLogger("aioice")
        original_levels = aiortc_logger.level, aioice_logger.level
        try:
            _configure_logging("INFO")
            self.assertEqual(aiortc_logger.level, logging.INFO)
            self.assertEqual(aioice_logger.level, logging.INFO)
            _configure_logging("DEBUG")
            self.assertEqual(aiortc_logger.level, logging.DEBUG)
            self.assertEqual(aioice_logger.level, logging.DEBUG)
        finally:
            aiortc_logger.setLevel(original_levels[0])
            aioice_logger.setLevel(original_levels[1])

    async def test_packet_from_replaced_connection_is_ignored(self) -> None:
        remote = Identity.create()
        stale_link = StubLink()
        current_link = StubLink()
        self.node.links[remote.node_id] = current_link
        packet = sign_packet(remote, new_packet(
            remote.node_id,
            self.identity.node_id,
            "PROFILE_UPDATE",
            {"profile": {"publicKey": remote.public_key}},
        ))
        with self.assertLogs(level="DEBUG") as captured:
            await self.node.handle_data(
                remote.node_id,
                json.dumps(packet, ensure_ascii=False, separators=(",", ":")),
                stale_link,
            )
        self.assertTrue(any("stale connection" in line for line in captured.output))
        self.assertNotIn(remote.node_id, self.node.authenticated)

    async def test_mismatched_packet_warning_reports_sender_and_recipient(self) -> None:
        remote = Identity.create()
        packet = sign_packet(remote, new_packet(
            remote.node_id,
            "another-recipient",
            "PROFILE_UPDATE",
            {"profile": {"publicKey": remote.public_key}},
        ))
        with self.assertLogs(level="WARNING") as captured:
            await self.node.handle_data(
                remote.node_id,
                json.dumps(packet, ensure_ascii=False, separators=(",", ":")),
            )
        self.assertTrue(any(
            "recipient='another-recipient'" in line
            and "expected_recipient=null or" in line
            for line in captured.output
        ))

    async def test_authenticated_profile_handshake_and_fingerprint_binding(self) -> None:
        remote = Identity.create()
        peer = remote.node_id
        packet = sign_packet(remote, new_packet(
            peer,
            self.identity.node_id,
            "PROFILE_UPDATE",
            {"profile": {"publicKey": remote.public_key}},
        ))
        self.assertTrue(self.node._authenticate_profile(peer, packet))
        self.assertIn(peer, self.node.authenticated)
        impostor = sign_packet(remote, new_packet(
            "00:00:00:00:00:00:00:00",
            self.identity.node_id,
            "PROFILE_UPDATE",
            {"profile": {"publicKey": remote.public_key}},
        ))
        self.assertFalse(self.node._authenticate_profile(peer, impostor))

    async def test_display_name_persists_and_signed_profile_uses_browser_identity_fields(self) -> None:
        configured = PeerNode(self.identity, self.store, display_name="Cache Relay")
        restarted = PeerNode(self.identity, self.store)
        self.assertEqual(configured.display_name, "Cache Relay")
        self.assertEqual(restarted.display_name, "Cache Relay")
        self.assertEqual(self.store.get_setting("display_name"), "Cache Relay")

        remote = Identity.create()
        channel = StubChannel()
        configured.links[remote.node_id] = StubLink(channel)
        await configured._send_profile(remote.node_id, "PROFILE_UPDATE")
        packet = channel.packets[0]
        profile = packet["payload"]["profile"]
        self.assertEqual(profile["author"], self.identity.node_id)
        self.assertEqual(profile["publicKey"], self.identity.public_key)
        self.assertEqual(profile["displayName"], "Cache Relay")
        self.assertFalse(profile["following"])
        self.assertTrue(validate_packet_shape(packet))
        self.assertTrue(verify_signature(
            self.identity.public_key,
            canonicalize({key: value for key, value in packet.items() if key != "signature"}),
            packet["signature"],
        ))

    async def test_browser_profile_exchange_drives_persisted_follow_back_once(self) -> None:
        remote = Identity.create()
        channel = StubChannel()
        self.node.links[remote.node_id] = StubLink(channel)
        profile = {
            "author": remote.node_id,
            "publicKey": remote.public_key,
            "displayName": "Browser peer",
            "following": True,
            "timestamp": "2026-10-20T12:34:56.000Z",
        }
        packet = sign_packet(remote, new_packet(
            remote.node_id,
            self.identity.node_id,
            "PROFILE_UPDATE",
            {"profile": profile},
        ))
        raw = json.dumps(packet, ensure_ascii=False, separators=(",", ":"))
        await self.node.handle_data(remote.node_id, raw)
        self.assertIn(remote.node_id, self.node.authenticated)
        self.assertTrue(self.store.is_following(remote.node_id))
        profile_packets = [
            packet for packet in channel.packets
            if packet["type"] == "PROFILE_UPDATE"
        ]
        self.assertEqual(len(profile_packets), 1)
        bot_packet = profile_packets[0]
        bot_profile = bot_packet["payload"]["profile"]
        self.assertTrue(bot_profile["following"])
        self.assertEqual(bot_profile["author"], self.identity.node_id)
        self.assertTrue(verify_signature(
            self.identity.public_key,
            canonicalize({key: value for key, value in bot_packet.items() if key != "signature"}),
            bot_packet["signature"],
        ))

        await self.node.handle_data(remote.node_id, raw)
        self.assertEqual(len(channel.packets), 2)

        await self.node.close()
        self.store.close()
        self.store = PeerStore(self.root / "objects.sqlite3")
        self.node.store = self.store
        restarted = PeerNode(self.identity, self.store)
        resumed_channel = StubChannel()
        restarted.links[remote.node_id] = StubLink(resumed_channel)
        await restarted._send_profile(remote.node_id, "PROFILE_UPDATE")
        self.assertTrue(resumed_channel.packets[0]["payload"]["profile"]["following"])
        self.node = restarted

        unfollow = sign_packet(remote, new_packet(
            remote.node_id,
            self.identity.node_id,
            "PROFILE_UPDATE",
            {"profile": {**profile, "following": False}},
        ))
        await self.node.handle_data(
            remote.node_id,
            json.dumps(unfollow, ensure_ascii=False, separators=(",", ":")),
        )
        self.assertFalse(self.store.is_following(remote.node_id))
        self.assertEqual(len(resumed_channel.packets), 3)
        self.assertFalse(resumed_channel.packets[-1]["payload"]["profile"]["following"])

    async def test_hoarder_requests_authenticated_unfollowed_feeds_without_following_back(self) -> None:
        node = PeerNode(self.identity, self.store, mode="hoarder")
        self.node = node
        first_peer, second_peer = Identity.create(), Identity.create()
        channels = {}
        for remote in (first_peer, second_peer):
            channel = StubChannel()
            channels[remote.node_id] = channel
            node.links[remote.node_id] = StubLink(channel)
            packet = sign_packet(remote, new_packet(
                remote.node_id,
                self.identity.node_id,
                "PROFILE_UPDATE",
                {"profile": {
                    "author": remote.node_id,
                    "publicKey": remote.public_key,
                    "following": True,
                }},
            ))
            await node.handle_data(
                remote.node_id,
                json.dumps(packet, ensure_ascii=False, separators=(",", ":")),
            )

        self.assertFalse(node.auto_follow_back)
        for remote in (first_peer, second_peer):
            self.assertIn(remote.node_id, node.authenticated)
            self.assertFalse(self.store.is_following(remote.node_id))
            self.assertEqual(
                [packet["type"] for packet in channels[remote.node_id].packets],
                ["POST_REQUEST"],
            )

    async def test_hoarder_rejects_object_before_profile_authentication(self) -> None:
        remote = Identity.create()
        channel = StubChannel()
        self.node = PeerNode(self.identity, self.store, mode="hoarder")
        self.node.links[remote.node_id] = StubLink(channel)
        obj = make_legacy_object(remote, "mycelium.post", {"content": "must authenticate"})
        packet = sign_packet(remote, new_packet(
            remote.node_id,
            self.identity.node_id,
            "OBJECT_STORE",
            {"object": obj},
        ))
        await self.node.handle_data(
            remote.node_id,
            json.dumps(packet, ensure_ascii=False, separators=(",", ":")),
        )
        self.assertNotIn(remote.node_id, self.node.authenticated)
        self.assertIsNone(self.store.get_object(obj["object_id"]))
        self.assertNotIn(remote.node_id, self.node.feed_syncs)
        self.assertEqual(channel.packets, [])

    async def test_hoarder_resumes_persisted_cursor_after_reconnect(self) -> None:
        remote = Identity.create()
        cursor = {
            "created_at": "2026-10-21T12:00:00.000Z",
            "object_id": "f" * 64,
        }
        node = PeerNode(self.identity, self.store, mode="hoarder")
        self.node = node
        self.store.set_feed_cursor(remote.node_id, cursor)
        first_channel = StubChannel()
        node.links[remote.node_id] = StubLink(first_channel)
        profile = sign_packet(remote, new_packet(
            remote.node_id,
            self.identity.node_id,
            "PROFILE_UPDATE",
            {"profile": {"publicKey": remote.public_key, "following": False}},
        ))
        raw_profile = json.dumps(profile, ensure_ascii=False, separators=(",", ":"))
        await node.handle_data(remote.node_id, raw_profile)
        self.assertEqual(first_channel.packets[0]["payload"]["after"], cursor)

        await node.close()
        restarted = PeerNode(self.identity, self.store, mode="hoarder")
        self.node = restarted
        resumed_channel = StubChannel()
        restarted.links[remote.node_id] = StubLink(resumed_channel)
        await restarted.handle_data(remote.node_id, raw_profile)
        self.assertEqual(resumed_channel.packets[0]["type"], "POST_REQUEST")
        self.assertEqual(resumed_channel.packets[0]["payload"]["after"], cursor)

    async def test_duplicate_feed_page_is_deduplicated_without_another_request(self) -> None:
        remote = Identity.create()
        channel = StubChannel()
        self.node = PeerNode(self.identity, self.store, mode="hoarder")
        self.node.links[remote.node_id] = StubLink(channel)
        profile = sign_packet(remote, new_packet(
            remote.node_id,
            self.identity.node_id,
            "PROFILE_UPDATE",
            {"profile": {"publicKey": remote.public_key, "following": False}},
        ))
        await self.node.handle_data(
            remote.node_id,
            json.dumps(profile, ensure_ascii=False, separators=(",", ":")),
        )
        request_id = channel.packets[0]["payload"]["requestId"]
        obj = make_legacy_object(remote, "mycelium.post", {"content": "one copy"})
        batch = sign_packet(remote, new_packet(
            remote.node_id,
            self.identity.node_id,
            "OBJECT_BATCH",
            {
                "objects": [obj],
                "page": {
                    "request_id": request_id,
                    "next_cursor": {
                        "created_at": obj["created_at"],
                        "object_id": obj["object_id"],
                    },
                    "has_more": False,
                },
            },
        ))
        raw_batch = json.dumps(batch, ensure_ascii=False, separators=(",", ":"))
        await self.node.handle_data(remote.node_id, raw_batch)
        await self.node.handle_data(remote.node_id, raw_batch)
        self.assertEqual(self.store.get_object(obj["object_id"]), obj)
        self.assertEqual(len(channel.packets), 1)
        self.assertNotIn(remote.node_id, self.node.feed_syncs)

    async def test_hoarder_follow_back_can_be_explicitly_enabled(self) -> None:
        remote = Identity.create()
        channel = StubChannel()
        self.node = PeerNode(
            self.identity, self.store, mode="hoarder", auto_follow_back=True
        )
        self.node.links[remote.node_id] = StubLink(channel)
        profile = sign_packet(remote, new_packet(
            remote.node_id,
            self.identity.node_id,
            "PROFILE_UPDATE",
            {"profile": {"publicKey": remote.public_key, "following": True}},
        ))
        await self.node.handle_data(
            remote.node_id,
            json.dumps(profile, ensure_ascii=False, separators=(",", ":")),
        )
        self.assertTrue(self.store.is_following(remote.node_id))
        self.assertIn("PROFILE_UPDATE", [packet["type"] for packet in channel.packets])

    async def test_authenticated_browser_profile_starts_feed_sync_and_batch_is_persisted(self) -> None:
        self.assertEqual(self.node.mode, "social")
        self.assertTrue(self.node.auto_follow_back)
        browser = Identity.create()
        channel = StubChannel()
        self.node.links[browser.node_id] = StubLink(channel)
        profile = {
            "author": browser.node_id,
            "publicKey": browser.public_key,
            "displayName": "Browser peer",
            "following": False,
            "timestamp": "2026-10-20T12:34:56.000Z",
        }
        profile_packet = sign_packet(browser, new_packet(
            browser.node_id,
            self.identity.node_id,
            "PROFILE_UPDATE",
            {"profile": profile},
        ))
        await self.node.handle_data(
            browser.node_id,
            json.dumps(profile_packet, ensure_ascii=False, separators=(",", ":")),
        )
        self.assertEqual(len(channel.packets), 1)
        request = channel.packets[0]
        self.assertEqual(request["type"], "POST_REQUEST")
        self.assertEqual(request["payload"]["limit"], FEED_SYNC_PAGE_SIZE)
        self.assertEqual(request["payload"]["after"], {
            "created_at": "0001-01-01T00:00:00.000Z",
            "object_id": "",
        })
        request_id = request["payload"]["requestId"]

        post = make_legacy_object(browser, "mycelium.post", {"content": "signed feed entry"})
        response = sign_packet(browser, new_packet(
            browser.node_id,
            self.identity.node_id,
            "OBJECT_BATCH",
            {
                "objects": [post],
                "page": {
                    "request_id": request_id,
                    "next_cursor": {
                        "created_at": post["created_at"],
                        "object_id": post["object_id"],
                    },
                    "has_more": True,
                },
            },
        ))
        await self.node.handle_data(
            browser.node_id,
            json.dumps(response, ensure_ascii=False, separators=(",", ":")),
        )
        self.assertEqual(self.store.get_object(post["object_id"]), post)
        self.assertEqual(self.store.get_feed_cursor(browser.node_id), {
            "created_at": post["created_at"],
            "object_id": post["object_id"],
        })
        self.assertEqual(channel.packets[-1]["type"], "POST_REQUEST")
        next_request = channel.packets[-1]["payload"]
        self.assertEqual(next_request["after"], self.store.get_feed_cursor(browser.node_id))
        empty_page = sign_packet(browser, new_packet(
            browser.node_id,
            self.identity.node_id,
            "OBJECT_BATCH",
            {
                "objects": [],
                "page": {
                    "request_id": next_request["requestId"],
                    "next_cursor": self.store.get_feed_cursor(browser.node_id),
                    "has_more": False,
                },
            },
        ))
        await self.node.handle_data(
            browser.node_id,
            json.dumps(empty_page, ensure_ascii=False, separators=(",", ":")),
        )
        self.assertNotIn(browser.node_id, self.node.feed_syncs)

    async def test_bot_answers_authenticated_post_request_with_empty_feed_page(self) -> None:
        browser = Identity.create()
        channel = StubChannel()
        self.node.links[browser.node_id] = StubLink(channel)
        profile = sign_packet(browser, new_packet(
            browser.node_id,
            self.identity.node_id,
            "PROFILE_UPDATE",
            {"profile": {"publicKey": browser.public_key}},
        ))
        await self.node.handle_data(
            browser.node_id,
            json.dumps(profile, ensure_ascii=False, separators=(",", ":")),
        )
        request = sign_packet(browser, new_packet(
            browser.node_id,
            self.identity.node_id,
            "POST_REQUEST",
            {
                "since": None,
                "after": {
                    "created_at": "0001-01-01T00:00:00.000Z",
                    "object_id": "",
                },
                "limit": 100,
                "requestId": "browser-feed-1",
            },
        ))
        await self.node.handle_data(
            browser.node_id,
            json.dumps(request, ensure_ascii=False, separators=(",", ":")),
        )
        response = channel.packets[-1]
        self.assertEqual(response["type"], "OBJECT_BATCH")
        self.assertEqual(response["payload"], {
            "objects": [],
            "page": {
                "request_id": "browser-feed-1",
                "next_cursor": {
                    "created_at": "0001-01-01T00:00:00.000Z",
                    "object_id": "",
                },
                "has_more": False,
            },
        })

    @unittest.skipUnless(importlib.util.find_spec("aiortc"), "aiortc is not installed")
    async def test_aiortc_data_channel_and_authenticated_peer_handshake(self) -> None:
        from aiortc import RTCConfiguration, RTCPeerConnection

        remote = Identity.create()
        remote_store = PeerStore(self.root / "remote.sqlite3")
        remote_node = PeerNode(remote, remote_store)
        local_pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        remote_pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        local_link = PeerLink(self.node, remote.node_id, local_pc, outgoing=True)
        remote_link = PeerLink(remote_node, self.identity.node_id, remote_pc, outgoing=False)
        self.node.links[remote.node_id] = local_link
        remote_node.links[self.identity.node_id] = remote_link
        answers = []

        async def capture_signal(message):
            answers.append(message)

        remote_node._send_signal = capture_signal
        try:
            local_link.channel = local_pc.createDataChannel("chat")
            local_link.bind_channel(local_link.channel)
            offer = await local_pc.createOffer()
            await local_pc.setLocalDescription(offer)
            await remote_link.handle_signal("offer", {
                "type": "offer",
                "sdp": local_pc.localDescription.sdp,
                "negotiationId": local_link.negotiation_id,
            })
            self.assertEqual(answers[0]["type"], "answer")
            await local_link.handle_signal("answer", answers[0]["payload"])
            deadline = asyncio.get_running_loop().time() + 10
            while (
                self.identity.node_id not in remote_node.authenticated
                or remote.node_id not in self.node.authenticated
            ) and asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(0.05)
            self.assertIn(remote.node_id, self.node.authenticated)
            self.assertIn(self.identity.node_id, remote_node.authenticated)
        finally:
            await remote_node.close()
            remote_store.close()

    async def test_invalid_packet_signature_is_rejected(self) -> None:
        remote = Identity.create()
        packet = sign_packet(remote, new_packet(
            remote.node_id, self.identity.node_id, "PING", {"pingId": "one"}
        ))
        packet["payload"]["pingId"] = "tampered"
        self.node.remote_keys[remote.node_id] = remote.public_key
        self.assertFalse(self.node._verify_packet_if_signed(remote.node_id, packet))

    async def test_object_deduplication_and_persistent_restart(self) -> None:
        obj = make_legacy_object(self.identity, "mycelium.post", {"content": "persistent"})
        self.assertTrue(self.store.put_object(obj))
        self.assertFalse(self.store.put_object(obj))
        self.store.close()
        self.store = PeerStore(self.root / "objects.sqlite3")
        self.node.store = self.store
        self.assertEqual(self.store.get_object(obj["object_id"]), obj)

    async def test_find_local_response_and_bounded_forwarding(self) -> None:
        obj = make_legacy_object(self.identity, "mycelium.post", {"content": "find me"})
        self.store.put_object(obj)
        response_packets = []

        async def capture_response(peer_id, packet_type, payload):
            response_packets.append((peer_id, packet_type, payload))

        self.node.send_packet = capture_response
        local_packet = new_packet("upstream", self.identity.node_id, "FIND", {
            "requested_objects": [obj["object_id"]],
            "object_id": obj["object_id"],
            "requestId": "local-find",
            "ttl": 1,
            "expiresAt": (datetime_now_plus(4)),
        })
        await self.node._handle_find("upstream", local_packet)
        self.assertEqual(response_packets[0][1], "FIND_RESPONSE")
        self.assertEqual(response_packets[0][2]["objects"], [obj])

        children = [Identity.create() for _ in range(3)]
        sent = []

        async def capture_send(peer_id, packet):
            sent.append((peer_id, packet))

        self.node.send = capture_send
        for child in children:
            self.node.links[child.node_id] = StubLink()
            self.node.authenticated.add(child.node_id)
        missing_ids = [hashlib.sha256(str(i).encode()).hexdigest() for i in range(3)]
        forwarded = new_packet("upstream", self.identity.node_id, "FIND", {
            "requested_objects": missing_ids,
            "object_id": missing_ids[0],
            "requestId": "bounded-find",
            "ttl": 1,
            "expiresAt": datetime_now_plus(4),
        })
        await self.node._handle_find("upstream", forwarded)
        self.assertEqual(len(sent), 2)
        self.assertTrue(all(item[1]["payload"]["ttl"] == 0 for item in sent))
        await self.node._handle_find("upstream", forwarded)
        self.assertEqual(len(sent), 2)

    async def test_delete_request_tombstone_blocks_later_target_copy(self) -> None:
        author = Identity.create()
        target = make_v3_object(author)
        request_payload = {
            "command": "delete",
            "target_object_id": target["object_id"],
            "target_object_type": target["object_type"],
            "target_author": target["author"],
            "target_created_at": target["created_at"],
            "target_object_id_version": 3,
            "target_content_hash": target["content_hash"],
            "target_author_proof": target["signature"],
        }
        now = time.time()
        created = datetime.fromtimestamp(now - 1, timezone.utc).isoformat().replace("+00:00", "Z")
        expires = datetime.fromtimestamp(now + 60, timezone.utc).isoformat().replace("+00:00", "Z")
        immutable = {
            "object_type": "mycelium.delete-request",
            "author": author.public_key,
            "created_at": created,
            "expires_at": expires,
            "payload": request_payload,
            "replication_policy": {"replication_budget": 9_007_199_254_740_991},
        }
        canonical = canonicalize(immutable)
        request = {
            **immutable,
            "object_id": hashlib.sha256(canonical.encode()).hexdigest(),
            "signature": author.sign(canonical),
        }
        self.assertTrue(validate_object(target))
        downstream = Identity.create()
        self.node.links[downstream.node_id] = StubLink()
        self.node.authenticated.add(downstream.node_id)
        self.node.remote_keys[downstream.node_id] = downstream.public_key
        propagated = []

        async def capture_packet(peer_id, packet_type, payload):
            propagated.append((peer_id, packet_type, payload))

        self.node.send_packet = capture_packet
        await self.node.receive_object_from("upstream", request)
        self.assertEqual(propagated[0][0], downstream.node_id)
        self.assertEqual(propagated[0][1], "OBJECT_STORE")
        self.assertEqual(propagated[0][2]["object"], request)
        self.assertTrue(self.store.is_tombstoned(target["object_id"]))
        self.assertIsNone(self.store.get_object(target["object_id"]))
        self.assertFalse(self.store.put_object(target))
        self.assertEqual(self.store.get_object(request["object_id"]), request)
        self.store.object_cache_limit_bytes = 1
        self.store._prune_objects()
        self.assertEqual(self.store.get_object(request["object_id"]), request)
        self.assertEqual(
            self.store.query_objects({"object_type": "mycelium.delete-request"})[0],
            [request],
        )
        self.store.close()
        self.store = PeerStore(self.root / "objects.sqlite3", object_cache_limit_bytes=1)
        self.node.store = self.store
        self.assertTrue(self.store.is_tombstoned(target["object_id"]))
        self.assertFalse(self.store.put_object(target))
        self.assertEqual(self.store.get_object(request["object_id"]), request)
        self.assertEqual(
            self.store.query_objects({"object_type": "mycelium.delete-request"})[0],
            [request],
        )

        version_two_target = make_v2_object(author)
        version_two_payload = {
            "command": "delete",
            "target_object_id": version_two_target["object_id"],
            "target_object_type": version_two_target["object_type"],
            "target_author": version_two_target["author"],
            "target_created_at": version_two_target["created_at"],
            "target_object_id_version": 2,
            "target_content_hash": version_two_target["content_hash"],
            "target_author_proof": version_two_target["author_proof"],
        }
        version_two_content = {
            "object_type": "mycelium.delete-request",
            "author": author.public_key,
            "created_at": created,
            "expires_at": expires,
            "payload": version_two_payload,
            "replication_policy": {"replication_budget": 9_007_199_254_740_991},
        }
        version_two_canonical = canonicalize(version_two_content)
        version_two_request = {
            **version_two_content,
            "object_id": hashlib.sha256(version_two_canonical.encode()).hexdigest(),
            "signature": author.sign(version_two_canonical),
        }
        self.assertTrue(await self.node._accept_delete_request(version_two_request))
        self.assertTrue(self.store.is_tombstoned(version_two_target["object_id"]))

    async def test_disconnect_reconnect_and_known_peers_without_discovery(self) -> None:
        remote_id = "ff:ff:ff:ff:ff:ff:ff:ff"
        if self.identity.node_id == remote_id:
            remote_id = "00:00:00:00:00:00:00:01"
        self.store.add_peer(remote_id, time.time())
        self.node.online_peers.add(remote_id)
        attempts = []
        self.node._create_offer = AsyncMock(side_effect=lambda peer: attempts.append(peer))
        await self.node.maintain_connections()
        self.assertEqual(attempts, [remote_id])
        await self.node.maintain_connections()
        self.assertEqual(attempts, [remote_id])
        self.assertIsNone(self.node.signalling)

        class ClosingPeerConnection:
            async def close(self):
                return None

        link = PeerLink.__new__(PeerLink)
        link.node = self.node
        link.peer_id = remote_id
        link.pc = ClosingPeerConnection()
        link.closed = False
        link.channel = None
        self.node.links[remote_id] = link
        self.node.authenticated.add(remote_id)
        await link.close()
        self.assertNotIn(remote_id, self.node.links)
        self.node.attempts[remote_id] = (1, 0)
        await self.node.maintain_connections()
        self.assertEqual(attempts, [remote_id, remote_id])

    async def test_peer_capacity_and_retry_selection_rotate_candidates(self) -> None:
        self.assertEqual(DEFAULT_MAX_PEERS, 16)
        self.assertLessEqual(HARD_MAX_PEERS, 64)
        with self.assertRaises(ValueError):
            PeerNode(self.identity, self.store, HARD_MAX_PEERS + 1)
        node = PeerNode(self.identity, self.store, max_peers=2)
        candidates = []
        while len(candidates) < 5:
            candidate = Identity.create().node_id
            if candidate > self.identity.node_id and candidate not in candidates:
                candidates.append(candidate)
        node.online_peers.update(candidates)
        attempted = []

        async def capture_offer(peer_id):
            attempted.append(peer_id)

        node._create_offer = AsyncMock(side_effect=capture_offer)
        await node.maintain_connections()
        first_batch = set(attempted)
        await node.maintain_connections()
        second_batch = set(attempted) - first_batch
        self.assertEqual(len(first_batch), 2)
        self.assertEqual(len(second_batch), 2)
        self.assertTrue(first_batch.isdisjoint(second_batch))
        await node.close()

    async def test_pre_auth_browser_packets_are_ignored_but_not_malformed(self) -> None:
        remote = Identity.create()
        packet = sign_packet(remote, new_packet(
            remote.node_id, self.identity.node_id, "PING", {"pingId": "before-profile"}
        ))
        with self.assertLogs(level="DEBUG") as captured:
            await self.node.handle_data(
                remote.node_id,
                json.dumps(packet, ensure_ascii=False, separators=(",", ":")),
            )
        self.assertTrue(any("pre-authentication" in line for line in captured.output))
        self.assertNotIn(remote.node_id, self.node.authenticated)

    async def test_legacy_browser_profile_fallback_is_ignored_without_authentication(self) -> None:
        remote = Identity.create()
        fallback = {
            "type": "metadata",
            "metadata": {
                "author": remote.node_id,
                "publicKey": remote.public_key,
                "displayName": "Browser peer",
                "following": True,
            },
        }
        with self.assertLogs(level="DEBUG") as captured:
            await self.node.handle_data(remote.node_id, json.dumps(fallback))
        self.assertTrue(any("non-Mycelium" in line for line in captured.output))
        self.assertNotIn(remote.node_id, self.node.authenticated)
        self.assertFalse(self.store.is_following(remote.node_id))

    async def test_malformed_packet_and_rate_limits_are_safe(self) -> None:
        remote = Identity.create()
        self.node.authenticated.add(remote.node_id)
        self.node.remote_keys[remote.node_id] = remote.public_key
        await self.node.handle_data(remote.node_id, "{" * 40)
        await self.node.handle_data(remote.node_id, "x" * (1_048_577))
        self.node.rate_windows[remote.node_id] = deque([time.monotonic()] * 120)
        before = len(self.node.packet_tasks)
        self.node.spawn_packet_task(remote.node_id, "{}")
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(len(self.node.packet_tasks), before)
        oversized_object = make_legacy_object(
            self.identity, "mycelium.post", {"content": "x" * MAX_OBJECT_BYTES}
        )
        await self.node.receive_object_from(remote.node_id, oversized_object)
        self.assertIsNone(self.store.get_object(oversized_object["object_id"]))

    async def test_packet_task_concurrency_is_bounded(self) -> None:
        started = asyncio.Event()
        release = asyncio.Event()

        async def wait_packet(peer_id, raw, source_link=None):
            started.set()
            await release.wait()

        self.node.handle_data = wait_packet
        for _ in range(MAX_PACKET_TASKS + 8):
            self.node.spawn_packet_task("peer", "{}")
        await started.wait()
        self.assertEqual(len(self.node.packet_tasks), MAX_PACKET_TASKS)
        release.set()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(len(self.node.packet_tasks), 0)

    async def test_three_peer_object_propagation_uses_regular_signed_packets(self) -> None:
        middle, end = Identity.create(), Identity.create()
        nodes = [
            self.node,
            PeerNode(middle, PeerStore(self.root / "middle.sqlite3")),
            PeerNode(end, PeerStore(self.root / "end.sqlite3")),
        ]

        class LinkedChannel:
            def __init__(self, source, target):
                self.source = source
                self.target = target
                self.readyState = "open"

            def send(self, raw):
                self.target.spawn_packet_task(self.source.identity.node_id, raw)

        def connect(left, right):
            left.links[right.identity.node_id] = StubLink(LinkedChannel(left, right))
            right.links[left.identity.node_id] = StubLink(LinkedChannel(right, left))
            left.remote_keys[right.identity.node_id] = right.identity.public_key
            right.remote_keys[left.identity.node_id] = left.identity.public_key
            left.authenticated.add(right.identity.node_id)
            right.authenticated.add(left.identity.node_id)

        connect(nodes[0], nodes[1])
        connect(nodes[1], nodes[2])
        obj = make_legacy_object(self.identity, "mycelium.post", {"content": "network relay"})
        await nodes[0].receive_object_from("external-source", obj)
        for _ in range(20):
            if nodes[2].store.get_object(obj["object_id"]):
                break
            await asyncio.sleep(0.01)
        self.assertEqual(nodes[1].store.get_object(obj["object_id"]), obj)
        self.assertEqual(nodes[2].store.get_object(obj["object_id"]), obj)
        for node in nodes[1:]:
            await node.close()
            node.store.close()

    async def test_missing_post_ancestry_is_found_and_replicated_root_first(self) -> None:
        middle, remote = Identity.create(), Identity.create()
        nodes = [
            self.node,
            PeerNode(middle, PeerStore(self.root / "ancestry-middle.sqlite3")),
            PeerNode(remote, PeerStore(self.root / "ancestry-remote.sqlite3")),
        ]

        class LinkedChannel:
            def __init__(self, source, target):
                self.source = source
                self.target = target
                self.readyState = "open"

            def send(self, raw):
                self.target.spawn_packet_task(self.source.identity.node_id, raw)

        def connect(left, right):
            left.links[right.identity.node_id] = StubLink(LinkedChannel(left, right))
            right.links[left.identity.node_id] = StubLink(LinkedChannel(right, left))
            left.remote_keys[right.identity.node_id] = right.identity.public_key
            right.remote_keys[left.identity.node_id] = left.identity.public_key
            left.authenticated.add(right.identity.node_id)
            right.authenticated.add(left.identity.node_id)

        connect(nodes[0], nodes[1])
        connect(nodes[1], nodes[2])
        root = make_legacy_object(remote, "mycelium.post", {"content": "root"})
        parent = make_legacy_object(
            remote, "mycelium.post", {"content": "parent", "reply_to": root["object_id"]}
        )
        child = make_legacy_object(
            remote, "mycelium.post", {"content": "child", "reply_to": parent["object_id"]}
        )
        nodes[2].store.put_object(root)
        nodes[2].store.put_object(parent)
        replicated = []
        async def record_replication(value, source_peer):
            replicated.append(value["object_id"])

        self.node._replicate_object = record_replication
        await self.node.receive_object_from("unconnected-source", child)

        self.assertEqual(
            replicated,
            [root["object_id"], parent["object_id"], child["object_id"]],
        )
        for obj in (root, parent, child):
            self.assertEqual(self.store.get_object(obj["object_id"]), obj)
        for node in nodes[1:]:
            await node.close()
            node.store.close()

    async def test_post_ancestry_stops_at_protocol_depth_limit(self) -> None:
        identity = Identity.create()
        chain = []
        reply_to = None
        for index in range(MAX_POST_ANCESTRY_DEPTH + 3):
            payload = {"content": str(index)}
            if reply_to:
                payload["reply_to"] = reply_to
            obj = make_legacy_object(identity, "mycelium.post", payload)
            self.store.put_object(obj)
            chain.append(obj)
            reply_to = obj["object_id"]

        ordered, newly_cached = await self.node._collect_post_chain(
            chain[-1], original_newly_cached=False
        )
        self.assertEqual(len(ordered), MAX_POST_ANCESTRY_DEPTH + 1)
        self.assertEqual(ordered[0]["object_id"], chain[-MAX_POST_ANCESTRY_DEPTH - 1]["object_id"])
        self.assertEqual(ordered[-1]["object_id"], chain[-1]["object_id"])
        self.assertEqual(newly_cached, set())


def datetime_now_plus(seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    unittest.main()
