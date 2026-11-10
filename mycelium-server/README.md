# Mycelium signalling and discovery server

This directory is a self-contained deployment of the Python signalling and
discovery service. It has no imports from or runtime dependency on the peer
bot. The local `protocol.py` contains only the signalling envelope validation
needed by this server.

## Install and run

Use Python 3.10 or newer:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
TLS_CERT_PATH=/path/to/server.crt \
TLS_KEY_PATH=/path/to/server.key \
python server.py
```

The server requires TLS certificate and private-key paths. It listens on
`0.0.0.0:8443` by default; `SIGNAL_HOST` and `SIGNAL_PORT` may override the
bind address. `DISCOVERY_DB_PATH` defaults to `discovery.db` in this
directory, regardless of the process working directory. Set it to the
existing persistent database path when upgrading an existing deployment, or
to another persistent writable path for production.

This service relays WebRTC offers, answers, and ICE candidates and provides
optional discovery storage. It does not create, arbitrate, or own P2P
connections. Deploy and restart it independently from the Python peer in
`mycelium-peer/`.
