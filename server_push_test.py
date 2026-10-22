import asyncio
import base64
import hashlib
import json
import logging
import socket
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from aiohttp.test_utils import TestClient, TestServer
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

import server_push

VECTOR = json.loads((Path(__file__).parent / 'tests' / 'web-push-request-v1.json').read_text())
BODY = base64.b64decode(VECTOR['bodyBase64'])
APP_ORIGIN = 'https://app.example.test'


def b64url(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode('ascii')


class FakeUpstreamResponse:
    def __init__(self, status):
        self.status = status

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False


class FakeUpstreamSession:
    def __init__(self, status=201, error=None):
        self.status = status
        self.error = error
        self.calls = []

    def post(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self.error:
            raise self.error
        return FakeUpstreamResponse(self.status)


def test_config():
    private_key = ec.derive_private_key(1, ec.SECP256R1())
    public_raw = private_key.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint
    )
    return server_push.SenderConfig(
        allowed_push_origins=frozenset({'https://updates.push.services.mozilla.com'}),
        cors_origins=frozenset({APP_ORIGIN}),
        vapid_private_key=private_key,
        vapid_public_key=b64url(public_raw),
        vapid_subject='mailto:ops@example.test'
    )


def signed_headers(body=BODY, **overrides):
    fields = {
        'public_key': VECTOR['publicKey'],
        'fingerprint': VECTOR['fingerprint'],
        'endpoint': VECTOR['endpoint'],
        'timestamp': VECTOR['timestamp'],
        'nonce': VECTOR['nonce'],
        'ttl': VECTOR['ttl'],
    }
    fields.update(overrides)
    canonical = server_push.canonical_request_v1(
        fields['public_key'],
        fields['fingerprint'],
        fields['endpoint'],
        fields['timestamp'],
        fields['nonce'],
        fields['ttl'],
        hashlib.sha256(body).hexdigest()
    )
    private_key = serialization.load_der_private_key(
        base64.b64decode(VECTOR['privateKey']),
        password=None
    )
    der_signature = private_key.sign(canonical, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der_signature)
    signature = base64.b64encode(r.to_bytes(32, 'big') + s.to_bytes(32, 'big')).decode('ascii')
    headers = {
        server_push.HEADER_PUBLIC_KEY: fields['public_key'],
        server_push.HEADER_FINGERPRINT: fields['fingerprint'],
        server_push.HEADER_ENDPOINT: fields['endpoint'],
        server_push.HEADER_TIMESTAMP: fields['timestamp'],
        server_push.HEADER_NONCE: fields['nonce'],
        server_push.HEADER_TTL: fields['ttl'],
        server_push.HEADER_SIGNATURE: signature,
        'Content-Encoding': server_push.CONTENT_ENCODING,
        'Content-Type': server_push.CONTENT_TYPE,
        'Origin': APP_ORIGIN,
    }
    return headers, canonical


class WebPushSenderTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.upstream = FakeUpstreamSession()
        self.client = TestClient(TestServer(
            server_push.create_app(
                test_config(),
                session=self.upstream,
                clock=lambda: int(VECTOR['timestamp'])
            ),
            auto_decompress=False
        ))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()

    async def post(self, *, body=BODY, headers=None, **overrides):
        signed, _canonical = signed_headers(body=body, **overrides)
        if headers:
            signed.update(headers)
        return await self.client.post(
            server_push.REQUEST_PATH,
            data=body,
            headers=signed,
            allow_redirects=False
        )

    def test_shared_typescript_python_canonical_vector_and_signature(self):
        fields = (
            VECTOR['publicKey'],
            VECTOR['fingerprint'],
            VECTOR['endpoint'],
            VECTOR['timestamp'],
            VECTOR['nonce'],
            VECTOR['ttl'],
            hashlib.sha256(BODY).hexdigest()
        )
        canonical = server_push.canonical_request_v1(*fields)
        self.assertEqual(canonical.decode('ascii'), VECTOR['canonical'])
        self.assertEqual(fields[-1], VECTOR['bodyHash'])
        self.assertEqual(server_push.fingerprint_from_public_key(VECTOR['publicKey']), VECTOR['fingerprint'])
        server_push.verify_sender_signature(
            VECTOR['publicKey'], VECTOR['fingerprint'], canonical, VECTOR['signature']
        )

    async def test_forwards_encrypted_body_with_vapid_and_no_redirects(self):
        response = await self.post()
        self.assertEqual(response.status, 202)
        self.assertEqual(await response.json(), {'status': 'accepted'})
        args, kwargs = self.upstream.calls[0]
        self.assertEqual(args[0], VECTOR['endpoint'])
        self.assertEqual(kwargs['data'], BODY)
        self.assertFalse(kwargs['allow_redirects'])
        self.assertEqual(kwargs['headers']['Content-Encoding'], 'aes128gcm')
        self.assertEqual(kwargs['headers']['Content-Type'], 'application/octet-stream')
        self.assertEqual(kwargs['headers']['TTL'], '300')
        self.assertTrue(kwargs['headers']['Authorization'].startswith('vapid t='))

    async def test_rejects_replayed_nonce(self):
        first = await self.post()
        second = await self.post()
        self.assertEqual(first.status, 202)
        self.assertEqual(second.status, 409)
        self.assertEqual(len(self.upstream.calls), 1)

    async def test_rejects_invalid_signature_fingerprint_and_wrong_public_key(self):
        invalid_signature, _ = signed_headers(nonce=b64url(b'\x02' * 16))
        invalid_signature[server_push.HEADER_SIGNATURE] = base64.b64encode(b'\x00' * 64).decode('ascii')
        self.assertEqual((await self.client.post(server_push.REQUEST_PATH, data=BODY, headers=invalid_signature)).status, 401)

        mismatch, _ = signed_headers(nonce=b64url(b'\x03' * 16), fingerprint='00:00:00:00:00:00:00:00')
        self.assertEqual((await self.client.post(server_push.REQUEST_PATH, data=BODY, headers=mismatch)).status, 401)

        wrong_key, _ = signed_headers(nonce=b64url(b'\x04' * 16), public_key='not-a-key')
        self.assertEqual((await self.client.post(server_push.REQUEST_PATH, data=BODY, headers=wrong_key)).status, 401)
        self.assertEqual(self.upstream.calls, [])

    async def test_rejects_stale_timestamp_malformed_fields_and_body_hash_mismatch(self):
        stale, _ = signed_headers(timestamp='1')
        self.assertEqual((await self.client.post(server_push.REQUEST_PATH, data=BODY, headers=stale)).status, 401)

        malformed, _ = signed_headers(nonce=b64url(b'\x05' * 16))
        malformed[server_push.HEADER_TTL] = '3601'
        self.assertEqual((await self.client.post(server_push.REQUEST_PATH, data=BODY, headers=malformed)).status, 400)

        mismatch, _ = signed_headers(nonce=b64url(b'\x06' * 16))
        altered_body = BODY[:-1] + bytes([BODY[-1] ^ 1])
        self.assertEqual((await self.client.post(server_push.REQUEST_PATH, data=altered_body, headers=mismatch)).status, 401)
        self.assertEqual(self.upstream.calls, [])

    async def test_rejects_non_aes128gcm_and_oversized_request(self):
        malformed, _ = signed_headers(nonce=b64url(b'\x07' * 16))
        malformed['Content-Encoding'] = 'br'
        self.assertEqual((await self.client.post(server_push.REQUEST_PATH, data=BODY, headers=malformed)).status, 400)

        oversized, _ = signed_headers(body=BODY + b'x' * 4097, nonce=b64url(b'\x08' * 16))
        response = await self.client.post(server_push.REQUEST_PATH, data=BODY + b'x' * 4097, headers=oversized)
        self.assertEqual(response.status, 413)

    async def test_enforces_cors_preflight_allowlist(self):
        allowed = await self.client.options(
            server_push.REQUEST_PATH,
            headers={
                'Origin': APP_ORIGIN,
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'content-encoding, content-type, x-mycelium-signature'
            }
        )
        self.assertEqual(allowed.status, 204)
        self.assertEqual(allowed.headers['Access-Control-Allow-Origin'], APP_ORIGIN)

        denied = await self.client.options(
            server_push.REQUEST_PATH,
            headers={
                'Origin': 'https://attacker.example',
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'content-type'
            }
        )
        self.assertEqual(denied.status, 403)

    async def test_upstream_status_mapping_and_redirect_behavior(self):
        for status, expected in ((404, 410), (410, 410), (429, 429), (503, 503), (302, 503)):
            self.upstream.status = status
            response = await self.post(nonce=b64url(bytes([status % 255]) * 16))
            self.assertEqual(response.status, expected)
        self.assertTrue(all(call[1]['allow_redirects'] is False for call in self.upstream.calls))

    async def test_upstream_timeout_is_generic_and_does_not_log_sensitive_values(self):
        self.upstream.error = asyncio.TimeoutError(VECTOR['endpoint'])
        with self.assertLogs('mycelium.web_push', level=logging.WARNING) as captured:
            response = await self.post(nonce=b64url(b'\x09' * 16))
        self.assertEqual(response.status, 503)
        log_text = '\n'.join(captured.output)
        self.assertNotIn(VECTOR['endpoint'], log_text)
        self.assertNotIn(VECTOR['signature'], log_text)
        self.assertNotIn(VECTOR['bodyBase64'], log_text)

    async def test_bounded_concurrency_rejects_excess_requests(self):
        self.client.server.app[server_push.ACTIVE_REQUESTS_KEY]['count'] = server_push.MAX_CONCURRENT_FORWARDS
        response = await self.post(nonce=b64url(b'\x0a' * 16))
        self.assertEqual(response.status, 503)
        self.assertEqual(self.upstream.calls, [])

    async def test_request_body_timeout_returns_generic_rejection(self):
        with patch('server_push._read_bounded_body', new=AsyncMock(side_effect=asyncio.TimeoutError)):
            response = await self.post(nonce=b64url(b'\x0b' * 16))
        self.assertEqual(response.status, 408)
        self.assertEqual(self.upstream.calls, [])


class WebPushValidationTests(unittest.TestCase):
    def test_destination_allowlist_and_url_rejections(self):
        allowed = frozenset({'https://updates.push.services.mozilla.com'})
        self.assertEqual(
            server_push.validate_destination(VECTOR['endpoint'], allowed)[0],
            'https://updates.push.services.mozilla.com'
        )
        for endpoint in (
            'http://updates.push.services.mozilla.com/token',
            'https://user:pass@updates.push.services.mozilla.com/token',
            'https://updates.push.services.mozilla.com:444/token',
            'https://127.0.0.1/token',
            'https://localhost/token',
            'https://unknown.example/token',
            'https://updates.push.services.mozilla.com/#fragment'
        ):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                server_push.validate_destination(endpoint, allowed)

    def test_dns_resolver_rejects_local_addresses_and_returns_validated_public_address(self):
        resolver = server_push.PublicAddressResolver()
        local_record = (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))
        public_record = (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443))
        with patch.object(asyncio.BaseEventLoop, 'getaddrinfo', new=AsyncMock(return_value=[local_record])):
            with self.assertRaises(OSError):
                asyncio.run(resolver.resolve('push.example.test', 443))
        with patch.object(asyncio.BaseEventLoop, 'getaddrinfo', new=AsyncMock(return_value=[public_record])):
            result = asyncio.run(resolver.resolve('push.example.test', 443))
        self.assertEqual(result[0]['host'], '8.8.8.8')

    def test_rate_limit_and_vapid_claims(self):
        limiter = server_push.RateLimiter()
        accepted = [
            limiter.allow('198.51.100.1', f'peer-{index}', f'https://push.test/{index}', 1000)
            for index in range(server_push.PER_IP_PER_MINUTE)
        ]
        self.assertTrue(all(accepted))
        self.assertFalse(limiter.allow('198.51.100.1', 'peer-over-limit', 'https://push.test/over', 1000))

        authorization = server_push.build_vapid_authorization(test_config(), 'https://push.test', now=100)
        scheme, value = authorization.split(' ', 1)
        self.assertEqual(scheme, 'vapid')
        token = value.split(', ', 1)[0][2:]
        header_b64, claims_b64, signature_b64 = token.split('.')
        decode = lambda part: base64.urlsafe_b64decode(part + '=' * ((4 - len(part) % 4) % 4))
        header = json.loads(decode(header_b64))
        claims = json.loads(decode(claims_b64))
        self.assertEqual(header, {'typ': 'JWT', 'alg': 'ES256'})
        self.assertEqual(claims, {'aud': 'https://push.test', 'exp': 100 + 12 * 60 * 60, 'sub': 'mailto:ops@example.test'})
        signature = decode(signature_b64)
        self.assertEqual(len(signature), 64)
        r, s = int.from_bytes(signature[:32], 'big'), int.from_bytes(signature[32:], 'big')
        test_config().vapid_private_key.public_key().verify(
            __import__('cryptography').hazmat.primitives.asymmetric.utils.encode_dss_signature(r, s),
            f'{header_b64}.{claims_b64}'.encode('ascii'),
            ec.ECDSA(hashes.SHA256())
        )

    def test_config_requires_vapid_pair_and_nonempty_allowlists(self):
        with self.assertRaisesRegex(RuntimeError, 'WEB_PUSH_ALLOWED_ORIGINS'):
            server_push.load_config({})

        private_key = test_config().vapid_private_key
        private_raw = private_key.private_numbers().private_value.to_bytes(32, 'big')
        public_raw = private_key.public_key().public_bytes(
            serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint
        )
        env = {
            'WEB_PUSH_ALLOWED_ORIGINS': 'https://updates.push.services.mozilla.com',
            'WEB_PUSH_CORS_ORIGINS': APP_ORIGIN,
            'WEB_PUSH_VAPID_PRIVATE_KEY': b64url(private_raw),
            'WEB_PUSH_VAPID_PUBLIC_KEY': b64url(public_raw),
            'WEB_PUSH_VAPID_SUBJECT': 'mailto:ops@example.test'
        }
        self.assertEqual(server_push.load_config(env).vapid_public_key, b64url(public_raw))
        env['WEB_PUSH_VAPID_PUBLIC_KEY'] = b64url(bytes(65))
        with self.assertRaisesRegex(RuntimeError, 'does not match'):
            server_push.load_config(env)

    def test_tls_context_refuses_missing_configuration(self):
        with self.assertRaisesRegex(RuntimeError, 'plaintext is not supported'):
            server_push.create_tls_context(None, None)


if __name__ == '__main__':
    unittest.main()
