import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const ROOT = process.cwd();

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local signalling port');
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const waitForExit = (timeoutMs: number) => new Promise<boolean>((resolveExit) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once('exit', onExit);
  });
  const stopped = waitForExit(5_000);
  child.kill('SIGTERM');
  if (await stopped) return;
  const killed = waitForExit(5_000);
  child.kill('SIGKILL');
  await killed;
}

function appendOutput(current: string, value: Buffer): string {
  return `${current}${value.toString()}`.slice(-64_000);
}

async function waitForOutput(
  readOutput: () => string,
  expected: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readOutput().includes(expected)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for "${expected}". Output:\n${readOutput()}`);
}

async function waitForLocalSocket(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolveConnect, reject) => {
        const socket = createConnection(port, '127.0.0.1');
        socket.once('connect', () => {
          socket.destroy();
          resolveConnect();
        });
        socket.once('error', reject);
      });
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error('Local signalling server did not start');
}

async function state(page: Page) {
  return page.evaluate(() => window.__MYCELIUM_E2E__?.state() ?? null);
}

test('browser and Python bot resolve a queued simultaneous offer to one usable connection', async ({ browser, baseURL }, testInfo) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'mycelium-browser-python-'));
  let signalServer: ChildProcess | undefined;
  let bot: ChildProcess | undefined;
  let context: BrowserContext | undefined;

  try {
    const port = await findFreePort();
    const certificatePath = join(temporaryDirectory, 'server.crt');
    const privateKeyPath = join(temporaryDirectory, 'server.key');
    const databasePath = join(temporaryDirectory, 'discovery.sqlite');
    const certificate = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', privateKeyPath,
      '-out', certificatePath,
      '-days', '1',
      '-subj', '/CN=localhost'
    ], { cwd: ROOT, encoding: 'utf8' });
    if (certificate.status !== 0) {
      throw new Error(`Could not create temporary signalling TLS certificate:\n${certificate.stderr}`);
    }

    const projectPython = resolve(ROOT, '.venv/bin/python');
    const python = process.env.MYCELIUM_PYTHON ?? (existsSync(projectPython) ? projectPython : 'python3');
    const startedServer = spawn(python, [resolve(ROOT, 'server.py')], {
      cwd: ROOT,
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
    signalServer = startedServer;
    if (!startedServer.stdout || !startedServer.stderr) {
      throw new Error('Local signalling server process did not expose output streams');
    }
    let signalOutput = '';
    startedServer.stdout.on('data', (data: Buffer) => { signalOutput = appendOutput(signalOutput, data); });
    startedServer.stderr.on('data', (data: Buffer) => { signalOutput = appendOutput(signalOutput, data); });

    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const signalUrl = `wss://localhost:${port}`;
    await waitForLocalSocket(port);
    await page.addInitScript((url) => {
      Object.assign(globalThis, { VITE_SIGNAL_SERVER_URL: url });
    }, signalUrl);
    await page.goto(baseURL ?? 'http://127.0.0.1:8080');
    await page.waitForFunction(() => {
      const current = window.__MYCELIUM_E2E__?.state();
      return current?.signallingStatus === 'connected' && Boolean(current.identityId);
    });

    const browserId = (await state(page))?.identityId;
    if (!browserId) throw new Error('Browser identity was not initialized');
    const dataDirectory = join(temporaryDirectory, 'bot-data');
    const prepared = spawnSync(python, [
      resolve(ROOT, 'tests/browser_python_peer.py'),
      '--prepare',
      '--data-dir', dataDirectory,
      '--browser-id', browserId
    ], { cwd: ROOT, encoding: 'utf8' });
    if (prepared.status !== 0) {
      throw new Error(`Could not prepare Python peer identity:\n${prepared.stderr}`);
    }
    const botId = prepared.stdout.trim();
    expect(botId).toMatch(/^([0-9a-f]{2}:){7}[0-9a-f]{2}$/);
    expect(botId.localeCompare(browserId)).toBeLessThan(0);

    await page.evaluate((peerId) => window.__MYCELIUM_E2E__?.connectPeer(peerId), botId);
    await waitForOutput(() => signalOutput, `Queued signal for ${botId}`, 15_000);

    const startedBot = spawn(python, [
      resolve(ROOT, 'tests/browser_python_peer.py'),
      '--data-dir', dataDirectory,
      '--browser-id', browserId,
      '--signal-url', signalUrl
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        SSL_CERT_FILE: certificatePath,
        MYCELIUM_ICE_SERVERS: '[]',
        PYTHONUNBUFFERED: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    bot = startedBot;
    if (!startedBot.stdout || !startedBot.stderr) {
      throw new Error('Python bot process did not expose output streams');
    }
    let botOutput = '';
    startedBot.stdout.on('data', (data: Buffer) => { botOutput = appendOutput(botOutput, data); });
    startedBot.stderr.on('data', (data: Buffer) => { botOutput = appendOutput(botOutput, data); });

    await expect.poll(async () => (await state(page))?.connectedPeers.includes(botId) ?? false, {
      timeout: 45_000
    }).toBe(true);
    await expect.poll(async () => (await state(page))?.logs.join('\n') ?? '', {
      timeout: 15_000
    }).toContain('glare collision: polite peer rolling back local negotiationId=');
    await waitForOutput(
      () => botOutput,
      `Ignoring colliding offer from ${browserId}: local peer is the elected initiator`,
      15_000
    );
    await expect.poll(async () => (await state(page))?.logs.join('\n') ?? '', {
      timeout: 15_000
    }).toContain(`Received authenticated connection metadata from ${botId}`);
    expect((await state(page))?.connectedPeers.filter((peerId) => peerId === botId)).toHaveLength(1);
    await testInfo.attach('python-bot-log', { body: botOutput, contentType: 'text/plain' });
  } finally {
    await context?.close();
    if (bot) await stopChild(bot);
    if (signalServer) await stopChild(signalServer);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
