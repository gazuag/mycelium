import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const OBSERVATION_STORES = [
  'peer_connection_observations',
  'find_forwarding_observations',
  'object_supply_observations'
] as const;
interface Peer {
  label: string;
  context: BrowserContext;
  page: Page;
  identityId: string;
}

interface BrowserDiagnostics {
  label: string;
  consoleErrors: string[];
  pageErrors: string[];
}

interface ObservationExport {
  format: string;
  version: number;
  exported_at: string;
  summary: Record<string, number>;
  observations: Record<string, Array<Record<string, unknown>>>;
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local signalling port');
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function stopChildProcess(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const waitForExit = (timeoutMs: number) => new Promise<boolean>((resolveExit) => {
    let timer: ReturnType<typeof setTimeout>;
    const handleExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once('exit', handleExit);
    timer = setTimeout(() => {
      child.removeListener('exit', handleExit);
      resolveExit(false);
    }, timeoutMs);
  });
  const gracefulExit = waitForExit(5_000);
  child.kill('SIGTERM');
  if (await gracefulExit) return;
  const forcedExit = waitForExit(5_000);
  child.kill('SIGKILL');
  await forcedExit;
}

async function startSignallingServer() {
  const port = await findFreePort();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'mycelium-observations-'));
  const databasePath = join(temporaryDirectory, 'discovery.sqlite');
  const certificatePath = join(temporaryDirectory, 'server.crt');
  const privateKeyPath = join(temporaryDirectory, 'server.key');
  const certificateProcess = spawn('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', privateKeyPath,
    '-out', certificatePath,
    '-days', '1',
    '-subj', '/CN=localhost'
  ], { stdio: 'ignore' });
  try {
    await new Promise<void>((resolveCertificate, rejectCertificate) => {
      certificateProcess.once('error', rejectCertificate);
      certificateProcess.once('exit', (code) => code === 0
        ? resolveCertificate()
        : rejectCertificate(new Error(`Could not create temporary signalling TLS certificate (exit ${code})`)));
    });
  } catch (error) {
    for (const path of [certificatePath, privateKeyPath]) {
      try {
        await unlink(path);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError;
      }
    }
    await rmdir(temporaryDirectory);
    throw error;
  }
  const projectPython = resolve(process.cwd(), '.venv/bin/python');
  const python = process.env.MYCELIUM_PYTHON ?? (existsSync(projectPython) ? projectPython : 'python3');
  const child = spawn(python, [resolve(process.cwd(), 'server.py')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SIGNAL_HOST: '127.0.0.1',
      SIGNAL_PORT: String(port),
      DISCOVERY_DB_PATH: databasePath,
      TLS_CERT_PATH: certificatePath,
      TLS_KEY_PATH: privateKeyPath
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let processError: Error | undefined;
  child.on('error', (error) => {
    processError = error;
    output += `${error.message}\n`;
  });
  child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { output += data.toString(); });

  const startedAt = Date.now();
  let ready = false;
  while (Date.now() - startedAt < 15_000) {
    if (processError || child.exitCode !== null) {
      for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, certificatePath, privateKeyPath]) {
        try {
          await unlink(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await rmdir(temporaryDirectory);
      throw new Error(`Local signalling server could not start:\n${output}`);
    }
    try {
      await new Promise<void>((resolveConnection, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => {
          socket.destroy();
          resolveConnection();
        });
        socket.once('error', reject);
      });
      ready = true;
      break;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  if (!ready) {
    await stopChildProcess(child);
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, certificatePath, privateKeyPath]) {
      try {
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await rmdir(temporaryDirectory);
    throw new Error(`Local signalling server did not start within 15 seconds:\n${output}`);
  }

  return {
    child,
    endpoint: `wss://localhost:${port}`,
    diagnostics: () => output,
    stop: async () => {
    await stopChildProcess(child);
      for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, certificatePath, privateKeyPath]) {
        try {
          await unlink(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await rmdir(temporaryDirectory);
    }
  };
}

async function readObservationStores(page: Page) {
  return page.evaluate(async (storeNames) => {
    const observations = await new Promise<Record<string, Array<Record<string, unknown>>>>((resolveRead, rejectRead) => {
      const request = indexedDB.open('mycelium_p2p');
      request.onerror = () => rejectRead(request.error ?? new Error('Could not open Mycelium observation database'));
      request.onsuccess = () => {
        const database = request.result;
        const missingStore = storeNames.find((storeName) => !database.objectStoreNames.contains(storeName));
        if (missingStore) {
          database.close();
          rejectRead(new Error(`Required observation store is missing: ${missingStore}`));
          return;
        }
        const transaction = database.transaction([...storeNames], 'readonly');
        const records: Record<string, Array<Record<string, unknown>>> = {};
        let remaining = storeNames.length;
        const completeRequest = () => {
          remaining -= 1;
          if (remaining !== 0) return;
          database.close();
          resolveRead(records);
        };
        for (const storeName of storeNames) {
          const storeRequest = transaction.objectStore(storeName).getAll();
          storeRequest.onsuccess = () => {
            records[storeName] = storeRequest.result as Array<Record<string, unknown>>;
            completeRequest();
          };
          storeRequest.onerror = () => rejectRead(storeRequest.error ?? new Error(`Could not read ${storeName}`));
        }
        transaction.onerror = () => rejectRead(transaction.error ?? new Error('IndexedDB observation read failed'));
      };
    });
    const objects = await new Promise<Array<Record<string, unknown>>>((resolveRead, rejectRead) => {
      const request = indexedDB.open('mycelium_objects');
      request.onerror = () => rejectRead(request.error ?? new Error('Could not open Mycelium object database'));
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('objects')) {
          database.close();
          rejectRead(new Error('Required object store is missing: objects'));
          return;
        }
        const transaction = database.transaction('objects', 'readonly');
        const objectRequest = transaction.objectStore('objects').getAll();
        objectRequest.onsuccess = () => {
          database.close();
          resolveRead(objectRequest.result as Array<Record<string, unknown>>);
        };
        objectRequest.onerror = () => rejectRead(objectRequest.error ?? new Error('Could not read stored objects'));
        transaction.onerror = () => rejectRead(transaction.error ?? new Error('IndexedDB object read failed'));
      };
    });
    return { observations, objects };
  }, [...OBSERVATION_STORES]);
}

async function readPeerState(page: Page) {
  return page.evaluate(() => {
    const api = window.__MYCELIUM_E2E__;
    if (!api) throw new Error('Development-only Mycelium test API is unavailable');
    return api.state();
  });
}

async function waitForPeerConnection(left: Peer, right: Peer) {
  const leftState = await readPeerState(left.page);
  if (!leftState.connectedPeers.includes(right.identityId)) {
    await left.page.evaluate(async (peerId) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      await api.connectPeer(peerId);
    }, right.identityId);
  }
  await expect.poll(async () => (await readPeerState(left.page)).connectedPeers, {
    timeout: 30_000,
    message: `${left.label} did not connect to ${right.label}; app logs: ${(await readPeerState(left.page)).logs.slice(-20).join('\n')}`
  }).toContain(right.identityId);
  await expect.poll(async () => (await readPeerState(right.page)).connectedPeers, {
    timeout: 15_000,
    message: `${right.label} did not observe the connection from ${left.label}`
  }).toContain(left.identityId);
}

