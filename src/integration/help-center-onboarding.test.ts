import { expect, test } from '@playwright/test';

test('welcome can start and skip the tour, Help can replay it, and stays responsive', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'Welcome! Pick your name!' });
  await expect(welcome).toBeVisible();
  const welcomeHandle = welcome.locator('.welcome-wizard-handle strong');
  await welcomeHandle.evaluate((element) => {
    element.textContent = `@${'VeryLongUnbrokenHandle'.repeat(12)}`;
  });
  const handleLayout = await welcomeHandle.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowWrap: getComputedStyle(element).overflowWrap
  }));
  expect(handleLayout.overflowWrap).toBe('anywhere');
  expect(handleLayout.scrollWidth).toBeLessThanOrEqual(handleLayout.clientWidth);
  const longDisplayName = 'UnbrokenDisplayName'.repeat(12);
  await welcome.getByRole('textbox', { name: 'Display name' }).fill(longDisplayName);
  const displayNameLayout = await welcome.getByRole('textbox', { name: 'Display name' }).evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    dialogWidth: element.closest('.welcome-wizard-dialog')?.getBoundingClientRect().width ?? 0
  }));
  expect(displayNameLayout.width).toBeLessThan(displayNameLayout.dialogWidth);
  await welcome.getByRole('button', { name: 'Show me around' }).click();

  const tour = page.getByRole('dialog', { name: 'Home and your feed' });
  await expect(tour).toBeVisible();
  await expect(page.locator('.guided-tour-spotlight')).toBeVisible();
  await tour.getByRole('button', { name: 'Next' }).click();
  const messagesTour = page.getByRole('dialog', { name: 'Messages' });
  await expect(messagesTour).toContainText('unread notifications for messages and replies');
  await expect(messagesTour).toContainText('Notification preferences, including followed-post updates, are in Settings');
  await messagesTour.getByRole('button', { name: 'Skip tour' }).click();
  const welcomeSuggestions = page.getByRole('dialog', { name: 'Mycelium is best with others.' });
  await expect(welcomeSuggestions).toBeVisible();
  await welcomeSuggestions.getByRole('button', { name: 'Continue to Mycelium' }).click();
  await expect(welcomeSuggestions).toHaveCount(0);
  await expect(page.locator('.guided-tour-dialog')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('myceliumWelcomeOnboardingStatus'))).toBe('completed');

  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Mycelium is best with others.' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Open Help centre' }).click();
  const help = page.getByRole('dialog', { name: 'How can we help?' });
  await expect(help).toBeVisible();
  await help.getByRole('searchbox', { name: 'Search help articles' }).fill('restore');
  await help.getByRole('button', { name: 'Restore an identity from a backup' }).click();
  await expect(help.locator('.help-center-article')).toContainText('does not restore posts, direct messages');
  await help.getByRole('button', { name: 'Start guided tour' }).click();
  await page.locator('.guided-tour-dialog').getByRole('button', { name: 'Skip tour' }).click();
  await expect(page.locator('.guided-tour-dialog')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Mycelium is best with others.' })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open Help centre' }).click();
  const replayHelp = page.getByRole('dialog', { name: 'How can we help?' });
  await replayHelp.getByRole('button', { name: 'Start guided tour' }).click();
  const tourDialog = page.locator('.guided-tour-dialog');
  await expect(tourDialog).toContainText('Step 1 of 6');
  const bounds = await tourDialog.boundingBox();
  expect(bounds?.width).toBeLessThanOrEqual(390);
  expect(bounds?.height).toBeLessThanOrEqual(844);
  const mobileSpotlight = page.locator('.guided-tour-spotlight');
  await expect(mobileSpotlight).toBeVisible();
  const spotlightBounds = await mobileSpotlight.boundingBox();
  expect(spotlightBounds?.x).toBeGreaterThanOrEqual(0);
  expect((spotlightBounds?.x ?? 0) + (spotlightBounds?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(spotlightBounds?.y).toBeGreaterThanOrEqual(0);
  expect((spotlightBounds?.y ?? 0) + (spotlightBounds?.height ?? 0)).toBeLessThanOrEqual(844);
  await tourDialog.getByRole('button', { name: 'Skip tour' }).click();
  await expect(tourDialog).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Mycelium is best with others.' })).toHaveCount(0);
});

test('completing the welcome tour opens optional popular-post onboarding', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('dialog', { name: 'Welcome! Pick your name!' })
    .getByRole('button', { name: 'Show me around' }).click();

  const tour = page.locator('.guided-tour-dialog');
  for (let index = 0; index < 5; index += 1) {
    await tour.getByRole('button', { name: 'Next' }).click();
  }
  await tour.getByRole('button', { name: 'Finish' }).click();

  const onboarding = page.getByRole('dialog', { name: 'Mycelium is best with others.' });
  await expect(onboarding).toBeVisible();
  const onboardingBounds = await onboarding.boundingBox();
  expect(onboardingBounds?.width).toBeLessThanOrEqual(390);
  expect(onboardingBounds?.height).toBeLessThanOrEqual(844);
  await expect(onboarding.getByRole('button', { name: 'Continue to Mycelium' })).toBeVisible();
  await onboarding.getByRole('button', { name: 'Continue to Mycelium' }).click();
  await expect(onboarding).toHaveCount(0);
  await expect(page.locator('.app-shell')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Welcome! Pick your name!' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Mycelium is best with others.' })).toHaveCount(0);
});

test('choosing to explore independently opens Home and completed welcome stays dismissed', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'Welcome! Pick your name!' });
  await expect(welcome).toBeVisible();
  await welcome.getByRole('textbox', { name: 'Display name' }).fill('Independent Explorer');
  await welcome.getByRole('button', { name: "I'll explore on my own" }).click();

  await expect(welcome).toHaveCount(0);
  await expect(page.locator('.tab-item-home')).toHaveClass(/active/);
  await expect(page.locator('.guided-tour-dialog')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('myceliumWelcomeOnboardingStatus'))).toBe('completed');

  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Welcome! Pick your name!' })).toHaveCount(0);
});
