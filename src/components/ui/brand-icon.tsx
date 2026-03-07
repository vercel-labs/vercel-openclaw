type BrandIconProps = {
  size?: number;
  className?: string;
};

/**
 * OpenClaw brand icon — pixel-art claw in the moltbot lobster style,
 * recolored to warm orange for the OpenClaw identity.
 */
export function BrandIcon({ size = 24, className }: BrandIconProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
    >
      {/* Claws and body — primary orange */}
      <g fill="#e87b35">
        <rect x="20" y="20" width="10" height="10" />
        <rect x="15" y="30" width="15" height="15" />
        <rect x="70" y="20" width="10" height="10" />
        <rect x="70" y="30" width="15" height="15" />
        <rect x="30" y="45" width="10" height="5" />
        <rect x="60" y="45" width="10" height="5" />
        <rect x="40" y="35" width="20" height="15" />
        <rect x="40" y="50" width="20" height="20" />
        <rect x="45" y="70" width="10" height="15" />
        <rect x="30" y="55" width="10" height="5" />
        <rect x="60" y="55" width="10" height="5" />
        <rect x="35" y="65" width="5" height="5" />
        <rect x="60" y="65" width="5" height="5" />
      </g>
      {/* Body shading — darker orange */}
      <g fill="#c45e1a">
        <rect x="50" y="35" width="10" height="15" />
        <rect x="50" y="50" width="10" height="20" />
        <rect x="50" y="70" width="5" height="15" />
      </g>
      {/* Eyes */}
      <g fill="#000">
        <rect x="42" y="38" width="4" height="4" />
        <rect x="54" y="38" width="4" height="4" />
      </g>
    </svg>
  );
}
