# Mycelium P2P Social

A privacy-first peer-to-peer social app prototype.

## What this prototype does

- Generates a local cryptographic identity in the browser.
- Stores identity data locally in IndexedDB.
- Exports an identity backup file.
- Connects two peers via WebRTC using a minimal signalling server.
- Sends direct text messages over an RTCDataChannel.
- Publishes and fetches discovery posts via the Mycelium Protocol over WebSocket.
- Shows connection state: signalling, connecting, connected, disconnected.

## Project structure

- `src/crypto/identity.ts` — local keypair generation and fingerprint derivation.
- `src/storage/idb.ts` — IndexedDB storage for local identity.
- `src/p2p/signalling.ts` — WebSocket signalling connection.
- `src/p2p/webrtc.ts` — WebRTC peer connection and data channel.
- `src/services/discovery.ts` — discovery publish/fetch over the signalling WebSocket.
- `server.py` — Python WebSocket server handling signalling and discovery on a single port.

## Install dependencies

```bash
npm install
python3 -m pip install -r requirements.txt
```

## Run locally

### Frontend

```bash
npm run dev
```

Open the local URL printed by Vite.

### Server

```bash
python3 server.py
```

The server listens on a single WebSocket port (`ws://0.0.0.0:8765`) and handles both peer signalling and discovery — no HTTP is used.

## Testing with two browser windows or devices

1. Open the app in two browser windows or two devices.
2. Create a local identity in each instance.
3. Copy the displayed `Local ID` from one instance into the other's remote peer field.
4. Click `Connect`.
5. Wait until status changes to `Connected`.
6. Send a chat message.

## Deploying the frontend to Cloudflare Pages

- Build the static site with `npm run build`.
- Deploy the generated `dist` folder as a static site.
- The app is a static PWA and does not need a server for the UI.

## Server configuration

- The frontend defaults to `ws://217.154.78.152:8765` for all server communication (signalling and discovery).
- Override with the `VITE_SIGNAL_SERVER_URL` environment variable.

### Mixed-content and TLS