async function waitForAuthenticatedConnection(left: Peer, right: Peer) {
  const authenticateFrom = async (peer: Peer, remote: Peer) => {
    await expect.poll(async () => {
      await peer.page.evaluate(async (peerId) => {
        const api = window.__MYCELIUM_E2E__;
        if (!api) throw new Error('Development-only Mycelium test API is unavailable');
        await api.sendAuthenticatedProfile(peerId);
      }, remote.identityId);
      return (await readPeerState(peer.page)).logs.some((entry) => entry.includes(
        `Received authenticated connection metadata from ${remote.identityId}`
      ));
    }, {
      timeout: 20_000,
      message: `${peer.label} did not authenticate ${remote.label}; logs: ${(await readPeerState(peer.page)).logs.slice(-25).join('\n')}`
    }).toBe(true);
  };
  await Promise.all([
    authenticateFrom(left, right),
    authenticateFrom(right, left)
  ]);
}

async function createPeer(
  context: BrowserContext,
  label: string,
  endpoint: string,
  diagnostics: BrowserDiagnostics
): Promise<Peer> {
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.stack ?? error.message));
  await page.addInitScript((signalEndpoint) => {
    Object.assign(globalThis, { VITE_SIGNAL_SERVER_URL: signalEndpoint });
  }, endpoint);
  await page.goto('/');
  await page.getByRole('dialog', { name: 'Welcome! Pick your name!' }).waitFor();
  await page.getByRole('button', { name: "I'll explore on my own", exact: true }).click();
  await page.waitForFunction(() => Boolean(window.__MYCELIUM_E2E__));
  await expect.poll(async () => (await readPeerState(page)).signallingStatus, {
    timeout: 20_000,
    message: `${label} did not connect to local signalling; app logs: ${(await readPeerState(page)).logs.slice(-20).join('\n')}; browser errors: ${diagnostics.consoleErrors.join('\n')}; page errors: ${diagnostics.pageErrors.join('\n')}`
  }).toBe('connected');
  const state = await readPeerState(page);
  expect(state.identityId, `${label} should have a unique identity`).toMatch(/^(?:[a-f\d]{2}:){7}[a-f\d]{2}$/i);
  return { label, context, page, identityId: state.identityId };
}

