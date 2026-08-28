# Mycelium Distributed Object Protocol — Draft Specification

## 1. Purpose

Mycelium is a peer-to-peer distributed object network.

The fundamental purpose of the protocol is to allow signed objects to be stored, replicated, located, retrieved, and transferred between peers without requiring the object's originating node to remain online.

The network should behave as a transparent distributed object cloud. Applications should be able to create an object and ask the Mycelium network to store or retrieve it without needing to know which peer currently holds the object.

The transport/storage layer must remain agnostic about the semantic meaning of objects. Posts, profiles, direct messages, images, comments, and future object types should use the same underlying object infrastructure.

The social application layer defines what objects mean. The Mycelium object layer defines how objects move through and persist in the network.

## 2. Core principles

An object is identified independently of where it is stored.

Objects may be replicated on multiple peers.

The originating author does not need to remain online after an object has been replicated.

Any suitable peer may temporarily store and relay an object.

Peers do not need to know the entire network topology. Each peer maintains partial knowledge of other peers and uses that knowledge to route requests and replicate objects.

Requests propagate recursively through the peer network, but request IDs prevent the same request from being processed repeatedly by the same peer.

Responses propagate back through the request path and are aggregated at intermediate peers.

The network must use bounded TTLs, deadlines, and replication budgets to prevent uncontrolled propagation.

Public objects may be readable by anyone but must be cryptographically signed by their author.

Private objects must be encrypted so that relay/storage peers cannot read them.

## 3. Object model

Every object has an envelope containing metadata and a payload.

Conceptually:

    object_id
    object_type
    author
    created_at
    expires_at
    sequence
    payload
    signature
    replication_policy

The exact serialization format should be canonical and deterministic so that signatures and hashes are reproducible.

`object_id` uniquely identifies the object. It should be derived from the object's immutable content or otherwise be cryptographically collision-resistant.

`object_type` identifies the application-level object type. The transport layer should not need to understand the meaning of the type.

`author` identifies the public key of the object creator.

`created_at` is the author's declared creation/publication timestamp.

`expires_at` is optional. Objects without an expiration are persistent unless removed by an application-specific mechanism.

`sequence` is an optional author-controlled monotonically increasing sequence number. Objects such as posts should use it to establish ordering within an author's stream.

`payload` contains the actual object data.

`signature` is a cryptographic signature made by the author's private key over the canonical object contents.

`replication_policy` describes how aggressively the object should be replicated and how long temporary replicas should be retained.

The object ID and signature use the same canonical immutable content, excluding both `object_id` and `signature`:

    object content
        -> canonical serialization
        -> SHA-256 -> object_id

    object content
        -> canonical serialization
        -> author signature -> signature

The signature is envelope metadata and is not part of the object ID. The object ID is not part of the signed content. Consequently, changing only the signature does not change the object ID, while changing any immutable content requires both a new object ID and a new valid signature.

## Object Transport (Initial)

The object layer uses an `ObjectTransport` abstraction and does not own peer connections. The initial transport path is a direct transfer to one already-connected peer:

        Object Layer
                -> ObjectTransport
                -> existing PeerConnection/WebRTC transport

The first object-layer packet is `OBJECT_STORE`. It reuses the existing Mycelium outer packet format and carries one complete generic distributed object in its payload:

        {
            "protocol": "mycelium",
            "version": 1,
            "id": "<UUID>",
            "type": "OBJECT_STORE",
            "timestamp": "<UTC ISO8601>",
            "sender": "<Sender Node ID>",
            "recipient": "<Recipient Node ID>",
            "payload": { "object": { "<distributed object>" } },
            "signature": "<Digital Signature>"
        }

At this stage, `OBJECT_STORE` is handled only between directly connected peers. The receiver validates the generic object independently and stores it locally. There is no forwarding, FIND, distributed QUERY, replication, retry routing, or delivery protocol yet. The object layer does not invoke application-specific post, profile, or direct-message handlers.

## Direct FIND Request Tracking

The initial direct `FIND` operation includes a unique `requestId`, a non-negative `ttl`, and an optional `origin` field in its payload. The `origin` identifies the node that originated the request and therefore the node that should ultimately receive any successful `FIND_RESPONSE`. A `FIND_RESPONSE` repeats the request ID and requested object ID and may also carry the same `origin` for route validation.

The receiving peer keeps a short-lived cache of processed request IDs. A repeated request ID is ignored, including when a later copy contains a different object ID. Different request IDs may independently request the same object. Every valid request performs a local lookup, including when `ttl` is zero. A `ttl` of zero is the final lookup hop: a matching object is returned, while a missing object produces an empty response and is not forwarded. Positive TTL values are consumed by this hop and may be forwarded only when the local lookup misses. The cache is bounded by request lifetime and is cleaned as new requests arrive.

