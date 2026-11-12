/** Recording identity preserves version labels; broad song keys remain for themes. */
export function recordingKey(source: string, artist = '', title = '', album = '', id = ''): string {
  const norm = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  return `rec:${JSON.stringify([source, artist, title, album, id].map(norm))}`;
}
