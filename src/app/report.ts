import type { LyricsResult } from '../lyrics/LyricsResolver';
import type { Settings } from '../core/settings/schema';
import type { CorrectionEvent, SyncSnapshot } from '../core/sync/SyncEngine';
import type { TrackInfo } from '../playback/adapters';
import type { SystemInfo } from '../playback/SystemMediaAdapter';
import type { AppInfo } from '../shared/api';

export interface ReportInput {
  now: Date;
  info: AppInfo | null;
  settings: Settings;
  source: string;
  track: TrackInfo | null;
  lyrics: LyricsResult;
  themeId: string;
  /** Why that theme was chosen, e.g. "Known genre · Hip-Hop/Rap (Apple catalogue)". */
  themeLabel?: string;
  offsetMs: number;
  sync: SyncSnapshot;
  corrections: readonly CorrectionEvent[];
  system: SystemInfo | null;
  frameCost: { avg: number; p95: number };
  logTail: string[];
}

const n = (x: number | null | undefined, d = 0) => (x === null || x === undefined || !Number.isFinite(x) ? '-' : x.toFixed(d));

/**
 * Plain-text report the user can paste into a message when something looks wrong.
 * It holds what Afterglow knows about the current song, the timing state and recent
 * log lines. It holds no file paths beyond the app's own folder, no account data, and
 * is only ever copied to the clipboard by the user.
 */
export function buildReport(r: ReportInput): string {
  const s = r.settings;
  const t = r.track;
  const doc = r.lyrics.doc;
  const st = r.sync.stats;
  const len = r.lyrics.length;
  const learned = Object.entries(s.learned.lengthOffsets).map(([k, v]) => `${k}: [${v.join(', ')}]`);
  const out: (string | undefined)[] = [
    'Afterglow diagnostics report',
    `Created ${r.now.toISOString()}`,
    '',
    '## App',
    `version ${r.info?.version ?? '-'} · ${r.info?.platform ?? '-'} · Electron ${r.info?.electron ?? '-'} · Chrome ${r.info?.chrome ?? '-'}`,
    `media bridge ${r.info?.bridgeAvailable ? 'present' : 'missing'}`,
    '',
    '## Song',
    `source ${r.source}${t?.app ? ` (${t.app})` : ''}`,
    t ? `"${t.title ?? '-'}" by ${t.artist ?? '-'} · album ${t.album ?? '-'} · player length ${n(t.durationMs ? t.durationMs / 1000 : undefined, 1)} s` : 'no song',
    '',
    '## Lyrics',
    `status ${r.lyrics.status}${doc ? ` · ${doc.source.label} · ${doc.timing} timing · ${doc.lines.length} lines · first line ${n(doc.lines[0]?.startMs)} ms` : ''}`,
    doc?.source.match ? `match ${doc.source.match}` : undefined,
    doc?.source.note ? `note ${doc.source.note}` : undefined,
    len ? `length: player ${n(len.reportedSec, 1)} s, used ${len.usedSec !== undefined ? `${n(len.usedSec, 1)} s` : 'a range'}, learned correction ${len.learnedOffsetSec !== undefined ? `${n(len.learnedOffsetSec, 1)} s` : 'not yet'}, this song ${len.measuredGapSec !== undefined ? `${n(len.measuredGapSec, 1)} s` : 'not measured'}` : undefined,
    ...r.lyrics.tried.map((x) => `tried ${x.source}: ${x.outcome}`),
    '',
    '## Timing',
    `offset now ${r.offsetMs} ms (global ${s.timing.globalOffsetMs} ms, ${Object.keys(s.timing.trackOffsets).length} songs with their own correction)`,
    `quality ${r.sync.quality}: ${r.sync.qualityReason}`,
    `position ${n(r.sync.positionMs)} ms · playing ${r.sync.playing} · rate ${n(r.sync.rate, 2)} · last report age ${n(r.sync.observationAgeMs)} ms`,
    `reports ok ${st.accepted} rejected ${st.rejected} duplicates ${st.duplicates} · snaps ${st.snaps} slews ${st.slews} seeks ${st.seeks} holds ${st.holds}`,
    `error mean ${n(st.meanAbsErrorMs, 1)} p95 ${n(st.p95AbsErrorMs, 1)} max ${n(st.maxAbsErrorMs, 1)} ms (n=${st.samples})`,
    learned.length ? `learned song-length gaps ${learned.join('; ')}` : 'learned song-length gaps none yet',
    `estimated sweep ${s.motion.estimatedSweep ? 'on' : 'off'} · theme ${r.themeId}${r.themeLabel ? ` (${r.themeLabel})` : ''} · scene ${n(r.frameCost.avg, 2)} ms avg, ${n(r.frameCost.p95, 2)} ms p95`,
    '',
    '## Recent corrections',
    ...r.corrections.slice(-20).map((e) => `${e.kind}${e.errorMs !== undefined ? ` ${e.errorMs > 0 ? '+' : ''}${e.errorMs.toFixed(0)} ms` : ''} at ${e.positionMs.toFixed(0)} ms${e.reason ? ` (${e.reason})` : ''}`),
    '',
  ];
  if (r.system) {
    out.push(
      '## Windows media session',
      `bridge ${r.system.bridge}${r.system.message ? ` (${r.system.message})` : ''} · app ${r.system.app ?? '-'} · status ${r.system.status ?? '-'}`,
      `timeline ${r.system.timelineAvailable ?? '-'} · update interval ${n(r.system.timelineIntervalMs)} ms · counts ${Object.entries(r.system.counts).map(([k, v]) => `${k}:${v}`).join(' ')}`,
      '',
    );
  }
  out.push(
    '## Settings',
    `online lyrics ${s.sources.onlineLyrics ? 'on' : 'off'} (LRCLIB ${s.sources.providers.lrclib ? 'on' : 'off'}, AMLL ${s.sources.providers.amll ? 'on' : 'off'}, saved copies ${s.sources.useCache ? 'on' : 'off'}) · follow media ${s.sources.followSystemMedia ? 'on' : 'off'} · lyrics folder ${s.sources.lyricsFolder ? 'set' : 'none'}`,
    '',
    `## Log (last ${r.logTail.length} lines)`,
    ...r.logTail,
  );
  return out.filter((l): l is string => l !== undefined).join('\n');
}
