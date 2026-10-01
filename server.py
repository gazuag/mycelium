#!/usr/bin/env python3
import asyncio
import hashlib
import json
import logging
import os
import sqlite3
import ssl
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import websockets
from websockets.server import WebSocketServerProtocol

logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(message)s')

def normalize_client_id(value: Optional[str]) -> Optional[str]:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None

MAX_DISCOVERY_POSTS = int(os.environ.get('MAX_DISCOVERY_POSTS', '10000'))
MAX_POST_SIZE = int(os.environ.get('MAX_POST_SIZE', '4096'))
MAX_DISCOVERY_BATCH_SIZE = int(os.environ.get('MAX_DISCOVERY_BATCH_SIZE', '50'))
SIGNAL_QUEUE_TTL_SECONDS = int(os.environ.get('SIGNAL_QUEUE_TTL_SECONDS', '60'))
MAX_QUEUED_SIGNALS_PER_CLIENT = int(os.environ.get('MAX_QUEUED_SIGNALS_PER_CLIENT', '32'))
DB_PATH = Path(os.environ.get('DISCOVERY_DB_PATH', 'discovery.db'))
SIGNAL_HOST = os.environ.get('SIGNAL_HOST', '0.0.0.0')
SIGNAL_PORT = int(os.environ.get('SIGNAL_PORT', '8443'))
TLS_CERT_PATH = os.environ.get('TLS_CERT_PATH')
TLS_KEY_PATH = os.environ.get('TLS_KEY_PATH')
PEER_DISCOVERY_WINDOW_DAYS = int(os.environ.get('PEER_DISCOVERY_WINDOW_DAYS', '30'))

clients: Dict[str, WebSocketServerProtocol] = {}
pending_signals: Dict[str, List[Tuple[float, str]]] = {}


def queue_signal(target: str, raw_message: str) -> None:
    now = time.monotonic()
    queued = [item for item in pending_signals.get(target, []) if now - item[0] <= SIGNAL_QUEUE_TTL_SECONDS]
    queued.append((now, raw_message))
    pending_signals[target] = queued[-MAX_QUEUED_SIGNALS_PER_CLIENT:]
    logging.info('Queued signal for %s (%d pending)', target, len(pending_signals[target]))


async def flush_queued_signals(client_id: str, websocket: WebSocketServerProtocol) -> None:
    queued = pending_signals.pop(client_id, [])
    now = time.monotonic()
    fresh_messages = [raw_message for timestamp, raw_message in queued if now - timestamp <= SIGNAL_QUEUE_TTL_SECONDS]
    for raw_message in fresh_messages:
        try:
            if websocket.open:
                await websocket.send(raw_message)
        except Exception:
            logging.warning('Failed to deliver queued signal to %s', client_id)
            break
    if fresh_messages:
        logging.info('Delivered %d queued signals to %s', len(fresh_messages), client_id)

async def broadcast_peer_list() -> None:
    message = json.dumps({
        'type': 'peer-list',
        'peers': list(clients.keys())
    })
    for ws in list(clients.values()):
        try:
            if ws.open:
                await ws.send(message)
        except Exception:
            pass


