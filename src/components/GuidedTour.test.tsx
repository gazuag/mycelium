// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuidedTour } from './GuidedTour';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

describe('GuidedTour', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    document.querySelectorAll('[data-tour-target]').forEach((element) => element.remove());
    root = undefined;
    container = undefined;
  });

  async function renderTour(onExit = vi.fn(), onFinish = vi.fn(), onSkip = vi.fn()) {
    const home = document.createElement('button');
    home.dataset.tourTarget = 'home';
    home.textContent = 'Home';
    document.body.append(home);
    Object.defineProperty(home, 'getClientRects', { value: () => [new DOMRect(10, 10, 80, 40)] });
    vi.spyOn(home, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 80, 40));

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<GuidedTour onExit={onExit} onSkip={onSkip} onFinish={onFinish} />));
    const dialog = document.body.querySelector<HTMLElement>('.guided-tour-dialog');
    if (!dialog) throw new Error('Guided tour dialog was not rendered.');
    return { dialog, onExit, onFinish, onSkip };
  }

  it('shows progress, highlights the current area, and supports Back and Next', async () => {
    const { dialog } = await renderTour();
    expect(dialog.textContent).toContain('Step 1 of 6');
    expect(document.body.querySelector('.guided-tour-spotlight')).not.toBeNull();

    const next = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Next');
    await act(async () => next?.click());
    expect(dialog.textContent).toContain('Messages');
    expect(dialog.textContent).toContain('unread notifications for messages and replies');
    expect(dialog.textContent).toContain('Notification preferences, including followed-post updates, are in Settings.');
    expect(dialog.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('2');

    const back = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Back');
    await act(async () => back?.click());
    expect(dialog.textContent).toContain('Step 1 of 6');
  });

  it('can be skipped or exited with Escape', async () => {
    const { dialog, onExit, onSkip } = await renderTour();
    const skip = dialog.querySelector<HTMLButtonElement>('.guided-tour-skip');
    await act(async () => skip?.click());
    expect(onSkip).toHaveBeenCalledOnce();
    expect(onExit).not.toHaveBeenCalled();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('visits the six destinations in order and finishes after Help', async () => {
    const { dialog, onExit, onFinish } = await renderTour();
    const titles = ['Home and your feed', 'Messages', 'Discover', 'Profile', 'Settings', 'Help centre'];
    for (let index = 0; index < titles.length; index += 1) {
      expect(dialog.querySelector('h2')?.textContent).toBe(titles[index]);
      if (titles[index] === 'Settings') {
        expect(dialog.textContent).toContain('Configure feed, publishing, and notification preferences');
        expect(dialog.textContent).toContain('inspect connection and synchronization diagnostics');
      }
      if (index === titles.length - 1) break;
      const next = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Next');
      await act(async () => next?.click());
    }

    expect(dialog.textContent).toContain('Step 6 of 6');
    expect(dialog.querySelector('[role="progressbar"]')?.getAttribute('aria-valuemax')).toBe('6');
    const finish = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === "Let's go!");
    await act(async () => finish?.click());
    expect(onFinish).toHaveBeenCalledOnce();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('shows a usable fallback when the target is not visible', async () => {
    const { dialog } = await renderTour();
    const next = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Next');
    await act(async () => next?.click());
    expect(dialog.textContent).toContain('This control is not visible here');
    expect(document.body.querySelector('.guided-tour-spotlight')).toBeNull();
  });
});
