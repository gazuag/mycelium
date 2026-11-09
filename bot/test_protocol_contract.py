from __future__ import annotations

import json
import unittest
from pathlib import Path

from .protocol import (
    canonicalize,
    canonicalize_v3,
    fingerprint,
    is_negotiation_id,
    is_peer_fingerprint,
    should_yield_to_remote_offer,
    validate_packet_shape,
    validate_signal_message,
)

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = json.loads((ROOT / "tests" / "fixtures" / "network-contract.json").read_text())


class SharedNetworkingContractTests(unittest.TestCase):
    def test_identity_fingerprints_match_shared_fixture(self) -> None:
        identity = FIXTURE["identity"]
        self.assertEqual(fingerprint(identity["publicKey"]), identity["fingerprint"])
        for peer_id in FIXTURE["peerIds"]:
            self.assertEqual(is_peer_fingerprint(peer_id["value"]), peer_id["valid"])

    def test_negotiation_ids_and_signal_messages_match_shared_fixture(self) -> None:
        for negotiation_id in FIXTURE["negotiationIds"]:
            self.assertEqual(is_negotiation_id(negotiation_id["value"]), negotiation_id["valid"])
        for signal in FIXTURE["signals"]:
            self.assertEqual(validate_signal_message(signal["message"]), signal["valid"])
        too_long = dict(FIXTURE["signals"][0]["message"])
        too_long["payload"] = {**too_long["payload"], "negotiationId": "n" * 129}
        self.assertFalse(validate_signal_message(too_long))

    def test_simultaneous_offers_elect_the_same_lower_peer(self) -> None:
        election = FIXTURE["simultaneousOffers"]
        self.assertFalse(should_yield_to_remote_offer(election["lowerPeerId"], election["higherPeerId"]))
        self.assertTrue(should_yield_to_remote_offer(election["higherPeerId"], election["lowerPeerId"]))
        self.assertEqual(election["lowerNegotiationId"], election["winningNegotiationId"])

    def test_packet_shape_and_serialization_match_shared_fixture(self) -> None:
        for packet in FIXTURE["packets"]:
            self.assertEqual(validate_packet_shape(packet["packet"]), packet["valid"])
        canonical = FIXTURE["canonicalization"]
        self.assertEqual(canonicalize(canonical["value"]), canonical["v1"])
        self.assertEqual(canonicalize_v3(canonical["value"]), canonical["v3"])

    def test_portable_peer_sources_are_kept_identical(self) -> None:
        for filename in ("peer.py", "protocol.py", "store.py"):
            with self.subTest(filename=filename):
                self.assertEqual(
                    (ROOT / "bot" / filename).read_bytes(),
                    (ROOT / "mycelium-peer" / "bot" / filename).read_bytes(),
                )


if __name__ == "__main__":
    unittest.main()
