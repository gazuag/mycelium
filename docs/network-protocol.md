# Mycelium networking and protocol contract

This document is the canonical contract for the browser, Python peers, and
discovery/signalling server. The TypeScript browser implementation defines
client behavior. Python implementations must remain wire-compatible; the
server relays WebRTC signalling and serves optional discovery, but does not
select, own, or maintain P2P connections.

The shared vectors in [`tests/fixtures/network-contract.json`](../tests/fixtures/network-contract.json)
are normative examples for identity fingerprints, signalling envelopes,
negotiation election, packet shape, and canonical serialization. Both
TypeScript and Python tests consume that same file. A change to a contract
field, validation rule, or negotiation policy must update this document, the
shared vectors, and the implementations/tests in the same change.

## Responsibilities and source locations

| Responsibility | Reference implementation |
| --- | --- |
| Browser signalling and negotiation | `src/p2p/signalling.ts`, `src/p2p/webrtc.ts`, and `src/App.tsx` |
| Browser MYP packet envelope and object transport | `src/p2p/protocol.ts`, `src/p2p/object-transport.ts`, and `src/object-layer/` |
| Python peer signalling, negotiation, packet handling | `bot/protocol.py` and `bot/peer.py` |
| Signalling relay and discovery storage | `server.py` |
| Portable Python deployment copy | `mycelium-peer/bot/`; it is a checked-in distribution copy, not a separate protocol authority |

`bot/` is the canonical Python source in this repository. The portable
`mycelium-peer/` distribution intentionally duplicates the bot modules to
preserve its standalone deployment paths. `bot.test_protocol_contract` checks
that `peer.py`, `protocol.py`, and `store.py` stay byte-identical across the
two locations. Update both copies when changing those modules; do not move or
rename the portable files without updating its installer and service scripts.

## Identity and peer IDs

- Signing identities are P-256 ECDSA key pairs. Public keys are base64-encoded
  DER SubjectPublicKeyInfo values.
- A peer ID is the first eight bytes of SHA-256 over the UTF-8 bytes of the
  public-key base64 string after removing whitespace, rendered as eight
  two-digit hexadecimal bytes separated by colons. Implementations emit
  lowercase IDs; validators accept either hex case for compatibility.
- A peer must prove its ID by presenting its public key in a signed
  `PROFILE_UPDATE` or `PROFILE_RESPONSE`. A receiver verifies the packet
  signature and recomputes the fingerprint before authenticating the peer.
- A peer ID is a routing identifier, not a claim about a person's identity.
  Signed identity profile objects bind display metadata and optional
  encryption-key material to the public signing key; they do not replace
  connection-profile authentication.

## Signalling WebSocket

All signalling messages are JSON objects. The WebSocket uses `ws://` only on
loopback and `wss://` for deployed endpoints.

### Registration and online peer lists

| Message | Fields |
| --- | --- |
| `register` | Required: `type: "register"`, `id: <peer fingerprint>` |
| `peer-list-request` | Required: `type`, `id` (the registered peer ID), and non-empty `requestId` (at most 128 characters) |
| `peer-list` | Required: `type`, `peers: string[]`; optional: `requestId` to correlate a request |

The server broadcasts an online peer list after registration changes and
answers authenticated peer-list requests. A peer list is a transient view of
signalling connections; it is not an authoritative P2P membership list.

### Offers, answers, and ICE

The shared envelope is:

```json
{
  "type": "offer | answer | ice-candidate",
  "from": "<sender fingerprint>",
  "to": "<recipient fingerprint>",
  "payload": {}
}
```

`from` must match the sender's active WebSocket registration. Both peer IDs
must be valid fingerprints. The server validates and routes the envelope; it
does not interpret SDP, nominate a winner, or assert that a P2P link is open.
Signals for an offline recipient are queued for at most 60 seconds, with at
most 32 queued messages per recipient.

| Signal | Required payload fields | Validation |
| --- | --- | --- |
| `offer` | `type: "offer"`, non-empty `sdp`, `negotiationId` | SDP is at most 100,000 characters; ID is non-empty after trimming and at most 128 characters |
| `answer` | `type: "answer"`, non-empty `sdp`, `negotiationId` | Same limits as offers |
| `ice-candidate` | `negotiationId`, `candidate` | Candidate is `null` for end-of-candidates, or an object with a string `candidate` (at most 2,048 characters), optional nullable string `sdpMid`, optional nullable non-negative safe-integer `sdpMLineIndex`, and optional nullable string `usernameFragment` |

