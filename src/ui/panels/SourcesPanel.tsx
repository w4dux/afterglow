import { useState } from 'react';
import { controller } from '../../app/controller';
import { isElectron, native } from '../../app/platform';
import { type AppState, setUi, useApp } from '../../app/store';
import type { LyricSource } from '../../core/lyrics/model';
import { appDisplayName } from '../../playback/SystemMediaAdapter';
import { Panel, Toggle } from './Panel';

/**
 * Music & lyrics. Ordered for beginners: follow Spotify first, then what is known
 * about this song's lyrics, then demos and files. Technical detail (providers, saved
 * copies, connection state) is one click away under "Advanced" / "Connection details".
 */
export function SourcesPanel() {
  const demos = useApp((s) => s.demos);
  const track = useApp((s) => s.track);
  const settings = useApp((s) => s.settings);
  const lyrics = useApp((s) => s.lyrics);

  return (
    <Panel id="sources" title="Music & lyrics" wide>
      <section>
        <FollowCard />
      </section>

      <section>
        <h3>Lyrics for this song</h3>
        <LyricsSummary />
        <div className="row-actions">
          {track && settings.sources.onlineLyrics && !track.demo && (
            <button className="chip strong" onClick={() => controller.searchAgain()}>
              Search again
            </button>
          )}
          <button className="chip" onClick={() => setUi({ pasteOpen: true, panel: null })}>
            Paste lyrics…
          </button>
          <button className="chip" onClick={() => void controller.importLyrics()}>
            Open a lyrics file…
          </button>
          {track && settings.lyricLinks[track.key] && (
            <button className="chip" onClick={() => controller.forgetLyricsLink()}>
              Detach file
            </button>
          )}
        </div>
        {lyrics.alternatives && lyrics.alternatives.length > 0 && (
          <details className="explain">
            <summary>Not the right lyrics? Other versions ({lyrics.alternatives.length})</summary>
            {lyrics.alternatives.map((r) => (
              <button key={r.id} className="align-line" onClick={() => controller.chooseAlternative(r)}>
                {r.artistName} — {r.trackName} {r.duration ? `(${Math.floor(r.duration / 60)}:${String(Math.round(r.duration % 60)).padStart(2, '0')})` : ''}{' '}
                {r.syncedLyrics || r.hasWordSync ? '· timed' : '· text only'}
              </button>
            ))}
          </details>
        )}
        <Toggle
          label="Find lyrics online"
          checked={settings.sources.onlineLyrics}
          disabled={!isElectron}
          onChange={(v) => controller.setOnlineLyrics(v)}
          hint="Sends the song’s title, artist, album and length to lrclib.net, a public lyrics list on GitHub and Apple’s music catalogue. No account needed."
        />
        <details className="explain advanced">
          <summary>Advanced</summary>
          {settings.sources.onlineLyrics && (
            <div className="sub-toggles">
              <Toggle
                label="LRCLIB"
                checked={settings.sources.providers.lrclib}
                onChange={(v) => controller.updateSettings((s) => ({ ...s, sources: { ...s.sources, providers: { ...s.sources.providers, lrclib: v } } }))}
                hint="lrclib.net: a large community lyrics database, mostly line timing."
              />
              <Toggle
                label="AMLL TTML DB"
                checked={settings.sources.providers.amll}
                onChange={(v) => controller.updateSettings((s) => ({ ...s, sources: { ...s.sources, providers: { ...s.sources.providers, amll: v } } }))}
                hint="Community word-timed lyrics on GitHub (CC0), about 3,400 songs, mostly Asian pop. Its song list is downloaded and searched on this PC."
              />
              <Toggle
                label="Genre from Apple’s catalogue"
                checked={settings.sources.providers.catalog}
                onChange={(v) => controller.updateSettings((s) => ({ ...s, sources: { ...s.sources, providers: { ...s.sources.providers, catalog: v } } }))}
                hint="Spotify does not tell Windows a song’s genre; Apple’s public catalogue does, which helps Auto pick a theme. Also gives the song length and, if the player shows none, artwork."
              />
            </div>
          )}
          <Toggle
            label="Remember lyrics found online"
            checked={settings.sources.useCache}
            onChange={(v) => controller.updateSettings((s) => ({ ...s, sources: { ...s.sources, useCache: v } }))}
            hint="Keeps a copy per song so it loads instantly and works offline. Rechecked online after a week."
          />
          {isElectron && (
            <div className="row-actions">
              <button className="chip" onClick={() => void controller.chooseLyricsFolder()}>
                {settings.sources.lyricsFolder ? 'Change lyrics folder…' : 'Use a folder of .lrc files…'}
              </button>
              {settings.sources.lyricsFolder && <small className="path">{settings.sources.lyricsFolder}</small>}
            </div>
          )}
          <WhereWeLooked />
        </details>
      </section>

      <section>
        <h3>No Spotify right now? Try a demo or a file</h3>
        <div className="demo-grid">
          {demos.map((d) => (
            <button key={d.id} className={`demo${track?.demo?.id === d.id ? ' on' : ''}`} onClick={() => void controller.playDemo(d.id)}>
              <img src={d.artwork} alt="" />
              <span>
                <b>{d.title}</b>
                <small>{d.genre}</small>
              </span>
            </button>
          ))}
        </div>
        <div className="row-actions">
          <button className="chip" onClick={() => void controller.openLocal()}>
            Open a music file…
          </button>
          {settings.recent.length > 0 && isElectron && (
            <select aria-label="Recent files" value="" onChange={(e) => e.target.value && void controller.openRecent(e.target.value)}>
              <option value="">Recent…</option>
              {settings.recent.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.artist ? `${r.artist} — ` : ''}
                  {r.title}
                </option>
              ))}
            </select>
          )}
        </div>
        <p className="note">The demos are original songs whose word timing is known exactly.</p>
      </section>
    </Panel>
  );
}