async function submitPost(page: Page, content: string) {
  const settings = page.getByRole('heading', { name: 'Settings', exact: true }).first();
  if (!(await settings.count())) await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const publishToDiscovery = page.getByRole('checkbox', { name: 'Publish to discovery' });
  if (await publishToDiscovery.isChecked()) await publishToDiscovery.uncheck({ force: true });
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  const composer = page.getByPlaceholder('Share what is happening...');
  if (!(await composer.count())) await page.getByRole('button', { name: 'Write', exact: true }).click();
  await composer.fill(content);
  await page.getByRole('button', { name: 'Send', exact: true }).click({ force: true });
}

async function exportObservations(page: Page, path: string): Promise<ObservationExport> {
  const before = await readObservationStores(page);
  const downloadPromise = page.waitForEvent('download');
  const settings = page.getByRole('heading', { name: 'Settings', exact: true }).first();
  if (!(await settings.count())) await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Export Local Observations', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('mycelium-local-observations.json');
  await download.saveAs(path);
  const payload = JSON.parse(await readFile(path, 'utf8')) as ObservationExport;
  const after = await readObservationStores(page);
  expect(after).toEqual(before);
  expect(payload).toMatchObject({
    format: 'mycelium-local-observations',
    version: 1
  });
  const expectedObservations = {
    connections: before.observations.peer_connection_observations,
    find_forwarding: before.observations.find_forwarding_observations,
    object_supply: before.observations.object_supply_observations
  };
  expect(payload.observations).toEqual(expectedObservations);
  expect(payload.summary).toEqual({
    connections: expectedObservations.connections.length,
    find_forwarding: expectedObservations.find_forwarding.length,
    object_supply: expectedObservations.object_supply.length
  });
  expect(payload.observations.connections).toBeInstanceOf(Array);
  expect(payload.observations.find_forwarding).toBeInstanceOf(Array);
  expect(payload.observations.object_supply).toBeInstanceOf(Array);
  return payload;
}

