#!/usr/bin/env node
/**
 * Generates Afterglow's offline demo songs.
 *
 * Everything here is original: procedurally synthesized instrumentals and a synthetic
 * espeak-ng guide vocal. Because this script *places* every vocal word, the word
 * timestamps written to the .elrc files are ground truth (measured from the trimmed
 * audio that was mixed in), not estimates. Tempo and downbeat are likewise known
 * exactly, so the beat pulse is legitimately beat-synchronized for these demos.
 *
 * Output: public/demo/<id>.ogg, <id>.elrc, <id>.svg and public/demo/manifest.json
 * Requires: espeak-ng, ffmpeg on PATH.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'demo');
const CACHE = join(process.env.AFTERGLOW_DEMO_CACHE ?? join(tmpdir(), 'afterglow-demo-cache'));
mkdirSync(OUT, { recursive: true });
mkdirSync(CACHE, { recursive: true });

const SR = 44100;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- utilities
let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const noise = () => rand() * 2 - 1;
const midi = (n) => 440 * 2 ** ((n - 69) / 12);
const NOTE = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
/** "Am" -> [57,60,64]; "Fmaj7" etc. Root octave 3/4. */
function chord(name, oct = 4) {
  const m = /^([A-G][#b]?)(m(?!aj))?(maj7|7|sus2|sus4|add9|5)?$/.exec(name);
  const root = 12 * (oct + 1) + NOTE[m[1]];
  const minor = !!m[2];
  const ext = m[3];
  let iv = minor ? [0, 3, 7] : [0, 4, 7];
  if (ext === 'maj7') iv = [...iv, 11];
  if (ext === '7') iv = [...iv, 10];
  if (ext === 'sus2') iv = [0, 2, 7];
  if (ext === 'sus4') iv = [0, 5, 7];
  if (ext === 'add9') iv = [...iv, 14];
  if (ext === '5') iv = [0, 7, 12];
  return iv.map((x) => root + x);
}

class Mix {
  constructor(seconds) {
    this.len = Math.ceil(seconds * SR);
    this.L = new Float32Array(this.len);
    this.R = new Float32Array(this.len);
    this.sendL = new Float32Array(this.len);
    this.sendR = new Float32Array(this.len);
  }
  /** add mono samples at time t (s) with gain and pan (-1..1), optional reverb send */
  add(t, buf, gain = 1, pan = 0, send = 0) {
    const off = Math.round(t * SR);
    const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < buf.length; i++) {
      const j = off + i;
      if (j < 0) continue;
      if (j >= this.len) break;
      const v = buf[i];
      this.L[j] += v * gl;
      this.R[j] += v * gr;
      if (send) {
        this.sendL[j] += v * gl * send;
        this.sendR[j] += v * gr * send;
      }
    }
  }
  reverb(size = 0.82, damp = 0.35, wet = 1) {
    const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
    const aps = [556, 441, 341, 225];
    const run = (input, spread) => {
      const out = new Float32Array(input.length);
      for (const c of combs) {
        const d = c + spread;
        const buf = new Float32Array(d);
        let idx = 0;
        let lp = 0;
        for (let i = 0; i < input.length; i++) {
          const y = buf[idx];
          lp = y * (1 - damp) + lp * damp;
          buf[idx] = input[i] + lp * size;
          idx = (idx + 1) % d;
          out[i] += y / combs.length;
        }
      }
      for (const a of aps) {
        const d = a + spread;
        const buf = new Float32Array(d);
        let idx = 0;
        for (let i = 0; i < out.length; i++) {
          const b = buf[idx];
          const y = -out[i] + b;
          buf[idx] = out[i] + b * 0.5;
          idx = (idx + 1) % d;
          out[i] = y;
        }
      }
      return out;
    };
    const rl = run(this.sendL, 0);
    const rr = run(this.sendR, 23);
    for (let i = 0; i < this.len; i++) {
      this.L[i] += rl[i] * wet;
      this.R[i] += rr[i] * wet;
    }
  }
  master(targetPeak = 0.89) {
    let peak = 0;
    for (let i = 0; i < this.len; i++) {
      this.L[i] = Math.tanh(this.L[i] * 1.1);
      this.R[i] = Math.tanh(this.R[i] * 1.1);
      peak = Math.max(peak, Math.abs(this.L[i]), Math.abs(this.R[i]));
    }
    const g = targetPeak / (peak || 1);
    for (let i = 0; i < this.len; i++) {
      this.L[i] *= g;
      this.R[i] *= g;
    }
  }
  wav() {
    const n = this.len;
    const b = Buffer.alloc(44 + n * 4);
    b.write('RIFF', 0);
    b.writeUInt32LE(36 + n * 4, 4);
    b.write('WAVEfmt ', 8);
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);
    b.writeUInt16LE(2, 22);
    b.writeUInt32LE(SR, 24);
    b.writeUInt32LE(SR * 4, 28);
    b.writeUInt16LE(4, 32);
    b.writeUInt16LE(16, 34);
    b.write('data', 36);
    b.writeUInt32LE(n * 4, 40);
    for (let i = 0; i < n; i++) {
      b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(this.L[i] * 32767))), 44 + i * 4);
      b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(this.R[i] * 32767))), 46 + i * 4);
    }
    return b;
  }
}

