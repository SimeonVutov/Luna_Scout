import type { ReactNode } from "react";

const paths = {
  moon: <><circle cx="12" cy="12" r="8.5" /><path d="M9 6.5c-2 3.5-2 7.5.4 11.1M5 12h5m5-.5h3m-3 4h2" /><circle cx="14.5" cy="8.5" r=".65" fill="currentColor" stroke="none" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  pin: <><path d="M19 10c0 5.4-7 10-7 10s-7-4.6-7-10a7 7 0 1 1 14 0z" /><circle cx="12" cy="10" r="2.2" /></>,
  chevron: <path d="m8 10 4 4 4-4" />,
  arrow: <path d="M7 17 17 7M7 7h10v10" />,
  target: <><circle cx="12" cy="12" r="6" /><path d="M12 3v5m0 8v5M3 12h5m8 0h5" /></>,
  minus: <path d="M5 12h14" />,
  calendar: <><rect x="4" y="6" width="16" height="14" rx="2" /><path d="M8 4v4m8-4v4M4 10h16" /></>,
  play: <path d="m9 6 11 6-11 6z" fill="currentColor" stroke="none" />,
  pause: <path d="M9 6v12m6-12v12" />,
  previous: <><path d="M8 6v12" /><path d="m17 7-7 5 7 5" /></>,
  next: <><path d="M16 6v12" /><path d="m7 7 7 5-7 5" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2" /></>,
  earth: <><circle cx="12" cy="12" r="8" /><ellipse cx="12" cy="12" rx="3.5" ry="8" /><path d="M4 12h16" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5m0 13V21m9-9h-2.5m-13 0H3m15.4-6.4-1.8 1.8M7.4 16.6l-1.8 1.8m12.8 0-1.8-1.8M7.4 7.4 5.6 5.6" /></>,
  swap: <path d="M7 4 3 8l4 4M3 8h14m0 4 4 4-4 4m4-4H7" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
} satisfies Record<string, ReactNode>;

export function Icon({ name, size = 18 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
