# V3 Object Identity Security Review

Date: 2026-10-21

Scope: Read-only audit of v3 object identity, Delete Request authorization, object admission, FIND/replication, storage, and protocol specification. The review identified the following issues.

| # | Severity | File | Lines | Vulnerability | Confidence |
|---|----------|------|-------|---------------|------------|
| 1 | 🟡 MEDIUM | [src/App.tsx](./src/App.tsx) | 1132-1144, 1158-1188 | Child FIND responses are validated and then aggregated or relayed without filtering object IDs against local deletion tombstones. A peer that accepted a deletion can therefore relay a stale copy of the deleted object obtained from another peer. | 9/10 |
| 2 | 🟡 MEDIUM | [src/p2p/protocol.ts](./src/p2p/protocol.ts) | 76-84 | Canonical JSON uses locale-sensitive `localeCompare` to sort keys. Since v3 content hashes cover arbitrary JSON payload keys, peers with different default locales may canonicalize the same content differently and reject otherwise valid objects. | 8/10 |

## Verified v3 invariants

- New IDs are generated from 32 bytes using `crypto.getRandomValues` and formatted as 64 lowercase hexadecimal characters. Creation is the only generation step; storage and transport carry the existing ID.
- The content hash is SHA-256 of the canonical immutable fields (`object_type`, `author`, optional `recipient`, `created_at`, optional `expires_at`, optional `sequence`, `payload`, and `replication_policy`).
- The v3 signature verifies the canonical, domain-separated record containing `domain: "mycelium.object-signature.v3"`, `object_id`, and `content_hash`, using the claimed author public key.
- Validation recomputes the content hash and verifies the v3 signature. Changing the ID, author, content hash, or immutable content without a corresponding valid signature fails validation.
- V3 Delete Requests carry the target content hash and target signature. Verification binds that proof to the requested ID, and acceptance requires the request signer to equal `target_author`; the target need not be locally present.
- Legacy and v2 object validation and Delete Request proof paths remain distinct from v3. Legacy deletion still requires a locally verifiable target; v2 deletion still uses its author-bound ID proof.
- Object storage, FIND IDs, replication, references, tombstones, and GC use `object_id` as an opaque identifier; content hashes are not used as storage identity.

## Specification accuracy

The specification accurately describes the v3 signature tuple and immutable content fields used for the content hash. It does not document the locale-sensitive key ordering used by the shared canonicalizer; this is the interoperability issue described in finding 2.