// ---------------------------------------------------------------- instruments
function env(i, n, a, r) {
  const t = i / SR;
  const len = n / SR;
  if (t < a) return t / a;
  if (t > len - r) return Math.max(0, (len - t) / r);
  return 1;
}
function kick({ f0 = 140, f1 = 46, decay = 0.32, click = 0.6, len = 0.45, drive = 1.2 } = {}) {
  const n = Math.round(len * SR);
  const b = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = f1 + (f0 - f1) * Math.exp(-t * 28);
    ph += (TAU * f) / SR;
    const a = Math.exp(-t / decay);
    b[i] = Math.tanh(Math.sin(ph) * a * drive) + (t < 0.004 ? noise() * click * (1 - t / 0.004) : 0);
  }
  return b;
}
function snare({ tone = 185, decay = 0.16, noiseAmt = 0.8, len = 0.3, bright = 0.55 } = {}) {
  const n = Math.round(len * SR);
  const b = new Float32Array(n);
  let lp = 0;
  let hp = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const x = noise();
    lp += (x - lp) * bright;
    hp = 0.92 * (hp + lp - prev);
    prev = lp;
    b[i] = hp * noiseAmt * Math.exp(-t / decay) + Math.sin(TAU * tone * t) * 0.5 * Math.exp(-t / 0.05);
  }
  return b;
}
function clap() {
  const n = Math.round(0.28 * SR);
  const b = new Float32Array(n);
  let hp = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const x = noise();
    hp = 0.85 * (hp + x - prev);
    prev = x;
    let e = Math.exp(-t / 0.09);
    for (const o of [0, 0.011, 0.022]) if (t >= o && t < o + 0.008) e = Math.max(e, 1.2 * (1 - (t - o) / 0.008));
    b[i] = hp * e * 0.7;
  }
  return b;
}
function hat({ decay = 0.035, len = 0.12, gain = 0.5 } = {}) {
  const n = Math.round(len * SR);
  const b = new Float32Array(n);
  let hp = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const x = noise();
    hp = 0.6 * (hp + x - prev);
    prev = x;
    b[i] = hp * Math.exp(-i / SR / decay) * gain;
  }
  return b;
}
function sub808(note, len, { glideFrom = null, drive = 1.8 } = {}) {
  const n = Math.round(len * SR);
  const b = new Float32Array(n);
  let ph = 0;
  const f = midi(note);
  const f0 = glideFrom ? midi(glideFrom) : f;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const ff = f + (f0 - f) * Math.exp(-t * 14) + (t < 0.02 ? f * 1.5 * (1 - t / 0.02) : 0);
    ph += (TAU * ff) / SR;
    b[i] = Math.tanh(Math.sin(ph) * drive) * 0.75 * env(i, n, 0.003, 0.08) * (0.55 + 0.45 * Math.exp(-t / 0.6));
  }
  return b;
}
function saw(ph) {
  return 2 * (ph - Math.floor(ph + 0.5));
}
function synthNote(note, len, { type = 'saw', cutoff = 1800, attack = 0.01, release = 0.12, detune = 0, voices = 1, gain = 0.25, decayTo = 1, decayTime = 0.3, res = 0 } = {}) {
  const n = Math.round(len * SR);
  const b = new Float32Array(n);
  const f = midi(note);
  const phs = Array.from({ length: voices }, () => rand());
  let y1 = 0;
  let y2 = 0;
  const g = 1 - Math.exp((-TAU * cutoff) / SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0;
    for (let v = 0; v < voices; v++) {
      const det = voices > 1 ? (v / (voices - 1) - 0.5) * detune : 0;
      phs[v] += (f * 2 ** (det / 1200)) / SR;
      const p = phs[v];
      s += type === 'saw' ? saw(p) : type === 'square' ? (p % 1 < 0.5 ? 1 : -1) : type === 'tri' ? 1 - 4 * Math.abs((p % 1) - 0.5) : Math.sin(TAU * p);
    }
    s /= Math.sqrt(voices);
    // two-pole lowpass
    y1 += g * (s - y1 + res * (y1 - y2));
    y2 += g * (y1 - y2);
    const dec = decayTo + (1 - decayTo) * Math.exp(-t / decayTime);
    b[i] = y2 * gain * env(i, n, attack, release) * dec;
  }
  return b;
}
function epiano(note, len, { gain = 0.22, index = 2.2, bright = 1 } = {}) {
  const n = Math.round(len * SR);
  const b = new Float32Array(n);
  const f = midi(note);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const I = index * bright * Math.exp(-t / 0.45);
    const mod = Math.sin(TAU * f * t) * I;
    b[i] = (Math.sin(TAU * f * t + mod) * 0.8 + Math.sin(TAU * 2 * f * t) * 0.1 * Math.exp(-t / 0.2)) * gain * Math.exp(-t / 1.6) * env(i, n, 0.004, 0.15);
  }
  return b;
}
function pluck(note, len, { gain = 0.3, damp = 0.996, bright = 0.5 } = {}) {
  const n = Math.round(len * SR);
  const b = new Float32Array(n);
  const p = Math.max(2, Math.round(SR / midi(note)));
  const ring = new Float32Array(p);
  for (let i = 0; i < p; i++) ring[i] = noise();
  let idx = 0;
  let last = 0;
  for (let i = 0; i < n; i++) {
    const cur = ring[idx];
    const nxt = (cur * bright + last * (1 - bright)) * damp;
    last = cur;
    ring[idx] = nxt;
    idx = (idx + 1) % p;
    b[i] = cur * gain * env(i, n, 0.001, 0.05);
  }
  return b;
}
function piano(note, len, { gain = 0.25 } = {}) {
  const n = Math.round(len * SR);
  const b = new Float32Array(n);
  const f = midi(note);
  const parts = [1, 0.5, 0.28, 0.16, 0.09, 0.05];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0;
    parts.forEach((a, k) => {
      s += a * Math.sin(TAU * f * (k + 1) * (1 + 0.0004 * k * k) * t) * Math.exp(-t * (0.8 + k * 0.9));
    });
    b[i] = s * gain * env(i, n, 0.002, 0.25);
  }
  return b;
}
function guitarChord(notes, len, { gain = 0.2, mute = false } = {}) {
  const n = Math.round(len * SR);
  const b = new Float32Array(n);
  const phs = notes.map(() => rand());
  let lp = 0;
  const g = 1 - Math.exp((-TAU * (mute ? 1400 : 3200)) / SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0;
    notes.forEach((nt, k) => {
      phs[k] += (midi(nt) * (1 + (k % 2 ? 0.003 : -0.002))) / SR;
      s += saw(phs[k]);
    });
    const dist = Math.tanh(s * 4.5);
    lp += g * (dist - lp);
    const e = mute ? Math.exp(-t / 0.09) : 0.6 + 0.4 * Math.exp(-t / 0.4);
    b[i] = lp * gain * e * env(i, n, 0.003, 0.04);
  }
  return b;
}
function riser(len, { gain = 0.25, up = true } = {}) {
  const n = Math.round(len * SR);
  const b = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const k = i / n;
    const fc = up ? 300 + 7000 * k * k : 7000 - 6700 * k;
    const g = 1 - Math.exp((-TAU * fc) / SR);
    lp += g * (noise() - lp);
    b[i] = lp * gain * (up ? k * k : 1 - k);
  }
  return b;
}
function crackle(seconds, gain = 0.06) {
  const n = Math.round(seconds * SR);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) if (rand() < 0.0009) b[i] = noise() * gain * 4;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp += 0.3 * (b[i] - lp);
    b[i] = lp + noise() * gain * 0.03;
  }
  return b;
}

