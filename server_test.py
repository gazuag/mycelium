import asyncio
import importlib
import json
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta


class FakeWebSocket:
    def __init__(self):
        self.messages = []
        self.open = True

    async def send(self, message):
        self.messages.append(json.loads(message))


class DiscoveryObjectServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory()
        os.environ['DISCOVERY_DB_PATH'] = os.path.join(cls.temp_dir.name, 'discovery.db')
        cls.server = importlib.import_module('server')

    @classmethod
    def tearDownClass(cls):
        cls.server.DB_CONN.close()
        cls.temp_dir.cleanup()

    def setUp(self):
        self.server.DB_CONN.execute('DELETE FROM discovery_posts')
        self.server.DB_CONN.commit()

    def store_object(self, object_id, object_type, author, payload, received_at=None):
        obj = {
            'object_id': object_id,
            'object_type': object_type,
            'author': author,
            'created_at': datetime.utcnow().isoformat() + 'Z',
            'payload': payload,
            'signature': 'not-validated-by-server'
        }
        self.server.DB_CONN.execute(
            'INSERT INTO discovery_posts (id, received_at, object_json, author, tags) VALUES (?, ?, ?, ?, ?)',
            (object_id, received_at or datetime.utcnow().isoformat() + 'Z', json.dumps(obj), author, '')
        )
        self.server.DB_CONN.commit()
        return obj

    def test_stores_and_retrieves_opaque_distributed_object(self):
        object_value = {
            'object_id': 'a' * 64,
            'object_type': 'mycelium.post',
            'author': 'author-key',
            'created_at': '2026-08-25T00:00:00.000Z',
            'payload': {'content': 'opaque', 'tags': ['stage5']},
            'replication_policy': {},
            'signature': 'not-validated-by-server'
        }
        message = {
            'id': 'publish-id',
            'sender': 'author-key',
            'payload': {'object': object_value}
        }
        asyncio.run(self.server.handle_discovery_publish(message))
        rows = self.server.load_discovery_posts(10, 'stage5')
        self.assertEqual(rows, [object_value])

        result = self.server.build_discovery_result_packet(rows, request_id='get-id', recipient='client')
        self.assertEqual(result['payload']['objects'], [object_value])
        self.assertNotIn('posts', result['payload'])

    def test_migrates_legacy_post_json_not_null_schema(self):
        legacy_path = os.path.join(self.temp_dir.name, 'legacy.db')
        legacy = sqlite3.connect(legacy_path)
        legacy.execute('''CREATE TABLE discovery_posts (
            id TEXT PRIMARY KEY, received_at TEXT NOT NULL, post_json TEXT NOT NULL,
            author TEXT NOT NULL, tags TEXT
        )''')
        old_object = {'object_type': 'mycelium.post', 'author': 'old-author'}
        legacy.execute(
            'INSERT INTO discovery_posts (id, received_at, post_json, author, tags) VALUES (?, ?, ?, ?, ?)',
            ('legacy-id', datetime.utcnow().isoformat() + 'Z', json.dumps(old_object), 'old-author', '')
        )
        legacy.commit()
        legacy.close()

        migrated = self.server.init_db(legacy_path)
        columns = {row[1] for row in migrated.execute('PRAGMA table_info(discovery_posts)')}
        self.assertIn('object_json', columns)
        self.assertNotIn('post_json', columns)
        self.assertEqual(json.loads(migrated.execute('SELECT object_json FROM discovery_posts WHERE id = ?', ('legacy-id',)).fetchone()[0]), old_object)
        migrated.execute(
            'INSERT INTO discovery_posts (id, received_at, object_json, author, tags) VALUES (?, ?, ?, ?, ?)',
            ('new-id', datetime.utcnow().isoformat() + 'Z', json.dumps({'object_type': 'mycelium.post'}), 'new-author', '')
        )
        migrated.commit()
        migrated.close()

    def test_publish_database_error_does_not_escape_handler(self):
        class FailingDatabase:
            rolled_back = False

            def execute(self, *_args):
                raise sqlite3.IntegrityError('simulated legacy schema failure')

            def rollback(self):
                self.rolled_back = True

        original_db = self.server.DB_CONN
        failing_db = FailingDatabase()
        self.server.DB_CONN = failing_db
        object_value = {
            'object_id': 'error-object',
            'object_type': 'mycelium.post',
            'author': 'author-key',
            'created_at': datetime.utcnow().isoformat() + 'Z',
            'payload': {'content': 'test'},
            'signature': 'not-validated-by-server'
        }
        try:
            asyncio.run(self.server.handle_discovery_publish({'payload': {'object': object_value}}))
        finally:
            self.server.DB_CONN = original_db
        self.assertTrue(failing_db.rolled_back)

    def test_popular_peer_tally_groups_reply_authors(self):
        self.store_object('reply-1', 'mycelium.post', 'author-a', {'reply_to_author': 'peer-a', 'reply_to': 'post-1'})
        self.store_object('reply-2', 'mycelium.post', 'author-b', {'reply_to_author': 'peer-a', 'reply_to': 'post-2'})
        self.store_object('reply-3', 'mycelium.post', 'author-c', {'reply_to_author': 'peer-b', 'reply_to': 'post-3'})
        self.store_object('reply-object', 'mycelium.reply', 'author-d', {'reply_to_author': 'peer-c', 'reply_to': 'post-4'})
        self.store_object('normal-post', 'mycelium.post', 'author-d', {'content': 'not a reply'})
        self.store_object('other-type', 'mycelium.like', 'author-e', {'reply_to_author': 'peer-d'})
        old_received_at = (datetime.utcnow() - timedelta(days=self.server.PEER_DISCOVERY_WINDOW_DAYS + 1)).isoformat() + 'Z'
        self.store_object('old-reply', 'mycelium.post', 'author-f', {'reply_to_author': 'peer-old'}, old_received_at)

        self.assertEqual(self.server.load_popular_peers(), [
            {'peer_id': 'peer-a', 'reply_count': 2},
            {'peer_id': 'peer-b', 'reply_count': 1},
            {'peer_id': 'peer-c', 'reply_count': 1}
        ])

    def test_popular_peers_returns_only_top_ten(self):
        for peer_number in range(12):
            for reply_number in range(peer_number + 1):
                self.store_object(
                    f'reply-{peer_number}-{reply_number}',
                    'mycelium.post',
                    f'author-{peer_number}-{reply_number}',
                    {'reply_to_author': f'peer-{peer_number:02d}'}
                )

        peers = self.server.load_popular_peers()
        self.assertEqual(len(peers), 10)
        self.assertEqual(peers[0], {'peer_id': 'peer-11', 'reply_count': 12})
        self.assertNotIn('peer-00', [peer['peer_id'] for peer in peers])

    def test_peer_pool_request_returns_protocol_response_over_websocket(self):
        post = self.store_object('pool-post', 'mycelium.post', 'author-key', {'content': 'hello'})
        websocket = FakeWebSocket()
        asyncio.run(self.server.handle_peer_pool_get({'id': 'pool-request', 'sender': 'requester'}, websocket))

        self.assertEqual(websocket.messages[0]['type'], 'PEER_POOL_RESULT')
        self.assertEqual(websocket.messages[0]['payload']['requestId'], 'pool-request')
        self.assertEqual(websocket.messages[0]['payload']['peers'], [self.server._peer_id_for_author(post['author'])])

    def test_popular_peer_request_returns_correlated_protocol_response(self):
        self.store_object('popular-reply', 'mycelium.post', 'author', {'reply_to_author': 'popular-peer'})
        websocket = FakeWebSocket()
        asyncio.run(self.server.handle_popular_peers_get({'id': 'popular-request', 'sender': 'requester'}, websocket))

        self.assertEqual(websocket.messages[0]['type'], 'POPULAR_PEERS_RESULT')
        self.assertEqual(websocket.messages[0]['payload']['requestId'], 'popular-request')
        self.assertEqual(websocket.messages[0]['payload']['peers'], [{'peer_id': 'popular-peer', 'reply_count': 1}])


if __name__ == '__main__':
    unittest.main()
