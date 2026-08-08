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
