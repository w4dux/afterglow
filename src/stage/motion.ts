/**
 * Motion primitives. Every function is a pure function of elapsed time so that the
 * stage is fully determined by playback position: pausing freezes it, seeking jumps
 * to the right frame, and previews/screenshots are reproducible.
 */
import type { MotionTreatment } from '../core/settings/schema';

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const easeOutCubic = (t: number) => 1 - (1 - clamp01(t)) ** 3;
export const easeOutQuart = (t: number) => 1 - (1 - clamp01(t)) ** 4;
export const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * clamp01(t)));
export const easeInCubic = (t: number) => clamp01(t) ** 3;
export const easeInOutSine = (t: number) => -(Math.cos(Math.PI * clamp01(t)) - 1) / 2;
export const easeOutBack = (t: number, s = 1.70158) => {
  const x = clamp01(t) - 1;
  return 1 + (s + 1) * x ** 3 + s * x ** 2;
};

/**
 * Damped spring step response (0 -> 1) at time `ms` after release.
 * freq in Hz, zeta damping ratio (<1 overshoots).
 */
export function spring(ms: number, freq = 9, zeta = 0.55): number {
  if (ms <= 0) return 0;
  const t = ms / 1000;
  const w = 2 * Math.PI * freq;
  if (zeta >= 1) return 1 - Math.exp(-w * t) * (1 + w * t);
  const wd = w * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t));
}

/** Deterministic hash -> [0,1). */
export function hash01(a: number, b = 0): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export const hashSigned = (a: number, b = 0) => hash01(a, b) * 2 - 1;

/** Decaying oscillation after an impulse, e.g. a word "landing". */
export function wobble(ms: number, freq = 7, decayMs = 260): number {
  if (ms <= 0) return 0;
  return Math.sin((2 * Math.PI * freq * ms) / 1000) * Math.exp(-ms / decayMs);
}

export interface MotionProfile {
  treatment: MotionTreatment;
  /** Overall multiplier for displacement, rotation, scale (0 when reduced). */
  amount: number;
  /** Continuous jiggle on the active word (only for the 'jiggle' treatment). */
  jiggle: number;
  /** Word displacement enabled (false for highlight/still/reduced). */
  wordMotion: boolean;
  /** Entrances use transforms (false = opacity-only crossfades). */
  transforms: boolean;
  reduced: boolean;
  /** Beat pulse allowed by the user (still requires trusted timing). */
  pulse: boolean;
}

export function resolveMotion(
  treatment: MotionTreatment,
  intensity: number,
  reducedPref: 'system' | 'on' | 'off',
  systemReduced: boolean,
  pulse: boolean,
): MotionProfile {
  const reduced = reducedPref === 'on' || (reducedPref === 'system' && systemReduced);
  if (reduced || treatment === 'still') {
    return { treatment: reduced ? 'still' : treatment, amount: 0, jiggle: 0, wordMotion: false, transforms: false, reduced, pulse: false };
  }
  const amount = Math.max(0, Math.min(1.5, intensity));
  return {
    treatment,
    amount,
    jiggle: treatment === 'jiggle' ? amount : 0,
    wordMotion: treatment !== 'highlight',
    transforms: true,
    reduced: false,
    pulse: pulse && amount > 0,
  };
}

/**
 * Beat envelope from a *stated* tempo and downbeat. Returns null when no trusted
 * timing exists — callers must not fake a pulse in that case.
 */
export function beatAt(t: number, bpm?: number, beatOffsetMs?: number): { phase: number; index: number; env: number; bar: number } | null {
  if (!bpm || beatOffsetMs === undefined || !Number.isFinite(t)) return null;
  const beatMs = 60000 / bpm;
  const x = (t - beatOffsetMs) / beatMs;
  if (x < 0) return null;
  const index = Math.floor(x);
  const phase = x - index;
  const env = Math.exp(-phase * 5.5);
  return { phase, index, env, bar: Math.floor(index / 4) };
}
