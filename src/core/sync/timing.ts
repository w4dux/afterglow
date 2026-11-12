/**
 * Mapping between media position and lyric time.
 *
 * offset > 0 means "show lyrics later": lyricTime = mediaPosition - offset.
 * The total offset is the global offset (e.g. output latency of the audio device)
 * plus an optional per-track correction remembered for that track.
 */
export interface TimingPrefs {
  globalOffsetMs: number;
  rememberTrackOffsets: boolean;
  trackOffsets: Record<string, number>;
}

export function trackOffsetOf(t: TimingPrefs, trackKey: string | null | undefined): number {
  if (!trackKey || !t.rememberTrackOffsets) return 0;
  return t.trackOffsets[trackKey] ?? 0;
}

export function totalOffsetMs(t: TimingPrefs, trackKey: string | null | undefined): number {
  return t.globalOffsetMs + trackOffsetOf(t, trackKey);
}

export function lyricTimeOf(mediaMs: number, offsetMs: number): number {
  return mediaMs - offsetMs;
}

export interface OffsetSuggestion {
  /** Amount to add to the global offset (ms, rounded to 10). */
  deltaMs: number;
  /** Songs whose own correction agrees with it. */
  songs: number;
}

/**
 * When the user has nudged several songs by about the same amount in the same
 * direction, that is usually output delay (Bluetooth, TV, receiver) rather than a
 * problem with each song: suggest moving it into the global offset. Needs at least
 * 3 corrected songs, all in one direction, a median of at least 80 ms, and three
 * quarters of them within max(60 ms, 35 %) of the median. Measured from the user's
 * own corrections only.
 */
export function suggestGlobalOffset(t: TimingPrefs): OffsetSuggestion | null {
  if (!t.rememberTrackOffsets) return null;
  const xs = Object.values(t.trackOffsets).filter((v) => Number.isFinite(v) && Math.abs(v) >= 30 && Math.abs(v) <= 2000);
  if (xs.length < 3) return null;
  if (!xs.every((v) => Math.sign(v) === Math.sign(xs[0]))) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  if (Math.abs(m) < 80) return null;
  const tol = Math.max(60, Math.abs(m) * 0.35);
  const agreeing = xs.filter((v) => Math.abs(v - m) <= tol).length;
  if (agreeing * 4 < xs.length * 3 || agreeing < 3) return null;
  return { deltaMs: Math.round(m / 10) * 10, songs: agreeing };
}

/**
 * Move `deltaMs` into the global offset. Every remembered song keeps exactly the
 * timing it has now (its own correction shrinks by the same amount); songs without a
 * correction, including future ones, get the new global offset.
 */
export function applyGlobalSuggestion<T extends TimingPrefs>(t: T, deltaMs: number): T {
  const trackOffsets: Record<string, number> = {};
  for (const [k, v] of Object.entries(t.trackOffsets)) {
    const left = v - deltaMs;
    if (Math.abs(left) >= 10) trackOffsets[k] = left;
  }
  return { ...t, globalOffsetMs: t.globalOffsetMs + deltaMs, trackOffsets };
}

/** Offset that makes `lineStartMs` begin exactly at the current media position ("sync this line now"). */
export function offsetToAlign(mediaMs: number, lineStartMs: number, globalOffsetMs: number): number {
  // want mediaMs - (global + track) === lineStartMs  =>  track = mediaMs - lineStartMs - global
  return Math.round(mediaMs - lineStartMs - globalOffsetMs);
}
