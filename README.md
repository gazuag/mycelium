# Mycelium P2P Social

A privacy-first peer-to-peer social app prototype.

## What this prototype does

- Generates a local cryptographic identity in the browser.
- Stores identity data locally in IndexedDB.
- Exports an identity backup file.
- Connects two peers via WebRTC using a minimal signalling server.
- Sends direct text messages over an RTCDataChannel.
- Shows connection state: signalling, connecting, connected, disconnected.

## Project structure

- `src/crypto/identity.ts` — local keypair generation and fingerprint derivation.
- `src/storage/idb.ts` — IndexedDB storage for local identity.
- `src/p2p/signalling.ts` — WebSocket signalling connection.
- `src/p2p/webrtc.ts` — WebRTC peer connection and data channel.
- `server.py` — minimal Python signalling server.

## Install dependencies

```bash
cd /Users/joakimfannick/Code/mycelium
npm install
python3 -m pip install -r requirements.txt
```

## Run locally

### Frontend

```bash
npm run dev
```

Open the local URL printed by Vite.

### Signalling server

```bash
python3 server.py
```

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

## Signalling server configuration

- The frontend defaults to `ws://217.154.78.152:8765` (signalling) and `http://217.154.78.152:8000` (discovery).
- Override with `VITE_SIGNAL_SERVER_URL` and `VITE_DISCOVERY_SERVER_URL` environment variables.

### Mixed-content and TLS

When the frontend is served over **HTTPS** (e.g. Cloudflare Pages), browsers block plain `ws://` and `http://` requests (mixed-content policy). This causes `Load failed` errors on signalling and discovery, preventing peers from connecting. WebRTC data channel traffic (UDP) is unaffected once connected, but peers cannot reach the signalling stage.

To fix this, run the Python server behind a TLS-terminating reverse proxy. Example with **Caddy** (auto-TLS via Let's Encrypt):

```
yourdomain.com {
    handle /api/* {
        reverse_proxy localhost:8000
    }
    handle {
        reverse_proxy localhost:8765
    }
}
```

Then set in your Cloudflare Pages environment variables:
- `VITE_SIGNAL_SERVER_URL=wss://yourdomain.com`
- `VITE_DISCOVERY_SERVER_URL=https://yourdomain.com`

## What travels through the signalling server

- `register` messages announce your peer ID.
- `offer` / `answer` SDP messages used for WebRTC setup.
- `ice-candidate` messages used to establish the peer route.

## What travels directly between peers

- All chat text via the WebRTC `RTCDataChannel`.
- After the connection is established, no chat content is sent through the signalling server.

## Notes

- The app currently does not implement profile, discovery, following, or recommendations.
- Private keys remain on the device and are never sent to the signalling server.
