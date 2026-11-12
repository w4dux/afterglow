import { controller } from '../../app/controller';
import { useApp } from '../../app/store';
import type { MotionTreatment } from '../../core/settings/schema';
import { Panel, Segmented, Toggle } from './Panel';

export function MotionPanel() {
  const m = useApp((s) => s.settings.motion);
  const display = useApp((s) => s.settings.display);
  const reducedSys = useApp((s) => s.reducedMotionSystem);
  const onBattery = useApp((s) => s.onBattery);
  const doc = useApp((s) => s.lyrics.doc);
  const reducedActive = m.reduced === 'on' || (m.reduced === 'system' && reducedSys);
  const beatSource = doc?.meta.bpm && doc.meta.beatOffsetMs !== undefined ? `${doc.meta.bpm} BPM stated by ${doc.source.kind === 'demo' ? 'the demo (exact)' : 'the lyric file'}` : null;
  const lineTimed = doc?.timing === 'line';
  const set = (p: Partial<typeof m>) => controller.updateSettings((s) => ({ ...s, motion: { ...s.motion, ...p } }));
  return (
    <Panel id="motion" title="Motion">
      <h3>Treatment</h3>
      <Segmented<MotionTreatment>
        label="Motion treatment"
        value={m.treatment}
        onChange={(v) => set({ treatment: v })}
        options={[
          { value: 'signature', label: 'Signature', hint: "The theme's own choreography" },
          { value: 'jiggle', label: 'Jiggle', hint: 'Small word bounce and tilt' },
          { value: 'highlight', label: 'Highlight', hint: 'Active word only, no movement' },
          { value: 'still', label: 'Still', hint: 'Crossfades only' },
        ]}
      />
      <label className="field">
        Intensity <output>{Math.round(m.intensity * 100)}%</output>
        <input type="range" min={0} max={1.5} step={0.05} value={m.intensity} onChange={(e) => set({ intensity: parseFloat(e.target.value) })} aria-label="Motion intensity" />
      </label>
      <label className="field">
        Reduced motion
        <select value={m.reduced} onChange={(e) => set({ reduced: e.target.value as typeof m.reduced })}>
          <option value="system">Follow Windows setting ({reducedSys ? 'on' : 'off'})</option>
          <option value="on">Always on</option>
          <option value="off">Off</option>
        </select>
      </label>
      {reducedActive && <p className="note">Reduced motion is active: words change colour and lines crossfade, nothing moves.</p>}
      <h3>Beat pulse</h3>
      <Toggle
        label="Pulse on the beat"
        checked={m.beatPulse}
        onChange={(v) => set({ beatPulse: v })}
        hint={beatSource ? `Available: ${beatSource}.` : 'Unavailable for this track: no tempo and downbeat are stated by the lyric source, and Afterglow does not guess them.'}
      />
      <h3>Line-timed lyrics</h3>
      <Toggle
        label="Estimated word sweep"
        checked={m.estimatedSweep}
        onChange={(v) => set({ estimatedSweep: v })}
        hint={`Moves a highlight across a line at the song's own pace, by syllables. It is an estimate, marked "≈ estimated" on screen, and never used when real word timestamps exist.${lineTimed ? '' : ' (Current lyrics have word timing.)'}`}
      />
      <h3>Layout</h3>
      <Segmented
        label="Context lines"
        value={display.context}
        onChange={(v) => controller.updateSettings((s) => ({ ...s, display: { ...s.display, context: v } }))}
        options={[
          { value: 'full', label: 'Full context' },
          { value: 'minimal', label: 'Minimal' },
          { value: 'off', label: 'Current only' },
        ]}
      />
      <label className="field">
        Text size <output>{Math.round(display.textScale * 100)}%</output>
        <input type="range" min={0.7} max={1.4} step={0.05} value={display.textScale} onChange={(e) => controller.updateSettings((s) => ({ ...s, display: { ...s.display, textScale: parseFloat(e.target.value) } }))} aria-label="Text size" />
      </label>
      <Toggle label="Use artwork in backgrounds" checked={display.showArtwork} onChange={(v) => controller.updateSettings((s) => ({ ...s, display: { ...s.display, showArtwork: v } }))} />
      <Toggle
        label="Show translations"
        checked={display.translations}
        onChange={(v) => controller.updateSettings((s) => ({ ...s, display: { ...s.display, translations: v } }))}
        hint="Only when the lyrics come with their own translation (some word-timed lyrics do). Nothing is machine-translated."
      />
      <Toggle
        label="Save battery"
        checked={display.batterySaver}
        onChange={(v) => controller.updateSettings((s) => ({ ...s, display: { ...s.display, batterySaver: v } }))}
        hint={`On battery: about 30 frames per second and no background blur. Lyric timing is not affected.${onBattery ? ' (On battery now.)' : ''}`}
      />
      <label className="field">
        Hide controls after <output>{(display.controlsHideMs / 1000).toFixed(1)} s</output>
        <input type="range" min={1200} max={10000} step={200} value={display.controlsHideMs} onChange={(e) => controller.updateSettings((s) => ({ ...s, display: { ...s.display, controlsHideMs: parseInt(e.target.value, 10) } }))} aria-label="Controls hide delay" />
      </label>
    </Panel>
  );
}

