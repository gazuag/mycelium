// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownComposer } from './MarkdownComposer';
import { MarkdownContent } from './MarkdownContent';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <MarkdownComposer value={value} onChange={setValue} />;
}

describe('MarkdownComposer', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  const mount = async (initial = '') => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness initial={initial} />));
    return container;
  };

  const button = (label: string) => {
    const target = label === 'Preview'
      ? container?.querySelector<HTMLButtonElement>('.markdown-preview-toggle')
      : container?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"], button[title="${label}"]`);
    if (!target) throw new Error(`Missing toolbar button: ${label}`);
    return target;
  };

  const select = (textarea: HTMLTextAreaElement, start: number, end: number) => {
    textarea.focus();
    textarea.setSelectionRange(start, end);
    textarea.dispatchEvent(new Event('select', { bubbles: true }));
  };

  const setInputValue = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const setTextareaValue = (textarea: HTMLTextAreaElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  };

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ['Bold', '**', 2],
    ['Italic', '*', 1],
    ['Underline', '__', 2]
  ])('wraps selected text with %s and restores the caret', async (label, marker, offset) => {
    await mount('before text after');
    const textarea = container!.querySelector('textarea')!;
    select(textarea, 7, 11);
    await act(async () => button(label).click());

    expect(textarea.value).toBe(`before ${marker}text${marker} after`);
    expect(textarea.selectionStart).toBe(7 + marker.length + 4 + marker.length);
    expect(textarea.selectionEnd).toBe(textarea.selectionStart);
    expect(offset).toBe(marker.length);
  });

  it.each([
    ['Bold', '****', 2],
    ['Italic', '**', 1],
    ['Underline', '____', 2]
  ])('inserts the %s template at the cursor when there is no selection', async (label, template, cursor) => {
    await mount('start end');
    const textarea = container!.querySelector('textarea')!;
    select(textarea, 5, 5);
    await act(async () => button(label).click());

    expect(textarea.value).toBe(`start${template} end`);
    expect(textarea.selectionStart).toBe(5 + cursor);
  });

  it('quotes selected multiline text without changing surrounding text or trailing newlines', async () => {
    await mount('before\nfirst\nsecond\nafter');
    const textarea = container!.querySelector('textarea')!;
    select(textarea, 7, 20);
    await act(async () => button('Blockquote').click());

    expect(textarea.value).toBe('before\n> first\n> second\nafter');
    expect(textarea.selectionStart).toBe(23);
  });

  it('quotes the full selected line when only part of a line is selected', async () => {
    await mount('before\nfirst line\nnext line');
    const textarea = container!.querySelector('textarea')!;
    select(textarea, 7, 12);
    await act(async () => button('Blockquote').click());

    expect(textarea.value).toBe('before\n> first line\nnext line');
    expect(textarea.selectionStart).toBe(19);
  });

  it('inserts selected link text and lets the user enter its URL', async () => {
    await mount('Visit Example now');
    const textarea = container!.querySelector('textarea')!;
    select(textarea, 6, 13);
    await act(async () => button('Insert link').click());

    const url = container!.querySelector<HTMLInputElement>('form[aria-label="Insert link"] input[inputmode="url"]')!;
    await act(async () => {
      setInputValue(url, 'https://example.com');
      container!.querySelector<HTMLButtonElement>('form[aria-label="Insert link"] button[type="submit"]')?.click();
    });

    expect(textarea.value).toBe('Visit [Example](https://example.com) now');
    expect(textarea.selectionStart).toBe(textarea.value.indexOf('https://example.com') + 'https://example.com'.length);
    expect(document.activeElement).toBe(textarea);
  });

  it('inserts an image template through the image description and URL form', async () => {
    await mount('Draft');
    const textarea = container!.querySelector('textarea')!;
    select(textarea, 5, 5);
    await act(async () => button('Insert image').click());

    const form = container!.querySelector<HTMLFormElement>('form[aria-label="Insert image"]')!;
    const fields = form.querySelectorAll<HTMLInputElement>('input');
    await act(async () => {
      setInputValue(fields[0], 'A view');
      setInputValue(fields[1], 'https://example.com/image.jpg');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(textarea.value).toBe('Draft![A view](https://example.com/image.jpg)');
  });

  it('toggles a live safe preview without losing the draft or navigating links', async () => {
    await mount('**Draft** [site](https://example.com) ![image](https://example.com/image.png)');
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const textarea = container!.querySelector('textarea')!;
    select(textarea, 2, 2);
    await act(async () => button('Preview').click());

    expect(container!.querySelector('.markdown-composer-preview strong')?.textContent).toBe('Draft');
    expect(container!.querySelector('.markdown-preview-link')?.textContent).toBe('site');
    expect(container!.querySelector('.markdown-composer-preview a')).toBeNull();
    expect(container!.querySelector('.markdown-image-placeholder')?.textContent).toContain('Size unknown · Tap to load');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(textarea.value).toContain('**Draft**');
    expect(textarea.selectionStart).toBe(2);

    await act(async () => button('Preview').click());
    expect(container!.querySelector('.markdown-composer-preview')).toBeNull();
    expect(textarea.value).toContain('https://example.com/image.png');
  });

  it('updates preview while typing and uses the published Markdown renderer', async () => {
    await mount('draft');
    const textarea = container!.querySelector('textarea')!;
    await act(async () => button('Preview').click());

    await act(async () => setTextareaValue(textarea, '**Live update**'));

    const preview = container!.querySelector('.markdown-composer-preview .markdown-content')!;
    const published = renderToStaticMarkup(<MarkdownContent source="**Live update**" />)
      .replace(/^<div class="markdown-content">/, '')
      .replace(/<\/div>$/, '');
    expect(preview.innerHTML).toBe(published);
    expect(preview.querySelector('strong')?.textContent).toBe('Live update');
  });
});
