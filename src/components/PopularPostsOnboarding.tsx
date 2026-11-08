import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Contact } from '../types';
import { postContent, postImageSizes, type LocalPostView } from '../object-layer';
import { displayNameOrFallback, resolvePeerDisplayName } from '../utils/fingerprintNames';
import { AVATAR_SIZES, IdentityAvatar } from './IdentityAvatar';
import { FollowButton } from './FollowButton';
import { MarkdownContent } from './MarkdownContent';
import { PeerName } from './PeerName';

type DiscoveryStageStatus = 'loading' | 'ready' | 'unavailable';

interface PopularPostsOnboardingProps {
  posts: LocalPostView[];
  contacts: Contact[];
  status: DiscoveryStageStatus;
  myPeerId: string;
  myPublicKey: string;
  onToggleFollow: (peerId: string) => Promise<void>;
  onFinish: () => void;
}

function authorContact(contacts: Contact[], post: LocalPostView): Contact | undefined {
  return contacts.find((contact) =>
    contact.publicKey === post.object.author
    || contact.fingerprint === post.object.author
    || contact.publicKey === post.authorFingerprint
    || contact.fingerprint === post.authorFingerprint
  );
}

export function PopularPostsOnboarding({
  posts,
  contacts,
  status,
  myPeerId,
  myPublicKey,
  onToggleFollow,
  onFinish
}: PopularPostsOnboardingProps) {
  const [pendingAuthors, setPendingAuthors] = useState<Set<string>>(() => new Set());
  const [followError, setFollowError] = useState('');
  const finishRef = useRef<HTMLButtonElement>(null);

  const suggestedPosts = useMemo(() => {
    const seenAuthors = new Set<string>();
    return posts.filter((post) => {
      const contact = authorContact(contacts, post);
      const aliases = [
        post.object.author,
        post.authorFingerprint,
        contact?.publicKey,
        contact?.fingerprint
      ].filter((alias): alias is string => Boolean(alias)).map((alias) => alias.toLowerCase());
      if (aliases.some((alias) =>
        alias === myPeerId.toLowerCase()
        || alias === myPublicKey.toLowerCase()
        || seenAuthors.has(alias)
      )) return false;
      aliases.forEach((alias) => seenAuthors.add(alias));
      return true;
    }).slice(0, 10);
  }, [contacts, myPeerId, myPublicKey, posts]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    finishRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
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

  const toggleFollow = async (peerId: string) => {
    if (pendingAuthors.has(peerId)) return;
    setPendingAuthors((current) => new Set(current).add(peerId));
    setFollowError('');
    try {
      await onToggleFollow(peerId);
    } catch (reason) {
      setFollowError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPendingAuthors((current) => {
        const next = new Set(current);
        next.delete(peerId);
        return next;
      });
    }
  };

  return createPortal(
    <div className="welcome-wizard-backdrop popular-posts-onboarding-backdrop">
      <section
        className="welcome-wizard-dialog popular-posts-onboarding-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="popular-posts-onboarding-title"
        aria-describedby="popular-posts-onboarding-description"
      >
        <button
          ref={finishRef}
          className="welcome-wizard-close"
          type="button"
          aria-label="Finish onboarding"
          onClick={onFinish}
        >
          <span aria-hidden="true">&times;</span>
        </button>
        <h1 id="popular-posts-onboarding-title">Mycelium is best with others.</h1>
        <p id="popular-posts-onboarding-description" className="welcome-wizard-intro">
          Here are some popular public posts right now. Follow the people behind the posts that interest you, and your Mycelium experience will become more interesting.
        </p>
        {status === 'loading' ? (
          <p className="popular-posts-onboarding-message" role="status">Loading public posts from Discover…</p>
        ) : null}
        {status === 'unavailable' ? (
          <p className="popular-posts-onboarding-message" role="status">
            Public posts are unavailable right now. You can continue and explore Discover later.
          </p>
        ) : null}
        {status === 'ready' && suggestedPosts.length === 0 ? (
          <p className="popular-posts-onboarding-message" role="status">
            There are no public posts to show right now. You can explore Discover later.
          </p>
        ) : null}
        {suggestedPosts.length > 0 ? (
          <div className="popular-posts-onboarding-list" aria-label="Popular public posts">
            {suggestedPosts.map((post) => {
              const contact = authorContact(contacts, post);
              const authorId = post.authorFingerprint || contact?.fingerprint || post.object.author;
              const profileName = post.authorDisplayName ?? (contact
                ? resolvePeerDisplayName(
                    contact.identityObject?.payload.display_name ?? contact.displayName,
                    contact.authenticatedDisplayName
                  )
                  : undefined);
              const authorName = displayNameOrFallback(profileName, authorId);
              const peerId = contact?.publicKey || post.object.author;
              const content = postContent(post);
              return (
                <article className="popular-post-onboarding-item" key={post.object.object_id}>
                  <header>
                    <div className="popular-post-onboarding-author">
                      <IdentityAvatar
                        seed={authorId}
                        size={AVATAR_SIZES.popularPost}
                        alt=""
                        profilePicture={contact?.profilePicture ?? contact?.identityObject?.payload.profile_picture}
                      />
                      <div className="popular-post-onboarding-author-details">
                        <strong><PeerName peerId={authorId} displayName={profileName ?? authorName} /></strong>
                      </div>
                    </div>
                    <FollowButton
                      peerId={peerId}
                      contacts={contacts}
                      onToggleFollow={toggleFollow}
                      className="btn secondary"
                      myPeerId={myPublicKey}
                      disabled={pendingAuthors.has(peerId)}
                    />
                  </header>
                  {content ? (
                    <MarkdownContent
                      className="markdown-content popular-post-onboarding-content"
                      source={content}
                      imageSizes={postImageSizes(post)}
                    />
                  ) : <p className="popular-post-onboarding-empty">This public post has no text preview.</p>}
                </article>
              );
            })}
          </div>
        ) : null}
        {followError ? <p className="welcome-wizard-error" role="alert">{followError}</p> : null}
        <div className="welcome-wizard-actions">
          <button className="btn" type="button" onClick={onFinish}>Continue to Mycelium</button>
        </div>
      </section>
    </div>,
    document.body
  );
}
