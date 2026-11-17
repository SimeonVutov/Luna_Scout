/**
 * The LunaScout mark: a crescent moon lit from the south-west on a dark tile. The same drawing is
 * the favicon (public/favicon.svg).
 */
export function Logo({ size = 42 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="LunaScout">
      <defs>
        <linearGradient id="logo-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1f3532" />
          <stop offset="1" stopColor="#0e1517" />
        </linearGradient>
        <radialGradient id="logo-moon" cx=".35" cy=".3" r=".9">
          <stop offset="0" stopColor="#f1f6f2" />
          <stop offset="1" stopColor="#9db3ad" />
        </radialGradient>
        <mask id="logo-crescent">
          <rect width="48" height="48" fill="#fff" />
          <circle cx="33" cy="17" r="15.5" fill="#000" />
        </mask>
      </defs>

      <rect width="48" height="48" rx="12" fill="url(#logo-tile)" />
      <circle cx="24" cy="24" r="15" fill="url(#logo-moon)" mask="url(#logo-crescent)" />
    </svg>
  );
}