export function TimingPanel() {
  const timing = useApp((s) => s.settings.timing);
  const track = useApp((s) => s.track);
  const sync = useApp((s) => s.sync);
  const doc = useApp((s) => s.lyrics.doc);
  const lineOnly = useApp((s) => s.lineOnly);
  const source = useApp((s) => s.source);
  const trackOffset = controller.trackOffset();
  const total = controller.currentOffset();
  const suggestion = controller.offsetSuggestion(); // re-evaluated whenever `timing` changes
  const cur = controller.runtime.last.cue?.lineIndex ?? -1;
  return (
    <Panel id="timing" title="Timing">
      <div className={`sync-state q-${sync.quality}`} role="status">
        <span className={`q-dot q-${sync.quality}`} />
        <div>
          <strong>{{ locked: 'Locked to the audio clock', tracking: 'Tracking the player', estimating: 'Estimating', unavailable: 'Timing unavailable' }[sync.quality]}</strong>
          <small>{sync.reason}</small>
        </div>
      </div>
      {suggestion && (
        <div className="suggestion" role="status">
          <p>
            You moved lyrics {suggestion.deltaMs > 0 ? 'later' : 'earlier'} on {suggestion.songs} songs by about {Math.abs(suggestion.deltaMs)} ms. That is usually
            delay from headphones or speakers, so it can apply to every song. Songs you already corrected keep their timing.
          </p>
          <div className="row-actions">
            <button className="chip strong" onClick={() => controller.applyOffsetSuggestion()}>
              Apply {suggestion.deltaMs > 0 ? '+' : ''}{suggestion.deltaMs} ms to all songs
            </button>
            <button className="chip" onClick={() => controller.dismissOffsetSuggestion()}>
              Not now
            </button>
          </div>
        </div>
      )}
      <h3>This track</h3>
      <div className="offset-big" aria-live="polite">
        <span className="mono">{total > 0 ? '+' : ''}{total} ms</span>
        <small>{total === 0 ? 'No correction' : total > 0 ? 'lyrics shown later' : 'lyrics shown earlier'}</small>
      </div>
      <div className="nudges">
        {[-250, -50, -10].map((d) => (
          <button key={d} className="chip" onClick={() => controller.nudge(d)} disabled={!track}>
            {d}
          </button>
        ))}
        <button className="chip" onClick={() => controller.setTrackOffset(0)} disabled={!track || trackOffset === 0}>
          Reset
        </button>
        {[10, 50, 250].map((d) => (
          <button key={d} className="chip" onClick={() => controller.nudge(d)} disabled={!track}>
            +{d}
          </button>
        ))}
      </div>
      <p className="note">Keys: <kbd>[</kbd> earlier · <kbd>]</kbd> later (50 ms, hold Shift for 250 ms) · <kbd>\</kbd> reset.</p>
      {doc && doc.lines.length > 0 && (
        <>
          <h3>Tap to align</h3>
          <p className="note">When you hear a line begin, choose it here and Afterglow sets this track's offset so that line starts now.</p>
          <div className="align-list">
            {doc.lines.slice(Math.max(0, cur - 1), Math.max(0, cur - 1) + 4).map((l) => (
              <button key={l.index} className={`align-line${l.index === cur ? ' cur' : ''}`} onClick={() => controller.alignLine(l.index)}>
                <span className="mono">{l.index + 1}</span> {l.text}
              </button>
            ))}
          </div>
        </>
      )}
      <Toggle
        label="Remember corrections per track"
        checked={timing.rememberTrackOffsets}
        onChange={(v) => controller.updateSettings((s) => ({ ...s, timing: { ...s.timing, rememberTrackOffsets: v } }))}
        hint={`${Object.keys(timing.trackOffsets).length} track${Object.keys(timing.trackOffsets).length === 1 ? '' : 's'} remembered`}
      />
      <h3>All tracks (output latency)</h3>
      <label className="field">
        Global offset <output>{timing.globalOffsetMs} ms</output>
        <input type="range" min={-1000} max={1000} step={10} value={timing.globalOffsetMs} onChange={(e) => controller.setGlobalOffset(parseInt(e.target.value, 10))} aria-label="Global offset" />
      </label>
      <p className="note">Bluetooth headphones typically need +150 to +300 ms. Spotify reports its own position, not what reaches your ears.</p>
      {doc?.timing === 'word' || lineOnly ? (
        <Toggle
          label="Preview line-only timing"
          checked={lineOnly}
          onChange={(v) => controller.setLineOnly(v)}
          hint="Hides word timestamps to show how line-synced lyrics behave. No word timing is invented."
        />
      ) : null}
      {source !== 'none' && doc && (
        <button className="chip" onClick={() => void controller.saveCorrectedLyrics()}>
          Save lyrics with this offset applied…
        </button>
      )}
    </Panel>
  );
}
