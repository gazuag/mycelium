// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { MarkdownHelp } from './MarkdownHelp';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

describe('MarkdownHelp', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it('opens a popup explaining supported Markdown and closes with Escape', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<MarkdownHelp />));

    const trigger = container.querySelector<HTMLButtonElement>('.markdown-help-link');
    expect(trigger?.textContent).toBe('Markdown formatting');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => trigger?.click());

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('**bold**');
    expect(dialog?.textContent).toContain('*italic*');
    expect(dialog?.textContent).toContain('__underline__');
    expect(dialog?.textContent).toContain('> quoted text');
    expect(dialog?.textContent).toContain('[link text](https://example.com)');
    expect(dialog?.textContent).toContain('![description](https://example.com/image.jpg)');
    expect(dialog?.textContent).toContain('Raw HTML is not supported.');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});
