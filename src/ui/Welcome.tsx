import { useEffect, useRef, useState } from 'react';
import { controller } from '../app/controller';
import { native } from '../app/platform';
import { appDisplayName } from '../playback/SystemMediaAdapter';
import type { MediaPeek } from '../shared/api';
import { Toggle } from './panels/Panel';

/**
 * First run (Windows, Linux): one question, one click. "Follow Spotify" turns on following
 * the system media session and, unless unticked, online lyric lookup. The demo stays
 * one click away. Shown once; settings can be changed later in Music & lyrics (S).
 */
export function Welcome() {
  const [peek, setPeek] = useState<MediaPeek | null | undefined>(undefined);
  const [online, setOnline] = useState(true);
  const primary = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    void native?.mediaPeek().then((p) => alive && setPeek(p), () => alive && setPeek(null));
    primary.current?.focus({ preventScroll: true });
    return () => {
      alive = false;
    };
  }, []);

  const app = peek?.app ? appDisplayName(peek.app) : null;
  const playing = !!peek?.app && !!peek.title;
  const followLabel = app && !/spotify/i.test(app) ? `Follow ${app}` : 'Follow Spotify';

  return (
    <div className="modal-back welcome-back" onKeyDown={(e) => e.key === 'Escape' && controller.finishWelcome('demo', online)}>
      <div className="modal welcome" role="dialog" aria-labelledby="welcome-title">
        <h2 id="welcome-title">Lyrics for the music you play</h2>
        <p>
          {playing ? (
            <>
              {app} is playing <b>“{peek!.title}”</b>
              {peek!.artist ? <> by {peek!.artist}</> : null}. Afterglow can show its lyrics in time with the music.
            </>
          ) : peek === undefined ? (
            'Looking for music that is playing…'
          ) : (
            'Play a song in Spotify and Afterglow shows its lyrics in time with the music. It follows along as you skip, pause and seek.'
          )}
        </p>
        <Toggle
          label="Find lyrics online"
          checked={online}
          onChange={setOnline}
          hint="Sends the song’s title, artist, album and length to lrclib.net, a public lyrics list on GitHub, and Apple’s public music catalogue (for the genre). No account and nothing else is sent."
        />
        <div className="row-actions">
          <button ref={primary} className="chip strong big" onClick={() => controller.finishWelcome('follow', online)}>
            {followLabel}
          </button>
          <button className="chip" onClick={() => controller.finishWelcome('demo', online)}>
            Try the demo first
          </button>
        </div>
        <p className="note">Works with the Spotify app on {native?.platform === 'linux' ? 'Linux' : 'Windows'} without logging in. You can change this any time under Music &amp; lyrics (S).</p>
      </div>
    </div>
  );
}
