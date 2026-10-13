import { createHash } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const SOAK_DURATION_MS = 60_000;
const POST_INTERVAL_MS = 8_000;
const POST_COUNT = 5;
const IDENTITY_PATTERN = /(?:[a-f\d]{2}:){7}[a-f\d]{2}/i;

interface FeedEntry {
  id: string;
  source: 'followed' | 'recommendation' | 'discovery' | 'unknown';
}

interface FeedSnapshot {
  entries: FeedEntry[];
  baselineCount: number;
  injectedCount: number;
  discoveryCount: number;
  orderHash: string;
}

interface InjectionPosition {
  index: number;
  previousBaseline?: string;
  nextBaseline?: string;
}

async function waitForSignalling(page: Page) {
  await expect(
    page.getByRole('button', { name: /Connected to signalling server/ })
  ).toBeVisible({ timeout: 60_000 });
  if (!(await page.getByRole('heading', { name: 'Connection status', exact: true }).count())) {
    await page.getByRole('button', { name: 'Diagnostics', exact: true }).click({ force: true });
  }
  await expect(page.getByRole('heading', { name: 'Connection status', exact: true })).toBeVisible();
  await expect(page.getByText('Signal: connected', { exact: true })).toBeVisible();
  const text = await page.locator('body').innerText();
  const identity = text.match(IDENTITY_PATTERN)?.[0];
  expect(identity, 'new peer identity fingerprint should be visible in diagnostics').toBeTruthy();
  return identity!;
}

async function goTo(page: Page, destination: 'Home' | 'People') {
  const heading = page.getByRole('heading', { name: destination, exact: true });
  if (await heading.count()) return;
  await page.getByRole('button', { name: destination, exact: true }).click({ force: true });
  await expect(heading).toBeVisible();
}

async function peerCard(page: Page, peerId: string) {
  const card = page.locator('.peer-card').filter({ hasText: peerId });
  await expect(card).toHaveCount(1, { timeout: 60_000 });
  return card;
}

async function setFollowing(page: Page, peerId: string, desired: boolean) {
  await goTo(page, 'People');
  const card = await peerCard(page, peerId);
  const followButton = card.getByRole('button', { name: /^(Follow|Unfollow)$/ });
  await expect(followButton).toBeVisible();
  const current = (await followButton.innerText()) === 'Unfollow';
  if (current !== desired) {
    await followButton.click({ force: true });
    await expect(followButton).toHaveText(desired ? 'Unfollow' : 'Follow');
  }
}

async function readFollowState(page: Page, peerId: string) {
  await goTo(page, 'People');
  const card = await peerCard(page, peerId);
  const followButton = card.getByRole('button', { name: /^(Follow|Unfollow)$/ });
  await expect(followButton).toBeVisible();
  return (await followButton.innerText()) === 'Unfollow';
}

async function readPersistedFollowState(page: Page, peerId: string) {
  return page.evaluate((targetPeerId) => new Promise<Array<{ fingerprint?: string; publicKey?: string; followed?: boolean }>>((resolve, reject) => {
    const request = indexedDB.open('mycelium_p2p');
    request.onerror = () => reject(request.error ?? new Error('Could not open local Mycelium database'));
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('contacts')) {
        database.close();
        reject(new Error('Contacts store is missing from local Mycelium database'));
        return;
      }
      const transaction = database.transaction('contacts', 'readonly');
      const contacts = transaction.objectStore('contacts').getAll();
      contacts.onerror = () => {
        database.close();
        reject(contacts.error ?? new Error('Could not read persisted contacts'));
      };
      contacts.onsuccess = () => {
        const matches = (contacts.result as Array<{ fingerprint?: string; publicKey?: string; followed?: boolean }>)
          .filter((contact) => contact.fingerprint === targetPeerId || contact.publicKey === targetPeerId);
        database.close();
        resolve(matches);
      };
    };
  }), peerId);
}

async function readFeed(page: Page): Promise<FeedSnapshot> {
  await goTo(page, 'Home');
  while (await page.getByRole('button', { name: 'Load more', exact: true }).count()) {
    await page.getByRole('button', { name: 'Load more', exact: true }).click({ force: true });
  }

  const entries = await page.locator('.feed-list .post-card').evaluateAll((cards) => cards.map((card) => {
    const content = card.querySelector('.post-content')?.textContent?.trim() ?? '';
    const debug = card.querySelector('.feed-debug-line')?.textContent ?? '';
    const source = /source=(followed|recommendation|discovery)/.exec(debug)?.[1] ?? 'unknown';
    return { id: content, source } as FeedEntry;
  }));
  const orderHash = createHash('sha256')
    .update(entries.map(({ source, id }) => `${source}:${id}`).join('\n'))
    .digest('hex')
    .slice(0, 16);
  const injectedCount = entries.filter((entry) => entry.source === 'recommendation' || entry.source === 'discovery').length;

  return {
    entries,
    baselineCount: entries.filter((entry) => entry.source === 'followed').length,
    injectedCount,
    discoveryCount: entries.filter((entry) => entry.source === 'discovery').length,
    orderHash
  };
}

