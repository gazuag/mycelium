import { useEffect, useState } from 'react';
import { createIdenticonDataUrl } from '../utils/identicon';
import { profilePictureDataUrl } from '../utils/profile-picture';

interface IdentityAvatarProps {
  seed: string;
  size?: number;
  alt?: string;
  online?: boolean;
  profilePicture?: unknown;
}

export function IdentityAvatar({
  seed,
  size = 40,
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
    <span className="identity-avatar-wrap" style={{ width: size, height: size }}>
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
