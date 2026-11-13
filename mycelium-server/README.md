# Mycelium signalling and discovery server

This directory is a self-contained deployment of the Python signalling and
discovery service. It has no imports from or runtime dependency on the peer
bot. The local `protocol.py` contains only the signalling envelope validation
needed by this server.

## Install and start

Use Python 3.10 or newer:

```sh
./install.sh
# Edit config.env with the certificate and private key paths first.
./start.sh
```

The installer creates a local `.venv`, installs `requirements.txt`, verifies
the server imports, and creates `runtime/`. Set `TLS_CERT_PATH` and
`TLS_KEY_PATH` in `config.env` to the readable TLS certificate and private
key files. The file contains paths, not key contents. Its assignments are
read as literal values rather than sourced as shell code; whole-line
comments and quoted values are supported. Environment variables already set
in the shell take precedence. Relative paths are resolved from
`mycelium-server/`.

`config.env` also sets the bind address, port, and database path. The server
listens on `0.0.0.0:8443` by default. `DISCOVERY_DB_PATH` defaults to
`discovery.db` in this directory; set it to the existing persistent database
path when upgrading an existing deployment, or to another persistent
writable path for production. Optional limits can be set in `config.env`.

## Manage the server

```sh
./start.sh
./stop.sh
./restart.sh
if [ -f runtime/server.pid ]; then ps -p "$(cat runtime/server.pid)" -o pid=,command=; else echo 'Server is not running'; fi
tail -f runtime/server.log
```

`runtime/server.pid` records the running process, and `runtime/server.log`
receives stdout and stderr. `./stop.sh` removes a stale PID file without
signaling a process when the recorded PID is no longer running.

To update or reinstall dependencies, run `./install.sh` again.

This service relays WebRTC offers, answers, and ICE candidates and provides
optional discovery storage. It does not create, arbitrate, or own P2P
connections. Deploy and restart it independently from the Python peer in
`mycelium-peer/`.