/** Following Spotify (or another media app): the one thing most people come for. */
function FollowCard() {
  const source = useApp((s) => s.source);
  const system = useApp((s) => s.system);
  const info = useApp((s) => s.info);
  const track = useApp((s) => s.track);
  const settings = useApp((s) => s.settings);
  const following = source === 'system';

  if (!isElectron) return <p className="note">Following Spotify works in the Afterglow desktop app for Windows.</p>;
  if (info && info.platform !== 'win32') return <p className="note">Following Spotify needs Windows (this PC runs {info.platform}).</p>;

  if (!following) {
    return (
      <div className="follow-card">
        <div className="follow-text">
          <b>Show lyrics for Spotify</b>
          <small>Afterglow follows whatever plays in Spotify, or another app that shows up in Windows’ media controls. No login needed.</small>
        </div>
        <button className="chip strong big" onClick={() => controller.followSystem(true)}>
          Follow Spotify
        </button>
      </div>
    );
  }

  const app = system?.app ? appDisplayName(system.app) : 'Spotify';
  const broken = system?.bridge === 'unavailable' || system?.bridge === 'error';
  const status = broken
    ? `Can’t connect to Windows media controls${system?.message ? `: ${system.message}` : ''}`
    : !track || track.key === 'system:none'
      ? 'Waiting for music: press play in Spotify.'
      : `Playing “${track.title}”${track.artist ? ` by ${track.artist}` : ''}`;
  return (
    <>
      <div className={`follow-card on${broken ? ' broken' : ''}`}>
        <span className="live-dot" aria-hidden="true" />
        <div className="follow-text">
          <b>Following {app}</b>
          <small>{status}</small>
        </div>
        <button className="chip" onClick={() => controller.followSystem(false)}>
          Stop
        </button>
      </div>
      {system?.timelineAvailable === false && system.app && (
        <p className="note warn-text">This app doesn’t share its playback position, so lyrics can be shown but not kept in time.</p>
      )}
      {system?.sessions && system.sessions.length > 1 && (
        <label className="field">
          Follow
          <select
            value={settings.sources.preferredApp}
            onChange={(e) => {
              controller.updateSettings((s) => ({ ...s, sources: { ...s.sources, preferredApp: e.target.value } }));
              void native?.bridgeCommand({ cmd: 'select', app: e.target.value });
            }}
          >
            {system.sessions.map((s) => (
              <option key={s.app} value={s.app.toLowerCase()}>
                {appDisplayName(s.app)} ({s.status})
              </option>
            ))}
          </select>
        </label>
      )}
      {system && (
        <details className="explain">
          <summary>Connection details</summary>
          <div className="sys-status">
            <div>
              Media bridge: <b>{system.bridge}</b>
              {system.message && <> — {system.message}</>}
            </div>
            <div>
              Session: <b>{system.app ?? 'none'}</b> {system.status && `(${system.status})`}
            </div>
            <div>Reads only what the app publishes to Windows’ media controls. No Spotify login, API keys, tokens or private endpoints.</div>
          </div>
        </details>
      )}
    </>
  );
}

const PROVIDER_NAME: Partial<Record<LyricSource['kind'], string>> = {
  lrclib: 'LRCLIB (community lyrics)',
  amll: 'AMLL (community word-timed lyrics)',
  demo: 'The demo',
  sidecar: 'A lyrics file next to the song',
  embedded: 'Lyrics stored in the music file',
  pasted: 'Lyrics you pasted',
};

