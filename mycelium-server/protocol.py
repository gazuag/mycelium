from __future__ import annotations

import math
import re
from typing import Any

PEER_ID_PATTERN = re.compile(r"^(?:[0-9a-f]{2}:){7}[0-9a-f]{2}$", re.IGNORECASE)
MAX_NEGOTIATION_ID_LENGTH = 128


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


def is_peer_fingerprint(value: Any) -> bool:
    return isinstance(value, str) and PEER_ID_PATTERN.fullmatch(value) is not None


def is_negotiation_id(value: Any) -> bool:
    return (
        isinstance(value, str)
        and bool(value.strip())
        and len(value) <= MAX_NEGOTIATION_ID_LENGTH
    )


def validate_signal_message(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    kind = value.get("type")
    sender, recipient = value.get("from"), value.get("to")
    payload = value.get("payload")
    if (
        kind not in ("offer", "answer", "ice-candidate")
        or not is_peer_fingerprint(sender)
        or not is_peer_fingerprint(recipient)
        or not isinstance(payload, dict)
        or not is_negotiation_id(payload.get("negotiationId"))
    ):
        return False
    if kind in ("offer", "answer"):
        sdp = payload.get("sdp")
        return (
            payload.get("type") == kind
            and isinstance(sdp, str)
            and 0 < len(sdp) <= 100_000
        )
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
    return (
        isinstance(candidate_line, str)
        and len(candidate_line) <= 2_048
        and (sdp_mid is None or isinstance(sdp_mid, str))
        and (
            sdp_line is None
            or (is_safe_integer(sdp_line) and sdp_line >= 0)
        )
        and (username_fragment is None or isinstance(username_fragment, str))
    )
