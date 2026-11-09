#!/usr/bin/env python3
import asyncio
import base64
import hashlib
import json
import logging
import math
import os
import random
import sqlite3
import ssl
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils
import websockets
from websockets.server import WebSocketServerProtocol

from bot.protocol import PEER_ID_PATTERN, validate_signal_message

logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(message)s')

def normalize_client_id(value: Optional[str]) -> Optional[str]:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None

def websocket_is_open(websocket: WebSocketServerProtocol) -> bool:
    legacy_open = getattr(websocket, 'open', None)
    if legacy_open is not None:
        return bool(legacy_open)
    return getattr(getattr(websocket, 'state', None), 'name', None) == 'OPEN'

MAX_DISCOVERY_POSTS = int(os.environ.get('MAX_DISCOVERY_POSTS', '10000'))
MAX_DISCOVERY_PROFILES = int(os.environ.get('MAX_DISCOVERY_PROFILES', '10000'))
MAX_POST_SIZE = int(os.environ.get('MAX_POST_SIZE', '4096'))
MAX_IDENTITY_PROFILE_SIZE = int(os.environ.get('MAX_IDENTITY_PROFILE_SIZE', '102400'))
MAX_DISCOVERY_BATCH_SIZE = int(os.environ.get('MAX_DISCOVERY_BATCH_SIZE', '50'))
SIGNAL_QUEUE_TTL_SECONDS = int(os.environ.get('SIGNAL_QUEUE_TTL_SECONDS', '60'))
MAX_QUEUED_SIGNALS_PER_CLIENT = int(os.environ.get('MAX_QUEUED_SIGNALS_PER_CLIENT', '32'))
DB_PATH = Path(os.environ.get('DISCOVERY_DB_PATH', 'discovery.db'))
SIGNAL_HOST = os.environ.get('SIGNAL_HOST', '0.0.0.0')
SIGNAL_PORT = int(os.environ.get('SIGNAL_PORT', '8443'))
TLS_CERT_PATH = os.environ.get('TLS_CERT_PATH')
TLS_KEY_PATH = os.environ.get('TLS_KEY_PATH')
PEER_DISCOVERY_WINDOW_DAYS = int(os.environ.get('PEER_DISCOVERY_WINDOW_DAYS', '30'))
MAX_REPLY_ACTIVITY_BONUS = 3
MAX_LIKE_ACTIVITY_BONUS = 3
ENGAGEMENT_SIGNAL_WEIGHT = 0.5
MAX_POSTS_PER_AUTHOR_PER_DISCOVERY_BATCH = 2
DISCOVERY_INTERACTION_SHARE = 0.25
MAX_PEER_ACTIVITY_SCORE = 10

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
            if websocket_is_open(websocket):
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
            if websocket_is_open(ws):
                await ws.send(message)
        except Exception:
            pass


async def handle_peer_list_request(message: dict, websocket: WebSocketServerProtocol, client_id: Optional[str]) -> None:
    request_id = message.get('requestId')
    if (
        client_id
        and clients.get(client_id) is websocket
        and normalize_client_id(message.get('id')) == client_id
        and isinstance(request_id, str)
        and 0 < len(request_id) <= 128
    ):
        await websocket.send(json.dumps({
            'type': 'peer-list',
            'peers': list(clients.keys()),
            'requestId': request_id
        }))


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
        _ensure_discovery_profiles_table(conn)
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
    _ensure_discovery_profiles_table(conn)
    conn.commit()
    return conn


