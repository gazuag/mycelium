# Standalone bootstrap peer

This is a normal Mycelium WebRTC peer implemented in Python. It uses the
existing signalling/discovery WebSocket service only for rendezvous; discovery
is not needed to keep established data-channel connections alive. The peer
validates object signatures locally, persists accepted objects and tombstones
in SQLite, answers bounded FIND requests, and relays newly stored objects.
For posts, it uses bounded FIND lookups to retrieve available reply ancestry
and relays that chain root-first, matching the browser object layer. It does
not create social objects or store browser profile data.

## Install and run

Use Python 3.10 or newer. From the repository root:

```sh
python3.11 -m venv .venv
. .venv/bin/activate
python -m pip install -r bot/requirements.txt
python -m bot.peer
```

The default signalling URL is the production endpoint already used by the
browser, `wss://discover.unfilter.ing:8443`. Keep the data directory on
persistent storage and restrict access to the service account.

## Configuration

| Option | Environment variable | Default |
| --- | --- | --- |
| `--signal-url` | `MYCELIUM_SIGNAL_URL` | `wss://discover.unfilter.ing:8443` |
| `--data-dir` | `MYCELIUM_DATA_DIR` | `~/.local/share/mycelium-peer` |
| `--identity-file` | `MYCELIUM_IDENTITY_FILE` | `<data-dir>/identity.json` |
| `--display-name` | `MYCELIUM_DISPLAY_NAME` | persisted value, otherwise `Mycelium peer` |
| `--cache-mb` | `MYCELIUM_CACHE_MB` | `2048` |
| `--max-peers` | `MYCELIUM_MAX_PEERS` | `16` (hard maximum `64`) |
| `--mode` | `MYCELIUM_MODE` | `social` |
| `--auto-follow-back` / `--no-auto-follow-back` | `MYCELIUM_AUTO_FOLLOW_BACK` | enabled in social mode; disabled in hoarder mode |
| `--log-level` | `MYCELIUM_LOG_LEVEL` | `INFO` |
| ICE servers | `MYCELIUM_ICE_SERVERS` | Google STUN |

`--mode hoarder` opts into cache-relay operation without automatically
following peers back. It still authenticates every peer through the existing
signed PROFILE exchange, and feed synchronization uses the existing
`POST_REQUEST` / `OBJECT_BATCH` protocol. The current bot already requests
authenticated peers' feeds independently of follow state; hoarder mode makes
that purpose explicit and changes the default follow-back behavior without
changing the wire protocol. The default `social` mode preserves the current
follow-back behavior. `--auto-follow-back` and `--no-auto-follow-back`
(or `MYCELIUM_AUTO_FOLLOW_BACK=true|false`) explicitly override either mode's
default. Feed access is never obtained by publishing a follow relationship.

The display name is published in the existing signed PROFILE exchange. It is
stored in the SQLite settings table and survives restarts; a supplied CLI
option or environment variable replaces the stored value. This is a display
name only: the bot has no username or handle. Its profile `author` is its
existing fingerprint, and `publicKey` carries the key used for signature and
identity verification.

The browser has no signed follow object. Its authenticated per-peer profile
has a `following` boolean indicating whether that peer follows the recipient.
When automatic follow-back is enabled, the bot records that value and follows
back by publishing its own signed profile with `following: true`. An
authenticated `following: false` withdraws the follow-back; a missing or
non-boolean value does not change stored state. In hoarder mode, automatic
follow-back is off by default, so incoming profile state does not create a
follow relationship. Follow state is keyed by peer fingerprint in SQLite,
suppresses duplicate profile updates, and is restored after restart. An
offline profile change is only learned when the peer connects and exchanges a
signed profile.

After accepting a peer's signed profile, the bot requests that peer's exposed
feed using the existing signed `POST_REQUEST` / `OBJECT_BATCH` exchange.
It validates each received object's ID and signature before storing it, then
persists the page cursor per peer and requests subsequent pages. A connection
is limited to 10 pages of 100 feed entries per sync attempt; if more remain,
the cursor is saved and the next connection resumes. The browser's feed
contains that browser identity's own posts and recommendations, not an
arbitrary dump of its entire cache. The bot answers a browser `POST_REQUEST`
with a correctly shaped empty page because this relay identity does not author
feed objects. FIND remains available for object lookups, forwarding, and post
ancestry, but it is not the browser's normal feed synchronization mechanism.