// ---------------------------------------------------------------- vocals
function readWav(path) {
  const buf = readFileSync(path);
  let p = 12;
  let rate = 22050;
  let data = null;
  while (p < buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') rate = buf.readUInt32LE(p + 12);
    if (id === 'data') {
      data = new Float32Array(Math.floor(Math.min(size, buf.length - p - 8) / 2));
      for (let i = 0; i < data.length; i++) data[i] = buf.readInt16LE(p + 8 + i * 2) / 32768;
      break;
    }
    p += 8 + size + (size % 2);
  }
  return { rate, data };
}
function resample(data, from, to, factor = 1) {
  const ratio = (from / to) * factor;
  const n = Math.floor(data.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const k = Math.floor(x);
    const fr = x - k;
    out[i] = (data[k] ?? 0) * (1 - fr) + (data[k + 1] ?? 0) * fr;
  }
  return out;
}
function trim(data, thresh = 0.03) {
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  const th = peak * thresh;
  let a = 0;
  let z = data.length - 1;
  while (a < data.length && Math.abs(data[a]) < th) a++;
  while (z > a && Math.abs(data[z]) < th) z--;
  return data.slice(Math.max(0, a - 22), Math.min(data.length, z + 44));
}
const espeakCache = new Map();
function speak(word, { voice, speed, pitch }) {
  const key = `${voice}|${speed}|${pitch}|${word}`;
  if (espeakCache.has(key)) return espeakCache.get(key);
  const file = join(CACHE, `${Buffer.from(key).toString('base64url').slice(0, 120)}.wav`);
  if (!existsSync(file)) execFileSync('espeak-ng', ['-v', voice, '-s', String(speed), '-p', String(pitch), '-a', '160', '-w', file, word]);
  const { rate, data } = readWav(file);
  const out = trim(resample(data, rate, SR));
  espeakCache.set(key, out);
  return out;
}
/** Synthesize a word that fits in maxDur seconds; returns samples. */
function fitWord(word, maxDur, voiceOpts) {
  let speed = voiceOpts.speed;
  let w = speak(word, { ...voiceOpts, speed });
  for (let k = 0; k < 4 && w.length / SR > maxDur; k++) {
    speed = Math.min(520, Math.round(speed * (w.length / SR / maxDur) * 1.08));
    w = speak(word, { ...voiceOpts, speed });
    if (speed >= 520) break;
  }
  if (w.length / SR > maxDur) {
    const f = Math.min(1.35, w.length / SR / maxDur);
    w = resample(w, SR, SR, f);
  }
  const maxN = Math.round(maxDur * SR);
  if (w.length > maxN) {
    w = w.slice(0, maxN);
    const fade = Math.min(400, maxN);
    for (let i = 0; i < fade; i++) w[maxN - 1 - i] *= i / fade;
  }
  // gentle de-click and presence
  for (let i = 0; i < Math.min(80, w.length); i++) w[i] *= i / 80;
  return w;
}
function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

