import logoUrl from '../assets/logo.png';

interface ProductLogoProps {
  size?: number;
  className?: string;
}

export function ProductLogo({ size = 16, className = '' }: ProductLogoProps) {
  return (
    <img
      src={logoUrl}
      alt="Tagma"
      width={size}
      height={size}
      draggable={false}
      className={`shrink-0 select-none ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