function injectionPositions(snapshot: FeedSnapshot) {
  return new Map(snapshot.entries.flatMap((entry, index) => {
    if (entry.source !== 'recommendation' && entry.source !== 'discovery') return [];
    const previousBaseline = snapshot.entries.slice(0, index).reverse().find((candidate) => candidate.source === 'followed')?.id;
    const nextBaseline = snapshot.entries.slice(index + 1).find((candidate) => candidate.source === 'followed')?.id;
    return [[entry.id, { index, previousBaseline, nextBaseline }] as const];
  }));
}

function assertInjectionStability(
  previous: Map<string, InjectionPosition>,
  current: Map<string, InjectionPosition>,
  currentEntries: FeedEntry[],
  peerLabel: string
) {
  for (const [postId, before] of previous) {
    const after = current.get(postId);
    if (!after) continue;

    expect(
      after.index,
      `${peerLabel}: injected post "${postId}" moved upward in the feed`
    ).toBeGreaterThanOrEqual(before.index);

    const presentBaselineIds = new Set(currentEntries
      .filter((entry) => entry.source === 'followed')
      .map((entry) => entry.id));
    if (before.previousBaseline && before.nextBaseline
      && presentBaselineIds.has(before.previousBaseline)
      && presentBaselineIds.has(before.nextBaseline)) {
      expect(
        [after.previousBaseline, after.nextBaseline],
        `${peerLabel}: injected post "${postId}" changed baseline neighbors`
      ).toEqual([before.previousBaseline, before.nextBaseline]);
    }
  }
}

async function createPeer(context: BrowserContext, label: string) {
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Create New Identity', exact: true }).click();
  const fingerprint = await waitForSignalling(page);
  console.log(`${label}: created identity ${fingerprint}`);
  return { label, page, fingerprint };
}

async function submitPost(page: Page, content: string) {
  await goTo(page, 'Home');
  const composer = page.getByPlaceholder('Share what is happening...');
  if (!(await composer.count())) {
    await page.getByRole('button', { name: 'Write', exact: true }).click();
  }
  await composer.fill(content);
  const discoveryCheckbox = page.getByRole('checkbox', { name: 'Publish to discovery' });
  if (await discoveryCheckbox.isChecked()) await discoveryCheckbox.uncheck({ force: true });
  await page.getByRole('button', { name: 'Send', exact: true }).click({ force: true });
}