// ---------------------------------------------------------------- songs
const SONGS = [
  {
    id: 'night-shift',
    title: 'Night Shift Cypher',
    artist: 'Afterglow Demo',
    genre: 'Hip-Hop',
    bpm: 92,
    palette: ['#0d0d0d', '#ffd60a', '#f2efe6'],
    voice: { voice: 'en-us+m3', speed: 330, pitch: 32 },
    sections: [
      { inst: 2 },
      { slots: 16, lines: [
        'Clocked in at midnight with the city on a slow burn',
        'Every streetlight flicker is a page I gotta turn',
        'Pen on the pavement, I been writing what I learn',
        'Bass in the basement, now it is everybody turn',
        'Stack the words tall like the towers on the skyline',
        'Count it on the downbeat, never late, it is my time',
        'Window down, let the whole block feel the bassline',
        'Afterglow on the speaker and the night is mine',
      ] },
      { slots: 16, hook: true, lines: [
        'We keep it moving when the lights go low',
        'Every word lands right on the beat, you know',
        'We keep it moving when the lights go low',
        'Turn it up loud, let the afterglow show',
      ] },
      { inst: 2, riser: true },
      { slots: 24, lines: [
        'Rapid fire never tired got the wire take it higher',
        'Every letter on the meter getting sweeter call the reader',
      ] },
      { slots: 16, lines: ['Slow it down', 'Let the room breathe, then we go again'] },
      { slots: 16, hook: true, lines: [
        'We keep it moving when the lights go low',
        'Every word lands right on the beat, you know',
        'We keep it moving when the lights go low',
        'Turn it up loud, let the afterglow show',
      ] },
      { inst: 2, outro: true },
    ],
    arrange: arrangeBoomBap,
  },
  {
    id: 'chrome-hours',
    title: 'Chrome Hours',
    artist: 'Afterglow Demo',
    genre: 'Trap',
    bpm: 140,
    palette: ['#000000', '#c8d3e0', '#8a5cff'],
    voice: { voice: 'en-us+m7', speed: 250, pitch: 22 },
    sections: [
      { inst: 2 },
      { slots: 8, barsPerLine: 2, lines: ['Chrome on the dashboard', 'Ice in the night air', 'Hands on the wheel, I do not feel it', 'Red lights blur, I am already there'] },
      { slots: 8, barsPerLine: 2, hook: true, lines: ['Midnight, chrome hours', 'Midnight, chrome hours', 'Bass so low it moves the tower'] },
      { inst: 3, riser: true },
      { slots: 8, barsPerLine: 2, lines: ['No sleep, only static', 'Neon in the rear view, automatic'] },
      { slots: 8, barsPerLine: 2, hook: true, lines: ['Midnight, chrome hours', 'Midnight, chrome hours', 'Bass so low it moves the tower'] },
      { inst: 2, outro: true },
    ],
    arrange: arrangeTrap,
  },
  {
    id: 'slow-honey',
    title: 'Slow Honey',
    artist: 'Afterglow Demo',
    genre: 'R&B',
    bpm: 72,
    palette: ['#2a0f2e', '#c4622d', '#f6c7a1'],
    voice: { voice: 'en-us+f2', speed: 165, pitch: 58 },
    melody: [0, 2, 4, 2, 0, -1, 0, 4, 5, 4, 2, 0],
    sections: [
      { inst: 1 },
      { slots: 8, lines: ['Candle light on the window', 'You move slow like a love song', 'Every word that you whisper', 'Melts like honey, all night long'] },
      { slots: 8, hook: true, lines: ['Stay a little longer, baby', 'Let the evening hold us close', 'Stay a little longer, baby', 'Soft and slow is how it goes'] },
      { inst: 2 },
      { slots: 8, lines: ['Velvet on the radio', 'Golden in the afterglow'] },
      { inst: 1, outro: true },
    ],
    arrange: arrangeRnB,
  },
  {
    id: 'sugar-signal',
    title: 'Sugar Signal',
    artist: 'Afterglow Demo',
    genre: 'Pop',
    bpm: 120,
    palette: ['#ff3d7f', '#2f6bff', '#ffcf00'],
    voice: { voice: 'en-us+f3', speed: 215, pitch: 62 },
    melody: [0, 0, 2, 4, 4, 2, 0, 7, 5, 4, 2, 2],
    sections: [
      { inst: 2 },
      { slots: 8, lines: ['Woke up with a song stuck in my head', 'Pink and blue like the sky said', 'Turn the radio up to ten', 'Every chorus feels brand new again'] },
      { slots: 8, lines: ['Oh oh, here it comes'], riserBefore: true },
      { slots: 8, hook: true, lines: ['Sugar signal, light me up', 'Can not stop dancing, never enough', 'Sugar signal, light me up', 'Sugar signal, fill my cup'] },
      { inst: 3 },
      { slots: 8, lines: ['Hands up, hands up, one more time'] },
      { slots: 8, hook: true, lines: ['Sugar signal, light me up', 'Can not stop dancing, never enough', 'Sugar signal, light me up', 'Sugar signal, fill my cup'] },
      { inst: 2, outro: true },
    ],
    arrange: arrangePop,
  },
  {
    id: 'static-hearts',
    title: 'Static Hearts',
    artist: 'Afterglow Demo',
    genre: 'Alternative Rock',
    bpm: 150,
    palette: ['#e8e2d4', '#111111', '#d7261e'],
    voice: { voice: 'en-gb-x-rp+m4', speed: 230, pitch: 44 },
    sections: [
      { inst: 2 },
      { slots: 8, barsPerLine: 2, lines: ['Plug it in and turn it loud', 'Feedback screaming through the crowd', 'Paper walls and broken strings', 'We still sing the ugly things'] },
      { slots: 8, barsPerLine: 2, hook: true, lines: ['Static hearts, we do not break', 'Shake the floor until it shakes', 'Static hearts, we do not break', 'Static hearts, for goodness sake'] },
      { inst: 3 },
      { slots: 8, barsPerLine: 2, lines: ['One, two, three, four'] },
      { slots: 8, barsPerLine: 2, hook: true, lines: ['Static hearts, we do not break', 'Shake the floor until it shakes', 'Static hearts, we do not break', 'Static hearts, for goodness sake'] },
      { inst: 2, outro: true },
    ],
    arrange: arrangeRock,
  },
  {
    id: 'low-tide',
    title: 'Low Tide Lanterns',
    artist: 'Afterglow Demo',
    genre: 'Ambient',
    bpm: 64,
    palette: ['#1d2b3a', '#f2c8a0', '#7f9db5'],
    voice: { voice: 'en-gb+f4', speed: 135, pitch: 50 },
    melody: [0, 2, 4, 7, 4, 2, 0, -3],
    sections: [
      { inst: 2 },
      { slots: 8, lines: ['The tide pulls the lanterns home', 'Slowly, slowly'] },
      { inst: 2 },
      { slots: 8, lines: ['Salt on the window, quiet as snow', 'Breathe in, breathe out', 'Let the evening go'] },
      { inst: 1 },
      { slots: 8, lines: ['Lanterns', 'Low tide'] },
      { inst: 2, outro: true },
    ],
    arrange: arrangeAmbient,
  },
];