def _ensure_discovery_profiles_table(conn: sqlite3.Connection) -> None:
    conn.execute('''
        CREATE TABLE IF NOT EXISTS discovery_profiles (
            author TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            object_id TEXT NOT NULL,
            object_json TEXT NOT NULL
        )
    ''')


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
    if limit <= 0:
        return []

    rows = DB_CONN.execute(
        'SELECT object_json, tags FROM discovery_posts'
    ).fetchall()
    objects = []
    replies_by_post: Dict[str, Set[str]] = {}
    for object_json, tags in rows:
        try:
            obj = json.loads(object_json)
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(obj, dict):
            continue
        objects.append((obj, tags if isinstance(tags, str) else ''))
        payload = obj.get('payload')
        reply_to = payload.get('reply_to') if isinstance(payload, dict) else None
        if obj.get('object_type') == 'mycelium.post' and _is_object_id(reply_to):
            reply_id = obj.get('object_id')
            if isinstance(reply_id, str) and reply_id:
                replies_by_post.setdefault(reply_to, set()).add(reply_id)

    likes_by_post: Dict[str, Set[str]] = {}
    recommendations = _latest_recommendations([obj for obj, _ in objects])
    for (author, post_id), recommendation in recommendations.items():
        if recommendation['action'] == 'recommend':
            likes_by_post.setdefault(post_id, set()).add(author)

    feed_posts = []
    interaction_objects = []
    for obj, object_tags in objects:
        if tag and tag not in object_tags:
            continue
        payload = obj.get('payload')
        reply_to = payload.get('reply_to') if isinstance(payload, dict) else None
        if obj.get('object_type') == 'mycelium.post' and reply_to is None:
            feed_posts.append(obj)
        else:
            interaction_objects.append(obj)

    interaction_limit = min(len(interaction_objects), int(limit * DISCOVERY_INTERACTION_SHARE))
    feed_limit = min(len(feed_posts), limit - interaction_limit)
    ranked_posts = _sample_reply_active_posts(feed_posts, replies_by_post, likes_by_post, feed_limit)
    if len(ranked_posts) + interaction_limit < limit:
        remaining_posts = [post for post in feed_posts if post not in ranked_posts]
        ranked_posts.extend(_sample_reply_active_posts(
            remaining_posts,
            replies_by_post,
            likes_by_post,
            limit - len(ranked_posts) - interaction_limit
        ))
    sampled_interactions = random.sample(interaction_objects, interaction_limit)
    selected = ranked_posts + sampled_interactions
    if len(selected) < limit:
        selected_ids = {obj.get('object_id') for obj in selected}
        remaining_objects = [
            obj for obj, object_tags in objects
            if (not tag or tag in object_tags)
            and obj.get('object_id') not in selected_ids
        ]
        selected.extend(random.sample(remaining_objects, min(limit - len(selected), len(remaining_objects))))
    return selected


def _is_object_id(value) -> bool:
    return isinstance(value, str) and len(value) == 64 \
        and all(character in '0123456789abcdef' for character in value)


def _latest_recommendations(objects: List[dict]) -> Dict[Tuple[str, str], dict]:
    latest_by_author_post: Dict[Tuple[str, str], dict] = {}
    seen_object_ids = set()
    for obj in objects:
        if obj.get('object_type') != 'mycelium.recommendation':
            continue
        payload = obj.get('payload')
        author = obj.get('author')
        post_id = payload.get('post_id') if isinstance(payload, dict) else None
        sequence = obj.get('sequence')
        action = payload.get('action') if isinstance(payload, dict) else None
        object_id = obj.get('object_id')
        if not isinstance(author, str) or not author.strip() or not _is_object_id(post_id) \
                or not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 1 \
                or (payload.get('sequence') if isinstance(payload, dict) else None) != sequence \
                or action not in {'recommend', 'withdraw'} \
                or not isinstance(object_id, str) or not object_id or object_id in seen_object_ids:
            continue
        seen_object_ids.add(object_id)
        key = (author, post_id)
        previous = latest_by_author_post.get(key)
        if previous is None or sequence > previous['sequence'] \
                or (sequence == previous['sequence'] and object_id > previous['object_id']):
            latest_by_author_post[key] = {
                'sequence': sequence,
                'object_id': object_id,
                'action': action
            }
    return latest_by_author_post


