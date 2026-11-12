import { controller } from '../app/controller';
import { isElectron, native } from '../app/platform';
import { mediaControlsName } from '../app/os';
import { setUi, useApp } from '../app/store';
import { WhereWeLooked } from './panels/SourcesPanel';

/** A status card over a dimmed stage, so the theme's own text never clashes with it. */
function Card({ title, children, quiet }: { title: string; children: React.ReactNode; quiet?: boolean }) {
  return (
    <>
      <div className="status-scrim" aria-hidden="true" />
      <div className={`status-card${quiet ? ' quiet' : ''}`} role="status">
        <h2>{title}</h2>
        {children}
      </div>
    </>
  );
}

/**
 * Honest states over the stage: searching, nothing found, unsynced text,
 * instrumental, no media session, and "position unavailable". Plain words first;
 * the technical "where we looked" list is one click away.
 */
export function StatusLayer() {
  const lyrics = useApp((s) => s.lyrics);
  const track = useApp((s) => s.track);
  const source = useApp((s) => s.source);
  const system = useApp((s) => s.system);
  const sync = useApp((s) => s.sync);
  const online = useApp((s) => s.settings.sources.onlineLyrics);
  const doc = lyrics.doc;
  const controls = mediaControlsName(useApp.getState().info?.platform ?? native?.platform);

  if (source === 'system' && system && (system.bridge === 'unavailable' || system.bridge === 'error')) {
    return (
      <Card title={`Can’t connect to ${controls}`}>
        <p>{system.message ?? `Afterglow could not start its connection to ${controls}.`}</p>
        <div className="row-actions">
          <button className="chip strong" onClick={() => controller.followSystem(false)}>
            Stop following
          </button>
          <button className="chip" onClick={() => void controller.playDemo(useApp.getState().demos[0]?.id)}>
            Try the demo instead
          </button>
        </div>
      </Card>
    );
  }
  if (source === 'system' && (!track || track.key === 'system:none')) {
    return (
      <Card title="Press play in Spotify">
        <p>The lyrics appear as soon as a song starts. Afterglow also follows other apps that show up in {controls}.</p>
        <div className="row-actions">
          <button className="chip" onClick={() => void controller.playDemo(useApp.getState().demos[0]?.id)}>
            Try the demo instead
          </button>
        </div>
      </Card>
    );
  }
  if (lyrics.status === 'loading') return <div className="status-pill" role="status">Finding lyrics…</div>;

  if (!doc && (lyrics.status === 'not-found' || lyrics.status === 'error')) {
    return (
      <Card title={`No lyrics found for “${track?.title ?? 'this song'}”`}>
        <p>
          {!isElectron || online
            ? 'None of the lyric sources had this song. You can paste the lyrics or open a lyrics file, and Afterglow will remember it for this song.'
            : 'Looking up lyrics online is off, so only files on this PC were checked.'}
        </p>
        <div className="row-actions">
          {isElectron && online && track && !track.demo && (
            <button className="chip strong" onClick={() => controller.searchAgain()}>
              Search again
            </button>
          )}
          {isElectron && !online && (
            <button className="chip strong" onClick={() => controller.setOnlineLyrics(true)}>
              Find lyrics online
            </button>
          )}
          <button className="chip" onClick={() => setUi({ pasteOpen: true })}>
            Paste lyrics…
          </button>
          <button className="chip" onClick={() => void controller.importLyrics()}>
            Open a lyrics file…
          </button>
        </div>
        <WhereWeLooked />
      </Card>
    );
  }
  if (lyrics.status === 'instrumental') {
    return (
      <Card title="Instrumental" quiet>
        <p>{lyrics.message ?? 'No vocals to show.'}</p>
      </Card>
    );
  }
  const noTimeline = !!doc && doc.timing !== 'none' && source === 'system' && sync.quality === 'unavailable';
  const sheetText = doc && doc.timing === 'none' ? doc.plainText : noTimeline ? doc!.lines.map((l) => l.text).join('\n') : undefined;
  if (doc && sheetText) {
    return (
      <div className="unsynced" role="region" aria-label="Unsynced lyrics">
        <div className="unsynced-head">
          {noTimeline ? (
            <>
              <b>Not synchronized</b> — this player isn’t publishing a playback position, so the lyrics are shown as text.
            </>
          ) : (
            <>
              <b>Unsynced lyrics</b> — {doc.source.label}. No timing is available, so nothing is highlighted.
            </>
          )}
          {!noTimeline && (
            <button className="chip" onClick={() => void controller.importLyrics()}>
              Import synced LRC…
            </button>
          )}
        </div>
        <div className="unsynced-text" tabIndex={0}>
          {sheetText.split(/\n{2,}/).map((stanza, i) => (
            <p key={i}>
              {stanza.split('\n').map((l, j) => (
                <span key={j}>
                  {l}
                  <br />
                </span>
              ))}
            </p>
          ))}
        </div>
      </div>
    );
  }
  return null;
}

export function Attribution() {
  const doc = useApp((s) => s.lyrics.doc);
  if (!doc?.source.attribution) return null;
  return (
    <button className="attribution" onClick={() => void window.afterglow?.openExternal('https://lrclib.net')} title="Lyrics provider">
      {doc.source.attribution}
    </button>
  );
}
