import asyncio
import base64
import hashlib
import importlib
import json
import os
import sqlite3
import subprocess
import textwrap
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils


def _canonicalize(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    if isinstance(value, list):
        return '[{}]'.format(','.join(_canonicalize(item) for item in value))
    return '{{{}}}'.format(','.join(
        '{}:{}'.format(json.dumps(key, ensure_ascii=False), _canonicalize(value[key]))
        for key in sorted(value)
    ))


def _public_key_string(key):
    return base64.b64encode(key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo
    )).decode('ascii')


def _sign(key, message):
    der_signature = key.sign(message.encode('utf-8'), ec.ECDSA(hashes.SHA256()))
    r, s = utils.decode_dss_signature(der_signature)
    return base64.b64encode(r.to_bytes(32, 'big') + s.to_bytes(32, 'big')).decode('ascii')


def generate_typescript_identity_profiles():
    script = textwrap.dedent('''
        import { createServer } from 'vite';

        const vite = await createServer({
          configFile: './vite.config.ts',
          server: { middlewareMode: true },
          appType: 'custom'
        });
        try {
          const cryptoIdentity = await vite.ssrLoadModule('/src/crypto/identity.ts');
          const dmCrypto = await vite.ssrLoadModule('/src/crypto/dm-crypto.ts');
          const objectIdentity = await vite.ssrLoadModule('/src/object-layer/identity.ts');
          const identityObject = await vite.ssrLoadModule('/src/object-layer/identity-object.ts');
          const signingPair = await cryptoIdentity.generateIdentityKeyPair();
          const publicKey = await cryptoIdentity.exportPublicKey(signingPair.publicKey);
          const privateKey = await cryptoIdentity.exportPrivateKey(signingPair.privateKey);
          const encryptionPair = await dmCrypto.generateEncryptionKeyPair();
          const encryptionPublicKey = await dmCrypto.exportEncryptionPublicKey(encryptionPair.publicKey);
          const identity = objectIdentity.createObjectIdentity({ id: 'interop-test', publicKey, privateKey });
          const binding = await dmCrypto.createEncryptionKeyBinding({ publicKey, privateKey, encryptionPublicKey });
          const createProfile = (displayName, createdAt) => identityObject.createSignedIdentityObject({
            display_name: displayName,
            bio: `Bio for ${displayName}`,
            encryption_public_key: encryptionPublicKey,
            encryption_key_binding: binding,
            created_at: createdAt
          }, identity);
          const profiles = await Promise.all([
            createProfile('TypeScript older profile', '2026-11-01T00:00:00.000Z'),
            createProfile('TypeScript newer profile', '2026-11-02T00:00:00.000Z')
          ]);
          process.stdout.write(JSON.stringify(profiles));
        } finally {
          await vite.close();
        }
    ''')
    return subprocess.run(
        ['node', '--input-type=module', '-e', script],
        cwd=Path(__file__).resolve().parents[1],
        check=True,
        capture_output=True,
        text=True
    ).stdout


def make_identity_profile(
    display_name,
    created_at,
    author_key=None,
    object_signing_key=None,
    binding_signing_key=None,
    object_id=None,
    profile_picture=None
):
    author_key = author_key or ec.generate_private_key(ec.SECP256R1())
    object_signing_key = object_signing_key or author_key
    binding_signing_key = binding_signing_key or author_key
    author = _public_key_string(author_key)
    binding = {
        'signing_public_key': _public_key_string(binding_signing_key),
        'encryption_public_key': 'test-encryption-public-key',
        'created_at': created_at
    }
    binding_message = json.dumps({
        'domain': 'mycelium-enc-key-binding-v1',
        'signing_public_key': binding['signing_public_key'],
        'encryption_public_key': binding['encryption_public_key'],
        'created_at': binding['created_at']
    }, ensure_ascii=False, separators=(',', ':'))
    payload = {
        'display_name': display_name,
        'bio': 'Profile for {}'.format(display_name),
        'encryption_public_key': binding['encryption_public_key'],
        'encryption_key_binding': {
            **binding,
            'signature': _sign(binding_signing_key, binding_message)
        }
    }
    if profile_picture is not None:
        payload['profile_picture'] = profile_picture
    content = {
        'object_type': 'mycelium.identity',
        'author': author,
        'created_at': created_at,
        'payload': payload,
        'replication_policy': {}
    }
    content_hash = hashlib.sha256(_canonicalize(content).encode('utf-8')).hexdigest()
    object_id = object_id or hashlib.sha256((display_name + created_at).encode('utf-8')).hexdigest()
    signature_payload = _canonicalize({
        'domain': 'mycelium.object-signature.v3',
        'object_id': object_id,
        'content_hash': content_hash
    })
    return {
        **content,
        'object_id': object_id,
        'signature': _sign(object_signing_key, signature_payload),
        'object_id_version': 3,
        'content_hash': content_hash
    }