def _sample_reply_active_posts(
    posts: List[dict],
    replies_by_post: Dict[str, Set[str]],
    likes_by_post: Dict[str, Set[str]],
    limit: int
) -> List[dict]:
    remaining = list(posts)
    selected: List[dict] = []
    author_counts: Dict[str, int] = {}
    while remaining and len(selected) < limit:
        diverse = [
            post for post in remaining
            if author_counts.get(post.get('author', ''), 0) < MAX_POSTS_PER_AUTHOR_PER_DISCOVERY_BATCH
        ]
        candidates = diverse or remaining
        weights = []
        for post in candidates:
            post_id = post.get('object_id')
            reply_count = len(replies_by_post.get(post_id, set())) if isinstance(post_id, str) else 0
            like_count = len(likes_by_post.get(post_id, set())) if isinstance(post_id, str) else 0
            engagement_bonus = min(reply_count, MAX_REPLY_ACTIVITY_BONUS) * ENGAGEMENT_SIGNAL_WEIGHT
            engagement_bonus += min(like_count, MAX_LIKE_ACTIVITY_BONUS) * ENGAGEMENT_SIGNAL_WEIGHT
            weights.append(1 + engagement_bonus)
        choice = random.random() * sum(weights)
        selected_index = len(candidates) - 1
        for index, weight in enumerate(weights):
            choice -= weight
            if choice < 0:
                selected_index = index
                break
        selected_post = candidates[selected_index]
        selected.append(selected_post)
        author = selected_post.get('author', '')
        if not isinstance(author, str):
            author = ''
        author_counts[author] = author_counts.get(author, 0) + 1
        remaining.remove(selected_post)
    return selected


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
    for popular_peer in load_popular_peers(limit):
        peer_id = popular_peer['peer_id']
        if peer_id not in seen:
            seen.add(peer_id)
            peer_ids.append(peer_id)
            if len(peer_ids) >= limit:
                return peer_ids
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
    objects = []
    posts_by_id: Dict[str, str] = {}
    for (object_json,) in rows:
        try:
            obj = json.loads(object_json)
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(obj, dict):
            continue
        objects.append(obj)
        if obj.get('object_type') == 'mycelium.post' and _is_object_id(obj.get('object_id')) \
                and isinstance(obj.get('author'), str) and obj['author'].strip():
            posts_by_id[obj['object_id']] = obj['author']

    reply_activity_by_peer_post: Dict[str, Set[str]] = {}
    for obj in objects:
        payload = obj.get('payload')
        if not isinstance(payload, dict):
            continue
        if obj.get('object_type') in {'mycelium.post', 'mycelium.reply'}:
            if obj.get('object_type') == 'mycelium.post':
                parent_id = payload.get('reply_to')
                target_author = posts_by_id.get(parent_id) if _is_object_id(parent_id) else None
                peer_id = _peer_id_for_author(target_author) if target_author else payload.get('reply_to_author')
                if not isinstance(parent_id, str) or not parent_id.strip():
                    parent_id = obj.get('object_id')
            else:
                parent_id = payload.get('reply_to')
                peer_id = payload.get('reply_to_author')
                if not isinstance(parent_id, str) or not parent_id:
                    parent_id = obj.get('object_id')
            if isinstance(peer_id, str) and peer_id.strip() and isinstance(parent_id, str) and parent_id.strip():
                reply_activity_by_peer_post.setdefault(peer_id.strip(), set()).add(parent_id)

    likes_by_post: Dict[str, Set[str]] = {}
    recommendations = _latest_recommendations(objects)
    for (author, post_id), recommendation in recommendations.items():
        if recommendation['action'] == 'recommend':
            likes_by_post.setdefault(post_id, set()).add(author)

    scores_by_peer: Dict[str, float] = {}
    for peer_id, posts in reply_activity_by_peer_post.items():
        scores_by_peer[peer_id] = scores_by_peer.get(peer_id, 0) + len(posts)
    for post_id, likers in likes_by_post.items():
        post_author = posts_by_id.get(post_id)
        if not post_author:
            continue
        peer_id = _peer_id_for_author(post_author)
        scores_by_peer[peer_id] = scores_by_peer.get(peer_id, 0) \
            + min(len(likers), MAX_LIKE_ACTIVITY_BONUS) * ENGAGEMENT_SIGNAL_WEIGHT

    ranked = [
        (peer_id, min(score, MAX_PEER_ACTIVITY_SCORE))
        for peer_id, score in scores_by_peer.items()
    ]
    random.shuffle(ranked)
    ranked.sort(key=lambda item: -item[1])
    profile_rows = DB_CONN.execute(
        'SELECT author, object_json FROM discovery_profiles'
    ).fetchall()
    profiles_by_peer = {}
    for author, object_json in profile_rows:
        peer_id = _peer_id_for_author(author)
        try:
            profile = json.loads(object_json)
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(profile, dict):
            profiles_by_peer[peer_id] = profile
    return [
        {
            'peer_id': peer_id,
            'activity_score': score,
            **({'identity_profile': profiles_by_peer[peer_id]} if peer_id in profiles_by_peer else {})
        }
        for peer_id, score in ranked[:max(0, limit)]
    ]


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
    object_type = object_payload.get('object_type')
    max_object_size = MAX_IDENTITY_PROFILE_SIZE if object_type == 'mycelium.identity' else MAX_POST_SIZE
    if len(raw_object_json) > max_object_size:
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
    if object_type == 'mycelium.identity':
        await store_discovery_identity_profile(object_payload)
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