/** One plain sentence about where this song's lyrics came from and how they are timed. */
export function lyricsHeadline(lyrics: AppState['lyrics']): { title: string; detail?: string; warn?: string } {
  const doc = lyrics.doc;
  if (lyrics.status === 'loading') return { title: 'Searching for lyrics…' };
  if (doc) {
    const timing = doc.timing === 'word' ? 'word-by-word timing' : doc.timing === 'line' ? 'line-by-line timing' : 'text only, no timing';
    const from =
      doc.source.kind === 'cache'
        ? `${doc.source.label.replace(/ \(saved\)$/, '')}, saved on this PC`
        : (PROVIDER_NAME[doc.source.kind] ?? doc.source.label);
    const loose = doc.source.match === 'loose' || /weak match/.test(doc.source.note ?? '');
    return {
      title: `${from} · ${timing}`,
      warn: loose ? 'Possible match only: check these are the right lyrics.' : undefined,
      detail: !loose && doc.source.note ? doc.source.note : undefined,
    };
  }
  if (lyrics.status === 'instrumental') return { title: 'Instrumental: no vocals to show' };
  if (lyrics.status === 'not-found' || lyrics.status === 'error') return { title: 'No lyrics found for this song' };
  return { title: 'No song yet' };
}

export function LyricsSummary() {
  const lyrics = useApp((s) => s.lyrics);
  const h = lyricsHeadline(lyrics);
  return (
    <div className="lyr-status">
      <b>{h.title}</b>
      {h.warn && <small className="warn-text">{h.warn}</small>}
      {h.detail && <small>{h.detail}</small>}
      {lyrics.doc?.source.attribution && <small>{lyrics.doc.source.attribution}</small>}
    </div>
  );
}

/** Every source that was checked and what it said (for the curious, and for bug reports). */
export function WhereWeLooked() {
  const tried = useApp((s) => s.lyrics.tried);
  const [open, setOpen] = useState(false);
  if (!tried.length) return null;
  return (
    <div className="lyr-status">
      <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? 'Hide' : 'Show'} where Afterglow looked
      </button>
      {open && (
        <ul>
          {tried.map((t, i) => (
            <li key={i}>
              <span>{t.source}</span> <em>{t.outcome}</em>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PasteDialog() {
  const open = useApp((s) => s.ui.pasteOpen);
  const [text, setText] = useState('');
  if (!open) return null;
  return (
    <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && setUi({ pasteOpen: false })}>
      <div className="modal" role="dialog" aria-label="Paste lyrics">
        <h2>Paste lyrics</h2>
        <p className="note">Timed lyrics (LRC, with or without word timing) or plain text. Plain text is shown without timing.</p>
        <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={'[00:12.30]First line\n[00:15.10]Second line'} rows={12} />
        <div className="row-actions">
          <button
            className="chip strong"
            disabled={!text.trim()}
            onClick={() => {
              controller.useLyricsText(text, 'Pasted lyrics');
              setUi({ pasteOpen: false });
              setText('');
            }}
          >
            Use these lyrics
          </button>
          <button className="chip" onClick={() => setUi({ pasteOpen: false })}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function HelpPanel() {
  const rows: [string, string][] = [
    ['Space / K', 'Play / pause'],
    ['← / →', 'Seek 5 s (Shift: 15 s)'],
    [', / .', 'Previous / next lyric line'],
    ['[ / ]', 'Lyrics earlier / later 50 ms (Shift: 250 ms)'],
    ['\\', 'Reset this song’s timing'],
    ['F or F11', 'Full screen'],
    ['Esc', 'Close panel / leave full screen'],
    ['T', 'Themes (all of them)'],
    ['1–9 / 0', 'Pick one of the first ten themes'],
    ['M', 'Motion and display'],
    ['C', 'Context: full / minimal / current line only'],
    ['S', 'Music & lyrics'],
    ['O / L', 'Open a music file / a lyrics file'],
    ['D', 'Diagnostics'],
    ['?', 'This list'],
  ];
  return (
    <Panel id="help" title="Keyboard shortcuts">
      <table className="keys">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>
                <kbd>{k}</kbd>
              </td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Something looks wrong?</h3>
      <p className="note">
        Copy a diagnostics report and paste it into a message. It describes the current song, where its lyrics came from and how the timing is doing, plus
        recent log lines. Nothing is sent anywhere by Afterglow.
      </p>
      <div className="row-actions">
        <button className="chip strong" onClick={() => void controller.copyDiagnostics()}>
          Copy diagnostics report
        </button>
        {isElectron && (
          <button className="chip" onClick={() => controller.openLogFolder()}>
            Open log folder
          </button>
        )}
      </div>
    </Panel>
  );
}
