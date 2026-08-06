export async function generateIdentityKeyPair() {
  return await crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256'
    },
    true,
    ['sign', 'verify']
  );
}

export async function exportPublicKey(key: CryptoKey) {
  const raw = await crypto.subtle.exportKey('spki', key);
  return arrayBufferToBase64(raw);
}

export async function exportPrivateKey(key: CryptoKey) {
  const raw = await crypto.subtle.exportKey('pkcs8', key);
  return arrayBufferToBase64(raw);
}

export async function importPublicKey(base64: string) {
  const raw = base64ToArrayBuffer(base64);
  return crypto.subtle.importKey(
    'spki',
    raw,
    {
      name: 'ECDSA',
      namedCurve: 'P-256'
    },
    true,
    ['verify']
  );
}

export async function importPrivateKey(base64: string) {
  const raw = base64ToArrayBuffer(base64);
  return crypto.subtle.importKey(
    'pkcs8',
    raw,
    {
      name: 'ECDSA',
      namedCurve: 'P-256'
    },
    true,
    ['sign']
  );
}

export async function sha256(data: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return arrayBufferToHex(digest);
}

export async function signString(privateKeyBase64: string, data: string) {
  const privateKey = await importPrivateKey(privateKeyBase64);
  const signature = await crypto.subtle.sign(
    {
      name: 'ECDSA',
      hash: 'SHA-256'
    },
    privateKey,
    new TextEncoder().encode(data)
  );
  return arrayBufferToBase64(signature);
}

export async function verifySignedString(publicKeyBase64: string, data: string, signatureBase64: string) {
  const publicKey = await importPublicKey(publicKeyBase64);
  const signatureBuffer = base64ToArrayBuffer(signatureBase64);
  return crypto.subtle.verify(
    {
      name: 'ECDSA',
      hash: 'SHA-256'
    },
    publicKey,
    signatureBuffer,
    new TextEncoder().encode(data)
  );
}

export function deriveFingerprint(publicKeyBase64: string) {
  const stripped = publicKeyBase64.replace(/\s+/g, '');
  const hash = crypto.subtle.digest('SHA-256', new TextEncoder().encode(stripped));
  return hash.then((buffer) => {
    const bytes = new Uint8Array(buffer);
    return Array.from(bytes.slice(0, 8))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(':');
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function arrayBufferToHex(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function base64ToArrayBuffer(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