def _identity_profile_version_key(profile: dict) -> Tuple[float, str]:
    created_at = profile.get('created_at')
    timestamp = float('-inf')
    if isinstance(created_at, str):
        try:
            parsed = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            timestamp = parsed.timestamp()
        except (ValueError, OverflowError):
            pass
    object_id = profile.get('object_id')
    return timestamp, object_id if isinstance(object_id, str) else ''


def _canonicalize_profile_value(value) -> str:
    if value is None:
        return 'null'
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError('Non-finite JSON number')
        if value == 0:
            return '0'
        rendered = repr(value).lower()
        if 'e' not in rendered:
            return rendered[:-2] if rendered.endswith('.0') else rendered
        mantissa, exponent_text = rendered.split('e')
        exponent = int(exponent_text)
        if -6 <= exponent < 21:
            sign = '-' if mantissa.startswith('-') else ''
            digits = mantissa.lstrip('-').replace('.', '')
            decimal_position = mantissa.lstrip('-').find('.')
            if decimal_position < 0:
                decimal_position = len(mantissa.lstrip('-'))
            decimal_position += exponent
            if decimal_position <= 0:
                return '{}0.{}{}'.format(sign, '0' * -decimal_position, digits)
            if decimal_position >= len(digits):
                return '{}{}{}'.format(sign, digits, '0' * (decimal_position - len(digits)))
            return '{}{}.{}'.format(sign, digits[:decimal_position], digits[decimal_position:])
        mantissa = mantissa[:-2] if mantissa.endswith('.0') else mantissa
        sign = '+' if exponent >= 0 else ''
        return '{}e{}{}'.format(mantissa, sign, exponent)
    if isinstance(value, list):
        return '[{}]'.format(','.join(_canonicalize_profile_value(item) for item in value))
    if isinstance(value, dict):
        return '{{{}}}'.format(','.join(
            '{}:{}'.format(
                json.dumps(key, ensure_ascii=False, separators=(',', ':')),
                _canonicalize_profile_value(value[key])
            )
            for key in sorted(value, key=lambda item: item.encode('utf-16-be', 'surrogatepass'))
        ))
    raise ValueError('Value is not JSON serializable')


def _profile_signing_key(author: str):
    try:
        der = base64.b64decode(author, validate=True)
        key = serialization.load_der_public_key(der)
    except (ValueError, TypeError, UnsupportedAlgorithm):
        return None
    if not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(key.curve, ec.SECP256R1):
        return None
    return key


def _verify_profile_signature(author: str, message: str, signature: str) -> bool:
    key = _profile_signing_key(author)
    if key is None:
        return False
    try:
        raw_signature = base64.b64decode(signature, validate=True)
        if len(raw_signature) != 64:
            return False
        der_signature = utils.encode_dss_signature(
            int.from_bytes(raw_signature[:32], 'big'),
            int.from_bytes(raw_signature[32:], 'big')
        )
        key.verify(der_signature, message.encode('utf-8'), ec.ECDSA(hashes.SHA256()))
        return True
    except (InvalidSignature, ValueError, TypeError, UnicodeEncodeError):
        return False


