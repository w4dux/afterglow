import { protocol } from 'electron';
import { createReadStream, promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';

/**
 * `afterglow-media://track/<token>` streams a local audio file the user explicitly
 * opened. Only files registered through `grant()` are served (no arbitrary paths),
 * and HTTP Range requests are honoured so the audio element can seek.
 */
export const MEDIA_SCHEME = 'afterglow-media';

const granted = new Map<string, string>();

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp4': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

export const AUDIO_EXTENSIONS = Object.keys(MIME).map((e) => e.slice(1));

export function registerMediaSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  ]);
}

export function grant(filePath: string): string {
  for (const [tok, p] of granted) if (p === filePath) return `${MEDIA_SCHEME}://track/${tok}`;
  const token = randomBytes(12).toString('hex');
  granted.set(token, filePath);
  return `${MEDIA_SCHEME}://track/${token}`;
}

export function installMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    const token = url.pathname.replace(/^\/+/, '');
    const filePath = granted.get(token);
    if (!filePath) return new Response('not found', { status: 404 });
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return new Response('file missing', { status: 404 });
    }
    const size = stat.size;
    const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const range = request.headers.get('range');
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (m && !m[1] && m[2]) {
        start = Math.max(0, size - parseInt(m[2], 10));
        end = size - 1;
      }
      if (start >= size || end < start) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      end = Math.min(end, size - 1);
      const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' },
    });
  });
}
