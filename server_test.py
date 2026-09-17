import asyncio
import importlib
import json
import os
import tempfile
import unittest


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


if __name__ == '__main__':
    unittest.main()
