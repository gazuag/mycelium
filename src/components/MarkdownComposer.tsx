import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, MouseEvent } from 'react';
import { MarkdownContent } from './MarkdownContent';

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

type FormatAction = 'bold' | 'italic' | 'underline' | 'quote';
type LinkKind = 'link' | 'image';

interface MarkdownComposerProps {
  value: string;
  onChange: (value: string, caretPosition?: number) => void;
  textareaRef?: (element: HTMLTextAreaElement | null) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  autoComplete?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onClick?: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onKeyUp?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

export function MarkdownComposer({
  value,
  onChange,
  textareaRef,
  placeholder,
  ariaLabel,
  disabled,
  autoComplete,
  onKeyDown,
  onClick,
  onKeyUp
}: MarkdownComposerProps) {
  const [textareaElement, setTextareaElement] = useState<HTMLTextAreaElement | null>(null);
  const selectionRef = useRef({ start: 0, end: 0 });
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [linkKind, setLinkKind] = useState<LinkKind | null>(null);
  const [linkText, setLinkText] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const linkTextRef = useRef<HTMLInputElement>(null);

  const setTextareaRef = useCallback((element: HTMLTextAreaElement | null) => {
    setTextareaElement(element);
    textareaRef?.(element);
  }, [textareaRef]);

  useEffect(() => {
    if (linkKind) linkTextRef.current?.focus();
  }, [linkKind]);

  useBrowserLayoutEffect(() => {
    const textarea = textareaElement;
    const selection = pendingSelectionRef.current;
    if (!textarea || !selection) return;
    textarea.focus();
    textarea.setSelectionRange(selection.start, selection.end);
    selectionRef.current = selection;
    pendingSelectionRef.current = null;
  }, [textareaElement, value]);

  const rememberSelection = (textarea: HTMLTextAreaElement) => {
    selectionRef.current = { start: textarea.selectionStart, end: textarea.selectionEnd };
  };

  const updateValue = (nextValue: string, selectionStart: number, selectionEnd = selectionStart) => {
    pendingSelectionRef.current = { start: selectionStart, end: selectionEnd };
    selectionRef.current = { start: selectionStart, end: selectionEnd };
    onChange(nextValue, selectionStart);
  };

  const applyFormat = (action: FormatAction) => {
    const textarea = textareaElement;
    const start = textarea?.selectionStart ?? selectionRef.current.start;
    const end = textarea?.selectionEnd ?? selectionRef.current.end;
    const selected = value.slice(start, end);
    if (action === 'quote') {
      if (!selected) {
        const prefix = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
        const insertion = `${prefix}> `;
        updateValue(`${value.slice(0, start)}${insertion}${value.slice(end)}`, start + insertion.length);
        return;
      }
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const lastSelectedCharacter = end - 1;
      const nextLineBreak = value.indexOf('\n', lastSelectedCharacter);
      const lineEnd = nextLineBreak === -1 ? value.length : nextLineBreak;
      const selectedLines = value.slice(lineStart, lineEnd);
      const quoted = selectedLines.split('\n').map((line) => `> ${line}`).join('\n');
      updateValue(`${value.slice(0, lineStart)}${quoted}${value.slice(lineEnd)}`, lineStart + quoted.length);
      return;
    }

    const marker = action === 'bold' ? '**' : action === 'italic' ? '*' : '__';
    const insertion = `${marker}${selected}${marker}`;
    const contentStart = start + marker.length;
    const contentEnd = contentStart + selected.length;
    updateValue(
      `${value.slice(0, start)}${insertion}${value.slice(end)}`,
      contentStart,
      selected ? contentEnd : contentStart
    );
  };

  const openLinkForm = (kind: LinkKind) => {
    const textarea = textareaElement;
    const start = textarea?.selectionStart ?? selectionRef.current.start;
    const end = textarea?.selectionEnd ?? selectionRef.current.end;
    selectionRef.current = { start, end };
    setLinkKind(kind);
    setLinkText(value.slice(start, end));
    setLinkUrl('');
  };

  const insertLink = () => {
    if (!linkKind) return;
    const { start, end } = selectionRef.current;
    const label = linkText || (linkKind === 'link' ? 'link text' : 'description');
    const destination = linkUrl || 'https://';
    const insertion = linkKind === 'link'
      ? `[${label}](${destination})`
      : `![${label}](${destination})`;
    const destinationStart = start + insertion.indexOf(destination);
    const cursor = destinationStart + destination.length;
    updateValue(`${value.slice(0, start)}${insertion}${value.slice(end)}`, cursor);
    setLinkKind(null);
  };

  const closeLinkForm = () => {
    setLinkKind(null);
    const textarea = textareaElement;
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(selectionRef.current.start, selectionRef.current.end);
    }
  };

  return (
    <div className="markdown-composer">
      <textarea
        ref={setTextareaRef}
        value={value}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
          rememberSelection(event.currentTarget);
          onChange(event.target.value, event.currentTarget.selectionStart);
        }}
        onSelect={(event) => rememberSelection(event.currentTarget)}
        onClick={(event) => {
          rememberSelection(event.currentTarget);
          onClick?.(event);
        }}
        onKeyUp={(event) => {
          rememberSelection(event.currentTarget);
          onKeyUp?.(event);
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        autoComplete={autoComplete}
      />
      <div className="markdown-composer-controls">
        <div className="markdown-toolbar" role="toolbar" aria-label="Markdown formatting">
          <button type="button" title="Bold" aria-label="Bold" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('bold')}><strong>B</strong></button>
          <button type="button" title="Italic" aria-label="Italic" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('italic')}><em>I</em></button>
          <button type="button" title="Underline" aria-label="Underline" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('underline')}><u>U</u></button>
          <button type="button" title="Blockquote" aria-label="Blockquote" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('quote')}>❝</button>
          <button type="button" title="Insert link" aria-label="Insert link" onMouseDown={(event) => event.preventDefault()} onClick={() => openLinkForm('link')}>↗</button>
          <button type="button" title="Insert image" aria-label="Insert image" onMouseDown={(event) => event.preventDefault()} onClick={() => openLinkForm('image')}>▧</button>
          <button
            className={`markdown-preview-toggle${previewOpen ? ' active' : ''}`}
            type="button"
            aria-pressed={previewOpen}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (textareaElement) rememberSelection(textareaElement);
              setPreviewOpen((open) => !open);
            }}
          >
            Preview
          </button>
        </div>
        {linkKind ? (
          <form
            className="markdown-link-form"
            aria-label={linkKind === 'link' ? 'Insert link' : 'Insert image'}
            onSubmit={(event) => {
              event.preventDefault();
              insertLink();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeLinkForm();
              }
            }}
          >
            <label>
              {linkKind === 'link' ? 'Link text' : 'Image description'}
              <input
                ref={linkTextRef}
                value={linkText}
                onChange={(event) => setLinkText(event.target.value)}
                placeholder={linkKind === 'link' ? 'Link text' : 'Description'}
              />
            </label>
            <label>
              URL
              <input
                value={linkUrl}
                onChange={(event) => setLinkUrl(event.target.value)}
                placeholder="https://"
                inputMode="url"
              />
            </label>
            <button className="btn" type="submit">Insert</button>
            <button className="btn secondary" type="button" onClick={closeLinkForm}>Cancel</button>
          </form>
        ) : null}
      </div>
      {previewOpen && value ? (
        <div className="markdown-composer-preview" aria-label="Markdown preview">
          <MarkdownContent source={value} preview />
        </div>
      ) : null}
    </div>
  );
}
