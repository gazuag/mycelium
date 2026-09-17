import { importPrivateKey, importPublicKey } from './identity';
import type { SignedProfile } from '../types';

function canonicalizeProfile(profile: Omit<SignedProfile, 'signature'>): string {
  return JSON.stringify({
    protocol: profile.protocol,
    version: profile.version,
    type: profile.type,
    id: profile.id,
    author: profile.author,
    timestamp: profile.timestamp,
    displayName: profile.displayName ?? undefined,
    bio: profile.bio ?? undefined,
    tags: profile.tags ?? []
  });
}

async function signData(privateKeyBase64: string, data: string): Promise<string> {
  const privateKey = await importPrivateKey(privateKeyBase64);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(data)
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function verifyData(publicKeyBase64: string, data: string, signatureBase64: string): Promise<boolean> {
  const publicKey = await importPublicKey(publicKeyBase64);
  const signature = Uint8Array.from(atob(signatureBase64), (c) => c.charCodeAt(0));
  return await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    signature,
    new TextEncoder().encode(data)
  );
}

export async function createSignedProfile(
  id: string,
  authorKey: string,
  privateKey: string,
  displayName?: string,
  bio?: string,
  tags: string[] = []
): Promise<SignedProfile> {
  const profile: Omit<SignedProfile, 'signature'> = {
    protocol: 'mycelium',
    version: 1,
    type: 'profile',
    id,
    author: authorKey,
    timestamp: new Date().toISOString(),
    displayName,
    bio,
    tags
  };

  const canonical = canonicalizeProfile(profile);
  const signature = await signData(privateKey, canonical);
  return { ...profile, signature };
}

export async function verifySignedProfile(profile: SignedProfile): Promise<boolean> {
  if (profile.protocol !== 'mycelium' || profile.type !== 'profile' || profile.version !== 1) {
    return false;
  }
  const canonical = canonicalizeProfile({
    protocol: profile.protocol,
    version: profile.version,
    type: profile.type,
    id: profile.id,
    author: profile.author,
    timestamp: profile.timestamp,
    displayName: profile.displayName ?? undefined,
    bio: profile.bio ?? undefined,
    tags: profile.tags ?? []
  });
  return verifyData(profile.author, canonical, profile.signature);
}
