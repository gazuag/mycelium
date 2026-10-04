type BrandLogoVariant = 'default' | 'black' | 'white';

interface BrandLogoProps {
  variant?: BrandLogoVariant;
  className?: string;
  alt?: string;
  size?: number;
}

const LOGO_BY_VARIANT: Record<BrandLogoVariant, string> = {
  default: '/mycelium_logo.svg',
  black: '/mycelium_logo_black.svg',
  white: '/mycelium_logo_white.svg'
};

export function BrandLogo({
  variant = 'default',
  className = '',
  alt = 'Mycelium logo',
  size
}: BrandLogoProps) {
  return (
    <img
      src={LOGO_BY_VARIANT[variant]}
      alt={alt}
      className={className}
      width={size}
      height={size}
      draggable={false}
    />
  );
}