test('three peers keep followed feeds stable during a 60-second live soak', async ({ browser }) => {
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext()
  ]);

  try {
    const peers = await Promise.all(contexts.map((context, index) =>
      createPeer(context, String.fromCharCode(65 + index))
    ));
    const [peerA, peerB, peerC] = peers;
    expect(new Set(peers.map((peer) => peer.fingerprint)).size).toBe(3);

    const desiredFollows = new Map([
      [peerA.label, [peerB.fingerprint, peerC.fingerprint]],
      [peerB.label, [peerA.fingerprint, peerC.fingerprint]],
      [peerC.label, [peerA.fingerprint, peerB.fingerprint]]
    ]);
    const followsBeforeRefresh = new Map<string, Map<string, boolean>>();

    for (const peer of peers) {
      const targetIds = desiredFollows.get(peer.label)!;
      for (const targetId of targetIds) {
        await setFollowing(peer.page, targetId, true);
      }
      const state = new Map<string, boolean>();
      for (const targetId of targetIds) {
        const followed = await readFollowState(peer.page, targetId);
        const persistedRecords = await readPersistedFollowState(peer.page, targetId);
        expect(persistedRecords, `${peer.label} should have one persisted contact for ${targetId}`).toHaveLength(1);
        const persisted = Boolean(persistedRecords[0]?.followed);
        expect(
          persisted,
          `${peer.label} should persist follow state for ${targetId} before refresh`
        ).toBe(followed);
        state.set(targetId, followed);
      }
      followsBeforeRefresh.set(peer.label, state);
      console.log(`${peer.label} follows before refresh: ${JSON.stringify([...state])}`);
    }

    for (const peer of peers) {
      await peer.page.reload();
      await waitForSignalling(peer.page);
      const targetIds = desiredFollows.get(peer.label)!;
      for (const targetId of targetIds) {
        const persistedRecords = await readPersistedFollowState(peer.page, targetId);
        expect(persistedRecords, `${peer.label} should have one persisted contact for ${targetId}`).toHaveLength(1);
        const persisted = Boolean(persistedRecords[0]?.followed);
        const actual = await readFollowState(peer.page, targetId);
        const expected = followsBeforeRefresh.get(peer.label)!.get(targetId);
        console.log(`${peer.label} follow ${targetId} after refresh: ui=${actual} persisted=${persisted}`);
        expect(persisted, `${peer.label} persisted follow state for ${targetId} should survive refresh`).toBe(expected);
        expect(actual, `${peer.label} follow state for ${targetId} should persist after refresh`).toBe(expected);
      }
      await goTo(peer.page, 'Home');
    }

    const windowStart = Date.now();
    const previousPositions = new Map<string, Map<string, InjectionPosition>>();
    const homeUrls = new Map(peers.map((peer) => [peer.label, peer.page.url()]));
    let nextPostIndex = 0;
    let nextCompositionLogAt = 0;

    while (Date.now() - windowStart <= SOAK_DURATION_MS) {
      const elapsedMs = Date.now() - windowStart;
      if (nextPostIndex < POST_COUNT && elapsedMs >= nextPostIndex * POST_INTERVAL_MS) {
        const content = `home-feed-soak-${peerA.fingerprint}-${nextPostIndex + 1}`;
        await submitPost(peerA.page, content);
        for (const peer of [peerB, peerC]) {
          const postedCard = peer.page.locator('.feed-list .post-card').filter({ hasText: content });
          await expect(postedCard, `${peer.label} should receive ${content} without navigation`).toBeVisible({ timeout: 7_500 });
          expect(peer.page.url()).toBe(homeUrls.get(peer.label));
          const snapshot = await readFeed(peer.page);
          const priorPositions = previousPositions.get(peer.label) ?? new Map<string, InjectionPosition>();
          const currentPositions = injectionPositions(snapshot);
          assertInjectionStability(priorPositions, currentPositions, snapshot.entries, peer.label);
          previousPositions.set(peer.label, currentPositions);
        }
        for (const peer of peers) {
          for (const targetId of desiredFollows.get(peer.label)!) {
            expect(
              (await readPersistedFollowState(peer.page, targetId))[0]?.followed ?? false,
              `${peer.label} follow state for ${targetId} should remain set during the soak`
            ).toBe(true);
          }
        }
        nextPostIndex += 1;
      }

      const elapsedSeconds = Math.floor(nextCompositionLogAt / 1000);
      if (Date.now() - windowStart >= nextCompositionLogAt) {
        for (const peer of [peerB, peerC]) {
          const snapshot = await readFeed(peer.page);
          console.log(
            `${peer.label} t=${elapsedSeconds}s baseline=${snapshot.baselineCount} injected=${snapshot.injectedCount} discovery=${snapshot.discoveryCount} order_hash=${snapshot.orderHash}`
          );
          const priorPositions = previousPositions.get(peer.label) ?? new Map<string, InjectionPosition>();
          const currentPositions = injectionPositions(snapshot);
          assertInjectionStability(priorPositions, currentPositions, snapshot.entries, peer.label);
          previousPositions.set(peer.label, currentPositions);
        }
        nextCompositionLogAt += 10_000;
      }

      if (Date.now() - windowStart >= SOAK_DURATION_MS) break;
      const nextPostAt = nextPostIndex < POST_COUNT ? nextPostIndex * POST_INTERVAL_MS : SOAK_DURATION_MS;
      const nextEventAt = Math.min(nextPostAt, nextCompositionLogAt, SOAK_DURATION_MS);
      const waitMs = nextEventAt - (Date.now() - windowStart);
      if (waitMs > 0) await peerA.page.waitForTimeout(Math.min(waitMs, 1_000));
    }

    expect(nextPostIndex).toBe(POST_COUNT);
    for (const peer of [peerB, peerC]) {
      const snapshot = await readFeed(peer.page);
      expect(
        snapshot.entries.some((entry) => entry.id.startsWith('home-feed-soak-')),
        `${peer.label} should have live A posts in its Home feed`
      ).toBe(true);
      for (const targetId of desiredFollows.get(peer.label)!) {
        expect(await readFollowState(peer.page, targetId)).toBe(true);
      }
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
