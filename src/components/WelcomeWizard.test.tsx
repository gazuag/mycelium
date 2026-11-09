// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WelcomeWizard } from './WelcomeWizard';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

describe('WelcomeWizard', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  let previousVisualViewport: PropertyDescriptor | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    if (previousVisualViewport) {
      Object.defineProperty(window, 'visualViewport', previousVisualViewport);
    } else {
      Reflect.deleteProperty(window, 'visualViewport');
    }
    root = undefined;
    container = undefined;
    previousVisualViewport = undefined;
  });

  it('shows the generated handle and lets the user choose a display name', async () => {
    const onComplete = vi.fn(async () => {});
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(
      <WelcomeWizard
        handle="GeneratedHandle"
        initialDisplayName=""
        onComplete={onComplete}
      />
    ));

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('h1')?.textContent).toBe('Welcome to Mycelium!');
    expect(dialog?.textContent).toContain('Please pick your name.');
    expect(dialog?.textContent).toContain('(You can change it later)');
    expect(dialog?.textContent).toContain('@GeneratedHandle');
    expect(dialog?.textContent).toContain('Your generated handle is your unique identity on Mycelium:');
    expect(dialog?.textContent).not.toContain('generate a new identity');
    expect(dialog?.querySelector('.welcome-wizard-name')?.compareDocumentPosition(dialog.querySelector('.welcome-wizard-handle') as Node))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    const nameInput = dialog?.querySelector<HTMLInputElement>('input[aria-label="Display name"]');
    expect(nameInput).not.toBeNull();
    expect(document.activeElement).toBe(nameInput);
    await act(async () => {
      if (!nameInput) throw new Error('Display name input was not rendered.');
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(nameInput, 'Ada');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(dialog?.textContent).toContain('@GeneratedHandle');
    const showMeAroundButton = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find((button) => button.textContent === 'Show me around');
    await act(async () => showMeAroundButton?.click());

    expect(onComplete).toHaveBeenCalledWith('Ada', 'discover');
  });

  it('keeps long unbroken handles and display names within the welcome dialog', async () => {
    const handle = 'LongUnbrokenIdentityHandle'.repeat(12);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(
      <WelcomeWizard handle={handle} initialDisplayName={'LongDisplayName'.repeat(12)} onComplete={vi.fn(async () => {})} />
    ));

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.querySelector('.welcome-wizard-handle strong')?.textContent).toBe(`@${handle}`);
    const nameInput = dialog?.querySelector<HTMLInputElement>('input[aria-label="Display name"]');
    expect(nameInput?.value).toBe('LongDisplayName'.repeat(12));
    expect(dialog?.querySelector('.welcome-wizard-handle')?.className).toContain('welcome-wizard-handle');
    expect(nameInput?.parentElement?.className).toContain('welcome-wizard-name');
  });

  it('updates the welcome dialog bounds when a mobile visual viewport shrinks', async () => {
    previousVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    const viewport = new EventTarget();
    Object.defineProperties(viewport, {
      height: { configurable: true, writable: true, value: 320 },
      offsetTop: { configurable: true, writable: true, value: 420 }
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(
      <WelcomeWizard handle="GeneratedHandle" initialDisplayName="" onComplete={vi.fn(async () => {})} />
    ));

    const backdrop = document.body.querySelector<HTMLElement>('.welcome-wizard-backdrop');
    expect(backdrop?.style.height).toBe('320px');
    expect(backdrop?.style.top).toBe('420px');
    Object.defineProperties(viewport, {
      height: { configurable: true, writable: true, value: 240 },
      offsetTop: { configurable: true, writable: true, value: 500 }
    });
    await act(async () => {
      viewport.dispatchEvent(new Event('resize'));
    });
    expect(backdrop?.style.height).toBe('240px');
    expect(backdrop?.style.top).toBe('500px');
    expect(backdrop?.querySelector<HTMLInputElement>('input[aria-label="Display name"]')).toBe(document.activeElement);

  });

  it('saves the display name and chooses Home when the user explores independently', async () => {
    const onComplete = vi.fn(async () => {});
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(
      <WelcomeWizard handle="GeneratedHandle" initialDisplayName="Ada" onComplete={onComplete} />
    ));
    const exploreButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === "I'll explore on my own");
    await act(async () => exploreButton?.click());

    expect(onComplete).toHaveBeenCalledWith('Ada', 'home');
  });

  it('can be dismissed with Escape', async () => {
    const onComplete = vi.fn(async () => {});
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(
      <WelcomeWizard handle="GeneratedHandle" initialDisplayName="" onComplete={onComplete} />
    ));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onComplete).toHaveBeenCalledWith('', 'home');
  });
});
