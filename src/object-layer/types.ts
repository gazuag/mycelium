export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ReplicationPolicy {
  readonly replication_budget?: number;
  readonly expires_at?: string;
}

export interface DistributedObject {
  readonly object_id: string;
  readonly object_type: string;
  readonly author: string;
  readonly created_at: string;
  readonly expires_at?: string;
  readonly sequence?: number;
  readonly payload: JsonValue;
  readonly signature: string;
  readonly replication_policy: ReplicationPolicy;
}

export interface ObjectStorePacket {
  readonly protocol: 'mycelium';
  readonly version: 1;
  readonly id: string;
  readonly type: 'OBJECT_STORE';
  readonly timestamp: string;
  readonly sender: string;
  readonly recipient: string | null;
  readonly payload: { readonly object: DistributedObject };
  readonly signature: string;
}

export interface FindPacket {
  readonly protocol: 'mycelium';
  readonly version: 1;
  readonly id: string;
  readonly type: 'FIND';
  readonly timestamp: string;
  readonly sender: string;
  readonly recipient: string | null;
  readonly payload: { readonly object_id: string; readonly requestId: string; readonly ttl: number; readonly expiresAt: string; readonly origin?: string };
  readonly signature: string;
}

export interface FindResponsePacket {
  readonly protocol: 'mycelium';
  readonly version: 1;
  readonly id: string;
  readonly type: 'FIND_RESPONSE';
  readonly timestamp: string;
  readonly sender: string;
  readonly recipient: string | null;
  readonly payload: { readonly object_id: string; readonly requestId: string; readonly expiresAt?: string; readonly origin?: string; readonly object?: DistributedObject };
  readonly signature: string;
}

export type ObjectPacket = ObjectStorePacket | FindPacket | FindResponsePacket;

export interface ObjectTransport {
  connectedPeers(): string[];
  send(peerId: string, packet: ObjectPacket): Promise<void>;
  onPacket(handler: (peerId: string, packet: ObjectPacket) => void): () => void;
}

export type ObjectContent = Omit<DistributedObject, 'object_id' | 'author' | 'signature'>;

export type ObjectCriteria = Partial<Pick<DistributedObject, 'object_id' | 'object_type' | 'author' | 'created_at' | 'expires_at' | 'sequence'>>;

export interface ObjectStore {
  put(object: DistributedObject): Promise<void>;
  get(objectId: string): Promise<DistributedObject | null>;
  delete(objectId: string): Promise<void>;
  query(criteria?: ObjectCriteria): Promise<DistributedObject[]>;
}

export type ObjectSignatureVerifier = (author: string, content: string, signature: string) => Promise<boolean>;

export interface ObjectIdentity {
  readonly nodeId: string;
  readonly publicKey: string;
  sign(data: string): Promise<string>;
  verify(publicKey: string, data: string, signature: string): Promise<boolean>;
}