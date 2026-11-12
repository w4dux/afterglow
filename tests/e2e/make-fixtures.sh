#!/usr/bin/env bash
# Creates audio fixtures for the Electron e2e test from the generated demo audio.
set -euo pipefail
OUT="${1:?output dir}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$OUT"
SRC="$ROOT/public/demo/static-hearts.ogg"
ffmpeg -y -loglevel error -i "$SRC" -t 30 -c:a libmp3lame -b:a 128k -id3v2_version 3 \
  -metadata title="Paper Lanterns" -metadata artist="Test Artist" -metadata album="Fixtures" -metadata genre="Alternative" \
  "$OUT/tagged-song.mp3"
cat > "$OUT/tagged-song.lrc" <<'LRC'
[ti:Paper Lanterns]
[ar:Test Artist]
[00:03.20]Plug it in and turn it loud
[00:06.40]Feedback screaming through the crowd
[00:09.60]Paper walls and broken strings
[00:12.80]We still sing the ugly things
[00:16.00]
LRC
ffmpeg -y -loglevel error -i "$SRC" -t 20 -c:a libmp3lame -b:a 96k -id3v2_version 3 \
  -metadata title="Embedded Only" -metadata artist="Test Artist" "$OUT/embedded-only.mp3"
# Embedded unsynced (USLT) and synced (SYLT, ms timestamps) lyrics frames via mutagen.
python3 - "$OUT/embedded-only.mp3" <<'PY'
import sys
from mutagen.id3 import ID3, USLT, SYLT, Encoding
tags = ID3(sys.argv[1])
tags.add(USLT(encoding=Encoding.UTF8, lang='eng', desc='', text='First embedded line\nSecond embedded line'))
tags.add(SYLT(encoding=Encoding.UTF8, lang='eng', format=2, type=1, desc='', text=[('First embedded line', 3200), ('Second embedded line', 6400)]))
tags.save(v2_version=3)
PY
ffmpeg -y -loglevel error -i "$ROOT/public/demo/low-tide.ogg" -t 15 -c:a libopus -b:a 64k \
  -metadata title="No Lyrics Anywhere" -metadata artist="Nobody" "$OUT/no-lyrics.ogg"
ls -la "$OUT"
