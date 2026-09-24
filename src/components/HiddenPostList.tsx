import type { LocalPostView } from '../object-layer';
import { postContent } from '../object-layer';
import type { Contact } from '../types';
import { displayNameOrFallback } from '../utils/fingerprintNames';

interface HiddenPostListProps {
  posts: LocalPostView[];
  contacts: Contact[];
  onUnhide: (postId: string) => void;
}

export function HiddenPostList({ posts, contacts, onUnhide }: HiddenPostListProps) {
  if (posts.length === 0) {
    return <p className="note">No hidden posts.</p>;
  }

  return (
    <div className="blocked-peer-list">
      {posts.map((post) => (
        <div key={post.object.object_id} className="blocked-peer-item">
          <div className="peer-label-block">
            <strong>{postContent(post) || 'Untitled post'}</strong>
            <span className="note">By {displayNameOrFallback(
              contacts.find((contact) => contact.fingerprint === post.authorFingerprint || contact.publicKey === post.object.author)?.displayName
                ?? post.authorDisplayName,
              post.authorFingerprint
            )}</span>
            <span className="note">{new Date(post.object.created_at).toLocaleString()}</span>
          </div>
          <button className="chip secondary" type="button" onClick={() => onUnhide(post.object.object_id)}>Show</button>
        </div>
      ))}
    </div>
  );
}
