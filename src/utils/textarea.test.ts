// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { resizeTextareaToRows } from './textarea';

describe('resizeTextareaToRows', () => {
  it('grows with content and caps the height at the configured number of lines', () => {
    const textarea = document.createElement('textarea');
    textarea.style.lineHeight = '20px';
    textarea.style.paddingTop = '2px';
    textarea.style.paddingBottom = '2px';
    textarea.style.borderTopWidth = '1px';
    textarea.style.borderBottomWidth = '1px';
    let scrollHeight = 40;
    Object.defineProperty(textarea, 'scrollHeight', { get: () => scrollHeight });

    resizeTextareaToRows(textarea, 10);
    expect(textarea.style.height).toBe('42px');
    expect(textarea.style.overflowY).toBe('hidden');

    scrollHeight = 300;
    resizeTextareaToRows(textarea, 10);
    expect(textarea.style.height).toBe('206px');
    expect(textarea.style.overflowY).toBe('auto');
  });
});
