from __future__ import annotations

import json
import heapq
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .protocol import HEX_SHA256, MAX_OBJECT_BYTES, object_expired, valid_object_shape, validate_object

DEFAULT_OBJECT_CACHE_BYTES = 2 * 1024 * 1024 * 1024
MAX_KNOWN_PEERS = 512


def _timestamp(value: str) -> float | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except (TypeError, ValueError):
        return None


class PeerStore:
    def __init__(self, path: Path, object_cache_limit_bytes: int = DEFAULT_OBJECT_CACHE_BYTES):
        if object_cache_limit_bytes < 1:
            raise ValueError("object cache limit must be positive")
        self.path = path
        self.object_cache_limit_bytes = object_cache_limit_bytes
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        path.parent.chmod(0o700)
        self.db = sqlite3.connect(path)
        path.chmod(0o600)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS objects (
                object_id TEXT PRIMARY KEY,
                object_type TEXT NOT NULL,
                author TEXT NOT NULL,
                created_at TEXT NOT NULL,
                object_json TEXT NOT NULL,
                parent_id TEXT
            );
            CREATE INDEX IF NOT EXISTS objects_created_at ON objects(created_at);
            CREATE TABLE IF NOT EXISTS tombstones (
                target_object_id TEXT PRIMARY KEY,
                tombstone_json TEXT NOT NULL,
                delete_request_id TEXT,
                delete_request_json TEXT
            );
            CREATE TABLE IF NOT EXISTS peers (
                peer_id TEXT PRIMARY KEY,
                last_seen REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS following (
                peer_id TEXT PRIMARY KEY,
                follows INTEGER NOT NULL CHECK (follows IN (0, 1))
            );
            CREATE TABLE IF NOT EXISTS feed_cursors (
                peer_id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                object_id TEXT NOT NULL
            );
        """)
        columns = {
            row["name"] for row in self.db.execute("PRAGMA table_info(objects)")
        }
        if "parent_id" not in columns:
            self.db.execute("ALTER TABLE objects ADD COLUMN parent_id TEXT")
            self._populate_parent_ids()
        self.db.execute("CREATE INDEX IF NOT EXISTS objects_parent_id ON objects(parent_id)")
        tombstone_columns = {
            row["name"] for row in self.db.execute("PRAGMA table_info(tombstones)")
        }
        if "delete_request_id" not in tombstone_columns:
            self.db.execute("ALTER TABLE tombstones ADD COLUMN delete_request_id TEXT")
        if "delete_request_json" not in tombstone_columns:
            self.db.execute("ALTER TABLE tombstones ADD COLUMN delete_request_json TEXT")
        self.db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS tombstones_delete_request_id "
            "ON tombstones(delete_request_id) WHERE delete_request_id IS NOT NULL"
        )
        self._prune_objects()

    def close(self) -> None:
        self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.db.close()

    def put_object(self, value: dict[str, Any]) -> bool:
        try:
            encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            size = len(encoded.encode("utf-8"))
        except (TypeError, ValueError, RecursionError, UnicodeEncodeError):
            size = MAX_OBJECT_BYTES + 1
        if size > MAX_OBJECT_BYTES or not validate_object(value):
            raise ValueError("invalid distributed object")
        parent_id = self._parent_id(value)
        with self.db:
            if self.db.execute(
                "SELECT 1 FROM tombstones WHERE target_object_id = ?",
                (value["object_id"],),
            ).fetchone():
                return False
            if parent_id and self.is_tombstoned(parent_id):
                return False
            inserted = self.db.execute(
                """INSERT OR IGNORE INTO objects
                   (object_id, object_type, author, created_at, object_json, parent_id)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    value["object_id"],
                    value["object_type"],
                    value["author"],
                    value["created_at"],
                    json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False),
                    parent_id,
                ),
            ).rowcount == 1
            if inserted:
                self._prune_objects()
            return inserted

    def get_object(self, object_id: str) -> dict[str, Any] | None:
        row = self.db.execute(
            "SELECT object_json FROM objects WHERE object_id = ?", (object_id,)
        ).fetchone()
        if row is None:
            row = self.db.execute(
                "SELECT delete_request_json AS object_json FROM tombstones "
                "WHERE delete_request_id = ?",
                (object_id,),
            ).fetchone()
        if row is None:
            return None
        try:
            value = json.loads(row["object_json"])
        except (json.JSONDecodeError, TypeError):
            value = None
        if not valid_object_shape(value):
            with self.db:
                self.db.execute("DELETE FROM objects WHERE object_id = ?", (object_id,))
            return None
        if object_expired(value):
            with self.db:
                self.db.execute("DELETE FROM objects WHERE object_id = ?", (object_id,))
            return None
        return value

    def query_objects(self, query: dict[str, Any], limit: int = 500) -> tuple[list[dict[str, Any]], bool]:
        if limit < 1:
            return [], False
        created_after = _timestamp(query["created_after"]) if query.get("created_after") else None
        created_before = _timestamp(query["created_before"]) if query.get("created_before") else None
        since = _timestamp(query["since"]) if query.get("since") else None
        cursor = query.get("page_before")
        cursor_time = _timestamp(cursor["created_at"]) if isinstance(cursor, dict) else None

        def matching_values():
            rows = self.db.execute(
                """SELECT objects.object_json FROM objects
                   WHERE NOT EXISTS (
                       SELECT 1 FROM tombstones
                       WHERE tombstones.target_object_id = objects.object_id
                   )
                   UNION ALL
                   SELECT tombstones.delete_request_json FROM tombstones
                   WHERE tombstones.delete_request_json IS NOT NULL
                     AND NOT EXISTS (
                         SELECT 1 FROM objects
                         WHERE objects.object_id = tombstones.delete_request_id
                     )"""
            )
            for row in rows:
                try:
                    value = json.loads(row["object_json"])
                except (json.JSONDecodeError, TypeError):
                    continue
                if not valid_object_shape(value) or object_expired(value):
                    continue
                if query.get("object_type") and value["object_type"] != query["object_type"]:
                    continue
                if query.get("author") and value["author"] != query["author"]:
                    continue
                if query.get("recipient") is not None and value.get("recipient") != query["recipient"]:
                    continue
                created = _timestamp(value["created_at"])
                if created is None:
                    continue
                if created_after is not None and created < created_after:
                    continue
                if created_before is not None and created > created_before:
                    continue
                if since is not None and created <= since:
                    continue
                if cursor:
                    if cursor_time is None or created > cursor_time or (
                        created == cursor_time and value["object_id"] >= cursor["object_id"]
                    ):
                        continue
                yield value

        if query.get("order") == "created_at_desc":
            selected = heapq.nlargest(
                limit + 1,
                matching_values(),
                key=lambda item: (_timestamp(item["created_at"]) or 0, item["object_id"]),
            )
        else:
            selected = []
            for value in matching_values():
                selected.append(value)
                if len(selected) > limit:
                    break
        return selected[:limit], len(selected) > limit

    def is_tombstoned(self, object_id: str) -> bool:
        return self.db.execute(
            "SELECT 1 FROM tombstones WHERE target_object_id = ?", (object_id,)
        ).fetchone() is not None

    def apply_tombstone(
        self,
        tombstone: dict[str, Any],
        delete_request: dict[str, Any] | None = None,
    ) -> bool:
        encoded_request = None
        request_id = None
        if delete_request is not None:
            request_payload = delete_request.get("payload")
            if (delete_request.get("object_type") != "mycelium.delete-request"
                    or not isinstance(request_payload, dict)
                    or request_payload.get("target_object_id") != tombstone["target_object_id"]
                    or not validate_object(delete_request)):
                raise ValueError("invalid delete request for tombstone")
            request_id = delete_request["object_id"]
            encoded_request = json.dumps(
                delete_request, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            )
        inserted = False
        with self.db:
            self.db.execute(
                """INSERT INTO tombstones
                   (target_object_id, tombstone_json, delete_request_id, delete_request_json)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(target_object_id) DO UPDATE SET
                       delete_request_id = COALESCE(tombstones.delete_request_id, excluded.delete_request_id),
                       delete_request_json = COALESCE(tombstones.delete_request_json, excluded.delete_request_json)""",
                (
                    tombstone["target_object_id"],
                    json.dumps(tombstone, ensure_ascii=False, separators=(",", ":")),
                    request_id,
                    encoded_request,
                ),
            )
            self.db.execute("DELETE FROM objects WHERE object_id = ?", (tombstone["target_object_id"],))
            self.db.execute(
                "DELETE FROM objects WHERE parent_id = ?",
                (tombstone["target_object_id"],),
            )
            if delete_request is not None:
                inserted = self.db.execute(
                    """INSERT OR IGNORE INTO objects
                       (object_id, object_type, author, created_at, object_json, parent_id)
                       VALUES (?, ?, ?, ?, ?, NULL)""",
                    (
                        delete_request["object_id"],
                        delete_request["object_type"],
                        delete_request["author"],
                        delete_request["created_at"],
                        encoded_request,
                    ),
                ).rowcount == 1
                self._prune_objects()
        return inserted

    def get_setting(self, key: str) -> str | None:
        row = self.db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def set_setting(self, key: str, value: str) -> None:
        with self.db:
            self.db.execute(
                """INSERT INTO settings VALUES (?, ?)
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
                (key, value),
            )

    def is_following(self, peer_id: str) -> bool:
        row = self.db.execute(
            "SELECT follows FROM following WHERE peer_id = ?", (peer_id,)
        ).fetchone()
        return bool(row["follows"]) if row else False

    def set_following(self, peer_id: str, follows: bool) -> bool:
        previous = self.is_following(peer_id)
        if previous == follows:
            return False
        with self.db:
            self.db.execute(
                """INSERT INTO following VALUES (?, ?)
                   ON CONFLICT(peer_id) DO UPDATE SET follows = excluded.follows""",
                (peer_id, int(follows)),
            )
        return True

    def get_feed_cursor(self, peer_id: str) -> dict[str, str] | None:
        row = self.db.execute(
            "SELECT created_at, object_id FROM feed_cursors WHERE peer_id = ?",
            (peer_id,),
        ).fetchone()
        return dict(row) if row else None

    def set_feed_cursor(self, peer_id: str, cursor: dict[str, str]) -> None:
        with self.db:
            self.db.execute(
                """INSERT INTO feed_cursors VALUES (?, ?, ?)
                   ON CONFLICT(peer_id) DO UPDATE SET
                       created_at = excluded.created_at,
                       object_id = excluded.object_id""",
                (peer_id, cursor["created_at"], cursor["object_id"]),
            )

    def counts(self) -> dict[str, int]:
        return {
            table: self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in (
                "objects",
                "tombstones",
                "peers",
                "settings",
                "following",
                "feed_cursors",
            )
        }

    def usage(self) -> dict[str, int]:
        object_bytes = self.db.execute(
            "SELECT COALESCE(SUM(length(CAST(object_json AS BLOB))), 0) FROM objects"
        ).fetchone()[0]
        tombstone_bytes = self.db.execute(
            """SELECT COALESCE(SUM(
                   length(CAST(tombstone_json AS BLOB))
                   + COALESCE(length(CAST(delete_request_json AS BLOB)), 0)
               ), 0) FROM tombstones"""
        ).fetchone()[0]
        disk_bytes = sum(
            candidate.stat().st_size
            for candidate in (
                self.path,
                Path(f"{self.path}-wal"),
                Path(f"{self.path}-shm"),
            )
            if candidate.exists()
        )
        return {
            "object_bytes": object_bytes,
            "tombstone_bytes": tombstone_bytes,
            "disk_bytes": disk_bytes,
            "object_limit_bytes": self.object_cache_limit_bytes,
        }

    def add_peer(self, peer_id: str, seen_at: float) -> None:
        with self.db:
            self.db.execute(
                """INSERT INTO peers VALUES (?, ?)
                   ON CONFLICT(peer_id) DO UPDATE SET last_seen = excluded.last_seen""",
                (peer_id, seen_at),
            )
            self.db.execute(
                """DELETE FROM peers WHERE peer_id IN (
                    SELECT peer_id FROM peers ORDER BY last_seen DESC LIMIT -1 OFFSET ?
                )""",
                (MAX_KNOWN_PEERS,),
            )

    def known_peers(self) -> list[str]:
        return [row["peer_id"] for row in self.db.execute(
            "SELECT peer_id FROM peers ORDER BY last_seen DESC LIMIT ?",
            (MAX_KNOWN_PEERS,),
        )]

    def _prune_objects(self) -> None:
        total = self.db.execute(
            "SELECT COALESCE(SUM(length(CAST(object_json AS BLOB))), 0) FROM objects"
        ).fetchone()[0]
        while total > self.object_cache_limit_bytes:
            row = self.db.execute(
                "SELECT object_id FROM objects ORDER BY rowid LIMIT 1"
            ).fetchone()
            if row is None:
                break
            object_ids = self._descendant_ids(row["object_id"])
            placeholders = ",".join("?" for _ in object_ids)
            sizes = self.db.execute(
                f"""SELECT COALESCE(SUM(length(CAST(object_json AS BLOB))), 0)
                    FROM objects WHERE object_id IN ({placeholders})""",
                object_ids,
            ).fetchone()[0]
            with self.db:
                self.db.execute(
                    f"DELETE FROM objects WHERE object_id IN ({placeholders})",
                    object_ids,
                )
            total -= sizes

    def _descendant_ids(self, object_id: str) -> list[str]:
        rows = self.db.execute(
            """WITH RECURSIVE descendants(object_id) AS (
                   SELECT object_id FROM objects WHERE parent_id = ?
                   UNION
                   SELECT objects.object_id FROM objects
                   JOIN descendants ON objects.parent_id = descendants.object_id
               )
               SELECT object_id FROM descendants
               UNION SELECT ?""",
            (object_id, object_id),
        )
        return [row["object_id"] for row in rows]

    @staticmethod
    def _parent_id(value: dict[str, Any]) -> str | None:
        if value.get("object_type") != "mycelium.post":
            return None
        payload = value.get("payload")
        parent_id = payload.get("reply_to") if isinstance(payload, dict) else None
        return parent_id if isinstance(parent_id, str) and HEX_SHA256.fullmatch(parent_id) else None

    def _populate_parent_ids(self) -> None:
        with self.db:
            rows = list(self.db.execute("SELECT object_id, object_json FROM objects"))
            for row in rows:
                try:
                    value = json.loads(row["object_json"])
                except (json.JSONDecodeError, TypeError):
                    continue
                parent_id = self._parent_id(value)
                if parent_id:
                    self.db.execute(
                        "UPDATE objects SET parent_id = ? WHERE object_id = ?",
                        (parent_id, row["object_id"]),
                    )
