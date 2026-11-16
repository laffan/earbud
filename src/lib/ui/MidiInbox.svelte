<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { app } from '../state/app.svelte';
  import { isTauri, errorMessage } from '../platform/tauri';
  import { music } from '../instruments/native';
  import { sessions, importSessionAudio, AUDIO_ACCEPT } from '../instruments/sessions';
  import type { IncomingAudio, MidiSession } from '../instruments/types';
  import Sheet from './Sheet.svelte';
  let pending = $state<MidiSession[]>([]), incoming = $state<IncomingAudio[]>([]);
  let visible = $state(false), sessionId = $state(''), incomingId = $state('');
  let notebookId = $state(''), canvasXMs = $state(0), canvasY = $state(80);
  let file = $state<File | null>(null), error = $state(''), busy = $state(false);
  let native = false, disposed = false;
  const selected = $derived(pending.find(s => s.id === sessionId));
  const selectedAudio = $derived(incoming.find(a => a.id === incomingId));
  let seen = new Set<string>();
  let preview = $state('');
  $effect(() => {
    if (!file) { preview = ''; return; }
    const url = URL.createObjectURL(file); preview = url;
    return () => URL.revokeObjectURL(url);
  });
  async function refresh(announce = false) {
    if (!app.library.persistent || !isTauri() || busy) return;
    try {
      const caps = await music.capabilities(); native = caps.supportsAudioShareImport;
      pending = (await sessions.list()).filter(s => s.status === 'pending');
      if (pending.length === 1 && !sessionId) sessionId = pending[0].id;
      if (native) incoming = await music.inbox();
      if (announce && incoming.some(a => !seen.has(a.id))) {
        incomingId = incoming.find(a => !seen.has(a.id))!.id; file = null; visible = true; chooseSession();
      }
      incoming.forEach(a => seen.add(a.id));
    } catch (e) { if (visible) error = errorMessage(e); }
  }
  function chooseSession() {
    const source = app.sketches.find(s => s.id === selected?.sourceId);
    const meta = selected?.snapshot.metadata;
    notebookId = source?.notebookId ?? (meta?.notebookId as string | undefined) ?? app.notebookId ?? app.notebooks[0]?.id ?? '';
    canvasXMs = source ? source.canvasXMs + (source.durationMs ?? 0) + 500 : Number(meta?.canvasXMs ?? 0);
    canvasY = source?.canvasY ?? Number(meta?.canvasY ?? 80);
  }
  onMount(() => {
    const start = setInterval(() => { if (app.ready && !disposed) { clearInterval(start); void refresh(true); } }, 500);
    const focus = () => { if (document.visibilityState === 'visible') void refresh(true); };
    document.addEventListener('visibilitychange', focus); window.addEventListener('focus', focus);
    return () => { clearInterval(start); document.removeEventListener('visibilitychange',focus); window.removeEventListener('focus',focus); };
  });
  onDestroy(() => { disposed = true; });
  async function importAudio() {
    const input = file ?? selectedAudio;
    if (!input || busy || !notebookId) return;
    busy = true; error = '';
    try {
      const place = { notebookId, canvasXMs, canvasY };
      if (selected) {
        const result = await importSessionAudio(app.library, selected, input, place);
        await app.refresh(); app.openSketch(result.id);
      } else if (input instanceof File) {
        if (!await app.importSketch('audio', input, place)) throw new Error('Audio import failed.');
      } else {
        const created = await app.library.create({ mediaExtension:input.extension,mediaMime:input.mime,captureBackend:'shared-audio',title:input.name,...place });
        try {
          const audio = await music.copyIncoming(input.id,created.mediaPath,created.analysisPath);
          await app.library.finalize({id:created.id,durationMs:audio.durationMs,hasVideo:false,videoWidth:null,videoHeight:null});
        } catch (e) { await app.library.discard(created.id); throw e; }
        await music.acknowledge(input.id).catch(() => {});
        await app.refresh(); if (app.settings.autoTranscribe) app.queue.enqueue(created.id); app.openSketch(created.id);
      }
      await music.stopPreview().catch(() => {});
      visible = false; file = null; incomingId = ''; sessionId = ''; await refresh();
    } catch (e) { error = errorMessage(e); }
    finally { busy = false; }
  }