`--cache-mb` measures the UTF-8 byte length of serialized object JSON rows,
not total disk use. The default is 2,048 MiB (2 GiB). When over the limit, the
store evicts the oldest inserted object and its cached reply descendants so
that replies are not retained without their ancestry. Tombstones, peer
contacts, settings, and follow state are not evicted by this limit; tombstones
are retained to prevent deleted content from being reintroduced, with the
first accepted signed delete request retained alongside its tombstone for
later FIND responses even if its ordinary object row is evicted. SQLite
indexes, page slack, WAL/SHM files, and tombstones add overhead, so the
configured limit is not a hard disk quota and total database size may remain
above it after eviction. Startup logs report serialized object bytes and the
retained tombstone/delete-request bytes, plus the current logical size of the
SQLite database and any WAL/SHM files.

`--max-peers` is both the desired connection count and the hard per-process
limit (1–64). The default of 16 is a moderate starting point, not a measured
Oracle Cloud capacity guarantee. Each WebRTC connection consumes CPU, memory,
bandwidth, file descriptors, and ICE/DTLS/SCTP resources; start at 16 and
increase gradually while monitoring the VM. Candidate attempts rotate and
failed peers use exponential backoff up to five minutes. The implementation
does not benchmark or automatically infer Oracle shape, VCN, NSG, host
firewall, NAT, or file-descriptor limits.

`MYCELIUM_ICE_SERVERS` accepts a JSON array in the same shape as WebRTC ICE
configuration, for example:

```sh
MYCELIUM_ICE_SERVERS='[{"urls":"turns:turn.example.invalid:5349","username":"peer","credential":"provisioned-secret"}]'
```

The peer does not bind a listening port. `aiortc` gathers ICE candidates and
uses STUN; deployments behind restrictive NATs may need operator-provisioned
TURN credentials. Do not put TURN credentials in source control or logs.
The key file is created with owner-only permissions and is never logged.

The peer follows the browser's deterministic ID election (the lower ID
initiates), retains peer IDs in its local store, and reconnects with exponential
backoff. Restarting preserves the identity, validated object cache, tombstones,
contacts, display name, and follow-back state. When signalling is unavailable,
established connections remain usable and stored peer IDs are retained for
later rendezvous. `--log-level` writes to standard output/error; a systemd
service can capture those streams in the journal.

### Example service configuration

For a headless server, keep command-line options or environment variables in
the systemd unit so the same settings are used after reboot. For example:

```ini
[Service]
User=mycelium
WorkingDirectory=/opt/mycelium
Environment=MYCELIUM_DATA_DIR=/var/lib/mycelium-peer
Environment="MYCELIUM_DISPLAY_NAME=Mycelium Cache Peer"
Environment=MYCELIUM_CACHE_MB=4096
Environment=MYCELIUM_MAX_PEERS=16
Environment=MYCELIUM_MODE=hoarder
Environment=MYCELIUM_AUTO_FOLLOW_BACK=false
Environment=MYCELIUM_LOG_LEVEL=INFO
ExecStart=/opt/mycelium/.venv/bin/python -m bot.peer
Restart=always
RestartSec=5
```

For a one-off run, the equivalent command is:

```sh
MYCELIUM_DISPLAY_NAME="Mycelium Cache Peer" \
MYCELIUM_CACHE_MB=4096 \
MYCELIUM_MAX_PEERS=16 \
MYCELIUM_MODE=hoarder \
python -m bot.peer --data-dir /var/lib/mycelium-peer
```

The data directory contains `identity.json` and `peer.sqlite3`; SQLite may
also create `peer.sqlite3-wal` and `peer.sqlite3-shm` while running. Back up the
identity and database together. Stop the service cleanly before copying them
to get a consistent backup. A display-name override in the service environment
is written to SQLite at startup. No browser or external database service is
needed.

For the approximately 47 GB disk described, a cautious first configuration is
`MYCELIUM_CACHE_MB=4096` and `MYCELIUM_MAX_PEERS=16`. This allocates a 4 GiB
object-JSON budget while leaving substantial room for SQLite overhead, the
operating system, logs, and updates. Confirm actual `disk_bytes` and VM
resource use before increasing either setting.

## Tests

```sh
python -m unittest bot.test_peer
```

The tests include a three-node in-process relay over signed Mycelium data
packets, bounded post-ancestry retrieval, signed browser-shaped profile
exchange, initial POST_REQUEST/OBJECT_BATCH feed synchronization and paging,
follow/unfollow persistence, and cache enforcement. The WebRTC
handshake test runs when `aiortc` is installed. These tests do not demonstrate
live interoperability with the deployed signalling service or Oracle Cloud
networking.