test('four independent browser peers record and export local topology observations', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const outputDirectory = resolve(process.cwd(), 'test-results/topology-observations');
  await mkdir(outputDirectory, { recursive: true });
  const signalling = await startSignallingServer();
  let browserInstance: Browser | undefined;
  const contexts: BrowserContext[] = [];
  const diagnostics: BrowserDiagnostics[] = [];
  const peers = new Map<string, Peer>();
  const exportsByPeer = new Map<string, ObservationExport>();
  const peerStateDiagnostics: Record<string, {
    identityId: string;
    connectedPeers: string[];
    signallingStatus: string;
    followingPeerIds: string[];
    logs: string[];
  }> = {};
  try {
    const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
    browserInstance = browser;
    const create = async (label: string) => {
      const context = await browser.newContext({ acceptDownloads: true, ignoreHTTPSErrors: true });
      contexts.push(context);
      const peerDiagnostics = { label, consoleErrors: [], pageErrors: [] };
      diagnostics.push(peerDiagnostics);
      let peer: Peer;
      try {
        peer = await createPeer(context, label, signalling.endpoint, peerDiagnostics);
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nLocal signalling server:\n${signalling.diagnostics()}`);
      }
      peers.set(label, peer);
      return peer;
    };
    const author = await create('peer-d');
    const cache = await create('peer-b');
    await waitForPeerConnection(author, cache);
    await author.page.evaluate(async (peerId) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      await api.followPeer(peerId, true);
    }, cache.identityId);
    await expect.poll(async () => (await readPeerState(author.page)).followingPeerIds).toContain(cache.identityId);

    const postContent = `Stage A cached post ${createHash('sha256').update(`${Date.now()}:${author.identityId}`).digest('hex').slice(0, 12)}`;
    await submitPost(author.page, postContent);
    await expect.poll(
      () => author.page.evaluate((content) => window.__MYCELIUM_E2E__?.objectIdForPost(content) ?? null, postContent),
      { timeout: 30_000, message: 'Author UI did not create its signed post' }
    ).not.toBeNull();
    const authorObjectId = await author.page.evaluate(
      (content) => window.__MYCELIUM_E2E__?.objectIdForPost(content) ?? null,
      postContent
    );
    expect(authorObjectId).toBeTruthy();
    await expect.poll(
      () => cache.page.evaluate((content) => window.__MYCELIUM_E2E__?.objectIdForPost(content) ?? null, postContent),
      { timeout: 30_000, message: 'The connected cache did not receive the signed post through normal replication' }
    ).toBe(authorObjectId);
    const authorObject = (await readObservationStores(author.page)).objects.find((object) => object.object_id === authorObjectId);
    expect(authorObject?.author).toBeTruthy();
    exportsByPeer.set('peer-d', await exportObservations(author.page, join(outputDirectory, 'peer-d-observations.json')));

    const origin = await create('peer-a');
    const relay = await create('peer-c');
    await waitForPeerConnection(origin, cache);
    await waitForPeerConnection(cache, relay);
    const connectedEdges = new Set<string>();
    for (const [label, peer] of peers) {
      const state = await readPeerState(peer.page);
      peerStateDiagnostics[label] = { ...state, logs: state.logs.slice(-20) };
      for (const connectedPeerId of state.connectedPeers) {
        connectedEdges.add([state.identityId, connectedPeerId].sort().join('|'));
      }
    }
    expect(new Set([...peers.values()].map((peer) => peer.identityId)).size).toBe(4);
    await author.page.close();
    await expect.poll(async () => (await readPeerState(cache.page)).connectedPeers, {
      timeout: 30_000,
      message: `Cache did not observe author's disconnection; logs: ${(await readPeerState(cache.page)).logs.slice(-20).join('\n')}`
    }).not.toContain(author.identityId);

    await origin.page.evaluate(async (objectId) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      await api.deleteObject(objectId);
    }, authorObjectId!);
    expect((await readObservationStores(origin.page)).objects.some((object) => object.object_id === authorObjectId)).toBe(false);
    const cachedFind = await origin.page.evaluate(async ({ objectId, peerId }) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      return api.findObject(objectId, peerId);
    }, { objectId: authorObjectId!, peerId: cache.identityId });
    expect(cachedFind).toMatchObject({ found: true, objectId: authorObjectId });
    expect(cachedFind.requestId).toBeTruthy();
    await expect.poll(async () => (await readObservationStores(origin.page)).observations.object_supply_observations, {
      timeout: 10_000,
      message: 'Validated FIND result was not recorded as an object supply'
    }).toContainEqual(expect.objectContaining({
      supplier_peer_id: cache.identityId,
      object_id: authorObjectId,
      object_author: authorObject?.author,
      validated: true
    }));

    const missingObjectId = createHash('sha256').update(`missing:${Date.now()}:${origin.identityId}`).digest('hex');
    const missingFind = await origin.page.evaluate(async ({ objectId, peerId }) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      return api.findObject(objectId, peerId);
    }, { objectId: missingObjectId, peerId: cache.identityId });
    expect(missingFind.found, 'A missing FIND must not be reported as a successful result').toBe(false);
    expect(missingFind.requestId).toBeTruthy();
    await expect.poll(async () => (await readObservationStores(cache.page)).observations.find_forwarding_observations, {
      timeout: 10_000,
      message: `Cache did not persist FIND forwarding request ${missingFind.requestId}`
    }).toContainEqual(expect.objectContaining({
      request_id: missingFind.requestId,
      incoming_peer_id: origin.identityId,
      status: expect.stringMatching(/^(responded|failed)$/)
    }));
    const forwardingRecord = (await readObservationStores(cache.page)).observations.find_forwarding_observations
      .find((record) => record.request_id === missingFind.requestId);
    expect(forwardingRecord?.child_peer_id).toBeTruthy();
    expect(forwardingRecord?.child_peer_id).not.toBe(origin.identityId);

    const invalidObjectId = await cache.page.evaluate(async (content) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      return api.createLocalTestPost(content);
    }, `invalid signature test ${Date.now()}`);
    await cache.page.evaluate(async ({ objectId, peerId }) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      await api.sendInvalidObject(objectId, peerId);
    }, { objectId: invalidObjectId, peerId: relay.identityId });
    await expect.poll(async () => (await readPeerState(relay.page)).logs, {
      timeout: 10_000,
      message: `Relay did not report rejection of tampered object ${invalidObjectId}`
    }).toEqual(expect.arrayContaining([
      expect.stringContaining(`Rejected invalid object ${invalidObjectId}`)
    ]));
    const relayRecords = (await readObservationStores(relay.page)).observations.object_supply_observations;
    expect(relayRecords.some((record) => record.object_id === invalidObjectId)).toBe(false);
    expect((await readObservationStores(relay.page)).objects.some((object) => object.object_id === invalidObjectId)).toBe(false);
    const supplyBeforeDuplicates = (await readObservationStores(origin.page)).observations.object_supply_observations
      .find((record) => record.supplier_peer_id === cache.identityId && record.object_id === authorObjectId);
    expect(supplyBeforeDuplicates).toBeTruthy();

    await cache.page.evaluate(async ({ objectId, peerId }) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      await api.sendObject(objectId, peerId);
      await api.sendObject(objectId, peerId);
    }, { objectId: authorObjectId!, peerId: origin.identityId });
    await expect.poll(async () => (await readObservationStores(origin.page)).observations.object_supply_observations, {
      timeout: 10_000
    }).toContainEqual(expect.objectContaining({ supplier_peer_id: cache.identityId, object_id: authorObjectId }));
    const originSupplyRecords = (await readObservationStores(origin.page)).observations.object_supply_observations
      .filter((record) => record.supplier_peer_id === cache.identityId && record.object_id === authorObjectId);
    expect(originSupplyRecords).toHaveLength(1);
    expect(originSupplyRecords[0].object_author).toBe(authorObject?.author);
    expect(originSupplyRecords[0].first_observed_at).toBe(supplyBeforeDuplicates?.first_observed_at);
    expect(originSupplyRecords[0].last_observed_at).toBe(supplyBeforeDuplicates?.last_observed_at);

    for (const [label, peer] of peers) {
      if (label === 'peer-d') continue;
      const exported = await exportObservations(peer.page, join(outputDirectory, `${label}-observations.json`));
      exportsByPeer.set(label, exported);
    }
    expect(exportsByPeer.size).toBe(4);
    const cacheConnections = exportsByPeer.get('peer-b')?.observations.connections ?? [];
    expect(cacheConnections).toContainEqual(expect.objectContaining({
      peer_id: author.identityId,
      success_count: expect.any(Number)
    }));
    const authorConnection = cacheConnections.find((record) => record.peer_id === author.identityId);
    expect((authorConnection?.sessions as Array<Record<string, unknown>>)?.some((session) => session.closed_at)).toBe(true);

    for (const [label, peer] of peers) {
      if (label === 'peer-d') continue;
      const state = await readPeerState(peer.page);
      peerStateDiagnostics[label] = { ...state, logs: state.logs.slice(-20) };
      for (const connectedPeerId of state.connectedPeers) {
        connectedEdges.add([state.identityId, connectedPeerId].sort().join('|'));
      }
    }
    expect(connectedEdges.size).toBeGreaterThanOrEqual(3);
    for (const peerDiagnostics of diagnostics) {
      expect(peerDiagnostics.pageErrors, `${peerDiagnostics.label} uncaught browser errors`).toEqual([]);
    }
    const report = {
      independentContexts: contexts.length,
      connectedEdges: [...connectedEdges],
      exports: Object.fromEntries([...exportsByPeer].map(([label, payload]) => [label, payload.summary])),
      forwardingRecord,
      offlineCacheSupply: originSupplyRecords[0],
      peerStates: peerStateDiagnostics,
      browserDiagnostics: diagnostics,
      signallingServer: signalling.diagnostics()
    };
    const diagnosticsPath = join(outputDirectory, 'peer-diagnostics.json');
    await writeFile(diagnosticsPath, JSON.stringify(report, null, 2));
    await testInfo.attach('multi-peer-observation-diagnostics', { path: diagnosticsPath, contentType: 'application/json' });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    try {
      await Promise.all(contexts.map((context) => context.close()));
    } finally {
      try {
        await browserInstance?.close();
      } finally {
        await signalling.stop();
      }
    }
  }
});