// ---------------------------------------------------------------- arrangements
function arrangeBoomBap(mix, s) {
  const bar = 240 / s.bpm;
  const st = bar / 16;
  const prog = ['Am', 'Am', 'F', 'E'];
  mix.add(0, crackle(s.total, 0.05), 0.35, 0.1);
  for (let b = 0; b < s.bars; b++) {
    const t0 = b * bar;
    const sec = s.barInfo[b];
    const sparse = sec.inst && !sec.outro && b < 2;
    const ch = chord(prog[b % 4], 3);
    // swung 16ths
    const at = (i) => t0 + i * st + (i % 2 ? st * 0.18 : 0);
    if (!sparse) {
      [0, 7, 10].forEach((i) => mix.add(at(i), kick({ f0: 150, decay: 0.28 }), 0.95));
      [4, 12].forEach((i) => mix.add(at(i), snare({ decay: 0.16, bright: 0.32 }), 0.42, 0.05, 0.12));
    } else {
      [0, 10].forEach((i) => mix.add(at(i), kick({ f0: 150, decay: 0.28 }), 0.5));
    }
    for (let i = 0; i < 16; i += 2) mix.add(at(i), hat({ decay: i % 4 === 2 ? 0.06 : 0.03 }), sec.inst ? 0.18 : 0.3, 0.3);
    // dusty keys chord stabs
    [0, 6, 11].forEach((i, k) => ch.forEach((n) => mix.add(at(i), epiano(n + 12, st * (k === 2 ? 5 : 4), { gain: 0.09, index: 1.2 }), 1, -0.2, 0.3)));
    // bass
    mix.add(at(0), synthNote(ch[0] - 12, st * 5, { type: 'tri', cutoff: 500, gain: 0.5, release: 0.05 }), 1);
    mix.add(at(8), synthNote(ch[0] - 12, st * 3, { type: 'tri', cutoff: 500, gain: 0.45, release: 0.05 }), 1);
    if (sec.riser && b === sec.endBar - 1) mix.add(t0, riser(bar), 0.7, 0, 0.3);
  }
}
function arrangeTrap(mix, s) {
  const bar = 240 / s.bpm;
  const st = bar / 16;
  const prog = ['Cm', 'Cm', 'Ab', 'G'];
  for (let b = 0; b < s.bars; b++) {
    const t0 = b * bar;
    const sec = s.barInfo[b];
    const ch = chord(prog[Math.floor(b / 2) % 4], 4);
    // dark pad
    ch.forEach((n) => mix.add(t0, synthNote(n, bar, { voices: 3, detune: 14, cutoff: 900, attack: 0.3, release: 0.4, gain: 0.07 }), 1, 0, 0.5));
    if (sec.inst && (b < 2 || sec.outro)) {
      mix.add(t0, sub808(ch[0] - 24, bar * 0.9), 0.4);
      continue;
    }
    // half-time: clap on beat 3
    mix.add(t0 + 8 * st, clap(), 0.7, 0, 0.15);
    // 808 pattern
    const ks = [0, 3, 10];
    ks.forEach((i, k) => mix.add(t0 + i * st, sub808(ch[0] - 24, st * (k === 2 ? 6 : 3), { glideFrom: k === 1 ? ch[0] - 19 : null }), 0.85));
    mix.add(t0, kick({ f0: 120, decay: 0.12, len: 0.2 }), 0.7);
    // hats with rolls
    for (let i = 0; i < 16; i += 2) {
      if (b % 2 === 1 && i >= 12) {
        for (let r = 0; r < 4; r++) mix.add(t0 + i * st + (r * st) / 2, hat({ decay: 0.02 }), 0.22, 0.25);
      } else mix.add(t0 + i * st, hat({ decay: 0.025 }), 0.28, 0.25);
    }
    // bell motif
    if (b % 2 === 0) [0, 3, 6, 10].forEach((i, k) => mix.add(t0 + i * st, epiano(ch[k % 3] + 24, st * 3, { gain: 0.05, index: 4 }), 1, 0.35, 0.5));
    if (sec.riser && b === sec.endBar - 1) mix.add(t0, riser(bar, { gain: 0.2 }), 0.6, 0, 0.4);
  }
}
function arrangeRnB(mix, s) {
  const bar = 240 / s.bpm;
  const st = bar / 16;
  const prog = ['Fmaj7', 'Em7', 'Dm7', 'Cmaj7'].map((c) => c.replace('m7', 'm').replace('Em', 'Em'));
  for (let b = 0; b < s.bars; b++) {
    const t0 = b * bar;
    const sec = s.barInfo[b];
    const name = ['Fmaj7', 'Em', 'Dm', 'Cmaj7'][b % 4];
    const ch = chord(name, 3);
    ch.forEach((n, k) => mix.add(t0 + k * 0.012, epiano(n + 12, bar * 0.98, { gain: 0.1, index: 1.4 }), 1, -0.15 + k * 0.1, 0.35));
    ch.forEach((n, k) => mix.add(t0 + 8 * st + k * 0.01, epiano(n + 12, bar * 0.48, { gain: 0.06, index: 1.0 }), 1, 0.1, 0.35));
    mix.add(t0, synthNote(ch[0] - 12, bar * 0.6, { type: 'sine', cutoff: 400, gain: 0.55, release: 0.2 }), 1);
    mix.add(t0 + 10 * st, synthNote(ch[0] - 12, bar * 0.3, { type: 'sine', cutoff: 400, gain: 0.45, release: 0.2 }), 1);
    if (sec.inst && b === 0) continue;
    [0, 9].forEach((i) => mix.add(t0 + i * st, kick({ f0: 110, decay: 0.3 }), 0.7));
    mix.add(t0 + 8 * st, snare({ decay: 0.22, bright: 0.35 }), 0.4, 0, 0.35);
    for (let i = 0; i < 16; i += 2) mix.add(t0 + i * st + (i % 4 ? st * 0.25 : 0), hat({ decay: 0.04 }), 0.12, -0.3);
  }
}
function arrangePop(mix, s) {
  const bar = 240 / s.bpm;
  const st = bar / 16;
  const prog = ['C', 'G', 'Am', 'F'];
  for (let b = 0; b < s.bars; b++) {
    const t0 = b * bar;
    const sec = s.barInfo[b];
    const ch = chord(prog[b % 4], 4);
    const big = sec.hook;
    // offbeat synth chords
    for (let i = 2; i < 16; i += 4) ch.forEach((n) => mix.add(t0 + i * st, synthNote(n, st * 1.6, { voices: 3, detune: 18, cutoff: big ? 3800 : 2600, gain: 0.06, release: 0.08 }), 1, 0, 0.25));
    // arpeggio pluck
    for (let i = 0; i < 16; i++) if (i % 2 === 0) mix.add(t0 + i * st, pluck(ch[(i / 2) % 3] + 12, st * 2, { gain: 0.12, bright: 0.6 }), 1, (i % 4 ? 0.4 : -0.4), 0.2);
    mix.add(t0, synthNote(ch[0] - 12, bar * 0.48, { type: 'square', cutoff: 700, gain: 0.25 }), 1);
    mix.add(t0 + 8 * st, synthNote(ch[0] - 12, bar * 0.48, { type: 'square', cutoff: 700, gain: 0.25 }), 1);
    if (sec.inst && b < 2) {
      [0, 8].forEach((i) => mix.add(t0 + i * st, kick({ f0: 130, decay: 0.2 }), 0.5));
      continue;
    }
    for (let i = 0; i < 16; i += 4) mix.add(t0 + i * st, kick({ f0: 140, decay: 0.22 }), 0.85);
    [4, 12].forEach((i) => mix.add(t0 + i * st, clap(), 0.6, 0, 0.2));
    for (let i = 2; i < 16; i += 4) mix.add(t0 + i * st, hat({ decay: 0.08 }), 0.25, 0.2);
    if (sec.riserBefore && b === sec.startBar) mix.add(t0, riser(bar, { gain: 0.25 }), 0.7, 0, 0.3);
  }
}
function arrangeRock(mix, s) {
  const bar = 240 / s.bpm;
  const st = bar / 8; // 8ths
  const prog = ['E5', 'E5', 'C5', 'D5'];
  for (let b = 0; b < s.bars; b++) {
    const t0 = b * bar;
    const sec = s.barInfo[b];
    const name = prog[Math.floor(b / 2) % 4];
    const ch = chord(name, 2);
    const open = sec.hook;
    if (open) mix.add(t0, guitarChord(ch, bar * 0.98, { gain: 0.16 }), 1, -0.5, 0.15);
    else for (let i = 0; i < 8; i++) mix.add(t0 + i * st, guitarChord(ch, st * 0.9, { gain: 0.15, mute: true }), 1, -0.5);
    if (open) mix.add(t0, guitarChord(ch.map((n) => n + 12), bar * 0.98, { gain: 0.1 }), 1, 0.5, 0.15);
    mix.add(t0, synthNote(ch[0] - 12, bar, { type: 'saw', cutoff: 600, gain: 0.25 }), 1);
    if (sec.inst && b < 2) continue;
    [0, 3, 5].forEach((i) => mix.add(t0 + i * st, kick({ f0: 130, decay: 0.18, drive: 1.6 }), 0.8));
    [2, 6].forEach((i) => mix.add(t0 + i * st, snare({ decay: 0.16, bright: 0.45, noiseAmt: 0.9 }), 0.5, 0, 0.25));
    for (let i = 0; i < 8; i++) mix.add(t0 + i * st, hat({ decay: open ? 0.12 : 0.04, gain: 0.4 }), 0.3, 0.3);
  }
}
function arrangeAmbient(mix, s) {
  const bar = 240 / s.bpm;
  const prog = ['Dmaj7', 'Bm', 'Gmaj7', 'A'];
  for (let b = 0; b < s.bars; b++) {
    const t0 = b * bar;
    const ch = chord(prog[b % 4].replace('maj7', 'maj7'), 3);
    ch.forEach((n) => mix.add(t0, synthNote(n + 12, bar * 1.15, { type: 'tri', voices: 2, detune: 8, cutoff: 1100, attack: 1.2, release: 1.2, gain: 0.09 }), 1, 0, 0.7));
    // sparse piano
    [0, 3, 6].forEach((beat8, k) => {
      if ((b + k) % 2 === 0) mix.add(t0 + (beat8 * bar) / 8, piano(ch[(k + b) % ch.length] + 24, bar * 0.9, { gain: 0.12 }), 1, k % 2 ? 0.3 : -0.3, 0.6);
    });
    mix.add(t0, synthNote(ch[0] - 12, bar, { type: 'sine', cutoff: 300, attack: 0.5, release: 0.6, gain: 0.2 }), 1);
  }
}

