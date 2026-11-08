import { useEffect, useState } from 'react';
import { createIdenticonDataUrl } from '../utils/identicon';
import { profilePictureDataUrl } from '../utils/profile-picture';

export const AVATAR_SIZES = {
  profile: 126,
  post: 44,
  reply: 44,
  messageList: 48,
  message: 42,
  person: 48,
  mention: 40,
  composer: 48,
  popularPost: 48,
  sharePreview: 38,
  profileEditor: 128
} as const;

interface IdentityAvatarProps {
  seed: string;
  size?: number;
  className?: string;
  alt?: string;
  online?: boolean;
  profilePicture?: unknown;
}

export function IdentityAvatar({
  seed,
  size = 40,
  className,
  alt = 'Identity avatar',
  online = false,
  profilePicture
}: IdentityAvatarProps) {
  const pictureSource = profilePictureDataUrl(profilePicture);
  const [pictureFailed, setPictureFailed] = useState(false);

  useEffect(() => {
    setPictureFailed(false);
  }, [pictureSource]);

  return (
    <span
      className={`identity-avatar-wrap${className ? ` ${className}` : ''}${online ? ' is-online' : ''}`}
      style={className ? undefined : { width: size, height: size }}
    >
      <img
        className="identity-avatar"
        src={pictureSource && !pictureFailed ? pictureSource : createIdenticonDataUrl(seed, size)}
        alt={alt}
        width={size}
        height={size}
        loading="lazy"
        onError={() => {
          if (pictureSource) setPictureFailed(true);
        }}
      />
      {online ? <span className="identity-avatar-online" role="img" aria-label="Online" title="Online" /> : null}
    </span>
  );
}