Every offer creates a fresh negotiation ID. Answers and ICE candidates repeat
the ID of the offer they belong to. A receiver must ignore an answer or ICE
candidate whose ID is not the active negotiation ID. A candidate may arrive
before the remote description; queue it only for that same active negotiation
and discard it when that negotiation is abandoned.

### Deterministic simultaneous-offer policy

Peer IDs are compared lexicographically as their canonical lowercase ASCII
fingerprints. The lower ID is the elected initiator; it is impolite and keeps
its outgoing offer. The higher ID is polite and yields a colliding outgoing
offer by rolling it back (browser) or closing its losing outgoing
`RTCPeerConnection` (Python), then accepting the lower ID's offer. It must not
replace an established link or an already-active inbound negotiation with a
competing offer.

Normal retries respect this election. Recovery may force an offer when needed,
but it uses the same tie-break: forced initiation does not create a second
election policy. The peer that yields discards its abandoned negotiation ID,
data-channel state, and candidates. The winning negotiation ID remains active
through answer, ICE processing, and data-channel establishment.

This policy resolves glare only when both peers apply it. The discovery server
does not arbitrate. Each client owns one connection manager/link per remote
peer; a new negotiation must not create a competing manager while an active
link or attempt already exists.

### Capacity, retries, and signalling interruptions

Capacity counts open data channels and admitted pending attempts. The browser
keeps its existing limits (preferred target 10, hard maximum 20, at most four
simultaneous reservations); inbound attempts may be admitted above the
preferred target until the hard maximum is reached. The Python bot keeps its
configured peer target (default 16, hard maximum 64). These are local resource
policies, not signalling-server limits.

An outbound browser attempt must be admitted before constructing its
`RTCPeerConnection`. Inbound offers reserve capacity before creating a
manager. A reservation is released on open, failure, cancellation, timeout,
or signalling disconnection. Deferred attempts must not allocate a manager.
The bot maintains at most one live link per peer and closes an unopened
negotiation when its signalling WebSocket disconnects; an already-open P2P
data channel survives a signalling interruption. Both implementations retain
their existing retry/backoff policies and close failed or timed-out links
before a subsequent attempt.

The browser's normal attempt timeout is 30 seconds (recovery attempts use 15
seconds); its ICE-disconnected manager replacement grace is 15 seconds. The
bot closes a link that does not open within 45 seconds and closes an ICE link
that remains disconnected for 20 seconds. The server's offline-signal queue
has a default TTL of 60 seconds and a default maximum of 32 messages per
recipient; deployments may override these two server settings. Queued
signalling is best-effort, not a durable negotiation record.

## P2P data channel and MYP v1

After WebRTC negotiation, Mycelium packets travel directly over the data
channel (the browser-created channel label is `chat`). No chat, object, or
connection-lifecycle payload is routed through the signalling server.

The common packet envelope is:

| Field | Type | Contract |
| --- | --- | --- |
| `protocol` | string | Exactly `"mycelium"` |
| `version` | integer | Exactly `1` (booleans are not integers) |
| `id` | string | Packet correlation/identity value |
| `type` | string | One of the packet types below; unknown types are ignored |
| `timestamp` | string | UTC timestamp generated by the sender |
| `sender` | string | Sender peer fingerprint |
| `recipient` | string or `null` | Recipient fingerprint, or `null` for broadcast |
| `payload` | object | Type-specific JSON object; arrays are not valid payload objects |
| `signature` | string | Signature value; `"unsigned-v1"` is accepted only where the packet's handler permits unsigned packets |

Signed packets sign the complete envelope except `signature`, after recursive
canonical JSON serialization. P-256 ECDSA/SHA-256 signatures are encoded as
base64 of the fixed-width 32-byte `r` followed by 32-byte `s`. Distributed
objects have their own object-level signature and validation rules; packet
signing does not replace object-signature verification.

The current packet families and their payload contracts are:

