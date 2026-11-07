// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WelcomeWizard } from './WelcomeWizard';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

describe('WelcomeWizard', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
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
    expect(dialog?.querySelector('h1')?.textContent).toBe('Welcome! Pick your name!');
    expect(dialog?.textContent).toContain("Choose the name you'd like people to see on Mycelium. You can change it later.");
    expect(dialog?.textContent).toContain('@GeneratedHandle');
    expect(dialog?.textContent).toContain('Your generated handle is your unique identity on Mycelium:');
    expect(dialog?.textContent).not.toContain('generate a new identity');
    expect(dialog?.querySelector('.welcome-wizard-name')?.compareDocumentPosition(dialog.querySelector('.welcome-wizard-handle') as Node))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    const nameInput = dialog?.querySelector<HTMLInputElement>('input[aria-label="Display name"]');
    expect(nameInput).not.toBeNull();
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

    expect(onComplete).toHaveBeenCalledWith('Ada', 'tour');
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
