<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { app } from '../state/app.svelte';
  import { errorMessage } from '../platform/tauri';
  import { music } from '../instruments/native';
  import { midiEvents, snapshotMidi } from '../instruments/sequence';
  import { sessions, importSessionAudio, AUDIO_ACCEPT } from '../instruments/sessions';
  import type { Destination, Instrument, MusicCapabilities, Parameter, Preset, MidiSession } from '../instruments/types';
  import type { SketchDetail } from '../library/types';
  import Sheet from './Sheet.svelte';
  let { detail, onclose }: { detail: SketchDetail; onclose: () => void } = $props();
  let caps = $state<MusicCapabilities | null>(null);
  let instruments = $state<Instrument[]>([]), destinations = $state<Destination[]>([]);
  let presets = $state<Preset[]>([]), parameters = $state<Parameter[]>([]);
  let instrument = $state(''), destination = $state(''), preset = $state(-999);
  let mode = $state<'au' | 'out'>('au');
  let busy = $state(false), playing = $state(false), rendering = $state(false), progress = $state(0);
  let error = $state(''), tail = $state(2), session = $state<MidiSession | null>(null);
  let poll: ReturnType<typeof setInterval> | undefined;
  let disposed = false, polling = false;
  const place = () => {
    if (!detail.notebookId) throw new Error('Place this sketch on a notebook first.');
    return { notebookId: detail.notebookId, canvasXMs: detail.canvasXMs + (detail.durationMs ?? 0) + 500, canvasY: detail.canvasY };
  };
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true; error = '';
    try { await action(); } catch (e) { error = errorMessage(e); } finally { busy = false; }
  }
  async function refresh() {
    if (caps?.supportsCoreMIDIOutput) destinations = await music.destinations();
    if (caps?.supportsAUv3Hosting) instruments = await music.instruments();
  }
  onMount(() => {
    void run(async () => { caps = await music.capabilities(); await refresh(); });
    poll = setInterval(() => { void tick(); }, 500);
  });
  onDestroy(() => { disposed = true; clearInterval(poll); void music.close().catch(() => {}); });
  async function snapshot() {
    const fresh = await app.library.get(detail.id);
    return snapshotMidi(fresh, (await app.library.originalMidi?.(detail.id)) ?? undefined);
  }
  async function selected() {
    await run(async () => {
      const state = await music.selectInstrument(instrument); presets = state.presets; parameters = state.parameters; preset = -999;
    });
  }
  async function play() {
    await run(async () => {
      await music.stop();
      let midi: Uint8Array;
      if (mode === 'out') {
        if (!destination) throw new Error('Choose a MIDI destination.');
        // Every new outgoing workflow gets its own immutable version. Restart
        // within this session always uses its saved MIDI, even after edits.
        if (!session || session.status !== 'pending' || session.destination.id !== destination) {
          const data = await snapshot();
          session = await sessions.create(detail.id, data.midi, data.snapshot, { type: 'external', ...destinations.find(d => d.id === destination) });
        }
        midi = await sessions.bytes(session.id);
      } else { midi = (await snapshot()).midi; }
      await music.play(midiEvents(midi), mode === 'out' ? destination : null); playing = true;
    });
  }
  async function render() {
    await run(async () => {
      const data = await snapshot();
      session = await sessions.create(detail.id, data.midi, data.snapshot, { type:'auv3', ...instruments.find(i => i.id === instrument), preset: presets.find(p => p.number === preset) ?? null });
      await music.render(midiEvents(data.midi), tail); rendering = true; progress = 0;
    });
  }
  async function tick() {
    if (polling || disposed || !caps?.supportsCoreMIDIOutput) return;
    polling = true;
    try {
      if (rendering) {
        const state = await music.renderProgress();
        progress = state.fraction;
        if (state.state === 'failed' || state.state === 'cancelled') { rendering = false; error = state.error ?? 'Rendering cancelled.'; }
        if (state.state === 'complete' && state.audio && session) {
          rendering = false;
          const completed = await importSessionAudio(app.library, session, state.audio, place(), { mode:'auv3', tailSeconds:tail });
          await app.refresh(); app.toast('Instrument render saved with its original MIDI.'); app.openSketch(completed.id); onclose();
        }
      } else if (playing) {
        const status = await music.status(); playing = status.playing; if (status.error) error = status.error;
      }
    } catch (e) { rendering = false; error = errorMessage(e); }
    finally { polling = false; }
  }
  async function returned(input: HTMLInputElement) {
    const file = input.files?.[0]; input.value = '';
    if (!file || !session) return;
    await run(async () => {
      await music.stop();
      const result = await importSessionAudio(app.library, session!, file, place());
      await app.refresh(); app.openSketch(result.id); onclose();
    });
  }
