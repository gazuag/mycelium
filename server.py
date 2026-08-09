#!/usr/bin/env python3
import asyncio
import json
import logging
import os
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

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
DB_PATH = Path(os.environ.get('DISCOVERY_DB_PATH', 'discovery.db'))

clients: Dict[str, WebSocketServerProtocol] = {}

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


def init_db() -> sqlite3.Connection:
    created = not DB_PATH.exists()
    conn = sqlite3.connect(DB_PATH)
    if created:
        conn.execute('''
            CREATE TABLE discovery_posts (
                id TEXT PRIMARY KEY,
                received_at TEXT NOT NULL,
                post_json TEXT NOT NULL,
                author TEXT NOT NULL,
                tags TEXT
            )
        ''')
        conn.execute('CREATE INDEX idx_received_at ON discovery_posts(received_at)')
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
            'posts': posts,
        },
        'signature': 'server-unsigned-v1'
    }


def load_discovery_posts(limit: int, tag: Optional[str]):
    if tag:
        cursor = DB_CONN.execute(
            'SELECT post_json FROM discovery_posts WHERE tags LIKE ? ORDER BY RANDOM() LIMIT ?',
            (f'%{tag}%', limit)
        )
    else:
        cursor = DB_CONN.execute(
            'SELECT post_json FROM discovery_posts ORDER BY RANDOM() LIMIT ?',
            (limit,)
        )
    rows = cursor.fetchall()
    return [json.loads(row[0]) for row in rows]


async def handle_discovery_get(message: dict, websocket: WebSocketServerProtocol) -> None:
    query = message.get('payload', {}) if isinstance(message.get('payload'), dict) else {}
    limit = min(int(query.get('limit', MAX_DISCOVERY_BATCH_SIZE)), MAX_DISCOVERY_BATCH_SIZE)
    tag = query.get('tag')
    posts = load_discovery_posts(limit, tag if isinstance(tag, str) else None)
    result = build_discovery_result_packet(posts, request_id=message.get('id'), recipient=message.get('sender'))
    await websocket.send(json.dumps(result))
    logging.info('Sent %d discovery posts to %s', len(posts), message.get('sender', '<unknown>'))


async def handle_discovery_publish(message: dict) -> None:
    raw_post_json = json.dumps(message)
    if len(raw_post_json) > MAX_POST_SIZE:
        logging.warning('DISCOVERY_PUBLISH payload too large, ignoring')
        return
    inner_payload = message.get('payload', {}) if isinstance(message.get('payload'), dict) else {}
    post_payload = inner_payload.get('post')
    if not isinstance(post_payload, dict):
        logging.warning('DISCOVERY_PUBLISH missing post payload')
        return
    required_keys = {'protocol', 'version', 'type', 'id', 'author', 'timestamp', 'content', 'tags', 'signature'}
    if not required_keys.issubset(post_payload.keys()):
        logging.warning('DISCOVERY_PUBLISH missing required fields: %s', required_keys - post_payload.keys())
        return
    post_id = post_payload['id']
    received_at = datetime.utcnow().isoformat() + 'Z'
    tags = ','.join(post_payload.get('tags', []))
    DB_CONN.execute(
        'INSERT OR REPLACE INTO discovery_posts (id, received_at, post_json, author, tags) VALUES (?, ?, ?, ?, ?)',
        (post_id, received_at, json.dumps(post_payload), post_payload['author'], tags)
    )
    DB_CONN.commit()
    await prune_discovery_posts()
    logging.info('Stored discovery post %s from %s tags=%s', post_id, post_payload['author'], tags)


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
                    logging.info('Target %s not connected; ignoring %s', target, msg_type)
                continue

            # Mycelium protocol packets
            if message.get('protocol') == 'mycelium' and message.get('version') == 1:
                if msg_type == 'DISCOVERY_GET':
                    await handle_discovery_get(message, websocket)
                    continue
                if msg_type == 'DISCOVERY_PUBLISH':
                    await handle_discovery_publish(message)
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
    server = await websockets.serve(websocket_handler, '0.0.0.0', 8765)
    logging.info('Server started on ws://0.0.0.0:8765 (signalling + discovery)')
    await asyncio.Future()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info('Server stopped')