test('FIND author_connected returns the responder’s live authenticated identity profiles', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const signalling = await startSignallingServer();
  let browserInstance: Browser | undefined;
  const contexts: BrowserContext[] = [];
  const diagnostics: BrowserDiagnostics[] = [];
  const peers: Peer[] = [];
  try {
    browserInstance = await chromium.launch({ args: ['--ignore-certificate-errors'] });
    const create = async (label: string) => {
      const context = await browserInstance!.newContext({ ignoreHTTPSErrors: true });
      contexts.push(context);
      const peerDiagnostics: BrowserDiagnostics = { label, consoleErrors: [], pageErrors: [] };
      diagnostics.push(peerDiagnostics);
      const peer = await createPeer(context, label, signalling.endpoint, peerDiagnostics);
      peers.push(peer);
      return peer;
    };
    const createdPeers = await Promise.all(['peer-1', 'peer-2', 'peer-3', 'peer-4'].map(create));
    const [requester, responder, relay, candidate] = [...createdPeers]
      .sort((left, right) => left.identityId.localeCompare(right.identityId));

    await waitForPeerConnection(responder, relay);
    await waitForAuthenticatedConnection(responder, relay);
    await waitForPeerConnection(responder, candidate);
    await waitForAuthenticatedConnection(responder, candidate);

    const relayCandidateState = await readPeerState(relay.page);
    if (relayCandidateState.connectedPeers.includes(candidate.identityId)) {
      await relay.page.evaluate((peerId) => {
        const api = window.__MYCELIUM_E2E__;
        if (!api) throw new Error('Development-only Mycelium test API is unavailable');
        api.disconnectPeer(peerId);
      }, candidate.identityId);
      await expect.poll(async () => (await readPeerState(relay.page)).connectedPeers, {
        timeout: 15_000
      }).not.toContain(candidate.identityId);
    }

    await waitForPeerConnection(requester, relay);
    await waitForAuthenticatedConnection(requester, relay);

    const relayProfiles = await relay.page.evaluate(async () => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      return api.identityProfiles();
    });
    const relayProfile = relayProfiles.find((profile) => profile.peerId === relay.identityId);
    expect(relayProfile).toBeTruthy();
    const candidateProfile = await candidate.page.evaluate(async (peerId) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      return (await api.identityProfiles()).find((profile) => profile.peerId === peerId) ?? null;
    }, candidate.identityId);
    expect(candidateProfile).toBeTruthy();
    const requesterProfile = await requester.page.evaluate(async (peerId) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      return (await api.identityProfiles()).find((profile) => profile.peerId === peerId) ?? null;
    }, requester.identityId);
    expect(requesterProfile).toBeTruthy();
    const responderProfile = await responder.page.evaluate(async (peerId) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      return (await api.identityProfiles()).find((profile) => profile.peerId === peerId) ?? null;
    }, responder.identityId);
    expect(responderProfile).toBeTruthy();

    const connectedPostContent = 'connected-author generic FIND post';
    const disconnectedPostContent = 'disconnected-author generic FIND post';
    const requesterPostId = await requester.page.evaluate(
      (content) => window.__MYCELIUM_E2E__?.createLocalTestPost(content) ?? Promise.reject(new Error('Test API unavailable')),
      connectedPostContent
    );
    await requester.page.evaluate(async ({ objectId, peerId }) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      await api.sendObject(objectId, peerId);
    }, { objectId: requesterPostId, peerId: relay.identityId });
    await expect.poll(async () => relay.page.evaluate(
      (content) => window.__MYCELIUM_E2E__?.objectIdForPost(content) ?? null,
      connectedPostContent
    ), { timeout: 15_000 }).toBe(requesterPostId);
    const responderPostId = await responder.page.evaluate(
      (content) => window.__MYCELIUM_E2E__?.createLocalTestPost(content) ?? Promise.reject(new Error('Test API unavailable')),
      'authenticated responder generic FIND post'
    );
    await responder.page.evaluate(async ({ objectId, peerId }) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      await api.sendObject(objectId, peerId);
    }, { objectId: responderPostId, peerId: relay.identityId });
    await expect.poll(async () => relay.page.evaluate(
      (content) => window.__MYCELIUM_E2E__?.objectIdForPost(content) ?? null,
      'authenticated responder generic FIND post'
    ), { timeout: 15_000 }).toBe(responderPostId);
    const candidatePostId = await candidate.page.evaluate(
      (content) => window.__MYCELIUM_E2E__?.createLocalTestPost(content) ?? Promise.reject(new Error('Test API unavailable')),
      disconnectedPostContent
    );
    await candidate.page.evaluate(async ({ objectId, peerId }) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      await api.sendObject(objectId, peerId);
    }, { objectId: candidatePostId, peerId: responder.identityId });
    await expect.poll(async () => responder.page.evaluate(
      (content) => window.__MYCELIUM_E2E__?.objectIdForPost(content) ?? null,
      disconnectedPostContent
    ), { timeout: 15_000 }).toBe(candidatePostId);
    await responder.page.evaluate(async ({ objectId, peerId }) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      await api.sendObject(objectId, peerId);
    }, { objectId: candidatePostId, peerId: relay.identityId });
    await expect.poll(async () => relay.page.evaluate(
      (content) => window.__MYCELIUM_E2E__?.objectIdForPost(content) ?? null,
      disconnectedPostContent
    ), { timeout: 15_000 }).toBe(candidatePostId);
    await relay.page.evaluate((peerId) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      api.disconnectPeer(peerId);
    }, candidate.identityId);
    await expect.poll(async () => (await readPeerState(relay.page)).connectedPeers, {
      timeout: 15_000
    }).not.toContain(candidate.identityId);

    const connectedPostAuthors = await requester.page.evaluate(async ({ peerId }) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      return api.findObjectsByQuery(peerId, 'mycelium.post', true, 0);
    }, { peerId: relay.identityId });
    expect(connectedPostAuthors.authors).toContain(requesterProfile!.author);
    expect(connectedPostAuthors.authors).toContain(responderProfile!.author);
    expect(connectedPostAuthors.authors).not.toContain(candidateProfile!.author);
    const disconnectedPostAuthors = await requester.page.evaluate(async ({ peerId }) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      return api.findObjectsByQuery(peerId, 'mycelium.post', false, 0);
    }, { peerId: relay.identityId });
    expect(disconnectedPostAuthors.authors).toContain(candidateProfile!.author);
    expect(disconnectedPostAuthors.authors).not.toContain(requesterProfile!.author);
    expect(disconnectedPostAuthors.authors).not.toContain(responderProfile!.author);
    const ordinaryPostAuthors = await requester.page.evaluate(async ({ peerId }) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      return api.findObjectsByQuery(peerId, 'mycelium.post', undefined, 0);
    }, { peerId: relay.identityId });
    expect(ordinaryPostAuthors.authors).toContain(requesterProfile!.author);
    expect(ordinaryPostAuthors.authors).toContain(responderProfile!.author);
    expect(ordinaryPostAuthors.authors).toContain(candidateProfile!.author);

    await expect.poll(async () => {
      const profiles = await responder.page.evaluate(async () => {
        const api = window.__MYCELIUM_E2E__;
        if (!api) throw new Error('Development-only Mycelium test API is unavailable');
        return api.identityProfiles();
      });
      return profiles.map((profile) => profile.peerId);
    }, {
      timeout: 20_000,
      message: `Responder did not store both connected identity profiles; logs: ${(await readPeerState(responder.page)).logs.slice(-30).join('\n')}`
    }).toEqual(expect.arrayContaining([relay.identityId, candidate.identityId]));

    const trueResult = await requester.page.evaluate(async ({ peerId }) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      return api.findIdentityProfiles(peerId, true, 1);
    }, { peerId: relay.identityId });
    expect(trueResult.responderPeerId).toBe(relay.identityId);
    expect(trueResult.authors).toContain(relayProfile!.author);
    expect(trueResult.authors).toContain(candidateProfile!.author);

    await expect.poll(async () => {
      const profiles = await relay.page.evaluate(async () => {
        const api = window.__MYCELIUM_E2E__;
        if (!api) throw new Error('Development-only Mycelium test API is unavailable');
        return api.identityProfiles();
      });
      return profiles.map((profile) => profile.peerId);
    }, { timeout: 20_000 }).toContain(requester.identityId);
    const requesterBeforeRedial = await readPeerState(requester.page);
    if (requesterBeforeRedial.connectedPeers.includes(candidate.identityId)) {
      await requester.page.evaluate((peerId) => {
        const api = window.__MYCELIUM_E2E__;
        if (!api) throw new Error('Development-only Mycelium test API is unavailable');
        api.disconnectPeer(peerId);
      }, candidate.identityId);
      await expect.poll(async () => (await readPeerState(requester.page)).connectedPeers, {
        timeout: 15_000
      }).not.toContain(candidate.identityId);
    }
    const discoveryResult = await requester.page.evaluate(async () => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      return api.discoverConnectedPeerProfiles();
    });
    expect(discoveryResult.discoveredPeerIds).toContain(candidate.identityId);
    expect([
      ...discoveryResult.connectedPeerIds,
      ...discoveryResult.activeAttemptPeerIds
    ]).toContain(candidate.identityId);
    const requesterState = await readPeerState(requester.page);
    expect(requesterState.followingPeerIds).not.toContain(responder.identityId);
    expect(requesterState.followingPeerIds).not.toContain(candidate.identityId);
    expect(requesterState.contacts.every((contact) => !contact.followed && !contact.follower)).toBe(true);

    await relay.page.evaluate(async ({ objectId, peerId }) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      await api.sendObject(objectId, peerId);
    }, { objectId: requesterProfile!.objectId, peerId: responder.identityId });
    await expect.poll(async () => {
      const profiles = await responder.page.evaluate(async () => {
        const api = window.__MYCELIUM_E2E__;
        if (!api) throw new Error('Development-only Mycelium test API is unavailable');
        return api.identityProfiles();
      });
      return profiles.map((profile) => profile.peerId);
    }, {
      timeout: 15_000
    }).toContain(requester.identityId);

    const responderState = await readPeerState(responder.page);
    if (responderState.connectedPeers.includes(requester.identityId)) {
      await responder.page.evaluate((peerId) => {
        const api = window.__MYCELIUM_E2E__;
        if (!api) throw new Error('Development-only Mycelium test API is unavailable');
        api.disconnectPeer(peerId);
      }, requester.identityId);
      await expect.poll(async () => (await readPeerState(responder.page)).connectedPeers, {
        timeout: 15_000
      }).not.toContain(requester.identityId);
    }

    const falseResult = await relay.page.evaluate(async ({ peerId }) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      return api.findIdentityProfiles(peerId, false, 0);
    }, { peerId: responder.identityId });
    expect(falseResult.responderPeerId).toBe(responder.identityId);
    expect(falseResult.authors).not.toContain(relayProfile!.author);
    expect(falseResult.authors).not.toContain(candidateProfile!.author);
    expect(falseResult.authors).toContain(requesterProfile!.author);

    const ordinaryResult = await relay.page.evaluate(async ({ peerId }) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      return api.findIdentityProfiles(peerId, undefined, 0);
    }, { peerId: responder.identityId });
    expect(ordinaryResult.authors).toContain(relayProfile!.author);
    expect(ordinaryResult.authors).toContain(candidateProfile!.author);
    expect(ordinaryResult.authors).toContain(requesterProfile!.author);

    await Promise.all([responder, relay, requester].map((peer) => peer.page.evaluate((peerId) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      api.disconnectPeer(peerId);
    }, candidate.identityId)));
    await candidate.context.close();
    await Promise.all([responder, relay, requester].map((peer) => expect.poll(
      async () => (await readPeerState(peer.page)).connectedPeers,
      {
        timeout: 15_000,
        message: `${peer.label} did not observe candidate disconnect`
      }
    ).not.toContain(candidate.identityId)));

    const afterDisconnect = await relay.page.evaluate(async ({ peerId }) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      return api.findIdentityProfiles(peerId, true, 0);
    }, { peerId: responder.identityId });
    expect(afterDisconnect.responderPeerId).toBe(responder.identityId);
    expect(afterDisconnect.authors).toContain(relayProfile!.author);
    expect(afterDisconnect.authors).not.toContain(candidateProfile!.author);

    const requesterAfterDisconnect = await requester.page.evaluate(async ({ peerId }) => {
      const api = window.__MYCELIUM_E2E__;
      if (!api) throw new Error('Development-only Mycelium test API is unavailable');
      return api.findIdentityProfiles(peerId, true, 1);
    }, { peerId: relay.identityId });
    expect(requesterAfterDisconnect.authors).toContain(relayProfile!.author);
    expect(requesterAfterDisconnect.authors).not.toContain(candidateProfile!.author);

    for (const peerDiagnostics of diagnostics) {
      expect(peerDiagnostics.pageErrors, `${peerDiagnostics.label} uncaught browser errors`).toEqual([]);
    }
    const report = {
      topology: {
        requester: requester.identityId,
        responder: responder.identityId,
        relay: relay.identityId,
        candidate: candidate.identityId
      },
      trueResult,
      falseResult,
      ordinaryResult,
      afterDisconnect,
      requesterAfterDisconnect,
      requesterState: await readPeerState(requester.page),
      diagnostics
    };
    await testInfo.attach('author-connected-discovery', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json'
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    try {
      await Promise.all(contexts.map((context) => context.close()));
    } finally {
      try {
        await browserInstance?.close();
      } finally {
        await signalling.stop();
      }
    }
  }
});