</script>
<Sheet title="Play with Instrument" onclose={() => { if (!busy && !rendering) onclose(); }}>
  <div class="instrument-sheet">
    <p>Keep the notes; make a new sketch from another instrument’s sound.</p>
    <div class="modes">
      <button disabled={busy || rendering} class:primary={mode === 'au'} onclick={() => { void music.stop().catch(() => {}); mode = 'au'; session = null; }}>In Earbud · AUv3</button>
      <button disabled={busy || rendering} class:primary={mode === 'out'} onclick={() => { void music.stop().catch(() => {}); mode = 'out'; session = null; }}>MIDI Out</button>
    </div>
    {#if caps && !(mode === 'au' ? caps.supportsAUv3Hosting : caps.supportsCoreMIDIOutput)}
      <p>Available in the iOS app. MIDI file export and the built-in piano remain available here.</p>
    {:else if mode === 'au'}
      <label>Instrument <select bind:value={instrument} onchange={selected} disabled={busy || rendering}>
        <option value="">Choose an installed AUv3 instrument</option>
        {#each instruments as item}<option value={item.id}>{item.name} · {item.manufacturer}</option>{/each}
      </select></label>
      {#if caps && !instruments.length}<p>No AUv3 instruments found. Install an instrument app that includes an AUv3 extension, then refresh.</p>{/if}
      {#if instrument}
        {#if presets.length}<label>Preset <select bind:value={preset} disabled={busy || rendering} onchange={() => run(() => music.preset(Number(preset)))}><option value={-999}>Current settings</option>{#each presets as p}<option value={p.number}>{p.name}</option>{/each}</select></label>{/if}
        <button disabled={busy || rendering} onclick={() => run(() => music.showInterface())}>Open instrument interface</button>
        {#if parameters.length}<details><summary>Instrument parameters</summary>{#each parameters as param}<label>{param.name}<input type="range" min={param.min} max={param.max} step="any" value={param.value} disabled={busy || rendering} onchange={(e) => run(() => music.parameter(param.address, Number(e.currentTarget.value)))} /></label>{/each}</details>{/if}
        <label>Release / reverb tail (seconds)<input type="number" min="0" max="30" step="0.5" bind:value={tail} disabled={rendering} /></label>
        <button class="primary" disabled={busy || rendering} onclick={render}>Render as New Sketch</button>
      {/if}
    {:else}
      <label>Destination <select bind:value={destination} disabled={busy || rendering}><option value="">Choose a destination</option>{#each destinations as item}<option value={item.id}>{item.name} · {item.transport}</option>{/each}</select></label>
      <p>In Logic Pro for iPad, enable its virtual MIDI input and select the destination it exposes here (usually “Logic Pro Virtual In”). Choose a software instrument in Logic. GarageBand may not expose an app MIDI destination; use MIDI file export if none appears.</p>
      <p>Playback stops when Earbud leaves the foreground. For switching apps, export the MIDI file and import it into the DAW. Core MIDI does not capture another app’s audio.</p>
      {#if session}<p>Awaiting audio for <strong>{session.sourceTitle}</strong>. This session keeps the exact MIDI version sent. Export audio from the DAW, share it to Earbud, or choose it from Files below.</p><label>Attach returned audio from Files<input type="file" accept={AUDIO_ACCEPT} disabled={busy} onchange={e => returned(e.currentTarget)} /></label><button disabled={busy} onclick={() => { session = null; }}>Start another MIDI version</button>{/if}
    {/if}
    {#if caps?.supportsCoreMIDIOutput}
      <div class="modes"><button disabled={busy || rendering || !(mode === 'au' ? instrument : destination)} onclick={play}>{playing ? 'Restart' : 'Play'}</button><button disabled={rendering} onclick={() => run(async () => { await music.stop(); playing = false; })}>Stop / All Notes Off</button><button disabled={busy || rendering} onclick={() => run(refresh)}>Refresh</button></div>
    {/if}
    {#if rendering}<progress max="1" value={progress}></progress><p>Rendering {Math.round(progress * 100)}%</p><button onclick={() => music.cancelRender()}>Cancel render</button>{/if}
    {#if error}<p role="alert">{error}</p>{/if}
    <button disabled={busy || rendering} onclick={onclose}>Done</button>
  </div>
</Sheet>
<style>
  .instrument-sheet { display: grid; gap: 12px; }
  p { margin: 0; font-size: .88rem; color: var(--ink-2); }
  label { display: grid; gap: 6px; }
  select, input[type=number] { width: 100%; padding: 8px; color: var(--ink); background: var(--paper); border: 1px solid var(--rule); border-radius: 8px; }
  .modes { display: flex; gap: 8px; flex-wrap: wrap; }
  button { border: 1px solid var(--rule); border-radius: 8px; padding: 9px; }
  .primary { background: var(--accent); color: var(--paper); }
  [role=alert] { color: var(--danger); }
</style>