For Phase 5 recursive forwarding, every forwarded `FIND` keeps the same `requestId`, decrements `ttl`, and preserves `origin`. The forwarding peer does not create a new request ID. When a peer forwards a request, it must exclude the peer that sent the request to it. If a peer has the object, it creates a `FIND_RESPONSE` addressed to the immediate upstream peer; each relay re-emits the same response toward the node recorded as the request `origin` or the previous hop from its local request route cache. This prevents a response from being broadcast to every connected peer while still allowing it to traverse the reverse path of the request.

## 4. Encryption and signatures

Signing and encryption are separate operations.

A public object is signed by its author. Any peer may read it and verify the signature.

A private object is encrypted for its intended recipient before being distributed.

For example, for a direct message from A to B:

    A encrypts the plaintext using B's public key.
    A signs the resulting object/envelope using A's private key.
    The encrypted object is distributed through the network.
    Relay peers may store and forward the object but cannot decrypt it.
    B uses B's private key to decrypt the payload.
    B uses A's public key to verify the sender's signature.

The network must not require relay peers to understand or decrypt application payloads.

## 5. Generic object storage

A peer may receive an object even if it has no relationship with the author, recipient, or application-level owner of the object.

A peer may store an object as a replica and/or relay it to other peers.

Objects should be treated as immutable. If an application needs to change information, it should normally create a new object referencing the previous object.

This makes deduplication and caching straightforward.

## 6. Replication

Objects may have a replication budget.

The replication budget represents the desired number of useful live replicas rather than the maximum number of times an object may be forwarded.

For example:

    replication_budget = 3

means that the network should attempt to maintain approximately three useful replicas.

The exact replica count does not need to be globally known.

Peers should prefer reliable peers when selecting replica destinations.

A replication budget must be combined with a propagation TTL or hop limit so that a faulty implementation cannot create unlimited replication.

Persistent public objects may use a high or effectively persistent replication policy.

Temporary objects such as direct messages should use a limited replication budget and an expiration time.

## 7. Peer knowledge

Peers maintain a local peer table.

The table may contain:

    public_key
    address/connection information
    last_seen
    last_successful_connection
    estimated_availability
    estimated_latency
    capabilities
    other routing information

This information is local knowledge, not a globally authoritative database.

Peers should periodically exchange useful peer information through controlled gossip.

A peer may know about many peers while maintaining active connections to only a manageable subset.

Knowledge of a peer does not imply a persistent connection.

Peers may periodically probe known peers to update their availability information.

## 8. Generic object retrieval

The fundamental retrieval operation is a request for one or more object IDs.

Conceptually:

    FIND(object_id)

or:

    FIND([object_id_1, object_id_2, ...])

A request contains at least:

    request_id
    origin
    requested_objects
    TTL / hop limit
    deadline
    request type

`request_id` must be globally unique enough to prevent collisions.

Each peer maintains a short-lived cache of recently seen request IDs.

If a peer receives a request ID it has already processed, it must not recursively process the same request again.

This prevents cycles in the peer graph from causing infinite propagation.

## 9. Recursive request propagation

A peer receiving a request first checks its own local storage.

If it has matching objects, it adds them to its response.

If objects are still missing, it may forward the request to selected connected peers.

The peer should not blindly forward to every known peer.

Forwarding should use a limited fanout and preferably select peers based on routing knowledge, availability, latency, and other locally available information.

Each forwarded request carries a decreasing TTL/hop count and the same absolute deadline.

Example:

    A
    ├── B
    │   ├── D
    │   └── E
    └── C
        ├── E
        └── F

If E receives the same request from B and C, E processes it only once.

The first parent may become the response route for that request.

Future implementations may optimize this by allowing E to select a better parent if multiple copies arrive within a short grace period.

## 10. Response aggregation

A request for a single object can terminate as soon as a valid copy is found.

A request for multiple objects must aggregate partial results.

Each peer combines:

    objects found locally
    +
    objects returned by child peers

Duplicate objects are removed using their object IDs.

Example:

    Child A returns: 1,2,3,4
    Child B returns: 4,5,6
    Parent returns:  1,2,3,4,5,6

A peer should normally wait for responses from its children for a bounded grace period rather than immediately returning after receiving the first response.

This allows multiple branches to contribute different objects.

The request deadline ultimately terminates the search even if some branches never respond.

The system should not require every branch to respond before returning a result.

A result therefore represents the objects found within the request's search budget and deadline.

## 11. Time-range queries

The protocol should prefer time-range queries over queries such as "latest N objects."

For an author's stream, an application may request:

    objects where author == B
    and created_at > T

or:

    objects where author == B
    and T1 <= created_at < T2

Every peer simply returns the matching objects it currently possesses.

Peers do not need to know whether their local copy represents the author's complete or latest history.

Results from different peers are merged automatically.

This avoids requiring the network to maintain a globally synchronized "latest objects" index.

## 12. Author sequence numbers

Application streams such as posts should normally contain an author-controlled sequence number.

For example:

    author = B
    sequence = 10482

This provides deterministic ordering within B's stream and allows missing objects to be detected.

A peer may possess:

    B/10480
    B/10481
    B/10483

