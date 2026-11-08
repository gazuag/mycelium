// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirstPostOnboarding } from './FirstPostOnboarding';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

describe('FirstPostOnboarding', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  async function renderOnboarding(
    onPublish: (content: string) => Promise<void> = vi.fn(async () => {}),
    onFinish = vi.fn()
  ) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <FirstPostOnboarding
        displayName="Ada"
        handle="GeneratedHandle"
        onPublish={onPublish}
        onFinish={onFinish}
      />
    ));
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    const textarea = dialog?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Your introductory post"]');
    if (!dialog || !textarea) throw new Error('First-post onboarding editor was not rendered.');
    return { dialog, textarea, onPublish, onFinish };
  }

  function changeTextarea(textarea: HTMLTextAreaElement, value: string) {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setValue?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('starts with an editable generated post and a collapsed interests selector', async () => {
    const { dialog, textarea } = await renderOnboarding();

    expect(dialog.querySelector('h1')?.textContent).toBe('Find your people.');
    expect(dialog.querySelector('.collapsible-toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(textarea.value.split('\n\n')[0]).toContain('Ada');
    expect(textarea.value.split('\n\n')).toHaveLength(2);
    expect(dialog.textContent).toContain('public and visible to other Mycelium users');
  });

  it('updates selected interests and replaces edited text when regenerated', async () => {
    const { dialog, textarea } = await renderOnboarding();
    const interests = dialog.querySelector<HTMLButtonElement>('.collapsible-toggle');
    await act(async () => interests?.click());
    const books = Array.from(dialog.querySelectorAll<HTMLInputElement>('.first-post-interest input'))
      .find((checkbox) => checkbox.parentElement?.textContent === 'Books');
    await act(async () => books?.click());
    expect(textarea.value).toContain('Books');

    await act(async () => {
      changeTextarea(textarea, 'My own edited introduction.');
    });
    const regenerate = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Regenerate'));
    await act(async () => regenerate?.click());
    expect(textarea.value).not.toBe('My own edited introduction.');
    expect(textarea.value).toContain('Books');
    expect(textarea.value.split('\n\n')).toHaveLength(3);
  });

  it('does not replace manual edits when changing interests', async () => {
    const { dialog, textarea } = await renderOnboarding();
    const customDraft = 'I wrote this introduction myself.';
    await act(async () => {
      changeTextarea(textarea, customDraft);
    });
    await act(async () => dialog.querySelector<HTMLButtonElement>('.collapsible-toggle')?.click());
    const books = Array.from(dialog.querySelectorAll<HTMLInputElement>('.first-post-interest input'))
      .find((checkbox) => checkbox.parentElement?.textContent === 'Books');
    await act(async () => books?.click());

    expect(textarea.value).toBe(customDraft);
    expect(dialog.textContent).toContain('Regenerate to include your selected interests');
  });

  it('publishes the current draft once and confirms success', async () => {
    let resolvePublish: (() => void) | undefined;
    const onPublish = vi.fn(() => new Promise<void>((resolve) => {
      resolvePublish = resolve;
    }));
    const { dialog, textarea } = await renderOnboarding(onPublish);
    const draft = textarea.value;
    const publish = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Publish post');

    await act(async () => {
      publish?.click();
      publish?.click();
    });
    expect(onPublish).toHaveBeenCalledOnce();
    expect(onPublish).toHaveBeenCalledWith(draft);
    expect(publish?.textContent).toBe('Publishing…');

    await act(async () => resolvePublish?.());
    expect(dialog.textContent).toContain('Your post is published and visible to other Mycelium users.');
    expect(dialog.textContent).toContain('Continue to tour');
  });

  it('preserves the draft after publishing fails and allows retry', async () => {
    const onPublish = vi.fn()
      .mockRejectedValueOnce(new Error('Please reconnect and try again.'))
      .mockResolvedValueOnce(undefined);
    const { dialog, textarea } = await renderOnboarding(onPublish);
    const draft = 'My carefully edited first post.';
    await act(async () => {
      changeTextarea(textarea, draft);
    });
    const publish = () => Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Publish post');

    await act(async () => publish()?.click());
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('Please reconnect and try again.');
    expect(textarea.value).toBe(draft);

    await act(async () => publish()?.click());
    expect(onPublish).toHaveBeenCalledTimes(2);
    expect(dialog.textContent).toContain('Your post is published and visible to other Mycelium users.');
  });

  it('allows skipping without publishing', async () => {
    const onPublish = vi.fn(async () => {});
    const onFinish = vi.fn();
    const { dialog } = await renderOnboarding(onPublish, onFinish);
    const skip = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Skip for now');

    await act(async () => skip?.click());
    expect(onFinish).toHaveBeenCalledOnce();
    expect(onPublish).not.toHaveBeenCalled();
  });
});