def init_db(db_path: Path = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    table_exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='discovery_posts'"
    ).fetchone() is not None
    if not table_exists:
        conn.execute('''
            CREATE TABLE discovery_posts (
                id TEXT PRIMARY KEY,
                received_at TEXT NOT NULL,
                object_json TEXT NOT NULL,
                author TEXT NOT NULL,
                tags TEXT
            )
        ''')
        conn.execute('CREATE INDEX idx_received_at ON discovery_posts(received_at)')
        conn.commit()
        return conn

    columns = {row[1] for row in conn.execute('PRAGMA table_info(discovery_posts)')}
    if 'post_json' in columns:
        json_expression = 'COALESCE(object_json, post_json)' if 'object_json' in columns else 'post_json'
        author_expression = 'author' if 'author' in columns else "''"
        tags_expression = 'tags' if 'tags' in columns else "''"
        conn.execute('BEGIN IMMEDIATE')
        try:
            conn.execute('''
                CREATE TABLE discovery_posts_migrated (
                    id TEXT PRIMARY KEY,
                    received_at TEXT NOT NULL,
                    object_json TEXT NOT NULL,
                    author TEXT NOT NULL,
                    tags TEXT
                )
            ''')
            conn.execute(f'''
                INSERT INTO discovery_posts_migrated (id, received_at, object_json, author, tags)
                SELECT id, received_at, {json_expression}, {author_expression}, {tags_expression}
                FROM discovery_posts
                WHERE {json_expression} IS NOT NULL
            ''')
            conn.execute('DROP TABLE discovery_posts')
            conn.execute('ALTER TABLE discovery_posts_migrated RENAME TO discovery_posts')
            conn.execute('CREATE INDEX idx_received_at ON discovery_posts(received_at)')
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    else:
        if 'object_json' not in columns:
            raise sqlite3.DatabaseError('discovery_posts has neither object_json nor legacy post_json')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_received_at ON discovery_posts(received_at)')
        conn.commit()
    return conn

DB_CONN = init_db()

async def prune_discovery_posts() -> None:
    cursor = DB_CONN.cursor()
    cursor.execute('SELECT COUNT(*) FROM discovery_posts')
    count = cursor.fetchone()[0]
    if count <= MAX_DISCOVERY_POSTS:
        return
    delete_count = count - MAX_DISCOVERY_POSTS
    cursor.execute(
        '''DELETE FROM discovery_posts WHERE id IN (
            SELECT id FROM discovery_posts ORDER BY received_at ASC LIMIT ?
        )''',
        (delete_count,)
    )
    DB_CONN.commit()
    logging.info('Pruned %d discovery posts, new count %d', delete_count, MAX_DISCOVERY_POSTS)


def build_discovery_result_packet(posts, request_id: Optional[str] = None, recipient: Optional[str] = None):
    return {
        'protocol': 'mycelium',
        'version': 1,
        'id': str(uuid.uuid4()),
        'type': 'DISCOVERY_RESULT',
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'sender': 'discovery-server',
        'recipient': recipient,
        'payload': {
            'requestId': request_id,
            'objects': posts,
        },
        'signature': 'server-unsigned-v1'
    }


def load_discovery_posts(limit: int, tag: Optional[str]):
    if tag:
        cursor = DB_CONN.execute(
            'SELECT object_json FROM discovery_posts WHERE tags LIKE ? ORDER BY RANDOM() LIMIT ?',
            (f'%{tag}%', limit)
        )
    else:
        cursor = DB_CONN.execute(
            'SELECT object_json FROM discovery_posts ORDER BY RANDOM() LIMIT ?',
            (limit,)
        )
    rows = cursor.fetchall()
    return [json.loads(row[0]) for row in rows]


def _recent_cutoff() -> str:
    return (datetime.utcnow() - timedelta(days=PEER_DISCOVERY_WINDOW_DAYS)).isoformat(timespec='seconds') + 'Z'


def _peer_id_for_author(author: str) -> str:
    digest = hashlib.sha256(author.strip().encode('utf-8')).digest()[:8]
    return ':'.join(f'{byte:02x}' for byte in digest)


def load_peer_pool(limit: int = 50) -> List[str]:
    if limit <= 0:
        return []
    rows = DB_CONN.execute(
        'SELECT object_json FROM discovery_posts WHERE received_at >= ? ORDER BY received_at DESC',
        (_recent_cutoff(),)
    ).fetchall()
    peer_ids: List[str] = []
    seen = set()
    for (object_json,) in rows:
        try:
            obj = json.loads(object_json)
        except (TypeError, json.JSONDecodeError):
            continue
        if obj.get('object_type') != 'mycelium.post' or not isinstance(obj.get('author'), str):
            continue
        peer_id = _peer_id_for_author(obj['author'])
        if peer_id not in seen:
            seen.add(peer_id)
            peer_ids.append(peer_id)
            if len(peer_ids) >= max(0, limit):
                break
    return peer_ids


