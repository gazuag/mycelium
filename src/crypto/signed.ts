import { importPrivateKey, importPublicKey } from './identity';
import type { SignedPost, SignedProfile } from '../types';

function canonicalizePost(post: Omit<SignedPost, 'signature'>): string {
  return JSON.stringify({
    protocol: post.protocol,
    version: post.version,
    type: post.type,
    id: post.id,
    author: post.author,
    timestamp: post.timestamp,
    content: post.content,
    tags: post.tags,
    reaction: post.reaction ?? undefined,
    repostOf: post.repostOf ?? undefined,
    originalAuthor: post.originalAuthor ?? undefined,
    replyTo: post.replyTo ?? undefined
  });
}

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

export async function createSignedPost(
  id: string,
  authorKey: string,
  privateKey: string,
  content: string,
  tags: string[],
  options: { reaction?: 'like' | 'dislike'; repostOf?: string; originalAuthor?: string; replyTo?: string } = {}
): Promise<SignedPost> {
  const post: Omit<SignedPost, 'signature'> = {
    protocol: 'mycelium',
    version: 1,
    type: 'post',
    id,
    author: authorKey,
    timestamp: new Date().toISOString(),
    content,
    tags,
    reaction: options.reaction,
    repostOf: options.repostOf,
    originalAuthor: options.originalAuthor,
    replyTo: options.replyTo
  };

  const canonical = canonicalizePost(post);
  const signature = await signData(privateKey, canonical);
  return { ...post, signature };
}

export async function verifySignedPost(post: SignedPost): Promise<boolean> {
  if (post.protocol !== 'mycelium' || post.type !== 'post' || post.version !== 1) {
    return false;
  }
  const canonical = canonicalizePost({
    protocol: post.protocol,
    version: post.version,
    type: post.type,
    id: post.id,
    author: post.author,
    timestamp: post.timestamp,
    content: post.content,
    tags: post.tags,
    reaction: post.reaction,
    repostOf: post.repostOf,
    originalAuthor: post.originalAuthor,
    replyTo: post.replyTo
  });
  return verifyData(post.author, canonical, post.signature);
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
