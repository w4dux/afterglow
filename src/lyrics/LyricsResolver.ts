import { parseLyricsfile } from '../core/lyrics/lyricsfile';
import { learnedOffsetSec, lengthCluster, lengthWindow, playerKey } from '../core/lyrics/length';
import { parseLrc } from '../core/lyrics/lrc';
import { artistsOverlap, normalizeForMatch } from '../core/lyrics/lrclibMatch';
import { LOOSE_THRESHOLD, MATCH_THRESHOLD, type ProviderHit, type TrackQuery, chooseHit, consensusIndex, lengthDeltaSec, scoreCandidate } from '../core/lyrics/match';
import { parseTtml } from '../core/lyrics/ttml';
import type { LyricDocument, LyricSource } from '../core/lyrics/model';
import { parseLyrics, parsePlain } from '../core/lyrics/parse';
import type { Settings } from '../core/settings/schema';
import type { AmllResponse, LrclibRecord, LrclibResponse, LyricFileResult, LyricsCacheEntry } from '../shared/api';
import type { TrackInfo } from '../playback/adapters';

export type LyricsStatus = 'idle' | 'loading' | 'synced' | 'unsynced' | 'instrumental' | 'not-found' | 'error';

export interface LyricsResult {
  status: LyricsStatus;
  doc: LyricDocument | null;
  message?: string;
  /** Sources consulted, in order, with their outcome (shown to the user). */
  tried: { source: string; outcome: string }[];
  alternatives?: LrclibRecord[];
  /** How the song length was used for matching (shown in diagnostics). */
  length?: LengthUse;
}

export interface LengthUse {
  /** Length the player reported (s). */
  reportedSec?: number;
  /** Length used for matching (s), when known exactly. */
  usedSec?: number;
  /** Correction learned for this player (s), if any. */
  learnedOffsetSec?: number;
  /** Gap measured on this song (real length agreed by uploads minus reported), to learn from. */
  measuredGapSec?: number;
}

export interface LyricsDeps {
  readLyricFile(path: string): Promise<LyricFileResult | null>;
  findLyricsInFolder(folder: string, artist: string, title: string): Promise<LyricFileResult | null>;
  lrclib(q: { artist: string; title: string; album?: string; durationSec?: number }): Promise<LrclibResponse>;
  lrclibById?(id: number): Promise<LrclibResponse>;
  amll?(q: { artist: string; title: string; album?: string; durationSec?: number }): Promise<AmllResponse>;
  cacheGet?(key: string): Promise<LyricsCacheEntry | null>;
  cachePut?(key: string, entry: LyricsCacheEntry): Promise<void>;
  fetchText(url: string): Promise<string>;
}

export const AMLL_ATTRIBUTION = 'Word-timed lyrics from AMLL TTML DB (community-made, CC0)';

interface ProviderOutcome {
  hits: ProviderHit[];
  tried: { source: string; outcome: string }[];
  alternatives?: LrclibRecord[];
  instrumental?: boolean;
  plain?: { doc: LyricDocument; raw: string; provider: string };
  /** Real length agreed by several uploads (s), when the player's length may be short. */
  agreedLengthSec?: number;
  /** The provider could not answer (offline, rate-limited, error). */
  failed?: boolean;
}

/** A saved line-timed copy is used as is for this long, then rechecked in the background. */
export const RECHECK_AFTER_MS = 7 * 24 * 3600 * 1000;
/** "Nothing found" is remembered this long (Search again bypasses it). */
export const NOT_FOUND_TTL_MS = 24 * 3600 * 1000;