def _valid_profile_timestamp(value) -> bool:
    if not isinstance(value, str):
        return False
    try:
        datetime.fromisoformat(value.replace('Z', '+00:00'))
        return True
    except ValueError:
        return False


def _is_json_value(value) -> bool:
    if value is None or isinstance(value, (str, bool, int)):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(_is_json_value(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and _is_json_value(item) for key, item in value.items())
    return False


def _validate_discovery_identity_profile(profile: dict) -> bool:
    if not isinstance(profile, dict) or profile.get('object_type') != 'mycelium.identity':
        return False
    author = profile.get('author')
    object_id = profile.get('object_id')
    signature = profile.get('signature')
    payload = profile.get('payload')
    policy = profile.get('replication_policy')
    if (not isinstance(author, str) or not author
            or not isinstance(object_id, str) or len(object_id) != 64
            or any(character not in '0123456789abcdef' for character in object_id)
            or not isinstance(signature, str) or not signature
            or not isinstance(payload, dict) or not isinstance(policy, dict)
            or not _valid_profile_timestamp(profile.get('created_at'))):
        return False
    if ('recipient' in profile and (not isinstance(profile['recipient'], str) or not profile['recipient'])
            or 'expires_at' in profile and not _valid_profile_timestamp(profile['expires_at'])
            or 'sequence' in profile and (
                not isinstance(profile['sequence'], int)
                or isinstance(profile['sequence'], bool)
                or profile['sequence'] < 0
                or profile['sequence'] > 9007199254740991
            )):
        return False
    if not _is_json_value(payload) or not _is_json_value(policy):
        return False
    replication_budget = policy.get('replication_budget')
    if replication_budget is not None and (
        not isinstance(replication_budget, int)
        or isinstance(replication_budget, bool)
        or replication_budget < 0
        or replication_budget > 9007199254740991
    ):
        return False
    if 'expires_at' in policy and not _valid_profile_timestamp(policy['expires_at']):
        return False

    display_name = payload.get('display_name')
    bio = payload.get('bio')
    encryption_public_key = payload.get('encryption_public_key')
    binding = payload.get('encryption_key_binding')
    if (not isinstance(display_name, str) or not isinstance(bio, str)
            or not isinstance(encryption_public_key, str)
            or not isinstance(binding, dict)
            or binding.get('signing_public_key') != author
            or binding.get('encryption_public_key') != encryption_public_key
            or not _valid_profile_timestamp(binding.get('created_at'))
            or not isinstance(binding.get('signature'), str)):
        return False

    try:
        binding_message = json.dumps({
            'domain': 'mycelium-enc-key-binding-v1',
            'signing_public_key': binding['signing_public_key'],
            'encryption_public_key': binding['encryption_public_key'],
            'created_at': binding['created_at']
        }, ensure_ascii=False, separators=(',', ':'))
        if not _verify_profile_signature(
            author,
            binding_message,
            binding['signature']
        ):
            return False
        object_content = {
            key: profile[key]
            for key in (
                'object_type', 'author', 'recipient', 'created_at',
                'expires_at', 'sequence', 'payload', 'replication_policy'
            )
            if key in profile
        }
        version = profile.get('object_id_version')
        if version is None:
            if 'content_hash' in profile or 'author_proof' in profile:
                return False
            canonical_content = _canonicalize_profile_value(object_content)
            if hashlib.sha256(canonical_content.encode('utf-8')).hexdigest() != object_id:
                return False
            return _verify_profile_signature(author, canonical_content, signature)

        canonical_content = _canonicalize_profile_value(object_content)
        content_hash = hashlib.sha256(canonical_content.encode('utf-8')).hexdigest()
        if profile.get('content_hash') != content_hash:
            return False
        if version == 2:
            if not isinstance(profile.get('author_proof'), str):
                return False
            expected_object_id = hashlib.sha256(_canonicalize_profile_value({
                'domain': 'mycelium.object-id.v2',
                'author': author,
                'content_hash': content_hash
            }).encode('utf-8')).hexdigest()
            if expected_object_id != object_id or not _verify_profile_signature(
                author,
                _canonicalize_profile_value({
                    'domain': 'mycelium.object-author-proof.v2',
                    'author': author,
                    'content_hash': content_hash
                }),
                profile['author_proof']
            ):
                return False
            return _verify_profile_signature(author, canonical_content, signature)
        if version == 3:
            if 'author_proof' in profile:
                return False
            return _verify_profile_signature(
                author,
                _canonicalize_profile_value({
                    'domain': 'mycelium.object-signature.v3',
                    'object_id': object_id,
                    'content_hash': content_hash
                }),
                signature
            )
        return False
    except (KeyError, TypeError, ValueError, UnicodeEncodeError):
        return False


async def store_discovery_identity_profile(profile: dict) -> None:
    if not _validate_discovery_identity_profile(profile):
        logging.warning('DISCOVERY_PUBLISH identity profile failed signature or structure validation, ignoring')
        return
    author = profile['author']
    try:
        DB_CONN.execute('BEGIN IMMEDIATE')
        current_row = DB_CONN.execute(
            'SELECT object_json FROM discovery_profiles WHERE author = ?',
            (author,)
        ).fetchone()
        if current_row:
            try:
                current_profile = json.loads(current_row[0])
            except (TypeError, json.JSONDecodeError):
                current_profile = {}
            if isinstance(current_profile, dict) \
                    and _identity_profile_version_key(profile) <= _identity_profile_version_key(current_profile):
                DB_CONN.rollback()
                logging.info('Ignored non-newer identity profile for %s', author)
                return
        else:
            profile_count = DB_CONN.execute(
                'SELECT COUNT(*) FROM discovery_profiles'
            ).fetchone()[0]
            if profile_count >= MAX_DISCOVERY_PROFILES:
                DB_CONN.rollback()
                logging.info(
                    'Rejected new discovery identity profile for %s: profile table is at capacity (%d)',
                    author,
                    MAX_DISCOVERY_PROFILES
                )
                return
        DB_CONN.execute(
            '''INSERT INTO discovery_profiles (author, created_at, object_id, object_json)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(author) DO UPDATE SET
                   created_at = excluded.created_at,
                   object_id = excluded.object_id,
                   object_json = excluded.object_json''',
            (author, str(profile.get('created_at', '')), str(profile.get('object_id', '')), json.dumps(profile))
        )
        DB_CONN.commit()
    except sqlite3.Error:
        DB_CONN.rollback()
        logging.exception('Failed to persist identity profile from %s; keeping signalling session alive', author)
        return
    logging.info('Stored latest discovery identity profile for %s', author)


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
                registered_id = normalize_client_id(message.get('id'))
                if not registered_id or not PEER_ID_PATTERN.fullmatch(registered_id):
                    logging.warning('Invalid register payload')
                    continue
                client_id = registered_id
                if client_id in clients and clients[client_id] is not websocket:
                    logging.info('Overwriting existing registration for %s', client_id)
                clients[client_id] = websocket
                logging.info('Registered client %s (%d clients currently)', client_id, len(clients))
                await broadcast_peer_list()
                await flush_queued_signals(client_id, websocket)
                continue

            if msg_type == 'peer-list-request':
                await handle_peer_list_request(message, websocket, client_id)
                continue

            if msg_type in {'offer', 'answer', 'ice-candidate'}:
                if not validate_signal_message(message):
                    logging.warning('Rejected malformed %s signalling message', msg_type)
                    continue
                target = normalize_client_id(message.get('to'))
                sender = normalize_client_id(message.get('from'))
                if not client_id or sender != client_id:
                    logging.warning('Rejected %s signalling message with unregistered sender', msg_type)
                    continue
                recipient = clients.get(target)
                if recipient and websocket_is_open(recipient):
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

async def websocket_handler(websocket: WebSocketServerProtocol, path: Optional[str] = None) -> None:
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
