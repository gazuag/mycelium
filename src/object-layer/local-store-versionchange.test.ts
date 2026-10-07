import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { IndexedDbOutboxStore } from './local-store';

const DATABASE_NAME = 'mycelium_objects';

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Database deletion was blocked'));
  });
}

afterAll(async () => {
  await deleteDatabase();
});

describe('object database connection lifecycle', () => {
  it('waits for an older stale connection, reports blocking, and reopens after versionchange close', async () => {
    await deleteDatabase();
    const staleConnection = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 4);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('objects', { keyPath: 'object_id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nativeOpen = indexedDB.open.bind(indexedDB);
    const openedConnections: IDBDatabase[] = [];
    vi.spyOn(indexedDB, 'open').mockImplementation((databaseName, version) => {
      const request = nativeOpen(databaseName, version);
      request.addEventListener('success', () => openedConnections.push(request.result));
      return request;
    });
    const store = new IndexedDbOutboxStore();
    const opening = store.listPending(10);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'IndexedDB upgrade is blocked by another open connection.'
    ));
    staleConnection.close();
    await expect(opening).resolves.toEqual([]);

    const deleteRequest = indexedDB.deleteDatabase(DATABASE_NAME);
    await new Promise<void>((resolve, reject) => {
      deleteRequest.onsuccess = () => resolve();
      deleteRequest.onerror = () => reject(deleteRequest.error);
      deleteRequest.onblocked = () => reject(new Error('Versionchange handler did not close its connection'));
    });

    await expect(new IndexedDbOutboxStore().listPending(10)).resolves.toEqual([]);
    expect(openedConnections).toHaveLength(2);
    expect(openedConnections[0].onversionchange).toBeTypeOf('function');
    warn.mockRestore();
    vi.restoreAllMocks();
  });
});
