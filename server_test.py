import asyncio
import importlib
import json
import os
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

    def test_peer_pool_http_route_returns_recent_post_authors(self):
        post = self.store_object('pool-post', 'mycelium.post', 'author-key', {'content': 'hello'})
        status, body = self.server.build_discovery_api_response('/api/peer-pool')

        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['peers'], [self.server._peer_id_for_author(post['author'])])


if __name__ == '__main__':
    unittest.main()
