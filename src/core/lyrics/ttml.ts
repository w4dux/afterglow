import { type LyricDocument, type LyricLine, type LyricSource, type LyricWord, docTimingOf, finalizeLines, untimedWords } from './model';
import { parseLooseTime } from './lrc';

/**
 * Minimal TTML lyric parser (the subset used by word-timed lyric files):
 *   <tt><body><div><p begin end>[text | <span begin end>word</span>]*</p></div></body></tt>
 * Times are treated as absolute media times. Spans with ttm:role="x-bg" are marked
 * as background vocals. Frame-based clock values are not supported.
 */

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR.lastIndex = 0;
  while ((m = ATTR.exec(s))) out[m[1]] = m[2] ?? m[3] ?? '';
  return out;
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function local(name: string): string {
  const i = name.indexOf(':');
  return i >= 0 ? name.slice(i + 1) : name;
}

function timeOf(a: Record<string, string>, key: 'begin' | 'end'): number | undefined {
  const v = a[key];
  if (v === undefined) return undefined;
  return parseLooseTime(v);
}

export function looksLikeTtml(text: string): boolean {
  return /<tt[\s>]/.test(text) && /<p[\s>]/.test(text);
}

interface Frame {
  name: string;
  begin?: number;
  end?: number;
  bg: boolean;
  /** Translation / romanization text: not part of the sung words. */
  skip: boolean;
  /** Where skipped text goes, when it is a translation or romanization. */
  extra?: 'translation' | 'romanization';
}

const SKIP_ROLES = new Set(['x-translation', 'x-roman', 'x-romanization', 'x-transliteration']);
const extraOf = (role?: string): Frame['extra'] =>
  role === 'x-translation' ? 'translation' : role && SKIP_ROLES.has(role) ? 'romanization' : undefined;

interface Current {
  begin?: number;
  end?: number;
  words: LyricWord[];
  untimed: string;
  agent?: string;
  key?: string;
  translation: string;
  romanization: string;
}

