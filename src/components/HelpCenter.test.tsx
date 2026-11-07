// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HelpCenter } from './HelpCenter';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

describe('HelpCenter', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  async function renderHelpCenter(onClose = vi.fn(), onStartTour = vi.fn()) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<HelpCenter onClose={onClose} onStartTour={onStartTour} />));
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) throw new Error('Help centre dialog was not rendered.');
    return { dialog, onClose, onStartTour };
  }

  it('opens, searches articles, and shows article details by default', async () => {
    const { dialog } = await renderHelpCenter();
    expect(dialog.textContent).toContain('How can we help?');

    const search = dialog.querySelector<HTMLInputElement>('input[type="search"]');
    if (!search) throw new Error('Help search field was not rendered.');
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(search, 'identity backup');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const backupArticle = Array.from(dialog.querySelectorAll<HTMLButtonElement>('.help-center-article-list button'))
      .find((button) => button.textContent?.includes('Back up your identity'));
    expect(backupArticle).toBeDefined();
    await act(async () => backupArticle?.click());
    expect(dialog.querySelector('h2')?.textContent).toBe('Back up your identity');
    expect(dialog.textContent).toContain('does not contain your posts, messages, or the app’s complete local data');
    expect(dialog.querySelector('summary')).toBeNull();
    expect(dialog.querySelector('.help-center-backup-warning strong')?.textContent)
      .toContain('In Settings → Identity management, export an identity backup');
    expect(dialog.querySelector('.help-center-article-details > p:not(.help-center-backup-warning) strong')).toBeNull();
  });

  it('organises articles by category and can start the tour', async () => {
    const { dialog, onStartTour } = await renderHelpCenter();
    const troubleshooting = Array.from(dialog.querySelectorAll<HTMLButtonElement>('.help-center-categories button'))
      .find((button) => button.textContent === 'Troubleshooting');
    await act(async () => troubleshooting?.click());
    expect(dialog.textContent).toContain('My feed is empty');

    const startTour = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Start guided tour');
    await act(async () => startTour?.click());
    expect(onStartTour).toHaveBeenCalledOnce();
  });

  it('closes from the button and Escape key', async () => {
    const { dialog, onClose } = await renderHelpCenter();
    const closeButton = dialog.querySelector<HTMLButtonElement>('button[aria-label="Close Help centre"]');
    await act(async () => closeButton?.click());
    expect(onClose).toHaveBeenCalledOnce();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