class FakeWebSocket:
    def __init__(self):
        self.messages = []
        self.open = True

    async def send(self, message):
        self.messages.append(json.loads(message))


class IncomingSignalWebSocket(FakeWebSocket):
    def __init__(self, messages):
        super().__init__()
        self.incoming_messages = messages

    def __aiter__(self):
        async def receive_messages():
            for message in self.incoming_messages:
                yield json.dumps(message)

        return receive_messages()


class ModernFakeWebSocket:
    def __init__(self, state_name):
        self.state = type('State', (), {'name': state_name})()


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
        self.server.DB_CONN.execute('DELETE FROM discovery_profiles')
        self.server.DB_CONN.commit()

    def test_websocket_open_check_supports_legacy_and_current_apis(self):
        self.assertTrue(self.server.websocket_is_open(FakeWebSocket()))
        self.assertTrue(self.server.websocket_is_open(ModernFakeWebSocket('OPEN')))
        self.assertFalse(self.server.websocket_is_open(ModernFakeWebSocket('CLOSED')))

    def store_object(self, object_id, object_type, author, payload, received_at=None, sequence=None):
        obj = {
            'object_id': object_id,
            'object_type': object_type,
            'author': author,
            'created_at': datetime.utcnow().isoformat() + 'Z',
            'payload': payload,
            'signature': 'not-validated-by-server'
        }
        if sequence is not None:
            obj['sequence'] = sequence
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

    def test_rejects_direct_message_discovery_publish(self):
        object_value = {
            'object_id': 'd' * 64,
            'object_type': 'mycelium.dm',
            'author': 'author-key',
            'created_at': datetime.utcnow().isoformat() + 'Z',
            'payload': {'ciphertext': 'private'},
            'signature': 'not-validated-by-server'
        }

        asyncio.run(self.server.handle_discovery_publish({'payload': {'object': object_value}}))

        rows = self.server.DB_CONN.execute('SELECT object_json FROM discovery_posts').fetchall()
        self.assertEqual(rows, [])

    def test_identity_profiles_are_stored_separately_and_latest_wins(self):
        author_key = ec.generate_private_key(ec.SECP256R1())
        older = make_identity_profile('Older', '2026-10-01T00:00:00.000Z', author_key=author_key)
        newer = make_identity_profile('Newer', '2026-10-02T00:00:00.000Z', author_key=author_key)
        asyncio.run(self.server.handle_discovery_publish({'payload': {'object': newer}}))
        asyncio.run(self.server.handle_discovery_publish({'payload': {'object': older}}))

        row = self.server.DB_CONN.execute(
            'SELECT object_json FROM discovery_profiles WHERE author = ?',
            (older['author'],)
        ).fetchone()
        self.assertEqual(json.loads(row[0]), newer)
        self.assertEqual(self.server.DB_CONN.execute('SELECT COUNT(*) FROM discovery_posts').fetchone()[0], 0)
        self.assertEqual(self.server.load_discovery_posts(10, None), [])

    def test_identity_profile_with_maximum_sized_picture_is_accepted(self):
        picture = {
            'mime_type': 'image/webp',
            'width': 256,
            'height': 256,
            'data': base64.b64encode(b'x' * (50 * 1024)).decode('ascii')
        }
        profile = make_identity_profile(
            'Large profile picture',
            '2026-10-03T00:00:00.000Z',
            profile_picture=picture
        )

        asyncio.run(self.server.handle_discovery_publish({'payload': {'object': profile}}))

        row = self.server.DB_CONN.execute(
            'SELECT object_json FROM discovery_profiles WHERE author = ?',
            (profile['author'],)
        ).fetchone()
        self.assertIsNotNone(row)
        stored = json.loads(row[0])
        self.assertEqual(stored['payload']['profile_picture'], picture)

    def test_profile_table_accepts_new_author_below_configured_capacity(self):
        profile = make_identity_profile('First author', '2026-10-01T00:00:00.000Z')
        with patch.object(self.server, 'MAX_DISCOVERY_PROFILES', 2):
            asyncio.run(self.server.store_discovery_identity_profile(profile))

        self.assertEqual(
            self.server.DB_CONN.execute('SELECT COUNT(*) FROM discovery_profiles').fetchone()[0],
            1
        )

    def test_profile_table_rejects_new_author_at_capacity_without_growing(self):
        existing = make_identity_profile('Existing author', '2026-10-01T00:00:00.000Z')
        newcomer = make_identity_profile('New author', '2026-10-02T00:00:00.000Z')
        with patch.object(self.server, 'MAX_DISCOVERY_PROFILES', 1):
            asyncio.run(self.server.store_discovery_identity_profile(existing))
            asyncio.run(self.server.store_discovery_identity_profile(newcomer))

        rows = self.server.DB_CONN.execute(
            'SELECT author FROM discovery_profiles ORDER BY author'
        ).fetchall()
        self.assertEqual(rows, [(existing['author'],)])

    def test_concurrent_new_authors_cannot_exceed_profile_capacity(self):
        profiles = [
            make_identity_profile(f'Concurrent author {index}', f'2026-10-{index + 1:02d}T00:00:00.000Z')
            for index in range(8)
        ]

        async def publish_profiles():
            with patch.object(self.server, 'MAX_DISCOVERY_PROFILES', 3):
                await asyncio.gather(*(
                    self.server.store_discovery_identity_profile(profile)
                    for profile in profiles
                ))

        asyncio.run(publish_profiles())

        self.assertEqual(
            self.server.DB_CONN.execute('SELECT COUNT(*) FROM discovery_profiles').fetchone()[0],
            3
        )

    def test_valid_existing_author_update_replaces_profile_at_capacity(self):
        author_key = ec.generate_private_key(ec.SECP256R1())
        existing = make_identity_profile('Existing old', '2026-10-01T00:00:00.000Z', author_key=author_key)
        newer = make_identity_profile('Existing new', '2026-10-02T00:00:00.000Z', author_key=author_key)
        other = make_identity_profile('Other author', '2026-10-01T00:00:00.000Z')
        with patch.object(self.server, 'MAX_DISCOVERY_PROFILES', 1):
            asyncio.run(self.server.store_discovery_identity_profile(existing))
            asyncio.run(self.server.store_discovery_identity_profile(newer))
            asyncio.run(self.server.store_discovery_identity_profile(other))

        rows = self.server.DB_CONN.execute(
            'SELECT author, object_json FROM discovery_profiles'
        ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], existing['author'])
        self.assertEqual(json.loads(rows[0][1]), newer)

    def test_older_or_equal_profile_at_capacity_does_not_change_row_or_consume_capacity(self):
        author_key = ec.generate_private_key(ec.SECP256R1())
        existing = make_identity_profile('Existing', '2026-10-02T00:00:00.000Z', author_key=author_key)
        older = make_identity_profile('Older', '2026-10-01T00:00:00.000Z', author_key=author_key)
        newcomer = make_identity_profile('New author', '2026-10-03T00:00:00.000Z')
        with patch.object(self.server, 'MAX_DISCOVERY_PROFILES', 1):
            asyncio.run(self.server.store_discovery_identity_profile(existing))
            asyncio.run(self.server.store_discovery_identity_profile(older))
            asyncio.run(self.server.store_discovery_identity_profile(existing))
            asyncio.run(self.server.store_discovery_identity_profile(newcomer))

        rows = self.server.DB_CONN.execute(
            'SELECT author, object_json FROM discovery_profiles'
        ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], existing['author'])
        self.assertEqual(json.loads(rows[0][1]), existing)

    def test_invalid_profile_does_not_consume_profile_capacity(self):
        invalid = make_identity_profile('Invalid author', '2026-10-02T00:00:00.000Z')
        invalid['signature'] = base64.b64encode(b'\x00' * 64).decode('ascii')
        valid_new_author = make_identity_profile('Valid new author', '2026-10-03T00:00:00.000Z')
        with patch.object(self.server, 'MAX_DISCOVERY_PROFILES', 1):
            asyncio.run(self.server.store_discovery_identity_profile(invalid))
            asyncio.run(self.server.store_discovery_identity_profile(valid_new_author))

        rows = self.server.DB_CONN.execute(
            'SELECT author, object_json FROM discovery_profiles'
        ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], valid_new_author['author'])
        self.assertEqual(json.loads(rows[0][1]), valid_new_author)

    def test_typescript_generated_identity_profiles_validate_and_store_latest(self):
        older, newer = json.loads(generate_typescript_identity_profiles())
        self.assertTrue(self.server._validate_discovery_identity_profile(older))
        self.assertTrue(self.server._validate_discovery_identity_profile(newer))

        asyncio.run(self.server.handle_discovery_publish({'payload': {'object': newer}}))
        asyncio.run(self.server.handle_discovery_publish({'payload': {'object': older}}))

        row = self.server.DB_CONN.execute(
            'SELECT object_json FROM discovery_profiles WHERE author = ?',
            (newer['author'],)
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(json.loads(row[0]), newer)

    def test_identity_profile_version_tie_break_is_deterministic(self):
        timestamp = '2026-10-02T00:00:00.000Z'
        author_key = ec.generate_private_key(ec.SECP256R1())
        profile_a = make_identity_profile('Alphabetically first', timestamp, author_key=author_key, object_id='a' * 64)
        profile_b = make_identity_profile('Alphabetically last', timestamp, author_key=author_key, object_id='b' * 64)

        asyncio.run(self.server.store_discovery_identity_profile(profile_b))
        asyncio.run(self.server.store_discovery_identity_profile(profile_a))
        stored_json = self.server.DB_CONN.execute(
            'SELECT object_json FROM discovery_profiles WHERE author = ?',
            (profile_a['author'],)
        ).fetchone()[0]
        self.assertEqual(json.loads(stored_json), profile_b)

    def test_forged_author_claim_cannot_replace_valid_identity_profile(self):
        victim_key = ec.generate_private_key(ec.SECP256R1())
        attacker_key = ec.generate_private_key(ec.SECP256R1())
        valid = make_identity_profile('Valid profile', '2026-10-01T00:00:00.000Z', author_key=victim_key)
        forged = make_identity_profile(
            'Forged author claim',
            '2026-10-03T00:00:00.000Z',
            author_key=victim_key,
            object_signing_key=attacker_key
        )
        asyncio.run(self.server.store_discovery_identity_profile(valid))
        asyncio.run(self.server.store_discovery_identity_profile(forged))

        stored = self.server.DB_CONN.execute(
            'SELECT object_json FROM discovery_profiles WHERE author = ?',
            (valid['author'],)
        ).fetchone()
        self.assertEqual(json.loads(stored[0]), valid)

    def test_invalid_identity_signature_cannot_replace_valid_profile(self):
        author_key = ec.generate_private_key(ec.SECP256R1())
        valid = make_identity_profile('Valid profile', '2026-10-01T00:00:00.000Z', author_key=author_key)
        invalid_signature = {
            **make_identity_profile('Tampered profile', '2026-10-03T00:00:00.000Z', author_key=author_key),
            'signature': base64.b64encode(b'\x00' * 64).decode('ascii')
        }
        asyncio.run(self.server.store_discovery_identity_profile(valid))
        asyncio.run(self.server.store_discovery_identity_profile(invalid_signature))

        stored = self.server.DB_CONN.execute(
            'SELECT object_json FROM discovery_profiles WHERE author = ?',
            (valid['author'],)
        ).fetchone()
        self.assertEqual(json.loads(stored[0]), valid)

    def test_mismatched_identity_binding_key_cannot_replace_valid_profile(self):
        author_key = ec.generate_private_key(ec.SECP256R1())
        other_key = ec.generate_private_key(ec.SECP256R1())
        valid = make_identity_profile('Valid profile', '2026-10-01T00:00:00.000Z', author_key=author_key)
        mismatched_binding = make_identity_profile(
            'Mismatched binding',
            '2026-10-03T00:00:00.000Z',
            author_key=author_key,
            binding_signing_key=other_key
        )
        asyncio.run(self.server.store_discovery_identity_profile(valid))
        asyncio.run(self.server.store_discovery_identity_profile(mismatched_binding))

        stored = self.server.DB_CONN.execute(
            'SELECT object_json FROM discovery_profiles WHERE author = ?',
            (valid['author'],)
        ).fetchone()
        self.assertEqual(json.loads(stored[0]), valid)

    def test_inconsistent_encryption_key_binding_cannot_replace_valid_profile(self):
        author_key = ec.generate_private_key(ec.SECP256R1())
        valid = make_identity_profile('Valid profile', '2026-10-01T00:00:00.000Z', author_key=author_key)
        inconsistent = make_identity_profile(
            'Inconsistent encryption key',
            '2026-10-03T00:00:00.000Z',
            author_key=author_key
        )
        inconsistent['payload']['encryption_public_key'] = 'different-encryption-key'
        asyncio.run(self.server.store_discovery_identity_profile(valid))
        asyncio.run(self.server.store_discovery_identity_profile(inconsistent))

        stored = self.server.DB_CONN.execute(
            'SELECT object_json FROM discovery_profiles WHERE author = ?',
            (valid['author'],)
        ).fetchone()
        self.assertEqual(json.loads(stored[0]), valid)

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
        parent_ids = ['1' * 64, '2' * 64, '3' * 64, '4' * 64]
        self.store_object('reply-1', 'mycelium.post', 'author-a', {'reply_to_author': 'peer-a', 'reply_to': parent_ids[0]})
        self.store_object('duplicate-reply-1', 'mycelium.post', 'author-b', {'reply_to_author': 'peer-a', 'reply_to': parent_ids[0]})
        self.store_object('reply-2', 'mycelium.post', 'author-b', {'reply_to_author': 'peer-a', 'reply_to': parent_ids[1]})
        self.store_object('reply-3', 'mycelium.post', 'author-c', {'reply_to_author': 'peer-b', 'reply_to': parent_ids[2]})
        self.store_object('reply-object', 'mycelium.reply', 'author-d', {'reply_to_author': 'peer-c', 'reply_to': parent_ids[3]})
        self.store_object('normal-post', 'mycelium.post', 'author-d', {'content': 'not a reply'})
        self.store_object('other-type', 'mycelium.like', 'author-e', {'reply_to_author': 'peer-d'})
        old_received_at = (datetime.utcnow() - timedelta(days=self.server.PEER_DISCOVERY_WINDOW_DAYS + 1)).isoformat() + 'Z'
        self.store_object('old-reply', 'mycelium.post', 'author-f', {'reply_to_author': 'peer-old'}, old_received_at)

        peers = self.server.load_popular_peers()
        self.assertEqual(peers[0], {'peer_id': 'peer-a', 'activity_score': 2})
        self.assertEqual({peer['peer_id'] for peer in peers[1:]}, {'peer-b', 'peer-c'})
        self.assertEqual({peer['activity_score'] for peer in peers}, {1, 2})

    def test_popular_peer_activity_score_is_capped_and_peer_order_varies_on_ties(self):
        for peer_number in range(12):
            for reply_number in range(peer_number + 1):
                self.store_object(
                    f'reply-{peer_number}-{reply_number}',
                    'mycelium.post',
                    f'author-{peer_number}-{reply_number}',
                    {'reply_to_author': f'peer-{peer_number:02d}', 'reply_to': f'post-{peer_number}-{reply_number}'}
                )

        with patch.object(self.server.random, 'shuffle', side_effect=lambda values: values.reverse()):
            peers = self.server.load_popular_peers()
        self.assertEqual(len(peers), 10)
        self.assertEqual(peers[0], {'peer_id': 'peer-11', 'activity_score': 10})
        self.assertTrue(all(0 < peer['activity_score'] <= self.server.MAX_PEER_ACTIVITY_SCORE for peer in peers))
        self.assertIn(3, {peer['activity_score'] for peer in peers})
        self.assertEqual(len({peer['peer_id'] for peer in peers}), 10)

    def test_discovery_sampling_combines_reply_and_like_activity_with_a_per_post_cap(self):
        active_post_id = 'a' * 64
        quiet_post_id = 'b' * 64
        self.store_object(active_post_id, 'mycelium.post', 'author-active', {'content': 'active'})
        self.store_object(quiet_post_id, 'mycelium.post', 'author-quiet', {'content': 'quiet'})
        for number in range(2):
            self.store_object(
                f'reply-{number}',
                'mycelium.post',
                f'replier-{number}',
                {'content': 'reply', 'reply_to': active_post_id}
            )
        for number in range(2):
            self.store_object(
                f'like-{number}',
                'mycelium.recommendation',
                f'liker-{number}',
                {'post_id': active_post_id, 'action': 'recommend', 'sequence': 1},
                sequence=1
            )

        with patch.object(self.server.random, 'random', return_value=0.7):
            selected = self.server.load_discovery_posts(1, None)

        self.assertEqual([post['object_id'] for post in selected], [active_post_id])

    def test_discovery_like_scoring_deduplicates_and_uses_latest_withdrawal_sequence(self):
        liked_post_id = 'a' * 64
        quiet_post_id = 'b' * 64
        self.store_object(liked_post_id, 'mycelium.post', 'author-liked', {'content': 'liked'})
        self.store_object(quiet_post_id, 'mycelium.post', 'author-quiet', {'content': 'quiet'})
        older_recommendation = self.store_object(
            'rec-like',
            'mycelium.recommendation',
            'liker',
            {'post_id': liked_post_id, 'action': 'recommend', 'sequence': 1},
            sequence=1
        )
        self.store_object(
            'rec-like-duplicate',
            'mycelium.recommendation',
            'liker',
            {'post_id': liked_post_id, 'action': 'recommend', 'sequence': 1},
            sequence=1
        )

        with patch.object(self.server.random, 'random', return_value=0.4):
            liked_selection = self.server.load_discovery_posts(1, None)
        self.assertEqual(liked_selection[0]['object_id'], liked_post_id)
        self.assertEqual(older_recommendation['object_id'], 'rec-like')

        with patch.object(self.server.random, 'random', return_value=0.62):
            deduplicated_selection = self.server.load_discovery_posts(1, None)
        self.assertEqual(deduplicated_selection[0]['object_id'], quiet_post_id)

        self.store_object(
            'rec-withdraw',
            'mycelium.recommendation',
            'liker',
            {'post_id': liked_post_id, 'action': 'withdraw', 'sequence': 2},
            sequence=2
        )
        with patch.object(self.server.random, 'random', return_value=0.6):
            withdrawn_selection = self.server.load_discovery_posts(1, None)
        self.assertEqual(withdrawn_selection[0]['object_id'], quiet_post_id)

    def test_follow_suggestions_combine_breadth_of_replies_and_active_likes(self):
        peer_a_posts = ['c' * 64, 'd' * 64]
        peer_b_post = 'e' * 64
        self.store_object(peer_a_posts[0], 'mycelium.post', 'author-a', {'content': 'a1'})
        self.store_object(peer_a_posts[1], 'mycelium.post', 'author-a', {'content': 'a2'})
        self.store_object(peer_b_post, 'mycelium.post', 'author-b', {'content': 'b1'})
        for post_id in peer_a_posts:
            self.store_object(
                f'reply-{post_id[0]}',
                'mycelium.post',
                f'replier-{post_id[0]}',
                {'content': 'reply', 'reply_to': post_id}
            )
            self.store_object(
                f'like-{post_id[0]}',
                'mycelium.recommendation',
                f'liker-{post_id[0]}',
                {'post_id': post_id, 'action': 'recommend', 'sequence': 1},
                sequence=1
            )
        self.store_object(
            'reply-b',
            'mycelium.post',
            'replier-b',
            {'content': 'reply', 'reply_to': peer_b_post}
        )
        for number in range(5):
            self.store_object(
                f'like-b-{number}',
                'mycelium.recommendation',
                f'liker-b-{number}',
                {'post_id': peer_b_post, 'action': 'recommend', 'sequence': 1},
                sequence=1
            )

        peers = self.server.load_popular_peers()
        self.assertEqual(peers[0], {
            'peer_id': self.server._peer_id_for_author('author-a'),
            'activity_score': 3
        })
        self.assertEqual(peers[1], {
            'peer_id': self.server._peer_id_for_author('author-b'),
            'activity_score': 2.5
        })
        suggested_peer_ids = self.server.load_peer_pool(3)
        self.assertEqual(suggested_peer_ids[:2], [peer['peer_id'] for peer in peers])

    def test_reply_activity_bonus_cannot_overwhelm_baseline_selection(self):
        active_post_id = 'c' * 64
        quiet_post_id = 'd' * 64
        self.store_object(active_post_id, 'mycelium.post', 'author-active', {'content': 'active'})
        self.store_object(quiet_post_id, 'mycelium.post', 'author-quiet', {'content': 'quiet'})
        for number in range(100):
            self.store_object(
                f'reply-{number}',
                'mycelium.post',
                f'replier-{number}',
                {'content': 'reply', 'reply_to': active_post_id}
            )

        with patch.object(self.server.random, 'random', return_value=0.85):
            selected = self.server.load_discovery_posts(1, None)

        self.assertEqual([post['object_id'] for post in selected], [quiet_post_id])

    def test_discovery_returns_stored_recommendations_and_canonical_replies_for_client_validation(self):
        post_id = 'e' * 64
        root = self.store_object(post_id, 'mycelium.post', 'author', {'content': 'root'})
        reply = self.store_object(
            'reply-object',
            'mycelium.post',
            'replier',
            {'content': 'reply', 'reply_to': post_id}
        )
        recommendation = self.store_object(
            'recommendation-object',
            'mycelium.recommendation',
            'liker',
            {'post_id': post_id, 'action': 'recommend', 'sequence': 1}
        )

        objects = self.server.load_discovery_posts(4, None)

        self.assertEqual({obj['object_id'] for obj in objects}, {
            root['object_id'],
            reply['object_id'],
            recommendation['object_id']
        })

    def test_discovery_post_sampling_limits_repeated_authors_and_handles_incomplete_activity(self):
        self.store_object('post-author-a-1', 'mycelium.post', 'author-a', {'content': 'first'})
        self.store_object('post-author-a-2', 'mycelium.post', 'author-a', {'content': 'second'})
        self.store_object('post-author-a-3', 'mycelium.post', 'author-a', {'content': 'third'})
        self.store_object('post-author-b', 'mycelium.post', 'author-b', {'content': 'other'})
        self.store_object(
            'malformed-reply',
            'mycelium.post',
            'author-c',
            {'content': 'incomplete reply', 'reply_to': 'z' * 64}
        )

        with patch.object(self.server.random, 'random', return_value=0):
            selected = self.server.load_discovery_posts(3, None)

        authors = [post['author'] for post in selected]
        self.assertEqual(authors.count('author-a'), 2)
        self.assertIn('author-b', authors)
        self.assertNotIn('malformed-reply', [post['object_id'] for post in selected])

    def test_peer_pool_request_returns_protocol_response_over_websocket(self):
        post = self.store_object('pool-post', 'mycelium.post', 'author-key', {'content': 'hello'})
        websocket = FakeWebSocket()
        asyncio.run(self.server.handle_peer_pool_get({'id': 'pool-request', 'sender': 'requester'}, websocket))

        self.assertEqual(websocket.messages[0]['type'], 'PEER_POOL_RESULT')
        self.assertEqual(websocket.messages[0]['payload']['requestId'], 'pool-request')
        self.assertEqual(websocket.messages[0]['payload']['peers'], [self.server._peer_id_for_author(post['author'])])

    def test_online_peer_list_includes_recently_connected_peer_without_posts_or_engagement(self):
        original_clients = self.server.clients.copy()
        websocket = FakeWebSocket()
        try:
            self.server.clients.clear()
            self.server.clients['online-without-posts'] = websocket
            asyncio.run(self.server.broadcast_peer_list())
        finally:
            self.server.clients.clear()
            self.server.clients.update(original_clients)

        self.assertEqual(websocket.messages, [{
            'type': 'peer-list',
            'peers': ['online-without-posts']
        }])

    def test_registered_peer_can_request_fresh_online_peer_list(self):
        original_clients = self.server.clients.copy()
        requester = FakeWebSocket()
        other_peer = FakeWebSocket()
        try:
            self.server.clients.clear()
            self.server.clients.update({'requester': requester, 'other-peer': other_peer})
            asyncio.run(self.server.handle_peer_list_request(
                {'id': 'requester', 'requestId': 'recovery-1'},
                requester,
                'requester'
            ))
        finally:
            self.server.clients.clear()
            self.server.clients.update(original_clients)

        self.assertEqual(requester.messages, [{
            'type': 'peer-list',
            'peers': ['requester', 'other-peer'],
            'requestId': 'recovery-1'
        }])

    def test_online_peer_list_request_requires_current_registration(self):
        websocket = FakeWebSocket()
        asyncio.run(self.server.handle_peer_list_request(
            {'id': 'requester', 'requestId': 'recovery-1'},
            websocket,
            'requester'
        ))
        self.assertEqual(websocket.messages, [])

    def test_registration_rejects_non_fingerprint_peer_ids(self):
        original_clients = self.server.clients.copy()
        websocket = IncomingSignalWebSocket([{'type': 'register', 'id': 'browser'}])
        try:
            self.server.clients.clear()
            asyncio.run(self.server.handle_client(websocket))
            self.assertEqual(self.server.clients, {})
        finally:
            self.server.clients.clear()
            self.server.clients.update(original_clients)

    def test_signalling_validation_matches_shared_cross_language_fixtures(self):
        fixture_path = (
            Path(__file__).resolve().parents[1]
            / 'tests' / 'fixtures' / 'network-contract.json'
        )
        fixture = json.loads(fixture_path.read_text(encoding='utf-8'))
        for signal in fixture['signals']:
            with self.subTest(message=signal['message']):
                self.assertEqual(
                    self.server.validate_signal_message(signal['message']),
                    signal['valid'],
                )

    def test_signalling_relay_validates_envelope_and_registered_sender(self):
        original_clients = self.server.clients.copy()
        recipient = FakeWebSocket()
        valid_offer = {
            'type': 'offer',
            'from': '00:00:00:00:00:00:00:01',
            'to': 'ff:ff:ff:ff:ff:ff:ff:fe',
            'payload': {
                'type': 'offer',
                'sdp': 'v=0\r\n',
                'negotiationId': 'negotiation-1'
            }
        }
        malformed_offer = {
            **valid_offer,
            'payload': {'type': 'offer', 'sdp': 'v=0\r\n'}
        }
        spoofed_offer = {**valid_offer, 'from': 'ff:ff:ff:ff:ff:ff:ff:fd'}
        browser = IncomingSignalWebSocket([
            {'type': 'register', 'id': 'not-a-fingerprint'},
            {'type': 'register', 'id': '00:00:00:00:00:00:00:01'},
            valid_offer,
            malformed_offer,
            spoofed_offer
        ])
        try:
            self.server.clients.clear()
            self.server.clients['ff:ff:ff:ff:ff:ff:ff:fe'] = recipient
            asyncio.run(self.server.handle_client(browser))
        finally:
            self.server.clients.clear()
            self.server.clients.update(original_clients)

        offers = [message for message in recipient.messages if message.get('type') == 'offer']
        self.assertEqual(offers, [valid_offer])

    def test_popular_peer_request_returns_correlated_protocol_response(self):
        self.store_object('popular-reply', 'mycelium.post', 'author', {'reply_to_author': 'popular-peer'})
        websocket = FakeWebSocket()
        asyncio.run(self.server.handle_popular_peers_get({'id': 'popular-request', 'sender': 'requester'}, websocket))

        self.assertEqual(websocket.messages[0]['type'], 'POPULAR_PEERS_RESULT')
        self.assertEqual(websocket.messages[0]['payload']['requestId'], 'popular-request')
        self.assertEqual(websocket.messages[0]['payload']['peers'], [{'peer_id': 'popular-peer', 'activity_score': 1}])

    def test_popular_peer_result_includes_profile_for_matching_author(self):
        author_key = ec.generate_private_key(ec.SECP256R1())
        profile = make_identity_profile('Popular author', '2026-10-02T00:00:00.000Z', author_key=author_key)
        author = profile['author']
        peer_id = self.server._peer_id_for_author(author)
        asyncio.run(self.server.handle_discovery_publish({'payload': {'object': profile}}))
        self.store_object(
            'popular-reply',
            'mycelium.post',
            'reply-author',
            {'reply_to_author': peer_id, 'reply_to': '1' * 64}
        )
        websocket = FakeWebSocket()
        asyncio.run(self.server.handle_popular_peers_get({'id': 'popular-request', 'sender': 'requester'}, websocket))

        peers = websocket.messages[0]['payload']['peers']
        self.assertEqual(len(peers), 1)
        self.assertEqual(peers[0]['peer_id'], peer_id)
        self.assertEqual(peers[0]['activity_score'], 1)
        self.assertEqual(peers[0]['identity_profile'], profile)


if __name__ == '__main__':
    unittest.main()