def load_popular_peers(limit: int = 10) -> List[dict]:
    rows = DB_CONN.execute(
        'SELECT object_json FROM discovery_posts WHERE received_at >= ?',
        (_recent_cutoff(),)
    ).fetchall()
    reply_counts: Dict[str, int] = {}
    for (object_json,) in rows:
        try:
            obj = json.loads(object_json)
        except (TypeError, json.JSONDecodeError):
            continue
        if obj.get('object_type') not in {'mycelium.post', 'mycelium.reply'}:
            continue
        payload = obj.get('payload')
        if not isinstance(payload, dict):
            continue
        peer_id = payload.get('reply_to_author')
        if isinstance(peer_id, str) and peer_id.strip():
            peer_id = peer_id.strip()
            reply_counts[peer_id] = reply_counts.get(peer_id, 0) + 1
    ranked = sorted(reply_counts.items(), key=lambda item: (-item[1], item[0]))
    return [{'peer_id': peer_id, 'reply_count': count} for peer_id, count in ranked[:max(0, limit)]]


def build_peer_discovery_result_packet(response_type: str, peers, request_id: Optional[str], recipient: Optional[str]):
    return {
        'protocol': 'mycelium',
        'version': 1,
        'id': str(uuid.uuid4()),
        'type': response_type,
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'sender': 'discovery-server',
        'recipient': recipient,
        'payload': {'requestId': request_id, 'peers': peers},
        'signature': 'server-unsigned-v1'
    }


async def handle_peer_pool_get(message: dict, websocket: WebSocketServerProtocol) -> None:
    packet = build_peer_discovery_result_packet(
        'PEER_POOL_RESULT', load_peer_pool(), message.get('id'), message.get('sender')
    )
    await websocket.send(json.dumps(packet))
    logging.info('Sent %d peer-pool suggestions to %s', len(packet['payload']['peers']), message.get('sender', '<unknown>'))


async def handle_popular_peers_get(message: dict, websocket: WebSocketServerProtocol) -> None:
    peers = load_popular_peers(10)
    packet = build_peer_discovery_result_packet(
        'POPULAR_PEERS_RESULT', peers, message.get('id'), message.get('sender')
    )
    await websocket.send(json.dumps(packet))
    logging.info('Sent %d popular peers to %s', len(peers), message.get('sender', '<unknown>'))


async def handle_discovery_get(message: dict, websocket: WebSocketServerProtocol) -> None:
    query = message.get('payload', {}) if isinstance(message.get('payload'), dict) else {}
    limit = min(int(query.get('limit', MAX_DISCOVERY_BATCH_SIZE)), MAX_DISCOVERY_BATCH_SIZE)
    tag = query.get('tag')
    objects = load_discovery_posts(limit, tag if isinstance(tag, str) else None)
    result = build_discovery_result_packet(objects, request_id=message.get('id'), recipient=message.get('sender'))
    await websocket.send(json.dumps(result))
    logging.info('Sent %d discovery objects to %s', len(objects), message.get('sender', '<unknown>'))


async def handle_discovery_publish(message: dict) -> None:
    inner_payload = message.get('payload', {}) if isinstance(message.get('payload'), dict) else {}
    object_payload = inner_payload.get('object')
    if not isinstance(object_payload, dict):
        logging.warning('DISCOVERY_PUBLISH missing object payload')
        return
    raw_object_json = json.dumps(object_payload)
    if len(raw_object_json) > MAX_POST_SIZE:
        logging.warning('DISCOVERY_PUBLISH object too large, ignoring')
        return
    required_keys = {'object_id', 'object_type', 'author', 'created_at', 'payload', 'signature'}
    if not required_keys.issubset(object_payload.keys()):
        logging.warning('DISCOVERY_PUBLISH missing object fields: %s', required_keys - object_payload.keys())
        return
    if object_payload['object_type'] == 'mycelium.dm':
        logging.warning('DISCOVERY_PUBLISH direct-message objects are not supported, ignoring')
        return
    object_id = object_payload['object_id']
    author = object_payload['author']
    object_content = object_payload['payload']
    if not isinstance(object_id, str) or not object_id or not isinstance(author, str) or not author or not isinstance(object_content, dict):
        logging.warning('DISCOVERY_PUBLISH invalid object envelope, ignoring')
        return
    received_at = datetime.utcnow().isoformat() + 'Z'
    object_tags = object_content.get('tags', [])
    tags = ','.join(tag for tag in object_tags if isinstance(tag, str)) if isinstance(object_tags, list) else ''
    try:
        DB_CONN.execute(
            'INSERT OR REPLACE INTO discovery_posts (id, received_at, object_json, author, tags) VALUES (?, ?, ?, ?, ?)',
            (object_id, received_at, raw_object_json, author, tags)
        )
        DB_CONN.commit()
        await prune_discovery_posts()
    except sqlite3.Error:
        DB_CONN.rollback()
        logging.exception('Failed to persist discovery object %s from %s; keeping signalling session alive', object_id, author)
        return
    logging.info('Stored discovery object %s from %s tags=%s', object_id, author, tags)