// ---------------------------------------------------------------- composition
function fmt(ms) {
  const t = Math.max(0, Math.round(ms));
  const m = Math.floor(t / 60000);
  const sec = Math.floor((t % 60000) / 1000);
  const msr = t % 1000;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(msr).padStart(3, '0')}`;
}

function buildSong(song) {
  seed = song.id.split('').reduce((a, c) => a + c.charCodeAt(0), 7);
  const bar = 240 / song.bpm;
  // lay out bars
  const barInfo = [];
  const placements = []; // {bar, slots, text, hook}
  for (const sec of song.sections) {
    const startBar = barInfo.length;
    if (sec.inst) {
      for (let i = 0; i < sec.inst; i++) barInfo.push({ inst: true, outro: !!sec.outro, riser: !!sec.riser, startBar, endBar: startBar + sec.inst });
      continue;
    }
    const bpl = sec.barsPerLine ?? 1;
    const n = sec.lines.length * bpl;
    for (let i = 0; i < n; i++) barInfo.push({ hook: !!sec.hook, riserBefore: !!sec.riserBefore, startBar, endBar: startBar + n });
    sec.lines.forEach((text, i) => placements.push({ bar: startBar + i * bpl, slots: sec.slots, text, hook: !!sec.hook, bpl }));
  }
  const bars = barInfo.length;
  const total = bars * bar + 2.5;
  const mix = new Mix(total);
  const s = { ...song, bars, barInfo, total };
  song.arrange(mix, s);

  // vocals
  const lrc = [
    `[ti:${song.title}]`,
    `[ar:${song.artist}]`,
    `[al:Afterglow Demo Reel]`,
    `[genre:${song.genre}]`,
    `[bpm:${song.bpm}]`,
    `[beat:0]`,
    `[length:${fmt(total * 1000)}]`,
    `[by:generated by scripts/generate-demo.mjs — word times are ground truth]`,
  ];
  const vocalBus = new Mix(total);
  let melodyIdx = 0;
  for (const p of placements) {
    const words = p.text.split(/\s+/);
    const syl = words.map(syllables);
    const totalSyl = syl.reduce((a, b) => a + b, 0);
    const slotsAvail = p.slots * p.bpl;
    const slotDur = (bar * p.bpl) / slotsAvail;
    // rap: 1 syllable per slot, melodic: stretch the last word
    const melodic = !!song.melody;
    let used = Math.min(slotsAvail - 1, totalSyl + (melodic ? Math.min(3, slotsAvail - 1 - totalSyl) : 0));
    const scale = totalSyl > slotsAvail - 1 ? (slotsAvail - 1) / totalSyl : 1;
    let cursor = melodic ? 0 : 0;
    const t0 = p.bar * bar;
    const parts = [];
    words.forEach((w, i) => {
      let len = syl[i] * scale;
      if (melodic && i === words.length - 1) len += Math.max(0, used - totalSyl);
      // commas breathe
      const comma = /,$/.test(w) ? 1 : 0;
      const start = t0 + cursor * slotDur;
      const maxDur = Math.max(0.09, len * slotDur * 0.94);
      const clean = w.replace(/[^A-Za-z']/g, '');
      const pitch = melodic ? Math.max(5, Math.min(95, song.voice.pitch + song.melody[melodyIdx++ % song.melody.length] * 3)) : song.voice.pitch + (i % 4 === 0 ? 4 : 0);
      const audio = fitWord(clean.toLowerCase(), maxDur, { ...song.voice, pitch });
      vocalBus.add(start, audio, 1.0, 0, 0.18);
      parts.push({ text: w, start: start * 1000, end: (start + audio.length / SR) * 1000 });
      cursor += len + (comma && !melodic ? 0.5 : 0);
    });
    const body = parts.map((q, i) => `<${fmt(q.start)}>${q.text}${i < parts.length - 1 ? ' ' : ''}`).join('') + `<${fmt(parts[parts.length - 1].end)}>`;
    lrc.push(`[${fmt(parts[0].start)}]${body}`);
  }
  // Duck the instrumental under the vocal so every word is clearly audible.
  mix.reverb(0.8, 0.35, 0.6);
  let envF = 0;
  for (let i = 0; i < mix.len; i++) {
    const v = Math.max(Math.abs(vocalBus.L[i]), Math.abs(vocalBus.R[i]));
    envF = v > envF ? envF + (v - envF) * 0.01 : envF * 0.99985;
    const duck = 1 - Math.min(0.5, envF * 2.2);
    mix.L[i] *= duck;
    mix.R[i] *= duck;
  }
  vocalBus.reverb(0.7, 0.4, 0.45);
  for (let i = 0; i < mix.len; i++) {
    mix.L[i] += vocalBus.L[i] * 1.6;
    mix.R[i] += vocalBus.R[i] * 1.6;
  }
  mix.master();
  return { mix, lrc: lrc.join('\n') + '\n', total };
}

function cover(song) {
  const [a, b, c] = song.palette;
  const t = song.title.toUpperCase();
  const shapes = {
    'night-shift': `<rect width="512" height="512" fill="${a}"/><circle cx="380" cy="150" r="120" fill="${b}"/><rect x="40" y="300" width="300" height="24" fill="${c}"/><rect x="40" y="340" width="220" height="24" fill="${c}" opacity=".6"/><text x="40" y="460" font-family="Impact, Anton, sans-serif" font-size="64" fill="${c}">${t.split(' ')[0]}</text>`,
    'chrome-hours': `<defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="${b}"/><stop offset=".52" stop-color="#3a4250"/><stop offset="1" stop-color="#cfd8e6"/></linearGradient></defs><rect width="512" height="512" fill="${a}"/><g stroke="${c}" stroke-width="2" opacity=".7">${Array.from({ length: 9 }, (_, i) => `<line x1="${256 - i * 60}" y1="512" x2="256" y2="300"/><line x1="${256 + i * 60}" y1="512" x2="256" y2="300"/>`).join('')}</g><circle cx="256" cy="230" r="110" fill="url(#g)"/>`,
    'slow-honey': `<defs><radialGradient id="g" cx=".35" cy=".4" r=".8"><stop offset="0" stop-color="${c}"/><stop offset=".45" stop-color="${b}"/><stop offset="1" stop-color="${a}"/></radialGradient></defs><rect width="512" height="512" fill="url(#g)"/><path d="M0 380 C 140 300 300 460 512 340 L512 512 L0 512Z" fill="${a}" opacity=".55"/>`,
    'sugar-signal': `<rect width="512" height="512" fill="${c}"/><circle cx="160" cy="180" r="130" fill="${a}"/><circle cx="350" cy="320" r="150" fill="${b}" opacity=".9"/><path d="M60 450 Q 140 380 220 450 T 380 450 T 540 450" stroke="#fff" stroke-width="18" fill="none"/>`,
    'static-hearts': `<rect width="512" height="512" fill="${a}"/><g fill="${b}">${Array.from({ length: 40 }, (_, i) => `<rect x="0" y="${i * 13}" width="512" height="${(i * 7) % 5 + 1}" opacity="${((i * 37) % 10) / 22}"/>`).join('')}</g><path d="M256 420 L120 280 A70 70 0 1 1 256 180 A70 70 0 1 1 392 280 Z" fill="${c}" transform="rotate(-6 256 300)"/>`,
    'low-tide': `<defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset=".62" stop-color="${c}"/><stop offset=".63" stop-color="#2b3d52"/><stop offset="1" stop-color="${a}"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><circle cx="330" cy="300" r="46" fill="${b}"/><g fill="${b}" opacity=".8"><circle cx="120" cy="360" r="5"/><circle cx="170" cy="372" r="4"/><circle cx="220" cy="356" r="5"/></g>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${shapes[song.id]}</svg>`;
}

const manifest = [];
const tmpWav = join(CACHE, 'mix.wav');
for (const song of SONGS) {
  const t0 = Date.now();
  const { mix, lrc, total } = buildSong(song);
  writeFileSync(tmpWav, mix.wav());
  const ogg = join(OUT, `${song.id}.ogg`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmpWav, '-c:a', 'libopus', '-b:a', '112k', ogg]);
  writeFileSync(join(OUT, `${song.id}.elrc`), lrc);
  writeFileSync(join(OUT, `${song.id}.svg`), cover(song));
  manifest.push({
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: 'Afterglow Demo Reel',
    genre: song.genre,
    bpm: song.bpm,
    beatOffsetMs: 0,
    durationMs: Math.round(total * 1000),
    audio: `demo/${song.id}.ogg`,
    lyrics: `demo/${song.id}.elrc`,
    artwork: `demo/${song.id}.svg`,
    palette: song.palette,
  });
  console.log(`${song.id}: ${total.toFixed(1)}s in ${Date.now() - t0}ms`);
}
rmSync(tmpWav, { force: true });
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ generatedBy: 'scripts/generate-demo.mjs', note: 'Original synthesized demo material. Vocals are espeak-ng speech placed at exact word onsets.', tracks: manifest }, null, 2));
console.log('wrote', join(OUT, 'manifest.json'));