export function parseTtml(input: string, source: Omit<LyricSource, 'format'>): LyricDocument {
  const lines: (LyricLine & { agent?: string; sourceKey?: string })[] = [];
  const meta: LyricDocument['meta'] = {};
  const stack: Frame[] = [];
  let inBody = false;
  let current: Current | null = null;
  let titleCapture: 'title' | null = null;
  // Singers declared in the head: <ttm:agent type="person|group" xml:id="v1"/>
  const agentTypes = new Map<string, string>();
  // Apple-style head translations: <translation><text for="L1">…</text></translation>
  const headExtra = { translation: new Map<string, string>(), romanization: new Map<string, string>() };
  let headSection: 'translation' | 'romanization' | null = null;
  let headText: { kind: 'translation' | 'romanization'; key: string } | null = null;

  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(input))) {
    if (m[0].startsWith('<!--') || m[0].startsWith('<?')) continue;
    const text = m[5];
    if (text !== undefined) {
      const t = decode(text);
      if (titleCapture === 'title' && t.trim()) meta.title = t.trim();
      if (headText && !inBody) {
        const map = headExtra[headText.kind];
        map.set(headText.key, (map.get(headText.key) ?? '') + t);
        continue;
      }
      if (!current) continue;
      const top = stack[stack.length - 1];
      if (top?.skip) {
        const extra = [...stack].reverse().find((f) => f.extra)?.extra;
        if (extra) current[extra] += t;
        continue;
      }
      const timedSpan = top && top.name === 'span' && top.begin !== undefined;
      if (timedSpan) {
        const trimmed = t.trim();
        if (trimmed) {
          const prevW = current.words[current.words.length - 1];
          if (prevW && /^\s/.test(t)) prevW.space = true;
          current.words.push({
            text: trimmed,
            startMs: top.begin!,
            endMs: top.end ?? NaN,
            space: /\s$/.test(t),
            bg: stack.some((f) => f.bg) || undefined,
          });
        }
      } else if (current.words.length > 0) {
        // Untimed text inside a timed line: whitespace marks word boundaries, punctuation attaches.
        const prevW = current.words[current.words.length - 1];
        if (/\s/.test(t)) prevW.space = true;
        const trimmed = t.trim();
        if (trimmed) prevW.text += (/^\s/.test(t) ? ' ' : '') + trimmed;
      } else {
        current.untimed += t;
      }
      continue;
    }

    const closing = m[1] === '/';
    const name = local(m[2]);
    const selfClosing = m[4] === '/';
    const a = attrs(m[3] ?? '');

    if (!closing) {
      if (name === 'body') inBody = true;
      if (name === 'title') titleCapture = 'title';
      if (name === 'br' && current) {
        const prevW = current.words[current.words.length - 1];
        if (prevW) prevW.space = true;
        else current.untimed += ' ';
      }
      if (name === 'body' && a['dur']) {
        const d = parseLooseTime(a['dur']);
        if (d !== undefined && d > 0) meta.lengthMs = d;
      }
      // AMLL / Apple-style metadata: <amll:meta key="musicName" value="…"/>
      if (name === 'meta' && a['key'] && a['value'] !== undefined) {
        const v = decode(a['value']).trim();
        if (a['key'] === 'musicName' && v) meta.title ??= v;
        if (a['key'] === 'artists' && v) meta.artist = meta.artist ? `${meta.artist}, ${v}` : v;
        if (a['key'] === 'album' && v) meta.album ??= v;
      }
      if (name === 'agent' && !inBody) {
        const id = a['xml:id'] ?? a['id'];
        if (id) agentTypes.set(id, a['type'] ?? 'person');
      }
      if (!inBody && (name === 'translation' || name === 'transliteration' || name === 'romanization')) {
        headSection = name === 'translation' ? 'translation' : 'romanization';
      }
      if (!inBody && name === 'text' && headSection && a['for'] && !selfClosing) headText = { kind: headSection, key: a['for'] };
      if (selfClosing) continue;
      const parent = stack[stack.length - 1];
      const role = a['ttm:role'] ?? a['role'];
      const frame: Frame = {
        name,
        begin: timeOf(a, 'begin'),
        end: timeOf(a, 'end'),
        bg: role === 'x-bg' || (parent?.bg ?? false),
        skip: (role !== undefined && SKIP_ROLES.has(role)) || (parent?.skip ?? false),
        extra: extraOf(role),
      };
      if (frame.begin !== undefined && frame.end === undefined && a['dur']) {
        const d = parseLooseTime(a['dur']);
        if (d !== undefined) frame.end = frame.begin + d;
      }
      stack.push(frame);
      if (name === 'p' && inBody) {
        current = {
          begin: frame.begin, end: frame.end, words: [], untimed: '', translation: '', romanization: '',
          agent: a['ttm:agent'] ?? a['agent'], key: a['itunes:key'] ?? a['key'],
        };
      }
    } else {
      if (name === 'title') titleCapture = null;
      if (name === 'text') headText = null;
      if (name === 'translation' || name === 'transliteration' || name === 'romanization') headSection = null;
      // pop to the matching element
      let idx = stack.length - 1;
      while (idx >= 0 && stack[idx].name !== name) idx--;
      if (idx < 0) continue;
      stack.length = idx;
      if (name === 'p' && current) {
        pushLine(lines, current);
        current = null;
      }
      if (name === 'body') inBody = false;
    }
  }

  // Singers: numbered in order of first appearance; groups are 0 ("everyone").
  const voices = new Map<string, number>();
  const isGroup = (id: string) => (agentTypes.get(id) ?? (/1000$/.test(id) ? 'group' : 'person')) === 'group';
  for (const l of lines) {
    if (l.agent && !isGroup(l.agent) && !voices.has(l.agent)) voices.set(l.agent, voices.size + 1);
  }
  const clean = (s?: string) => s?.replace(/\s+/g, ' ').trim() || undefined;
  for (const l of lines) {
    // Only songs with two or more singers get voices; a single named singer adds nothing.
    if (l.agent && voices.size >= 2) l.voice = isGroup(l.agent) ? 0 : voices.get(l.agent);
    if (l.sourceKey) {
      l.translation ??= clean(headExtra.translation.get(l.sourceKey));
      l.romanization ??= clean(headExtra.romanization.get(l.sourceKey));
    }
    delete l.agent;
    delete l.sourceKey;
  }
  const finalized = finalizeLines(lines, meta.lengthMs);
  return { timing: docTimingOf(finalized), lines: finalized, meta, source: { ...source, format: 'ttml' } };
}

function pushLine(lines: (LyricLine & { agent?: string; sourceKey?: string })[], c: Current): void {
  const extra = {
    agent: c.agent,
    sourceKey: c.key,
    translation: c.translation.replace(/\s+/g, ' ').trim() || undefined,
    romanization: c.romanization.replace(/\s+/g, ' ').trim() || undefined,
  };
  if (c.words.length > 0) {
    const words = c.words;
    words[words.length - 1].space = false;
    const begin = c.begin ?? words[0].startMs;
    const end = c.end ?? words[words.length - 1].endMs;
    lines.push({
      index: 0,
      startMs: Math.min(begin, words[0].startMs),
      endMs: end,
      endKnown: Number.isFinite(end),
      text: words.map((w) => w.text + (w.space ? ' ' : '')).join(''),
      words,
      wordTiming: 'exact',
      ...extra,
    });
    return;
  }
  const text = c.untimed.replace(/\s+/g, ' ').trim();
  if (!text || c.begin === undefined) return;
  lines.push({
    index: 0,
    startMs: c.begin,
    endMs: c.end ?? NaN,
    endKnown: c.end !== undefined,
    text,
    words: untimedWords(text, c.begin, c.end ?? c.begin),
    wordTiming: 'none',
    ...extra,
  });
}