async def handle_client(websocket: WebSocketServerProtocol) -> None:
    client_id: Optional[str] = None

    try:
        async for raw_message in websocket:
            try:
                message = json.loads(raw_message)
            except json.JSONDecodeError:
                logging.warning('Invalid JSON received from client')
                continue

            msg_type = message.get('type')

            if msg_type == 'register':
                client_id = normalize_client_id(message.get('id'))
                if not client_id:
                    logging.warning('Invalid register payload')
                    continue
                if client_id in clients and clients[client_id] is not websocket:
                    logging.info('Overwriting existing registration for %s', client_id)
                clients[client_id] = websocket
                logging.info('Registered client %s (%d clients currently)', client_id, len(clients))
                await broadcast_peer_list()
                await flush_queued_signals(client_id, websocket)
                continue

            if msg_type in {'offer', 'answer', 'ice-candidate'}:
                target = normalize_client_id(message.get('to'))
                sender = normalize_client_id(message.get('from'))
                if not target:
                    logging.warning('Signal missing target')
                    continue
                recipient = clients.get(target)
                if recipient and recipient.open:
                    await recipient.send(raw_message)
                    logging.info('Relayed %s from %s to %s', msg_type, sender or '<unknown>', target)
                else:
                    queue_signal(target, raw_message)
                    logging.info('Target %s not connected; queued %s', target, msg_type)
                continue

            # Mycelium protocol packets
            if message.get('protocol') == 'mycelium' and message.get('version') == 1:
                if msg_type == 'DISCOVERY_GET':
                    await handle_discovery_get(message, websocket)
                    continue
                if msg_type == 'DISCOVERY_PUBLISH':
                    await handle_discovery_publish(message)
                    continue
                if msg_type == 'PEER_POOL_GET':
                    await handle_peer_pool_get(message, websocket)
                    continue
                if msg_type == 'POPULAR_PEERS_GET':
                    await handle_popular_peers_get(message, websocket)
                    continue

            logging.warning('Unsupported message type: %s', msg_type)
    except websockets.ConnectionClosed:
        pass
    finally:
        if client_id and clients.get(client_id) is websocket:
            del clients[client_id]
            logging.info('Client disconnected: %s', client_id)
            await broadcast_peer_list()

async def websocket_handler(websocket: WebSocketServerProtocol, path: str) -> None:
    await handle_client(websocket)

async def main() -> None:
    logging.info('Starting discovery database at %s', DB_PATH)

    if not TLS_CERT_PATH or not TLS_KEY_PATH:
        raise RuntimeError('TLS_CERT_PATH and TLS_KEY_PATH must be set before starting the secure signalling server.')

    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ssl_context.load_cert_chain(TLS_CERT_PATH, TLS_KEY_PATH)
    logging.info('Loaded TLS certificate for secure signalling at %s and %s', TLS_CERT_PATH, TLS_KEY_PATH)

    wss_server = await websockets.serve(websocket_handler, SIGNAL_HOST, SIGNAL_PORT, ssl=ssl_context)
    logging.info('Secure server started on wss://%s:%s (signalling + discovery)', SIGNAL_HOST, SIGNAL_PORT)

    await asyncio.Future()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info('Server stopped')