</script>
{#if app.ready && app.library.persistent && !app.recording}
  <button class="inbox-button" onclick={() => { visible = true; void refresh().then(chooseSession); }}>MIDI sessions{incoming.length ? ` · ${incoming.length} audio` : ''}</button>
{/if}
{#if visible}
  <Sheet title="Import Audio Sketch" onclose={() => { if (!busy) { visible = false; void music.stopPreview().catch(() => {}); } }}>
    <div class="inbox">
      <p>Choose the saved MIDI version that made this audio. Its original notes will be copied without transcription.</p>
      <label>Original MIDI<select bind:value={sessionId} onchange={chooseSession} disabled={busy}><option value="">Audio only · no MIDI association</option>{#each pending as s}<option value={s.id}>{s.sourceTitle} · {new Date(s.createdAt).toLocaleString()} · {String(s.destination.name ?? s.destination.type ?? 'Instrument')}</option>{/each}</select></label>
      {#if selected}<p>Source: {String(selected.destination.name ?? 'Instrument')} · MIDI fingerprint {selected.midiHash.slice(0,12)}</p><button disabled={busy} onclick={async () => { await sessions.status(selected!.id,'cancelled'); sessionId = ''; await refresh(); }}>Cancel this session</button>{/if}
      {#if incoming.length}<label>Shared audio<select bind:value={incomingId} onchange={() => { file = null; }} disabled={busy}><option value="">Choose shared audio</option>{#each incoming as item}<option value={item.id}>{item.name}</option>{/each}</select></label>{/if}
      <label>Or choose audio from Files<input type="file" accept={AUDIO_ACCEPT} disabled={busy} onchange={e => { file = e.currentTarget.files?.[0] ?? null; incomingId = ''; }} /></label>
      {#if file}<p>File: {file.name}</p><audio controls src={preview}></audio>{/if}
      {#if selectedAudio}<p>File: {selectedAudio.name} · {(selectedAudio.durationMs/1000).toFixed(1)} seconds</p>
        {#if selectedAudio.error}<p role="alert">{selectedAudio.error}</p>{:else}<button disabled={busy} onclick={() => music.previewIncoming(selectedAudio!.id).catch(e => error = errorMessage(e))}>Preview shared audio</button><button onclick={() => music.stopPreview()}>Stop preview</button>{/if}
        <button disabled={busy} onclick={async () => { await music.acknowledge(selectedAudio!.id); incomingId = ''; await refresh(); }}>Discard shared audio</button>
      {/if}
      <label>Notebook<select bind:value={notebookId} disabled={busy}>{#each app.notebooks as book}<option value={book.id}>{book.title}</option>{/each}</select></label>
      <label>Timeline position (ms)<input type="number" bind:value={canvasXMs} min="0" disabled={busy} /></label>
      <label>Canvas height<input type="number" bind:value={canvasY} min="0" disabled={busy} /></label>
      {#if error}<p role="alert">{error}</p>{/if}
      <button class="primary" disabled={busy || !(file || selectedAudio) || !notebookId} onclick={importAudio}>{busy ? 'Importing…' : 'Import as New Sketch'}</button>
      <button disabled={busy} onclick={() => { visible = false; void music.stopPreview().catch(() => {}); }}>Cancel</button>
    </div>
  </Sheet>
{/if}
<style>
  .inbox-button { position: fixed; right: 12px; bottom: calc(76px + var(--safe-bottom)); z-index: 8; background: var(--paper-raised); border: 1px solid var(--rule); border-radius: 14px; padding: 7px 12px; font-size: .78rem; }
  .inbox { display: grid; gap: 12px; }
  label { display: grid; gap: 5px; }
  select, input[type=number] { width: 100%; padding: 8px; border: 1px solid var(--rule); border-radius: 8px; color: var(--ink); background: var(--paper); }
  button { padding: 9px; border: 1px solid var(--rule); border-radius: 8px; }
  p { margin: 0; font-size: .85rem; }
  [role=alert] { color: var(--danger); }
</style>
