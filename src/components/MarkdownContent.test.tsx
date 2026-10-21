// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExternalImageLimitContext,
  MarkdownContent
} from './MarkdownContent';
import { discardCachedExternalImage } from '../markdown/external-content';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

describe('MarkdownContent', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  let objectUrlMethodsOverridden = false;
  let originalCreateObjectURL: typeof URL.createObjectURL | undefined;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (objectUrlMethodsOverridden) {
      if (originalCreateObjectURL !== undefined) {
        Object.defineProperty(URL, 'createObjectURL', { value: originalCreateObjectURL, configurable: true });
      } else {
        Reflect.deleteProperty(URL, 'createObjectURL');
      }
      if (originalRevokeObjectURL !== undefined) {
        Object.defineProperty(URL, 'revokeObjectURL', { value: originalRevokeObjectURL, configurable: true });
      } else {
        Reflect.deleteProperty(URL, 'revokeObjectURL');
      }
      objectUrlMethodsOverridden = false;
    }
  });

  it('renders paragraphs, inline formatting, newlines, and multiline blockquotes', () => {
    const markup = renderToStaticMarkup(
      <MarkdownContent source={'First line\nnext line\n\n**bold** *italic* __underlined__\n\n> quoted\n> next quote'} />
    );
    expect(markup).toContain('<p>First line<br/>next line</p>');
    expect(markup).toContain('<strong>bold</strong>');
    expect(markup).toContain('<em>italic</em>');
    expect(markup).toContain('<u>underlined</u>');
    expect(markup).toContain('<blockquote><p>quoted<br/>next quote</p></blockquote>');
  });

  it('does not interpret underscores inside identifiers, filenames, and pasted code-like text', () => {
    const markup = renderToStaticMarkup(
      <MarkdownContent source={'peer_id path/to/file_name.txt paste__literal__without_spaces __init__ object.__name__ _single_italic_ `const user_id = "__name__"`'} />
    );
    expect(markup).not.toContain('<u>');
    expect(markup).not.toContain('<strong>');
    expect(markup).not.toContain('<em>');
    expect(markup).toContain('peer_id');
    expect(markup).toContain('file_name.txt');
    expect(markup).toContain('paste__literal__without_spaces');
    expect(markup).toContain('__init__');
    expect(markup).toContain('object.__name__');
    expect(markup).toContain('_single_italic_');
  });

  it('renders explicit links and pasted URLs as interstitial-triggering links', () => {
    const markup = renderToStaticMarkup(
      <MarkdownContent source="[visible](https://example.com/path) https://example.org/auto" />
    );
    expect(markup.match(/class="markdown-external-link"/g)).toHaveLength(2);
    expect(markup).not.toContain('href="https://example.com');
    expect(markup).toContain('href="#external-link"');
  });

  it('does not render dangerous URLs or allow raw HTML to create elements or trusted controls', () => {
    const markup = renderToStaticMarkup(
      <MarkdownContent source={'[bad](javascript:alert(1))\n\n<script>alert(1)</script><button>Proceed</button>'} />
    );
    expect(markup).not.toContain('<a ');
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<button>');
    expect(markup).toContain('&lt;script&gt;');
  });

  it('shows correct placeholders for large, unknown, and disabled automatic display sizes', () => {
    const content = '![Alt text](https://images.example/picture.png)';
    const knownLarge = [{ url: 'https://images.example/picture.png', status: 'known', sizeBytes: 12_400_000 }];
    const knownSmall = [{ url: 'https://images.example/picture.png', status: 'known', sizeBytes: 1_000_000 }];
    const aboveLimit = renderToStaticMarkup(
      <ExternalImageLimitContext.Provider value={5}>
        <MarkdownContent source={content} imageSizes={knownLarge} />
      </ExternalImageLimitContext.Provider>
    );
    const unknown = renderToStaticMarkup(
      <MarkdownContent source={content} />
    );
    const disabled = renderToStaticMarkup(
      <ExternalImageLimitContext.Provider value={0}>
        <MarkdownContent source={content} imageSizes={knownSmall} />
      </ExternalImageLimitContext.Provider>
    );
    const belowLimit = renderToStaticMarkup(
      <ExternalImageLimitContext.Provider value={5}>
        <MarkdownContent source={content} imageSizes={knownSmall} />
      </ExternalImageLimitContext.Provider>
    );

    expect(aboveLimit).toContain('Image · 12.4 MB · Tap to load');
    expect(unknown).toContain('Image · Size unknown · Tap to load');
    expect(disabled).toContain('Image · 1.0 MB · Tap to load');
    expect(belowLimit).toContain('Loading external image…');
    expect(belowLimit).not.toContain('<img');
  });

  it('requires an explicit Proceed decision and shows the validated destination hostname', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const parentClick = vi.fn();
    await act(async () => {
      root?.render(
        <article onClick={parentClick}>
          <MarkdownContent source="[destination](https://example.com/actual/path?query=one)" />
        </article>
      );
    });
    expect(parentClick).not.toHaveBeenCalled();
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    await act(async () => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(document.body.textContent).toContain('You are now leaving Mycelium.');
    expect(document.body.querySelector('.external-link-hostname')?.textContent).toBe('example.com');
    expect(document.body.textContent).toContain('https://example.com/actual/path?query=one');
    expect(open).not.toHaveBeenCalled();

    const back = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Go back');
    await act(async () => back?.click());
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(open).not.toHaveBeenCalled();

    await act(async () => {
      container?.querySelector('a')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    const proceed = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Proceed');
    await act(async () => proceed?.click());
    expect(parentClick).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      'https://example.com/actual/path?query=one',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('does not fetch unknown images automatically and offers retry after an explicit CORS failure', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('CORS failure'));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root?.render(
        <ExternalImageLimitContext.Provider value={0}>
          <MarkdownContent source="![unknown](https://images.example/unknown.png)" />
        </ExternalImageLimitContext.Provider>
      );
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Size unknown · Tap to load');

    const load = container.querySelector('button');
    await act(async () => load?.click());
    expect(fetchMock).toHaveBeenCalledWith(
      'https://images.example/unknown.png',
      expect.objectContaining({ method: 'GET', mode: 'cors', credentials: 'omit' })
    );
    expect(container.textContent).toContain('Image failed · Retry');
    expect(container.textContent).toContain('CORS failure');
  });

  it('reuses explicitly loaded image bytes after closing and reopening a post view', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const createObjectURL = vi.fn(() => 'blob:cached-image');
    const revokeObjectURL = vi.fn();
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    objectUrlMethodsOverridden = true;
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    const pngSignature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(pngSignature, { headers: { 'Content-Type': 'image/png' } })
    );
    vi.stubGlobal('fetch', fetchMock);
    const source = '![picture](https://images.example/picture.png)';
    const view = (
      <ExternalImageLimitContext.Provider value={0}>
        <MarkdownContent source={source} />
      </ExternalImageLimitContext.Provider>
    );
    await act(async () => root?.render(view));
    await act(async () => {
      container?.querySelector('button')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:cached-image');

    await act(async () => root?.unmount());
    root = createRoot(container);
    await act(async () => root?.render(view));
    await act(async () => container?.querySelector('button')?.click());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:cached-image');
    await act(async () => root?.unmount());
    root = undefined;
    discardCachedExternalImage('blob:cached-image');
  });
});
