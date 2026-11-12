<script lang="ts">
  import { app } from '../state/app.svelte';
  import { errorMessage } from '../platform/tauri';
  import type { WatchReceiver } from '../watch/receiver.svelte';

  let { watch }: { watch: WatchReceiver } = $props();

  const status = $derived(watch.status);
  const native = $derived(watch.native);
  let name = $state('');
  let now = $state(Date.now());
  let busy = $state(false);
  let confirmReset = $state(false);

  // Keep the field in step with the stored name unless the user is editing it.
  let editing = $state(false);
  $effect(() => {
    if (!editing && status) name = status.displayName;
  });

  const remaining = $derived(status?.pairing ? Math.max(0, Math.ceil((status.pairing.expiresAt - now) / 1000)) : 0);

  $effect(() => {
    if (!status?.pairing) return;
    const timer = setInterval(() => {
      now = Date.now();
      if (!busy && status?.pairing && now >= status.pairing.expiresAt) void run(() => watch.endPairing());
    }, 500);
    return () => clearInterval(timer);
  });

  async function run(action: () => Promise<void>) {
    busy = true;
    try {
      await action();
    } catch (error) {
      app.toast(errorMessage(error), 'error');
    } finally {
      busy = false;
    }
  }

  function saveName() {
    editing = false;
    if (status && name.trim() !== status.displayName) void run(() => watch.rename(name));
  }

  const bluetoothText: Record<string, string> = {
    poweredOn: 'on',
    poweredOff: 'off. Turn it on in Control Center to receive without Wi-Fi.',
    unauthorized: 'not allowed. Allow it in Settings → Privacy & Security → Bluetooth.',
    unsupported: 'not available on this device.',
    resetting: 'restarting…',
    starting: 'starting…',
    off: 'off',
  };

  function via(value: string) {
    return value === 'bluetooth' ? 'Bluetooth' : value === 'phoneSession' ? 'paired iPhone' : 'Wi-Fi';
  }
</script>

{#if status}
  <section>
    <h3>Apple Watch</h3>
    <label class="toggle">
      <input
        type="checkbox"
        checked={status.enabled}
        disabled={busy}
        onchange={(e) => {
          const enabled = e.currentTarget.checked;
          void run(() => watch.setEnabled(enabled));
        }}
      />
      <span>
        <strong>Receive recordings from Apple Watch</strong>
        <span class="help">
          The Earbud Watch app sends what you record to this device over Wi-Fi{watch.nativeAvailable
            ? ' or Bluetooth'
            : ''} while Earbud is open here.
        </span>
      </span>
    </label>

    <label class="field">
      <span class="label">Name shown on the Watch</span>
      <input
        type="text"
        maxlength="60"
        bind:value={name}
        onfocus={() => (editing = true)}
        onblur={saveName}
        onkeydown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </label>

    {#if status.pairing}
      <div class="pairing" aria-live="polite">
        <p class="help">On the Watch, open Earbud → Settings → Pair, and enter:</p>
        <div class="code tabular" aria-label="Pairing code {status.pairing.code.split('').join(' ')}">
          {#each status.pairing.code.split('') as digit, i (i)}<span>{digit}</span>{/each}
        </div>
        <p class="help">
          Expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}. Keep this screen open;
          the Watch finds this {native?.deviceModel ?? 'device'} over Wi-Fi or Bluetooth.
        </p>
        <button class="pill-button" disabled={busy} onclick={() => run(() => watch.endPairing())}>Cancel</button>
      </div>
    {:else}
      <button class="pill-button primary" disabled={busy} onclick={() => run(() => watch.beginPairing())}
        >Pair Apple Watch</button
      >
    {/if}

    {#if status.pairedWatches.length > 0}
      <div class="paired">
        <span class="label">Paired</span>
        <ul>
          {#each status.pairedWatches as w (w.name)}
            <li>{w.name} <span class="help inline">· {via(w.via)} · {new Date(w.pairedAt).toLocaleDateString()}</span></li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if status.enabled}
      <ul class="facts">
        {#if status.error}
          <li class="warn">{status.error}</li>
        {:else if status.listening}
          <li>
            Wi-Fi: listening{status.addresses.length > 0 ? ` on ${status.addresses.join(', ')}` : ''} (port {status.port}).
            The Watch must be on the same network.
          </li>
        {/if}
        {#if native}
          <li>Bluetooth: {bluetoothText[native.bluetooth] ?? native.bluetooth}</li>
        {/if}
      </ul>
    {/if}
    {#if native?.phoneSessionSupported && native.watchPaired}
      <p class="help">
        {native.watchAppInstalled
          ? 'The Earbud Watch app is installed on the Apple Watch paired with this iPhone, so it can also send through the iPhone. Those recordings are delivered by watchOS and added when Earbud opens.'
          : 'iOS does not report the Earbud Watch app as installed on the Watch paired with this iPhone, so sending through the iPhone may not be available. Pair with a code instead.'}
      </p>
    {/if}

    {#if status.pairedWatches.length > 0}
      {#if confirmReset}
        <div class="confirm">
          <span class="help">Watches will have to pair again.</span>
          <button
            class="pill-button danger"
            disabled={busy}
            onclick={() => {
              confirmReset = false;
              void run(() => watch.reset());
            }}>Forget paired watches</button
          >
          <button class="pill-button" onclick={() => (confirmReset = false)}>Keep</button>
        </div>
      {:else}
        <button class="pill-button" onclick={() => (confirmReset = true)}>Forget paired watches…</button>
      {/if}
    {/if}
  </section>
{/if}

<style>
  section {
    display: grid;
    gap: 10px;
    padding: 12px 0;
    border-top: 1px solid var(--rule);
    justify-items: start;
  }
  h3 {
    margin: 0;
    font-size: 0.8rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-3);
  }
  .help {
    display: block;
    margin: 0;
    font-size: 0.85rem;
    color: var(--ink-3);
  }
  .help.inline {
    display: inline;
  }
  .toggle {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  .toggle input {
    margin-top: 4px;
    width: 18px;
    height: 18px;
    flex: none;
    accent-color: var(--accent);
  }
  .field {
    display: grid;
    gap: 4px;
    width: 100%;
  }
  .label {
    font-size: 0.85rem;
    color: var(--ink-2);
  }
  .field input {
    width: 100%;
    min-height: 40px;
    padding: 0 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--rule-strong);
    background: var(--paper);
  }
  .pairing {
    display: grid;
    gap: 8px;
    justify-items: start;
    width: 100%;
    padding: 12px;
    border-radius: var(--radius-sm);
    background: var(--paper-sunk);
  }
  .code {
    display: flex;
    gap: 6px;
  }
  .code span {
    display: grid;
    place-items: center;
    width: 2.6rem;
    height: 3.2rem;
    border-radius: var(--radius-sm);
    background: var(--paper-raised);
    border: 1px solid var(--rule-strong);
    font-family: var(--font-mono);
    font-size: 1.7rem;
    font-weight: 600;
  }
  .paired ul,
  .facts {
    margin: 2px 0 0;
    padding: 0 0 0 18px;
    font-size: 0.88rem;
    color: var(--ink-2);
  }
  .facts {
    padding: 0;
    list-style: none;
    display: grid;
    gap: 4px;
  }
  .warn {
    color: var(--warn);
  }
  .confirm {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
</style>
