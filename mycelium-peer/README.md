# Mycelium Peer

This is a portable distribution of the Mycelium Python WebRTC peer. It uses
the existing Mycelium signalling service, validates and relays peer objects,
and stores its identity and cache in SQLite under `data/` by default.

## Install and start

Copy the complete `mycelium-peer/` directory to a Unix/Linux-compatible
computer. The scripts locate the installation from their own path, so they
work from any current directory. Run:

```sh
./install.sh
./start.sh
```

The installer creates a local `.venv`, installs `requirements.txt`, verifies
aiortc and its PyAV dependency, and creates `data/` and `runtime/`. It does not
leave the peer running. If a copied `.venv` cannot run on the target computer,
the installer recreates it there.

The requirements file is self-contained so a copied distribution does not
depend on files outside `mycelium-peer/`. This directory is the canonical
location for the Python peer implementation; it has no source or runtime
dependency on `mycelium-server/`.

## Configuration

Edit `config.env` before starting. It defaults to hoarder mode, display name
`Hyphae`, bio `I'm an automatic cache node.`, a 4096 MiB object cache, 16
peers, and a `data/` directory inside this distribution. The display name and
bio are published in a signed `mycelium.identity` object. Relative data paths
are resolved from this directory; absolute data paths and `~/...` are also
accepted. Do not put machine-specific paths in the distributed config file.

The settings map to the bot's existing `MYCELIUM_*` environment variables.
Optional entries can set the signalling URL, identity file, log level,
automatic follow-back, or ICE-server JSON; see the commented examples. Config
lines are read as literal assignments, not sourced as shell code. Use whole-
line comments, and quote values containing spaces if desired. Changes apply on
the next start. The signing key and its persistent P-256 encryption-key
sidecar are stored in `data/` with owner-only permissions; keep both when
backing up or moving the peer identity.

## Manage the peer

```sh
./start.sh
./stop.sh
./restart.sh
if [ -f runtime/peer.pid ]; then ps -p "$(cat runtime/peer.pid)" -o pid=,command=; else echo 'Peer is not running'; fi
tail -f runtime/peer.log
```

`runtime/peer.pid` records the running process, and `runtime/peer.log` receives
stdout and stderr. Check status with the `ps` command above; `./stop.sh` removes
a stale PID file without signaling a process when the recorded PID is no longer
running. To clear a large log while the peer is running, use
`> runtime/peer.log`; for a retained copy, stop the peer, rename the log, and
start it again.

To update or reinstall dependencies, run `./install.sh` again. To remove the
installation completely, stop it with `./stop.sh`, then delete the entire
`mycelium-peer/` directory. Back up `data/` first if the peer's signing or
encryption identity or cached objects must be retained.

## Requirements

- Unix/Linux-compatible shell utilities: `sh`, `ps`, `kill`, `nohup`, `sed`,
  and standard file utilities.
- CPython 3.10 or newer, with `venv` support.
- Outbound network access to install packages from PyPI and to reach the
  configured Mycelium signalling service.

aiortc installs its declared WebRTC dependencies, including PyAV (`av`). On
platforms with compatible prebuilt wheels, no separate FFmpeg installation is
needed. If pip reports that no compatible wheel exists, its error identifies
the missing platform support; a source build may require platform-specific
compiler and FFmpeg development libraries. The peer does not open a listening
port; network restrictions or restrictive NAT may require operator-provided
TURN configuration.