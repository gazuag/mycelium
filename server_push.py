#!/usr/bin/env python3
import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import socket
import ssl
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlsplit

import aiohttp
from aiohttp import web
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(levelname)s %(message)s')
LOGGER = logging.getLogger('mycelium.web_push')

REQUEST_PATH = '/v1/push'
REQUEST_DOMAIN = 'mycelium-web-push-request-v1'
CONTENT_ENCODING = 'aes128gcm'
CONTENT_TYPE = 'application/octet-stream'
MAX_BODY_BYTES = 4096
MIN_BODY_BYTES = 103
MIN_TTL_SECONDS = 1
MAX_TTL_SECONDS = 3600
TIMESTAMP_WINDOW_SECONDS = 120
MAX_REPLAY_ENTRIES = 50000
MAX_RATE_LIMIT_KEYS = 10000
MAX_CONCURRENT_FORWARDS = 32
GLOBAL_REQUESTS_PER_MINUTE = 1000
PER_IP_PER_MINUTE = 30
PER_SENDER_PER_MINUTE = 60
PER_DESTINATION_PER_MINUTE = 30
REQUEST_BODY_TIMEOUT_SECONDS = 10
UPSTREAM_TIMEOUT_SECONDS = 8

HEADER_PUBLIC_KEY = 'X-Mycelium-Public-Key'
HEADER_FINGERPRINT = 'X-Mycelium-Fingerprint'
HEADER_TIMESTAMP = 'X-Mycelium-Timestamp'
HEADER_NONCE = 'X-Mycelium-Nonce'
HEADER_TTL = 'TTL'
HEADER_SIGNATURE = 'X-Mycelium-Signature'
HEADER_ENDPOINT = 'X-Mycelium-Endpoint'
CORS_REQUEST_HEADERS = ', '.join([
    'Content-Encoding', 'Content-Type', HEADER_PUBLIC_KEY, HEADER_FINGERPRINT,
    HEADER_TIMESTAMP, HEADER_NONCE, HEADER_TTL, HEADER_SIGNATURE, HEADER_ENDPOINT
])


