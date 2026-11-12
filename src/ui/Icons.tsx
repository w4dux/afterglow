import type { SVGProps } from 'react';

const base = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const Icon = {
  Play: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" /></svg>
  ),
  Pause: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /></svg>
  ),
  Prev: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M18 5v14L8 12z" fill="currentColor" stroke="none" /><path d="M6 5v14" /></svg>
  ),
  Next: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M6 5v14l10-7z" fill="currentColor" stroke="none" /><path d="M18 5v14" /></svg>
  ),
  Full: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
  ),
  Exit: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>
  ),
  Palette: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.9 1.4-2-.5-1.2.3-2.3 1.6-2.3H17a4 4 0 0 0 4-4C21 7 17 3 12 3z" /><circle cx="7.5" cy="11" r="1.2" fill="currentColor" /><circle cx="10" cy="7" r="1.2" fill="currentColor" /><circle cx="14.5" cy="7" r="1.2" fill="currentColor" /></svg>
  ),
  Motion: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M3 12c3-6 6 6 9 0s6 6 9 0" /></svg>
  ),
  Clock: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2.5M9 2h6" /></svg>
  ),
  Source: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
  ),
  Bug: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M3 12h4M17 12h4M12 3v3M5 5l3 3M19 5l-3 3M5 19l3-3M19 19l-3-3" /><rect x="8" y="8" width="8" height="10" rx="4" /></svg>
  ),
  Close: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>
  ),
  Help: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 1-1 1.7M12 17h.01" /></svg>
  ),
  File: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M14 3H6v18h12V7z" /><path d="M14 3v4h4" /></svg>
  ),
  Lyrics: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base} {...p}><path d="M4 6h16M4 11h10M4 16h13M4 21h7" /></svg>
  ),
};