const ago = (ms: number) => (ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min ago` : `${Math.round(ms / 3600_000)} h ago`);

/**
 * The matching query for a track. Local files and the demo report their true length.
 * System media sessions may report a shortened length (Spotify with crossfade); for
 * them the correction learned on this PC is used, or, until one is learned, any length
 * in the plausible range counts as matching.
 */
export function trackQuery(track: TrackInfo, settings: Settings): { q: TrackQuery; learned?: number } {
  const reported = track.durationMs ? track.durationMs / 1000 : undefined;
  const base: TrackQuery = { artist: track.artist ?? '', title: track.title ?? '', album: track.album, reportedDurationSec: reported };
  if (reported === undefined) return { q: base };
  if (track.source !== 'system') return { q: { ...base, durationSec: reported } };
  const key = playerKey(track.app);
  const learned = key ? learnedOffsetSec(settings.learned.lengthOffsets[key]) : undefined;
  const q: TrackQuery = { ...base, lengthMayBeShort: true };
  return learned !== undefined ? { q: { ...q, durationSec: reported + learned }, learned } : { q: { ...q, lengthWindowSec: lengthWindow(reported) } };
}

/** LRCLIB: every returned version is scored; synced versions that agree win ties (consensus). */
export async function lrclibProvider(query: TrackQuery, deps: LyricsDeps): Promise<ProviderOutcome> {
  // Only an exact length is sent: LRCLIB's exact lookup allows about ±2 s.
  const res = await deps
    .lrclib({ artist: query.artist, title: query.title, album: query.album, durationSec: query.durationSec })
    .catch((e) => ({ ok: false as const, error: String(e) }));
  if (!res.ok) return { hits: [], tried: [{ source: 'LRCLIB', outcome: res.error }], failed: true };
  const records = [...(res.exact ? [res.exact] : []), ...res.candidates.filter((r) => r.id !== res.exact?.id)];
  // When the player's length may be short, the uploads themselves say how long the song is.
  let q = query;
  let agreedLengthSec: number | undefined;
  if (query.lengthMayBeShort && query.reportedDurationSec) {
    const t = normalizeForMatch(query.title);
    const lengths = records
      .filter((r) => r.duration && normalizeForMatch(r.trackName) === t && artistsOverlap(query.artist, r.artistName))
      .map((r) => r.duration!);
    agreedLengthSec = lengthCluster(lengths, query.reportedDurationSec);
    if (agreedLengthSec !== undefined) q = { ...query, durationSec: agreedLengthSec, lengthWindowSec: undefined };
  }
  const scored = records
    .map((r) => ({
      r,
      score: scoreCandidate(q, { title: r.trackName, artist: r.artistName, album: r.albumName ?? undefined, durationSec: r.duration }),
    }))
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  const instrumental = !!top && top.score >= MATCH_THRESHOLD && top.r.instrumental;
  const synced = scored.filter((x) => (x.r.syncedLyrics || x.r.hasWordSync) && x.score >= LOOSE_THRESHOLD).slice(0, 16);
  const docs = synced.map((x) => docFromLrclib(x.r, 'probable'));
  // consensus among strong versions with matching duration
  const strong = synced.map((x, i) => ({ x, i })).filter(({ x }) => x.score >= MATCH_THRESHOLD && Math.abs(lengthDeltaSec(q, x.r.duration) ?? 0) <= 3);
  let bonusIndex = -1;
  if (strong.length >= 3) {
    const k = consensusIndex(strong.map(({ i }) => docs[i]));
    bonusIndex = strong[k].i;
    docs[bonusIndex].source.note = `chosen from ${strong.length} LRCLIB versions by timing agreement`;
  }
  const hits: ProviderHit[] = synced.map((x, i) => ({
    provider: 'lrclib',
    doc: docs[i],
    score: Math.min(100, x.score + (i === bonusIndex ? 3 : 0)),
    durationDeltaSec: lengthDeltaSec(q, x.r.duration),
    raw: docs[i].source.format === 'lyricsfile' ? x.r.lyricsfile ?? '' : x.r.syncedLyrics ?? '',
  }));
  const plainRec = scored.find((x) => !x.r.syncedLyrics && x.r.plainLyrics && x.score >= MATCH_THRESHOLD);
  const outcome =
    synced.length > 0 ? `${records.length} result${records.length === 1 ? '' : 's'}, best synced score ${Math.max(...hits.map((h) => h.score))}` : records.length ? `${records.length} results, none synced and matching` : 'no match';
  return {
    hits,
    tried: [{ source: 'LRCLIB', outcome }],
    alternatives: scored.filter((x) => x.score >= LOOSE_THRESHOLD).map((x) => x.r).slice(0, 8),
    instrumental,
    plain: plainRec ? { doc: docFromLrclib(plainRec.r, 'probable'), raw: plainRec.r.plainLyrics ?? '', provider: 'lrclib' } : undefined,
    agreedLengthSec,
  };
}

/** AMLL TTML DB: word-timed TTML; the score is recomputed with the file's own duration. */
export async function amllProvider(q: TrackQuery, deps: LyricsDeps): Promise<ProviderOutcome> {
  const res = await deps.amll!(q).catch((e) => ({ ok: false as const, error: String(e) }));
  if (!res.ok) return { hits: [], tried: [{ source: 'AMLL TTML DB', outcome: res.error }], failed: true };
  const hits: ProviderHit[] = [];
  for (const h of res.hits) {
    if (!h.ttml) continue;
    const doc = parseTtml(h.ttml, { kind: 'amll', label: 'AMLL TTML DB', attribution: AMLL_ATTRIBUTION });
    if (!doc.lines.length) continue;
    const durationSec = doc.meta.lengthMs ? doc.meta.lengthMs / 1000 : undefined;
    const score = Math.max(h.score === 100 ? 100 : 0, scoreCandidate(q, { title: h.title, artist: h.artist, album: h.album, durationSec }));
    hits.push({ provider: 'amll', doc, score, durationDeltaSec: lengthDeltaSec(q, durationSec), raw: h.ttml });
  }
  const best = hits.length ? Math.max(...hits.map((h) => h.score)) : 0;
  return {
    hits,
    tried: [{ source: 'AMLL TTML DB', outcome: hits.length ? `match score ${best} (word timing)${res.stale ? ', offline index' : ''}` : `no match in ${res.indexSize.toLocaleString()} songs` }],
  };
}

export function docFromCache(c: LyricsCacheEntry): LyricDocument | null {
  const source = { kind: 'cache' as const, label: `${c.label} (saved)`, attribution: c.attribution, match: (c.match as LyricSource['match']) ?? undefined, note: c.note };
  const doc = c.format === 'lyricsfile' ? parseLyricsfile(c.text, source) : c.format === 'ttml' ? parseTtml(c.text, source) : c.format === 'lrc' ? parseLrc(c.text, source) : parsePlain(c.text, source);
  if (!doc) return null;
  doc.source.note = c.note;
  return doc.lines.length || doc.plainText ? doc : null;
}

async function store(deps: LyricsDeps, settings: Settings, key: string, provider: string, doc: LyricDocument, raw: string, lengthSec?: number): Promise<void> {
  if (!settings.sources.useCache || !deps.cachePut || !raw.trim()) return;
  const format: LyricsCacheEntry['format'] = doc.source.format === 'lyricsfile' ? 'lyricsfile' : doc.source.format === 'ttml' ? 'ttml' : doc.timing === 'none' ? 'plain' : 'lrc';
  const now = Date.now();
  await deps
    .cachePut(key, {
      savedAt: now, checkedAt: now, provider, format, text: raw, label: doc.source.label, attribution: doc.source.attribution,
      match: doc.source.match, note: doc.source.note, lengthSec: lengthSec && Number.isFinite(lengthSec) ? Math.round(lengthSec * 10) / 10 : undefined,
    })
    .catch(() => undefined);
}

async function storeNotFound(deps: LyricsDeps, settings: Settings, key: string): Promise<void> {
  if (!settings.sources.useCache || !deps.cachePut) return;
  const c = deps.cacheGet ? await deps.cacheGet(key).catch(() => null) : null;
  if (c && c.format !== 'none') return; // never replace real lyrics with a "not found" marker
  await deps.cachePut(key, { savedAt: Date.now(), provider: 'none', format: 'none', text: '', label: 'Nothing found' }).catch(() => undefined);
}

export const LRCLIB_ATTRIBUTION = 'Lyrics from LRCLIB (lrclib.net), a community-contributed database';

export function docFromLrclib(r: LrclibRecord, match: LyricSource['match']): LyricDocument {
  const source = { kind: 'lrclib' as const, label: 'LRCLIB', attribution: LRCLIB_ATTRIBUTION, match };
  if (r.hasWordSync && r.lyricsfile) {
    const wordDoc = parseLyricsfile(r.lyricsfile, source);
    if (wordDoc?.timing === 'word') return wordDoc;
  }
  if (r.syncedLyrics) {
    const doc = parseLrc(r.syncedLyrics, source);
    doc.meta.title ??= r.trackName;
    doc.meta.artist ??= r.artistName;
    return doc;
  }
  return parsePlain(r.plainLyrics ?? '', source);
}

/**
 * Resolves lyrics for a track. Order: lyrics the user attached to this track →
 * demo lyrics → sidecar file → embedded tags → lyrics folder → saved copy of an
 * earlier online result → online providers (opt-in; LRCLIB and AMLL TTML DB queried
 * in parallel, scored alike, word timing preferred when the match is as strong).
 * The first *synced* result wins; otherwise the first unsynced one.
 * The caller discards results for tracks that are no longer current.
 */
export async function resolveLyrics(
  track: TrackInfo,
  settings: Settings,
  deps: LyricsDeps,
  signal?: { cancelled: boolean },
  opts: { refresh?: boolean; onProgress?: (result: LyricsResult) => void } = {},
): Promise<LyricsResult> {
  const tried: LyricsResult['tried'] = [];
  let unsynced: LyricDocument | null = null;
  let saved: LyricDocument | null = null;
  const consider = (doc: LyricDocument | null, label: string): LyricDocument | null => {
    if (!doc) {
      tried.push({ source: label, outcome: 'none' });
      return null;
    }
    if (doc.timing !== 'none' && doc.lines.length > 0) {
      tried.push({ source: label, outcome: doc.timing === 'word' ? 'word-synced' : 'line-synced' });
      return doc;
    }
    if (doc.plainText) {
      tried.push({ source: label, outcome: 'unsynced' });
      unsynced ??= doc;
    } else if (doc.meta.instrumental) {
      tried.push({ source: label, outcome: 'instrumental' });
    } else tried.push({ source: label, outcome: 'empty' });
    return null;
  };
  const done = (doc: LyricDocument): LyricsResult => ({ status: 'synced', doc, tried });

  // 1. A file the user attached to this exact track.
  const linked = settings.lyricLinks[track.key];
  if (linked) {
    const f = await deps.readLyricFile(linked).catch(() => null);
    const doc = f ? parseLyrics(f.text, { kind: 'local-file', label: f.name, match: 'manual' }, f.name) : null;
    if (!f) tried.push({ source: 'Attached file', outcome: 'missing' });
    else if (consider(doc, `Attached file (${f.name})`)) return done(doc!);
  }
  if (signal?.cancelled) return { status: 'idle', doc: null, tried };

  // 2. Demo
  if (track.demo) {
    try {
      const text = await deps.fetchText(track.demo.lyrics);
      const doc = parseLyrics(text, { kind: 'demo', label: 'Demo lyrics' }, track.demo.lyrics);
      if (consider(doc, 'Demo')) return done(doc);
    } catch (e) {
      tried.push({ source: 'Demo', outcome: `error: ${String(e)}` });
    }
  }

  // 3/4. Local file: sidecar and embedded tags.
  const local = track.local;
  if (local) {
    if (local.sidecar) {
      const doc = parseLyrics(local.sidecar.text, { kind: 'sidecar', label: local.sidecar.name }, local.sidecar.name);
      if (consider(doc, `Sidecar (${local.sidecar.name})`)) return done(doc);
    } else tried.push({ source: 'Sidecar .lrc', outcome: 'none' });
    if (local.embedded.syncedLrc) {
      const doc = parseLyrics(local.embedded.syncedLrc, { kind: 'embedded', label: 'Embedded synced lyrics' });
      if (consider(doc, 'Embedded synced lyrics')) return done(doc);
    }
    if (local.embedded.unsynced) consider(parsePlain(local.embedded.unsynced, { kind: 'embedded', label: 'Embedded lyrics' }), 'Embedded lyrics');
    if (!local.embedded.syncedLrc && !local.embedded.unsynced) tried.push({ source: 'Embedded tags', outcome: 'none' });
  }
  if (signal?.cancelled) return { status: 'idle', doc: null, tried };

  // 5. Lyrics folder
  if (settings.sources.lyricsFolder && track.title) {
    const f = await deps.findLyricsInFolder(settings.sources.lyricsFolder, track.artist ?? '', track.title).catch(() => null);
    const doc = f ? parseLyrics(f.text, { kind: 'local-file', label: f.name, match: 'probable' }, f.name) : null;
    if (consider(doc, 'Lyrics folder')) return done(doc!);
  }
  if (signal?.cancelled) return { status: 'idle', doc: null, tried };

  // 6. Online: saved copy first (instant, works offline), then all providers in parallel.
  let alternatives: LrclibRecord[] | undefined;
  let length: LengthUse | undefined;
  if (!track.demo && track.title) {
    if (!settings.sources.onlineLyrics) {
      tried.push({ source: 'Online sources', outcome: 'off (enable online lookup)' });
    } else {
      const { q, learned } = trackQuery(track, settings);
      length = { reportedSec: q.reportedDurationSec, usedSec: q.durationSec, learnedOffsetSec: learned };
      const now = Date.now();
      if (settings.sources.useCache && !opts.refresh && deps.cacheGet) {
        const c = await deps.cacheGet(track.key).catch(() => null);
        if (c?.format === 'none') {
          if (now - c.savedAt < NOT_FOUND_TTL_MS) {
            tried.push({ source: 'Online sources', outcome: `nothing found ${ago(now - c.savedAt)}; use Search again to retry` });
            if (unsynced) return { status: 'unsynced', doc: unsynced, tried, length };
            return { status: 'not-found', doc: null, tried, length };
          }
        } else if (c) {
          const doc = docFromCache(c);
          const lengthOff = lengthDeltaSec(q, c.lengthSec);
          if (doc && lengthOff !== undefined && Math.abs(lengthOff) > 3) {
            tried.push({ source: 'Saved copy', outcome: `skipped: saved for a ${Math.round(c.lengthSec!)} s version` });
          } else if (doc && consider(doc, `Saved copy (${c.label}, ${new Date(c.savedAt).toLocaleDateString()})`)) {
            const fresh = now - (c.checkedAt ?? c.savedAt) < RECHECK_AFTER_MS;
            if (fresh || !opts.onProgress || doc.timing === 'word' || c.match === 'manual') return { ...done(doc), length };
            // Older line-timed copy: show it now, look again in the background.
            saved = doc;
            opts.onProgress({ ...done(doc), tried: [...tried], length });
          }
        }
      }
      // A version the user explicitly picked earlier.
      const chosen = settings.lrclibChoices[track.key];
      if (chosen && deps.lrclibById && settings.sources.providers.lrclib) {
        const c = await deps.lrclibById(chosen).catch(() => null);
        if (c && c.ok && c.exact) {
          const doc = docFromLrclib(c.exact, 'manual');
          if (consider(doc, 'LRCLIB (your pick)')) {
            void store(deps, settings, track.key, 'lrclib', doc, doc.source.format === 'lyricsfile' ? c.exact.lyricsfile ?? '' : c.exact.syncedLyrics ?? c.exact.plainLyrics ?? '', q.durationSec);
            return { ...done(doc), length };
          }
        } else tried.push({ source: 'LRCLIB (your pick)', outcome: c && !c.ok ? c.error : 'unavailable' });
      }
      const jobs: Promise<ProviderOutcome>[] = [];
      if (settings.sources.providers.lrclib) jobs.push(lrclibProvider(q, deps));
      if (settings.sources.providers.amll && deps.amll) jobs.push(amllProvider(q, deps));
      if (!jobs.length) tried.push({ source: 'Online sources', outcome: 'all providers turned off' });
      // Publish a useful result immediately while the remaining providers run.
      const completed: ProviderOutcome[] = [];
      const outcomes = await Promise.all(jobs.map(async job => {
        const outcome = await job;
        completed.push(outcome);
        if (!signal?.cancelled && opts.onProgress) {
          const interim = chooseHit(completed.flatMap(o => o.hits));
          if (interim && !interim.loose && (!saved || interim.hit.doc.timing === 'word')) {
            opts.onProgress({ status: 'synced', doc: interim.hit.doc,
              tried: [...tried, ...completed.flatMap(o => o.tried)], alternatives: outcome.alternatives, length });
          }
        }
        return outcome;
      }));
      if (signal?.cancelled) return { status: 'idle', doc: null, tried };
      const hits: ProviderHit[] = [];
      let instrumental = false;
      let failed = false;
      let plain: { doc: LyricDocument; raw: string; provider: string } | null = null;
      for (const o of outcomes) {
        tried.push(...o.tried);
        hits.push(...o.hits);
        if (o.alternatives) alternatives = o.alternatives;
        if (o.instrumental) instrumental = true;
        if (o.failed) failed = true;
        if (o.plain && !plain) plain = o.plain;
        if (o.agreedLengthSec !== undefined && q.reportedDurationSec) {
          length = { ...length, usedSec: o.agreedLengthSec, measuredGapSec: o.agreedLengthSec - q.reportedDurationSec };
        }
      }
      const choice = chooseHit(hits);
      if (choice) {
        const { hit } = choice;
        const doc = hit.doc;
        doc.source.match = choice.loose ? 'loose' : hit.score >= 90 ? 'exact' : 'probable';
        const notes: string[] = [];
        if (doc.source.note) notes.push(doc.source.note);
        if (choice.loose) notes.push(`weak match (score ${hit.score}); check it is the right song`);
        if (hit.durationDeltaSec !== undefined && Math.abs(hit.durationDeltaSec) > 3)
          notes.push(`this version is ${Math.abs(hit.durationDeltaSec).toFixed(0)} s ${hit.durationDeltaSec > 0 ? 'longer' : 'shorter'}; check the recording; an offset may not correct this version`);
        if (choice.crossCheckMs !== undefined && Math.abs(choice.crossCheckMs) > 300)
          notes.push(`other source's timing differs by ${(choice.crossCheckMs / 1000).toFixed(1)} s`);
        doc.source.note = notes.join(' · ') || undefined;
        tried.push({ source: `Chosen: ${doc.source.label}`, outcome: `${doc.timing === 'word' ? 'word' : 'line'} timing, score ${hit.score}` });
        // Weak matches are shown but not saved, so the next play searches again.
        if (!choice.loose) void store(deps, settings, track.key, hit.provider, doc, hit.raw ?? '', length?.usedSec);
        // Keep this play on the copy already shown, unless the new one adds real word timing.
        if (saved && !(doc.timing === 'word' && saved.timing !== 'word')) return { ...done(saved), alternatives, length };
        return { status: 'synced', doc, tried, alternatives, length };
      }
      if (saved) return { ...done(saved), length };
      if (instrumental && !unsynced) return { status: 'instrumental', doc: null, tried, message: 'LRCLIB lists this track as instrumental.', length };
      if (plain && !unsynced) {
        consider(plain.doc, `${plain.doc.source.label} (unsynced)`);
        void store(deps, settings, track.key, plain.provider, plain.doc, plain.raw, length?.usedSec);
      }
      // Remember "nothing found" for a day, only when every provider actually answered.
      if (!plain && !instrumental && !failed && jobs.length) void storeNotFound(deps, settings, track.key);
    }
  }

  if (unsynced) return { status: 'unsynced', doc: unsynced, tried, alternatives, length };
  return { status: 'not-found', doc: null, tried, alternatives, length };
}