When the frontend is served over **HTTPS** (e.g. Cloudflare Pages), browsers block plain `ws://` WebSocket connections (mixed-content policy). Run the server behind a TLS-terminating reverse proxy. Example with **Caddy** (auto-TLS via Let's Encrypt):

```
yourdomain.com {
    reverse_proxy localhost:8765
}
```

Then set in your Cloudflare Pages environment variables:
- `VITE_SIGNAL_SERVER_URL=wss://yourdomain.com`

## What travels through the signalling server

- `register` messages announce your peer ID.
- `offer` / `answer` SDP messages used for WebRTC setup.
- `ice-candidate` messages used to establish the peer route.
- `DISCOVERY_PUBLISH` packets to store a public post.
- `DISCOVERY_GET` packets to fetch public posts; the server replies with a `DISCOVERY_RESULT` packet.

## What travels directly between peers

- All chat text via the WebRTC `RTCDataChannel`.
- After the connection is established, no chat content is sent through the signalling server.

## Notes

- Private keys remain on the device and are never sent to the server.

# Mycelium Protocol

Mycelium Protocol (MYP) v1 Draft
Purpose
The Mycelium Protocol (MYP) is the peer-to-peer protocol used by Mycelium, a decentralized social network.
The protocol is designed around the following principles:
* No central authority.
* No central user database.
* Identities are cryptographic keypairs.
* Peers communicate directly whenever possible.
* Servers are only used for signalling and optional discovery.
* Every object is cryptographically signed.
* All private communication is end-to-end encrypted.
* The protocol should be versioned and extensible.

⸻

General Principles
Everything exchanged between peers is a packet.
Packets transport one or more objects.
Examples:
* Profile
* Post
* Message
* Like
* Relay Envelope
Objects have their own structure.
Packets only transport them.

⸻

Protocol Version
Protocol: mycelium
Version: 1
Future protocol versions must remain backward compatible whenever practical.

⸻

Packet Format
Every packet follows the same outer structure.
{
  "protocol": "mycelium",
  "version": 1,
  "id": "<UUID>",
  "type": "<PACKET_TYPE>",
  "timestamp": "<UTC ISO8601>",
  "sender": "<Sender Node ID>",
  "recipient": "<Recipient Node ID|null>",
  "payload": {},
  "signature": "<Digital Signature>"
}
Fields
protocol
Always:
mycelium
version
Current protocol version.
id
Globally unique packet identifier.
Used for:
* deduplication
* acknowledgements
* relay
* debugging
type
Packet type.
timestamp
Creation time.
sender
Node ID of sender.
recipient
Target node.
May be null for broadcasts or discovery.
payload
Packet-specific data.
signature
Digital signature covering the canonical representation of the packet.

⸻

Identity
Each node owns:
* private key
* public key
The private key never leaves the device.
The public key identifies the node.
Every identity also has a shorter Node ID.
Example:
myc:89A7D2317B5C
The Node ID is derived from the public key.
It is only a convenience identifier.
The full public key remains authoritative.

⸻

Session Layer
These packets only exist during an active peer connection.
HELLO
Sent immediately after connection.
Payload:
Node ID
Nickname
Software version
Protocol version
Capabilities
Purpose:
* verify compatibility
* exchange basic information

⸻

PING
Sent periodically.
Purpose:
* keep NAT mappings alive
* detect disconnects
* measure latency

⸻

PONG
Reply to PING.

⸻

GOODBYE
Optional clean disconnect.

⸻

Capability Negotiation
HELLO contains:
capabilities = [
    "profiles",
    "posts",
    "messages",
    "relay-v1"
]
Peers should only use functionality supported by both sides.

⸻

Profile Packets
PROFILE_REQUEST
Request profile information.

⸻

PROFILE_RESPONSE
Returns a signed Profile object.

⸻

PROFILE_UPDATE
Sent whenever the local profile changes while connected.

⸻

Post Packets
POST_REQUEST
Request posts newer than a given timestamp.
Payload:
since
limit

⸻

POST_BATCH
Returns multiple posts.
Payload:
posts[]

⸻

POST
Single new post.

⸻

Messaging
MESSAGE
Carries an encrypted direct message.
Payload contains encrypted message object.
Only sender and recipient should be able to decrypt it.

⸻

MESSAGE_ACK
Acknowledges successful receipt.
This only confirms delivery.
It does NOT imply the message has been read.

⸻

READ_RECEIPT (optional)
Optional feature.
Should be user-configurable.
Disabled by default.

⸻

Discovery
These packets are exchanged only between client and discovery server.
They are never used peer-to-peer.
DISCOVERY_PUBLISH
Submit a signed public post.

⸻

DISCOVERY_GET
Request discovery posts.
Parameters may include:
* limit
* optional tags

⸻

DISCOVERY_RESULT
Returns a collection of signed posts.

⸻

Relay (Version 2)
Relay functionality should be implemented after Version 1.
Proposed packets:
RELAY_OFFER
A relay node informs the recipient that it possesses an encrypted message.
RELAY_REQUEST
Recipient requests delivery.
RELAY_ALREADY_HAVE
Recipient already received it.
Relay node deletes its copy.
RELAY_DELIVER
Transfers encrypted message.
Every relayed message contains:
* destination Node ID
* TTL
* message ID
The relay cannot decrypt the message contents.
Only the intended recipient can.

⸻

Presence
Future packet.
STATUS
Possible values:
* online
* away
* busy
Offline is implied by loss of connection.

⸻

Objects
Objects are transported inside packets.

⸻

Profile
publicKey
nodeId
nickname
bio
updated
signature
Signed by owner.

⸻

Post
id
author
timestamp
content
tags[]
signature
Posts are immutable.
Edits create new posts.

⸻

Direct Message
id
from
to
created
ciphertext
signature
The ciphertext contains the actual message.

⸻

Packet Signing
Every packet should be digitally signed.
The signature should cover the canonical serialized packet.
Do not sign arbitrary JSON formatting.
Use deterministic serialization.

⸻

Encryption
Public objects:
* profiles
* posts
are signed only.
Private objects:
* direct messages
are encrypted for the recipient before transmission.
Relays must never be able to decrypt forwarded messages.

⸻

Synchronization
Synchronization should avoid repeatedly transferring identical data.
Rather than blindly requesting all posts, peers should eventually exchange synchronization information.
Future versions may use:
* timestamps
* object counts
* hashes
* state vectors
to determine what each side is missing.
This should be designed so synchronization remains efficient as networks grow.

⸻

Error Handling
Future packet types:
ERROR
Contains:
code
message
relatedPacketId
Possible errors:
* unsupported protocol version
* malformed packet
* invalid signature
* unauthorized request
* unknown packet type

⸻

Design Goals
The protocol should:
* remain human-readable during development
* be easy to debug
* remain extensible
* avoid unnecessary server involvement
* support offline operation where practical
* support future relay networking
* preserve user privacy
* minimize bandwidth
* support long-term compatibility
The protocol should never depend on a centralized account system or centralized social graph.
The cryptographic identity is the user’s identity.