#!/usr/bin/env python3
import asyncio
import json
import logging
import os
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

import websockets
from aiohttp import web
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

async def handle_discovery_post(request: web.Request) -> web.Response:
    if request.content_length is None or request.content_length > MAX_POST_SIZE:
        return web.Response(status=413, text='Post too large', headers={'Access-Control-Allow-Origin': '*'})
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        return web.Response(status=400, text='Invalid JSON', headers={'Access-Control-Allow-Origin': '*'})

    if not isinstance(payload, dict):
        return web.Response(status=400, text='Invalid post payload', headers={'Access-Control-Allow-Origin': '*'})

    required_keys = {'protocol', 'version', 'type', 'id', 'author', 'timestamp', 'content', 'tags', 'signature'}
    if not required_keys.issubset(payload.keys()):
        return web.Response(status=400, text='Missing required fields', headers={'Access-Control-Allow-Origin': '*'})

    post_id = payload['id']
    received_at = datetime.utcnow().isoformat() + 'Z'
    tags = ','.join(payload.get('tags', []))
    DB_CONN.execute(
        'INSERT OR REPLACE INTO discovery_posts (id, received_at, post_json, author, tags) VALUES (?, ?, ?, ?, ?)',
        (post_id, received_at, json.dumps(payload), payload['author'], tags)
    )
    DB_CONN.commit()
    await prune_discovery_posts()
    logging.info('Stored public discovery post %s from %s tags=%s', post_id, payload['author'], tags)
    return web.Response(status=201, text='Post accepted', headers={'Access-Control-Allow-Origin': '*'})

async def handle_discovery_get(request: web.Request) -> web.Response:
    limit = min(int(request.query.get('limit', MAX_DISCOVERY_BATCH_SIZE)), MAX_DISCOVERY_BATCH_SIZE)
    tag = request.query.get('tag')
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
    posts = [json.loads(row[0]) for row in rows]
    response = web.json_response(posts)
    response.headers['Access-Control-Allow-Origin'] = '*'
    return response

async def handle_options(request: web.Request) -> web.Response:
    response = web.Response(status=204)
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response

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

            logging.warning('Unsupported message type: %s', msg_type)
    except websockets.ConnectionClosed:
        pass
    finally:
        if client_id and clients.get(client_id) is websocket:
            del clients[client_id]
            logging.info('Client disconnected: %s', client_id)
            await broadcast_peer_list()

async def handle_options(request: web.Request) -> web.Response:
    response = web.Response(status=204)
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response

async def websocket_handler(websocket: WebSocketServerProtocol, path: str) -> None:
    await handle_client(websocket)

async def main() -> None:
    logging.info('Starting discovery database at %s', DB_PATH)
    server = await websockets.serve(websocket_handler, '0.0.0.0', 8765)
    app = web.Application()
    app.router.add_route('OPTIONS', '/api/discovery', handle_options)
    app.router.add_post('/api/discovery', handle_discovery_post)
    app.router.add_get('/api/discovery', handle_discovery_get)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', 8000)
    await site.start()
    logging.info('Signalling server started on ws://0.0.0.0:8765')
    logging.info('Discovery API started on http://0.0.0.0:8000')
    await asyncio.Future()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info('Server stopped')
