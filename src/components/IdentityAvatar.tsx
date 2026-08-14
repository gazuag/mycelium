import { createIdenticonDataUrl } from '../utils/identicon';

interface IdentityAvatarProps {
  seed: string;
  size?: number;
  alt?: string;
}

export function IdentityAvatar({ seed, size = 40, alt = 'Identity avatar' }: IdentityAvatarProps) {
  return (
    <img
      className="identity-avatar"
      src={createIdenticonDataUrl(seed, size)}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
    />
  );
}