| Types | Required payload fields / behavior |
| --- | --- |
| `HELLO` | `nodeId`, `nickname`, `softwareVersion`, integer `protocolVersion`, and string-array `capabilities`; advertises peer capabilities |
| `PING`, `PONG` | `pingId` and `sentAt`; `PONG` echoes the ping correlation |
| `GOODBYE` | No required payload fields; closes the peer link |
| `PROFILE_REQUEST` | Empty object; requests the signed connection profile |
| `PROFILE_UPDATE`, `PROFILE_RESPONSE` | `profile` (legacy-compatible `metadata` may be read); contains the public key and profile fields and is packet-signed by that key. The derived fingerprint must match `sender` |
| `IDENTITY_PROFILE_REQUEST` | `requestId` string, at most 128 characters |
| `IDENTITY_PROFILE_RESPONSE` | Matching `requestId` and `object` (signed `mycelium.identity` distributed object) |
| `OBJECT_STORE` | `object`: one validated signed distributed object |
| `OBJECT_BATCH` | `objects`: array of up to 50 distributed objects; optional `page` carries feed pagination metadata |
| `POST_REQUEST` | Optional `since` timestamp, `limit` (1–200), `after` cursor (`created_at`, `object_id`), and `requestId` (at most 128 characters) |
| `FIND` | `requested_objects`, `object_id`, `requestId`, `ttl`, and `expiresAt`; optional query filters include object type, author, recipient, time bounds, cursor, limit, order, and author-connected status |
| `FIND_RESPONSE` | `objects`, `object_id`, `requestId`; optional `object`, `origin`, `expiresAt`, `complete`, `pagination_supported`, and `has_more` |
| `PEER_LIST_REQUEST`, `PEER_LIST_RESPONSE` | `requestId`; peer lists are connection-local gossip, not server registration state |
| `DISCOVERY_PUBLISH` | `object`: a publishable signed public object; the server stores discovery data only |
| `DISCOVERY_GET`, `DISCOVERY_RESULT` | `requestId` plus discovery query/result fields; responses are correlated to a request |
| `PEER_POOL_GET`, `PEER_POOL_RESULT` | `requestId` and peer-list result fields; suggestions do not establish or authorize a connection |
| `POPULAR_PEERS_GET`, `POPULAR_PEERS_RESULT` | `requestId` and popular-peer result fields, optionally including validated identity profiles |
| `ERROR` | Error details for the relevant request; it does not change peer ownership or link state |

Object-store packets carry the existing signed object format, including
`object_id`, `object_type`, `author`, `created_at`, `payload`, `signature`,
and `replication_policy`; optional object fields include `recipient`,
`expires_at`, `sequence`, and versioned content-hash/proof data. Object
serialization, object-specific payload schemas, deletion tombstones, direct
messages, and storage semantics remain defined by the object-layer code and
the [draft object-protocol document](../Mycelium%20Distributed%20Object%20Protocol%20%E2%80%94%20Draft%20Specification.md).
Changes to those wire shapes must also add shared cross-language vectors and
tests here; this document does not authorize changing object formats or
storage semantics.

### Versioning and compatibility

The packet envelope currently has version `1`; `HELLO.protocolVersion` is
also `1`. There is no negotiation for incompatible major versions. A
breaking envelope, signature, negotiation-ID, or object-format change must
use a new version and an explicit compatibility plan rather than silently
changing version-1 meaning. Additive optional fields are compatible only when
older implementations safely ignore them and the relevant handler tests
prove that behavior. Unknown packet types must not be interpreted as a
different existing type.

The shared fixture tests cover valid and invalid signal envelopes, fingerprint
and negotiation-ID validation, simultaneous-offer election, packet shape,
and canonical serialization. The Playwright interoperability test runs the
real browser against the Python bot through the local Python signalling
server and verifies glare resolution, authentication, and one open data
channel. Python bot/server unit tests and the TypeScript suite provide the
remaining per-implementation checks.

## Change checklist

For any network/protocol change:

1. Update this specification and `tests/fixtures/network-contract.json`.
2. Update the TypeScript reference and both Python implementation copies as
   applicable.
3. Add a TypeScript and Python test consuming the shared vector; add a
   deterministic interaction test for lifecycle changes.
4. Run `npm test`, `npm run build`, the Python bot/server tests, and
   `npm run test:integration:network`.
5. Keep `bot/` and `mycelium-peer/bot/` synchronized and keep their dependency
   requirements self-contained.
