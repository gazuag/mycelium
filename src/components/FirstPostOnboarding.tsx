import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MAX_POST_CONTENT_LENGTH } from '../object-layer/post-state';
import { FIRST_POST_INTERESTS, generateFirstPost } from '../utils/first-post-generator';
import { CollapsibleSection } from './CollapsibleSection';
import { MarkdownComposer } from './MarkdownComposer';

interface FirstPostOnboardingProps {
  displayName: string;
  handle: string;
  onPublish: (content: string) => Promise<void>;
  onFinish: () => void;
}

export function FirstPostOnboarding({ displayName, handle, onPublish, onFinish }: FirstPostOnboardingProps) {
  const [generation, setGeneration] = useState(() => Math.floor(Math.random() * FIRST_POST_INTERESTS.length));
  const [selectedInterests, setSelectedInterests] = useState<string[]>([]);
  const [postText, setPostText] = useState(() => generateFirstPost(displayName, handle, [], generation));
  const [interestsExpanded, setInterestsExpanded] = useState(false);
  const [hasManualEdits, setHasManualEdits] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);
  const [error, setError] = useState('');
  const publishGuard = useRef(false);
  const publishingRef = useRef(publishing);
  const publishedRef = useRef(published);
  const finishRef = useRef<HTMLButtonElement>(null);
  publishingRef.current = publishing;
  publishedRef.current = published;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    finishRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !publishingRef.current && !publishedRef.current) {
        event.preventDefault();
        onFinish();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [onFinish]);

  const regenerate = (interests = selectedInterests) => {
    const nextGeneration = generation + 1;
    const previousIcebreaker = postText.trim().split('\n\n').slice(-1)[0];
    setGeneration(nextGeneration);
    setPostText(generateFirstPost(displayName, handle, interests, nextGeneration, previousIcebreaker));
    setHasManualEdits(false);
    setError('');
  };

  const toggleInterest = (interest: string) => {
    const nextInterests = selectedInterests.includes(interest)
      ? selectedInterests.filter((selected) => selected !== interest)
      : [...selectedInterests, interest];
    setSelectedInterests(nextInterests);
    if (!hasManualEdits) regenerate(nextInterests);
  };

  const publish = async () => {
    if (publishGuard.current || publishing || published) return;
    if (!postText.trim()) {
      setError('Write something before publishing your post.');
      return;
    }
    publishGuard.current = true;
    setPublishing(true);
    setError('');
    try {
      await onPublish(postText);
      setPublished(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      publishGuard.current = false;
      setPublishing(false);
    }
  };

  return createPortal(
    <div className="welcome-wizard-backdrop first-post-onboarding-backdrop">
      <section
        className="welcome-wizard-dialog first-post-onboarding-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-post-onboarding-title"
        aria-describedby="first-post-onboarding-description"
      >
        <button
          ref={finishRef}
          className="welcome-wizard-close"
          type="button"
          aria-label="Close first post onboarding"
          onClick={onFinish}
          disabled={publishing}
        >
          <span aria-hidden="true">&times;</span>
        </button>
        <h1 id="first-post-onboarding-title">Find your people.</h1>
        <p id="first-post-onboarding-description" className="welcome-wizard-intro">
          The best way to meet like-minded people is to start a conversation. Tell others a little about yourself, share your interests, and give them something interesting to respond to.
        </p>
        <p className="first-post-public-note">Your post will be public and visible to other Mycelium users.</p>
        <CollapsibleSection
          title="Interests"
          collapsed={!interestsExpanded}
          onToggle={() => setInterestsExpanded((expanded) => !expanded)}
          className="first-post-interests"
        >
          <div className="first-post-interest-list">
            {FIRST_POST_INTERESTS.map((interest) => (
              <label className="first-post-interest" key={interest}>
                <input
                  type="checkbox"
                  checked={selectedInterests.includes(interest)}
                  onChange={() => toggleInterest(interest)}
                  disabled={publishing || published}
                />
                <span>{interest}</span>
              </label>
            ))}
          </div>
        </CollapsibleSection>
        <div className="first-post-editor">
          <fieldset className="first-post-editor-fieldset" disabled={publishing || published}>
            <MarkdownComposer
              value={postText}
              onChange={(value) => {
                setPostText(value);
                setHasManualEdits(true);
              }}
              rows={7}
              maxLength={MAX_POST_CONTENT_LENGTH}
              ariaLabel="Your introductory post"
              placeholder="Write an introduction..."
              actionPlacement="controls"
              action={(
                <button
                  className="btn secondary first-post-regenerate"
                  type="button"
                  onClick={() => regenerate()}
                >
                  <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16">
                    <path d="M16.5 8A6.8 6.8 0 0 0 4.7 5.2L3 7m0 0V3.8M3 7h3.2M3.5 12a6.8 6.8 0 0 0 11.8 2.8L17 13m0 0v3.2M17 13h-3.2" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
                  </svg>
                  Regenerate
                </button>
              )}
            />
          </fieldset>
        </div>
        {hasManualEdits && selectedInterests.length > 0 ? (
          <p className="first-post-interest-note" role="status">
            Your draft has edits. Regenerate to include your selected interests in the generated wording.
          </p>
        ) : null}
        {error ? <p className="welcome-wizard-error first-post-error" role="alert">{error}</p> : null}
        {published ? (
          <p className="first-post-success" role="status">
            Your post is published and visible to other Mycelium users.
          </p>
        ) : null}
        <div className="welcome-wizard-actions first-post-actions">
          {!published ? (
            <>
              <button className="btn" type="button" onClick={() => void publish()} disabled={publishing}>
                {publishing ? 'Publishing…' : 'Publish post'}
              </button>
              <button className="btn secondary" type="button" onClick={onFinish} disabled={publishing}>
                Skip for now
              </button>
            </>
          ) : (
            <button className="btn" type="button" onClick={onFinish}>Continue to tour</button>
          )}
        </div>
      </section>
    </div>,
    document.body
  );
}