and therefore know that B/10482 is missing.

The application can then issue a targeted request for B/10482.

Sequence numbers are an optimization and consistency aid; time-range queries remain the primary mechanism for discovering objects over a time interval.

## 13. Publishing objects

When an object is created, the originating peer should distribute it to suitable connected peers.

The current Mycelium behavior of pushing newly created posts to connected followers may remain as an application-level replication strategy.

However, followers are not required for the object to become available.

A peer may replicate or relay an object to any suitable peer.

Once replicas exist, the original author may disconnect without making the object unavailable.

Publication and retrieval are therefore separate operations.

Publication creates replicas.

Retrieval locates existing replicas.

## 14. Distributed handoff

A peer that is about to disconnect should attempt to hand off temporary objects for which it is responsible.

For example:

    Peer A is going offline.
    A has temporary relay objects M1, M2, M3.
    A selects suitable connected peers.
    A transfers the objects.
    The receiving peers confirm storage.
    A may then safely remove its temporary copies.

Browser-based implementations should use the browser's available shutdown/background lifecycle mechanisms where possible.

However, shutdown handoff must be treated as an optimization rather than the only mechanism protecting data, because browser shutdown events cannot always be guaranteed.

The replication system must therefore maintain enough independent replicas that unexpected node disappearance is survivable.

## 15. Direct messages

A direct message is simply a temporary encrypted object whose application metadata identifies its intended recipient.

For example:

    object_type = direct_message
    recipient = B
    expires_at = ...
    replication_budget = 3

A does not need to be directly connected to B.

A may give the encrypted object to C, D, and E.

Those peers may store and relay the object even if they do not know B personally.

Relays cannot decrypt the payload.

The object propagates through the network according to its replication policy and TTL.

## 16. Message delivery

When a peer holding a message for B discovers that B is online, it should first send a lightweight availability/offer message rather than immediately transferring the full encrypted payload.

Conceptually:

    OFFER message_id

B responds:

    REQUEST message_id

or:

    ALREADY_HAVE message_id

The relay then transfers the object only if requested.

After successful receipt and verification, B sends:

    ACK message_id

The ACK may be propagated to other known holders so they can safely delete their temporary copies.

If no ACK is received before the message expiration time, relay peers eventually delete the message.

## 17. Delivery acknowledgements

A delivery acknowledgement should preferably be cryptographically signed by the recipient.

This allows relay peers to distinguish:

    "B has cryptographically acknowledged receipt"

from:

    "I merely think B probably received it."

Once a valid recipient ACK exists, temporary replicas may be garbage-collected according to the object's replication policy.

## 18. Application-level relationships

The object layer does not need to understand social relationships.

A post replying to another post can simply contain:

    reply_to = object_id

The storage layer treats this as ordinary application metadata.

The application layer can issue a distributed query such as:

    FIND objects where reply_to == object_id

Similarly, future applications can define relationships such as:

    references
    quotes
    reacts_to
    belongs_to
    follows
    replaces
    attaches_to

without modifying the underlying object transport mechanism.

## 19. Generic distributed queries

The long-term goal is for the network to support queries over replicated object metadata.

Examples:

    objects where author == B
    objects where author == B and created_at > T
    objects where reply_to == X
    objects where recipient == B
    object with ID X

The query system should remain generic enough that new application object types do not require changes to the fundamental peer-to-peer transport protocol.

## 20. Discovery/bootstrap

A discovery server should not be the authoritative storage system.

Its primary purpose should be bootstrap.

A new peer obtains a small set of currently reachable peers and connects to them.

After joining, the peer can discover additional peers through the distributed peer network.

Eventually, Mycelium should be able to operate without a centralized database of users, posts, or messages.

The bootstrap infrastructure is therefore replaceable and should not be required for ordinary object retrieval once a peer has joined the network.

## 21. Failure and bounded operation

Every recursive operation must be bounded.

Requests should have:

    request_id
    TTL/hop limit
    deadline
    maximum forwarding fanout

Replication should have:

    replication budget
    expiration/TTL where appropriate
    maximum propagation depth or equivalent safety mechanism

A node must never recursively forward the same request indefinitely.

A node must never create unlimited replicas of an object.

A node must not wait indefinitely for a child peer to respond.

The network should prefer partial useful results over blocking indefinitely for perfect results.

## 22. Architectural goal

The ultimate abstraction should be:

    STORE(object)
    FIND(object_id)
    QUERY(criteria)
    SEND(object, recipient)
    ACK(object_id)

The application should not need to know where an object is stored.

The network should transparently determine:

    where to send the request
    which peers may have the object
    how to recursively search
    how to merge partial responses
    how to replicate data
    how to route temporary objects
    how to hand off data when peers disconnect
    when temporary replicas can be deleted

The desired result is a self-healing distributed object cloud in which no single peer is required to remain online for the network to retain and deliver data.

Mycelium's social-network functionality is an application built on top of this distributed object layer, rather than the definition of the layer itself.