class RequestRejected(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class SenderConfig:
    allowed_push_origins: frozenset
    cors_origins: frozenset
    vapid_private_key: ec.EllipticCurvePrivateKey
    vapid_public_key: str
    vapid_subject: str


CONFIG_KEY = web.AppKey('config', SenderConfig)
SESSION_KEY = web.AppKey('session', object)
RESOLVER_KEY = web.AppKey('resolver', aiohttp.abc.AbstractResolver)
CLOCK_KEY = web.AppKey('clock', object)
REPLAY_CACHE_KEY = web.AppKey('replay_cache', object)
RATE_LIMITER_KEY = web.AppKey('rate_limiter', object)
FORWARD_SEMAPHORE_KEY = web.AppKey('forward_semaphore', asyncio.Semaphore)
ACTIVE_REQUESTS_KEY = web.AppKey('active_requests', dict)


def canonical_request_v1(
    public_key: str,
    fingerprint: str,
    endpoint: str,
    timestamp: str,
    nonce: str,
    ttl: str,
    body_hash: str,
) -> bytes:
    fields = [
        REQUEST_DOMAIN,
        'POST',
        REQUEST_PATH,
        public_key,
        fingerprint,
        endpoint,
        timestamp,
        nonce,
        ttl,
        CONTENT_ENCODING,
        CONTENT_TYPE,
        body_hash,
    ]
    if any('\n' in field or '\r' in field for field in fields):
        raise ValueError('Invalid canonical request field')
    return '\n'.join(fields).encode('ascii')


def _decode_b64url(value: str, expected_length: int = None) -> bytes:
    if not isinstance(value, str) or not value or any(
        character not in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
        for character in value
    ):
        raise ValueError('Invalid base64url value')
    decoded = base64.urlsafe_b64decode(value + '=' * ((4 - len(value) % 4) % 4))
    if expected_length is not None and len(decoded) != expected_length:
        raise ValueError('Invalid base64url length')
    if _b64url(decoded) != value:
        raise ValueError('Non-canonical base64url value')
    return decoded


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode('ascii')


def fingerprint_from_public_key(public_key: str) -> str:
    if not isinstance(public_key, str) or not public_key or len(public_key) > 4096:
        raise ValueError('Invalid public key')
    normalized = ''.join(public_key.split())
    digest = hashlib.sha256(normalized.encode('ascii')).digest()[:8]
    return ':'.join(f'{byte:02x}' for byte in digest)


def verify_sender_signature(public_key_b64: str, claimed_fingerprint: str, message: bytes, signature_b64: str) -> None:
    if fingerprint_from_public_key(public_key_b64) != claimed_fingerprint:
        raise ValueError('Fingerprint mismatch')
    try:
        public_key_der = base64.b64decode(public_key_b64, validate=True)
        public_key = serialization.load_der_public_key(public_key_der)
        signature = base64.b64decode(signature_b64, validate=True)
    except (ValueError, TypeError, base64.binascii.Error) as error:
        raise ValueError('Malformed key or signature') from error
    if not isinstance(public_key, ec.EllipticCurvePublicKey) or not isinstance(public_key.curve, ec.SECP256R1):
        raise ValueError('Wrong public key type')
    if len(signature) != 64:
        raise ValueError('Wrong signature length')
    der_signature = encode_dss_signature(
        int.from_bytes(signature[:32], 'big'),
        int.from_bytes(signature[32:], 'big')
    )
    try:
        public_key.verify(der_signature, message, ec.ECDSA(hashes.SHA256()))
    except Exception as error:
        raise ValueError('Invalid signature') from error


def parse_https_origin(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (ValueError, AttributeError) as error:
        raise ValueError('Invalid HTTPS origin') from error
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password \
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment \
            or port not in (None, 443):
        raise ValueError('Invalid HTTPS origin')
    host = parsed.hostname.rstrip('.').encode('idna').decode('ascii').lower()
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise ValueError('IP literal origin not permitted')
    return f'https://{host}'


def validate_destination(endpoint: str, allowed_origins: frozenset) -> tuple:
    if not isinstance(endpoint, str) or len(endpoint) > 2048 \
            or any(ord(character) < 0x21 or ord(character) > 0x7e for character in endpoint):
        raise ValueError('Malformed endpoint')
    try:
        parsed = urlsplit(endpoint)
        port = parsed.port
        host = parsed.hostname
    except (ValueError, AttributeError) as error:
        raise ValueError('Malformed endpoint') from error
    if parsed.scheme != 'https' or not host or parsed.username or parsed.password \
            or parsed.fragment or port not in (None, 443):
        raise ValueError('Invalid endpoint')
    normalized_host = host.rstrip('.').encode('idna').decode('ascii').lower()
    try:
        ipaddress.ip_address(normalized_host)
    except ValueError:
        pass
    else:
        raise ValueError('IP literal endpoint not permitted')
    origin = f'https://{normalized_host}'
    if origin not in allowed_origins:
        raise ValueError('Unapproved endpoint origin')
    return origin, normalized_host


class PublicAddressResolver(aiohttp.abc.AbstractResolver):
    async def resolve(self, host, port=0, family=socket.AF_INET):
        try:
            records = await asyncio.get_running_loop().getaddrinfo(
                host, port, family=family, type=socket.SOCK_STREAM
            )
            addresses = []
            seen = set()
            for record in records:
                address = record[4][0]
                parsed_address = ipaddress.ip_address(address.split('%')[0])
                if not parsed_address.is_global:
                    raise OSError('Destination resolves to a non-public address')
                if address not in seen:
                    seen.add(address)
                    addresses.append({
                        'hostname': host,
                        'host': address,
                        'port': port,
                        'family': record[0],
                        'proto': record[2],
                        'flags': record[3],
                    })
            if not addresses:
                raise OSError('Destination has no public address')
            return addresses
        except OSError:
            raise
        except Exception as error:
            raise OSError('Destination DNS validation failed') from error

    async def close(self):
        return None


class ReplayCache:
    def __init__(self, capacity=MAX_REPLAY_ENTRIES):
        self.capacity = capacity
        self.entries = OrderedDict()

    def add(self, key, expires_at, now):
        while self.entries:
            oldest_key, oldest_expiry = next(iter(self.entries.items()))
            if oldest_expiry > now:
                break
            self.entries.pop(oldest_key)
        if key in self.entries:
            raise RequestRejected(409, 'replayed-request')
        if len(self.entries) >= self.capacity:
            raise RequestRejected(503, 'temporarily-unavailable')
        self.entries[key] = expires_at


class RateLimiter:
    def __init__(self):
        self.global_window = int(time.time() // 60)
        self.global_count = 0
        self.buckets = OrderedDict()

    def allow(self, source_ip, fingerprint, destination, now):
        current_window = int(now // 60)
        if current_window != self.global_window:
            self.global_window = current_window
            self.global_count = 0
        self.global_count += 1
        if self.global_count > GLOBAL_REQUESTS_PER_MINUTE:
            return False

        limits = (
            (('ip', source_ip), PER_IP_PER_MINUTE),
            (('sender', fingerprint), PER_SENDER_PER_MINUTE),
            (('destination', destination), PER_DESTINATION_PER_MINUTE),
        )
        for key, limit in limits:
            window, count = self.buckets.get(key, (current_window, 0))
            if window != current_window:
                count = 0
            self.buckets[key] = (current_window, count + 1)
            self.buckets.move_to_end(key)
            if len(self.buckets) > MAX_RATE_LIMIT_KEYS:
                self.buckets.popitem(last=False)
            if count + 1 > limit:
                return False
        return True


def build_vapid_authorization(config: SenderConfig, audience: str, now: int = None) -> str:
    issued_at = int(time.time()) if now is None else now
    header = _json_b64url({'typ': 'JWT', 'alg': 'ES256'})
    claims = _json_b64url({
        'aud': audience,
        'exp': issued_at + 12 * 60 * 60,
        'sub': config.vapid_subject,
    })
    signing_input = f'{header}.{claims}'.encode('ascii')
    der_signature = config.vapid_private_key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der_signature)
    signature = r.to_bytes(32, 'big') + s.to_bytes(32, 'big')
    return f'vapid t={header}.{claims}.{_b64url(signature)}, k={config.vapid_public_key}'


def _json_b64url(value: dict) -> str:
    return _b64url(json.dumps(value, separators=(',', ':'), ensure_ascii=True).encode('ascii'))


def load_config(environ=os.environ) -> SenderConfig:
    allowed_origins = frozenset(
        parse_https_origin(value.strip())
        for value in environ.get('WEB_PUSH_ALLOWED_ORIGINS', '').split(',')
        if value.strip()
    )
    cors_origins = frozenset(
        parse_https_origin(value.strip())
        for value in environ.get('WEB_PUSH_CORS_ORIGINS', '').split(',')
        if value.strip()
    )
    if not allowed_origins:
        raise RuntimeError('WEB_PUSH_ALLOWED_ORIGINS must contain at least one HTTPS push-service origin.')
    if not cors_origins:
        raise RuntimeError('WEB_PUSH_CORS_ORIGINS must contain at least one HTTPS application origin.')

    private_raw = _decode_b64url(environ.get('WEB_PUSH_VAPID_PRIVATE_KEY', ''))
    if len(private_raw) != 32:
        raise RuntimeError('WEB_PUSH_VAPID_PRIVATE_KEY must be a base64url-encoded P-256 private scalar.')
    try:
        private_key = ec.derive_private_key(int.from_bytes(private_raw, 'big'), ec.SECP256R1())
        public_raw = private_key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    except ValueError as error:
        raise RuntimeError('WEB_PUSH_VAPID_PRIVATE_KEY is not a valid P-256 private scalar.') from error
    configured_public = environ.get('WEB_PUSH_VAPID_PUBLIC_KEY', '')
    if configured_public != _b64url(public_raw):
        raise RuntimeError('WEB_PUSH_VAPID_PUBLIC_KEY does not match the configured private key.')
    subject = environ.get('WEB_PUSH_VAPID_SUBJECT', '')
    if not subject.startswith('mailto:') and not subject.startswith('https://'):
        raise RuntimeError('WEB_PUSH_VAPID_SUBJECT must be a mailto: or https:// contact URI.')
    return SenderConfig(allowed_origins, cors_origins, private_key, configured_public, subject)


def create_app(config: SenderConfig, *, session=None, resolver=None, clock=time.time):
    application = web.Application(client_max_size=MAX_BODY_BYTES)
    application[CONFIG_KEY] = config
    application[SESSION_KEY] = session
    application[RESOLVER_KEY] = resolver or PublicAddressResolver()
    application[CLOCK_KEY] = clock
    application[REPLAY_CACHE_KEY] = ReplayCache()
    application[RATE_LIMITER_KEY] = RateLimiter()
    application[FORWARD_SEMAPHORE_KEY] = asyncio.Semaphore(MAX_CONCURRENT_FORWARDS)
    application[ACTIVE_REQUESTS_KEY] = {'count': 0}

    @web.middleware
    async def cors_middleware(request, handler):
        origin = request.headers.get('Origin')
        if request.method == 'OPTIONS':
            if origin not in config.cors_origins:
                return web.Response(status=403)
            requested_method = request.headers.get('Access-Control-Request-Method')
            requested_headers = {
                name.strip().lower()
                for name in request.headers.get('Access-Control-Request-Headers', '').split(',')
                if name.strip()
            }
            allowed_headers = {name.lower() for name in CORS_REQUEST_HEADERS.split(', ')}
            if requested_method != 'POST' or not requested_headers.issubset(allowed_headers):
                return web.Response(status=403)
            response = web.Response(status=204)
            response.headers['Access-Control-Allow-Origin'] = origin
            response.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
            response.headers['Access-Control-Allow-Headers'] = CORS_REQUEST_HEADERS
            response.headers['Access-Control-Max-Age'] = '600'
            response.headers['Vary'] = 'Origin'
            return response
        response = await handler(request)
        if origin in config.cors_origins:
            response.headers['Access-Control-Allow-Origin'] = origin
            response.headers['Vary'] = 'Origin'
        return response

    application.middlewares.append(cors_middleware)

    async def handle_push(request):
        active_requests = application[ACTIVE_REQUESTS_KEY]
        if active_requests['count'] >= MAX_CONCURRENT_FORWARDS:
            return _error_response(503, 'temporarily-unavailable')
        active_requests['count'] += 1
        try:
            try:
                body = await asyncio.wait_for(
                    _read_bounded_body(request),
                    timeout=REQUEST_BODY_TIMEOUT_SECONDS
                )
            except asyncio.TimeoutError:
                raise RequestRejected(408, 'invalid-request')
            fields = _read_request_fields(request)
            endpoint_origin, endpoint_host = validate_destination(fields['endpoint'], config.allowed_push_origins)
            _validate_ttl(fields['ttl'])
            now = int(application[CLOCK_KEY]())
            timestamp = _parse_timestamp(fields['timestamp'])
            if abs(now - timestamp) > TIMESTAMP_WINDOW_SECONDS:
                raise RequestRejected(401, 'invalid-request')
            nonce = _decode_b64url(fields['nonce'], expected_length=16)
            public_key = fields['public_key']
            fingerprint = fields['fingerprint']
            digest = hashlib.sha256(body).hexdigest()
            canonical = canonical_request_v1(
                public_key, fingerprint, fields['endpoint'], fields['timestamp'],
                fields['nonce'], fields['ttl'], digest
            )
            try:
                verify_sender_signature(public_key, fingerprint, canonical, fields['signature'])
            except ValueError:
                raise RequestRejected(401, 'invalid-request')

            source_ip = request.remote or 'unknown'
            if not application[RATE_LIMITER_KEY].allow(source_ip, fingerprint, fields['endpoint'], now):
                raise RequestRejected(429, 'rate-limited')
            monotonic_now = time.monotonic()
            application[REPLAY_CACHE_KEY].add(
                (fingerprint, nonce),
                monotonic_now + TIMESTAMP_WINDOW_SECONDS * 2,
                monotonic_now
            )

            _validate_encrypted_body(body)
            return await _forward_push(
                application, fields, body, endpoint_origin, endpoint_host
            )
        except RequestRejected as error:
            return _error_response(error.status, error.code)
        except web.HTTPRequestEntityTooLarge:
            return _error_response(413, 'request-too-large')
        except (ValueError, KeyError, TypeError):
            return _error_response(400, 'invalid-request')
        except asyncio.TimeoutError:
            LOGGER.warning('push request failed category=internal-timeout')
            return _error_response(503, 'temporarily-unavailable')
        finally:
            active_requests['count'] -= 1

    async def options_not_allowed(_request):
        return web.Response(status=405)

    application.router.add_route('OPTIONS', REQUEST_PATH, options_not_allowed)
    application.router.add_post(REQUEST_PATH, handle_push)
    return application


async def _read_bounded_body(request):
    if request.content_length is not None and request.content_length > MAX_BODY_BYTES:
        raise RequestRejected(413, 'request-too-large')
    body = bytearray()
    async for chunk in request.content.iter_chunked(1024):
        body.extend(chunk)
        if len(body) > MAX_BODY_BYTES:
            raise RequestRejected(413, 'request-too-large')
    if len(body) < MIN_BODY_BYTES:
        raise RequestRejected(400, 'invalid-request')
    return bytes(body)


def _read_request_fields(request):
    fields = {
        'public_key': request.headers.get(HEADER_PUBLIC_KEY, ''),
        'fingerprint': request.headers.get(HEADER_FINGERPRINT, ''),
        'timestamp': request.headers.get(HEADER_TIMESTAMP, ''),
        'nonce': request.headers.get(HEADER_NONCE, ''),
        'ttl': request.headers.get(HEADER_TTL, ''),
        'signature': request.headers.get(HEADER_SIGNATURE, ''),
        'endpoint': request.headers.get(HEADER_ENDPOINT, ''),
    }
    maximums = {
        'public_key': 4096, 'fingerprint': 64, 'timestamp': 16,
        'nonce': 64, 'ttl': 4, 'signature': 256, 'endpoint': 2048,
    }
    if any(not value or len(value) > maximums[name] for name, value in fields.items()):
        raise ValueError('Malformed request field')
    if request.headers.get('Content-Encoding') != CONTENT_ENCODING \
            or request.headers.get('Content-Type', '').split(';', 1)[0].strip().lower() != CONTENT_TYPE:
        raise ValueError('Unexpected content coding')
    return fields


def _validate_ttl(value):
    if not value.isdigit() or str(int(value)) != value:
        raise ValueError('Invalid TTL')
    ttl = int(value)
    if not MIN_TTL_SECONDS <= ttl <= MAX_TTL_SECONDS:
        raise ValueError('Invalid TTL')
    return ttl


def _parse_timestamp(value):
    if not value.isdigit() or len(value) > 12 or str(int(value)) != value:
        raise ValueError('Invalid timestamp')
    return int(value)


def _validate_encrypted_body(body):
    if len(body) < MIN_BODY_BYTES or len(body) > MAX_BODY_BYTES:
        raise ValueError('Invalid encrypted body size')
    record_size = int.from_bytes(body[16:20], 'big')
    key_id_length = body[20]
    if record_size != 4096 or key_id_length != 65 or body[21] != 0x04:
        raise ValueError('Invalid aes128gcm envelope')


async def _forward_push(application, fields, body, endpoint_origin, endpoint_host):
    session = application[SESSION_KEY]
    own_session = session is None
    if own_session:
        connector = aiohttp.TCPConnector(
            resolver=application[RESOLVER_KEY],
            use_dns_cache=False,
            limit=MAX_CONCURRENT_FORWARDS,
        )
        timeout = aiohttp.ClientTimeout(
            total=UPSTREAM_TIMEOUT_SECONDS,
            connect=UPSTREAM_TIMEOUT_SECONDS,
            sock_read=UPSTREAM_TIMEOUT_SECONDS,
        )
        session = aiohttp.ClientSession(connector=connector, timeout=timeout)
    headers = {
        'Authorization': build_vapid_authorization(application[CONFIG_KEY], endpoint_origin, int(application[CLOCK_KEY]())),
        'Content-Encoding': CONTENT_ENCODING,
        'Content-Type': CONTENT_TYPE,
        'TTL': fields['ttl'],
    }
    try:
        async with application[FORWARD_SEMAPHORE_KEY]:
            async with session.post(
                fields['endpoint'],
                data=body,
                headers=headers,
                allow_redirects=False,
                timeout=UPSTREAM_TIMEOUT_SECONDS,
            ) as response:
                if response.status in (404, 410):
                    return _error_response(410, 'invalid-subscription')
                if response.status == 429:
                    return _error_response(429, 'rate-limited')
                if 200 <= response.status < 300:
                    return web.json_response({'status': 'accepted'}, status=202)
                if response.status in (301, 302, 303, 307, 308):
                    LOGGER.warning('push upstream rejected category=redirect')
                elif response.status >= 500:
                    LOGGER.warning('push upstream failed category=server-error')
                else:
                    LOGGER.warning('push upstream rejected category=client-error')
                return _error_response(503, 'temporarily-unavailable')
    except asyncio.TimeoutError:
        LOGGER.warning('push upstream failed category=timeout')
        return _error_response(503, 'temporarily-unavailable')
    except (aiohttp.ClientError, OSError):
        LOGGER.warning('push upstream failed category=network-error')
        return _error_response(503, 'temporarily-unavailable')
    finally:
        if own_session:
            await session.close()


def _error_response(status, code):
    return web.json_response({'status': code}, status=status)


def create_tls_context(cert_path, key_path):
    if not cert_path or not key_path:
        raise RuntimeError('WEB_PUSH_TLS_CERT_PATH and WEB_PUSH_TLS_KEY_PATH are required; plaintext is not supported.')
    context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    context.load_cert_chain(cert_path, key_path)
    return context


def main():
    config = load_config()
    cert_path = os.environ.get('WEB_PUSH_TLS_CERT_PATH')
    key_path = os.environ.get('WEB_PUSH_TLS_KEY_PATH')
    tls_context = create_tls_context(cert_path, key_path)
    host = os.environ.get('WEB_PUSH_BIND_HOST', '127.0.0.1')
    port = int(os.environ.get('WEB_PUSH_PORT', '8444'))
    if not 1 <= port <= 65535:
        raise RuntimeError('WEB_PUSH_PORT must be between 1 and 65535.')
    app = create_app(config)
    LOGGER.info('Starting HTTPS Web Push sender on %s:%d', host, port)
    web.run_app(
        app,
        host=host,
        port=port,
        ssl_context=tls_context,
        access_log=None,
        auto_decompress=False
    )


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        LOGGER.info('Web Push sender stopped')
