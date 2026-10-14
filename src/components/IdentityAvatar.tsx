import { createIdenticonDataUrl } from '../utils/identicon';

interface IdentityAvatarProps {
  seed: string;
  size?: number;
  alt?: string;
  online?: boolean;
}

export function IdentityAvatar({ seed, size = 40, alt = 'Identity avatar', online = false }: IdentityAvatarProps) {
  return (
    <span className="identity-avatar-wrap" style={{ width: size, height: size }}>
      <img
        className="identity-avatar"
        src={createIdenticonDataUrl(seed, size)}
        alt={alt}
        width={size}
        height={size}
        loading="lazy"
      />
      {online ? <span className="identity-avatar-online" role="img" aria-label="Online" title="Online" /> : null}
    </span>
  );
}
