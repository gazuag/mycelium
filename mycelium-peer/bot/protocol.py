from __future__ import annotations

import base64
import hashlib
import json
import math
import re
import unicodedata
from dataclasses import dataclass
from typing import Any

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils
from cryptography.exceptions import InvalidSignature

MAX_PACKET_BYTES = 1_048_576
MAX_OBJECT_BYTES = 262_144
HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
PEER_ID_PATTERN = re.compile(r"^(?:[0-9a-f]{2}:){7}[0-9a-f]{2}$", re.IGNORECASE)
MAX_NEGOTIATION_ID_LENGTH = 128


def is_peer_fingerprint(value: Any) -> bool:
    return isinstance(value, str) and PEER_ID_PATTERN.fullmatch(value) is not None


def is_negotiation_id(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= MAX_NEGOTIATION_ID_LENGTH


def should_yield_to_remote_offer(local_peer_id: str, remote_peer_id: str) -> bool:
    return local_peer_id > remote_peer_id


def validate_signal_message(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    kind = value.get("type")
    sender, recipient = value.get("from"), value.get("to")
    payload = value.get("payload")
    if (kind not in ("offer", "answer", "ice-candidate")
            or not is_peer_fingerprint(sender)
            or not is_peer_fingerprint(recipient)
            or not isinstance(payload, dict)):
        return False
    negotiation_id = payload.get("negotiationId")
    if not is_negotiation_id(negotiation_id):
        return False
    if kind in ("offer", "answer"):
        sdp = payload.get("sdp")
        return payload.get("type") == kind and isinstance(sdp, str) and 0 < len(sdp) <= 100_000
    if "candidate" not in payload:
        return False
    candidate = payload["candidate"]
    if candidate is None:
        return True
    if not isinstance(candidate, dict):
        return False
    candidate_line = candidate.get("candidate")
    sdp_mid = candidate.get("sdpMid")
    sdp_line = candidate.get("sdpMLineIndex")
    username_fragment = candidate.get("usernameFragment")
    return (isinstance(candidate_line, str) and len(candidate_line) <= 2048
            and (sdp_mid is None or isinstance(sdp_mid, str))
            and (sdp_line is None or (is_safe_integer(sdp_line) and sdp_line >= 0))
            and (username_fragment is None or isinstance(username_fragment, str)))


def is_safe_integer(value: Any) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return (
            math.isfinite(float(value))
            and float(value).is_integer()
            and abs(value) <= 9_007_199_254_740_991
        )
    except OverflowError:
        return False


def _stringify_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _number_text(value: int | float) -> str:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("non-finite JSON number")
    if number == 0:
        return "0"
    text = repr(number).lower()
    if "e" not in text:
        if text.endswith(".0"):
            text = text[:-2]
        return text
    mantissa, exponent_text = text.split("e", 1)
    exponent = int(exponent_text)
    if -6 <= exponent < 21:
        from decimal import Decimal

        fixed = format(Decimal(text), "f")
        if "." in fixed:
            fixed = fixed.rstrip("0").rstrip(".")
        return fixed
    if mantissa.endswith(".0"):
        mantissa = mantissa[:-2]
    return f"{mantissa}e{'+' if exponent >= 0 else ''}{exponent}"


def _is_array_index(key: str) -> bool:
    if not key.isascii() or not key.isdigit() or (len(key) > 1 and key[0] == "0"):
        return False
    try:
        return int(key) < 4_294_967_295
    except ValueError:
        return False


def _locale_key(key: str) -> tuple[str, str]:
    # Protocol v1 uses JavaScript's localeCompare. Its object keys are normally
    # ASCII protocol names; this produces the same collation for those names.
    normalized = unicodedata.normalize("NFD", key).casefold()
    return normalized, key


def _v1(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _stringify_string(value)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _number_text(value)
    if isinstance(value, list):
        return "[" + ",".join(_v1(item) for item in value) + "]"
    if isinstance(value, dict):
        keys = list(value)
        indices = sorted((key for key in keys if isinstance(key, str) and _is_array_index(key)), key=int)
        regular = sorted((key for key in keys if key not in indices), key=_locale_key)
        return "{" + ",".join(
            f"{_stringify_string(key)}:{_v1(value[key])}" for key in indices + regular
        ) + "}"
    raise ValueError("unsupported JSON value")


def _utf16_sort_key(key: str) -> bytes:
    return key.encode("utf-16-be", errors="surrogatepass")


def _v3(value: Any) -> str:
    if value is None or isinstance(value, (bool, str)):
        if isinstance(value, str):
            return _stringify_string(value)
        return "true" if value is True else "false" if value is False else "null"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _number_text(value)
    if isinstance(value, list):
        return "[" + ",".join(_v3(item) for item in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value, key=_utf16_sort_key)
        return "{" + ",".join(
            f"{_stringify_string(key)}:{_v3(value[key])}" for key in keys
        ) + "}"
    raise ValueError("unsupported JSON value")


def canonicalize(value: Any) -> str:
    return _v1(value)


def canonicalize_v3(value: Any) -> str:
    return _v3(value)


def _decode_base64(value: str) -> bytes:
    return base64.b64decode(value, validate=True)


def fingerprint(public_key: str) -> str:
    digest = hashlib.sha256("".join(public_key.split()).encode("utf-8")).digest()[:8]
    return ":".join(f"{byte:02x}" for byte in digest)


@dataclass
class Identity:
    public_key: str
    private_key: str

    @property
    def node_id(self) -> str:
        return fingerprint(self.public_key)

    @classmethod
    def create(cls) -> Identity:
        private = ec.generate_private_key(ec.SECP256R1())
        return cls(
            public_key=base64.b64encode(private.public_key().public_bytes(
                serialization.Encoding.DER,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )).decode("ascii"),
            private_key=base64.b64encode(private.private_bytes(
                serialization.Encoding.DER,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )).decode("ascii"),
        )

    @classmethod
    def load(cls, public_key: str, private_key: str) -> Identity:
        key = serialization.load_der_private_key(_decode_base64(private_key), password=None)
        if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
            raise ValueError("identity private key must be P-256")
        derived_public = base64.b64encode(key.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )).decode("ascii")
        if derived_public != public_key:
            raise ValueError("identity public and private keys do not match")
        return cls(public_key, private_key)

    def sign(self, data: str) -> str:
        key = serialization.load_der_private_key(_decode_base64(self.private_key), password=None)
        der_signature = key.sign(data.encode("utf-8"), ec.ECDSA(hashes.SHA256()))
        r, s = utils.decode_dss_signature(der_signature)
        return base64.b64encode(r.to_bytes(32, "big") + s.to_bytes(32, "big")).decode("ascii")


def verify_signature(public_key: str, data: str, signature: str) -> bool:
    try:
        key = serialization.load_der_public_key(_decode_base64(public_key))
        raw_signature = _decode_base64(signature)
        if (not isinstance(key, ec.EllipticCurvePublicKey)
                or not isinstance(key.curve, ec.SECP256R1)
                or len(raw_signature) != 64):
            return False
        der_signature = utils.encode_dss_signature(
            int.from_bytes(raw_signature[:32], "big"),
            int.from_bytes(raw_signature[32:], "big"),
        )
        key.verify(der_signature, data.encode("utf-8"), ec.ECDSA(hashes.SHA256()))
        return True
    except (ValueError, TypeError, InvalidSignature):
        return False


def packet_unsigned(packet: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in packet.items() if key != "signature"}


def sign_packet(identity: Identity, packet: dict[str, Any]) -> dict[str, Any]:
    unsigned = dict(packet)
    unsigned.pop("signature", None)
    return {**unsigned, "signature": identity.sign(canonicalize(unsigned))}


def validate_packet_shape(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    if (value.get("protocol") != "mycelium"
            or type(value.get("version")) is not int or value.get("version") != 1
            or not isinstance(value.get("id"), str)
            or not isinstance(value.get("type"), str)
            or not isinstance(value.get("timestamp"), str)
            or not isinstance(value.get("sender"), str)
            or (value.get("recipient") is not None and not isinstance(value.get("recipient"), str))
            or not isinstance(value.get("payload"), dict)
            or not isinstance(value.get("signature"), str)):
        return False
    return True


def valid_object_shape(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    if (not isinstance(value.get("object_id"), str) or not HEX_SHA256.fullmatch(value["object_id"])
            or not isinstance(value.get("object_type"), str) or not value["object_type"]
            or not isinstance(value.get("author"), str) or not value["author"]
            or not isinstance(value.get("created_at"), str)
            or not isinstance(value.get("payload"), (dict, list, str, int, float, bool, type(None)))
            or not isinstance(value.get("signature"), str) or not value["signature"]
            or not isinstance(value.get("replication_policy"), dict)):
        return False
    for field in ("recipient", "expires_at"):
        if field in value and not isinstance(value[field], str):
            return False
    if "recipient" in value and not value["recipient"]:
        return False
    if "sequence" in value and (
        not is_safe_integer(value["sequence"]) or value["sequence"] < 0
    ):
        return False
    try:
        json.dumps(value["payload"], allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        return False
    policy = value["replication_policy"]
    budget = policy.get("replication_budget")
    if "replication_budget" in policy and (not is_safe_integer(budget) or budget < 0):
        return False
    if "expires_at" in policy:
        if not isinstance(policy["expires_at"], str):
            return False
    try:
        from datetime import datetime

        datetime.fromisoformat(value["created_at"].replace("Z", "+00:00"))
        if value.get("expires_at") is not None:
            datetime.fromisoformat(value["expires_at"].replace("Z", "+00:00"))
        if "expires_at" in policy:
            datetime.fromisoformat(policy["expires_at"].replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return False
    return True


def validate_object(value: Any) -> bool:
    if not valid_object_shape(value):
        return False
    author = value["author"]
    object_id = value["object_id"]
    version = value.get("object_id_version")
    try:
        if version is None:
            if "content_hash" in value or "author_proof" in value:
                return False
            immutable = immutable_object_content(value)
            content = canonicalize(immutable)
            if hashlib.sha256(content.encode("utf-8")).hexdigest() != object_id:
                return False
            return verify_signature(author, content, value["signature"])
        if version not in (2, 3):
            return False
        content_hash = value.get("content_hash")
        if not isinstance(content_hash, str) or not HEX_SHA256.fullmatch(content_hash):
            return False
        immutable = immutable_object_content(value)
        content = canonicalize_v3(immutable) if version == 3 else canonicalize(immutable)
        if hashlib.sha256(content.encode("utf-8")).hexdigest() != content_hash:
            return False
        if version == 2:
            if not isinstance(value.get("author_proof"), str) or not value["author_proof"]:
                return False
            expected_id = hashlib.sha256(canonicalize({
                "domain": "mycelium.object-id.v2",
                "author": author,
                "content_hash": content_hash,
            }).encode("utf-8")).hexdigest()
            proof = canonicalize({
                "domain": "mycelium.object-author-proof.v2",
                "author": author,
                "content_hash": content_hash,
            })
            return (object_id == expected_id
                    and verify_signature(author, proof, value["author_proof"])
                    and verify_signature(author, canonicalize(immutable), value["signature"]))
        if "author_proof" in value:
            return False
        proof = canonicalize_v3({
            "domain": "mycelium.object-signature.v3",
            "object_id": object_id,
            "content_hash": content_hash,
        })
        return verify_signature(author, proof, value["signature"])
    except (ValueError, TypeError, OverflowError, RecursionError, UnicodeError):
        return False


def immutable_object_content(value: dict[str, Any]) -> dict[str, Any]:
    result = {
        "object_type": value["object_type"],
        "author": value["author"],
    }
    for field in ("recipient", "created_at", "expires_at", "sequence"):
        if field in value:
            result[field] = value[field]
    result["payload"] = value["payload"]
    result["replication_policy"] = value["replication_policy"]
    return result


def object_expired(value: dict[str, Any], now: float | None = None) -> bool:
    from datetime import datetime, timezone

    boundary = value.get("expires_at", value.get("replication_policy", {}).get("expires_at"))
    if not isinstance(boundary, str):
        return False
    try:
        expires = datetime.fromisoformat(boundary.replace("Z", "+00:00"))
    except ValueError:
        return True
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    current = datetime.now(timezone.utc).timestamp() if now is None else now
    return expires.timestamp() <= current
