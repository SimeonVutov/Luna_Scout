/**
 * The LunaScout mark: a moon lit from the south-west, with a target ring at the south pole, where
 * the sites are. The same drawing is the favicon (public/favicon.svg).
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
        <clipPath id="logo-disk"><circle cx="24" cy="23" r="14.5" /></clipPath>
      </defs>

      <rect width="48" height="48" rx="12" fill="url(#logo-tile)" />
      <rect x=".75" y=".75" width="46.5" height="46.5" rx="11.25" fill="none" stroke="#a2e0d4" strokeOpacity=".28" strokeWidth="1.5" />

      <circle cx="24" cy="23" r="14.5" fill="url(#logo-moon)" />
      <g clipPath="url(#logo-disk)">
        <circle cx="33" cy="16" r="15.5" fill="#0e1517" fillOpacity=".9" />
        <circle cx="16" cy="27" r="2.3" fill="#7e948e" fillOpacity=".55" />
        <circle cx="21.5" cy="33" r="1.5" fill="#7e948e" fillOpacity=".5" />
      </g>
      <circle cx="24" cy="23" r="14.5" fill="none" stroke="#a2e0d4" strokeOpacity=".35" strokeWidth=".9" />

      <circle cx="24" cy="41" r="3.4" fill="#0e1517" stroke="#a2e0d4" strokeWidth="1.7" />
      <circle cx="24" cy="41" r="1.1" fill="#a2e0d4" />
    </svg>
  );
}
