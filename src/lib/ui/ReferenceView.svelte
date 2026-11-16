<script lang="ts">
  /**
   * Reference: chords to look up, not taken from a recording.
   *  - Chords: the roots down the side; the chosen root's chords (major,
   *    minor, sevenths…) across the top; the chosen chord's notes and how to
   *    play it on piano or guitar, which can be played.
   *  - Circle of fifths: tap a chord to hear it and see how to play it below.
   *    The record button under the circle records the chords tapped, in time,
   *    as a new sketch at the end of the open notebook.
   * The piano / guitar choice is the one the sketch view's Chords section uses.
   */
  import { onDestroy } from 'svelte';
  import { chordTones, formatChord } from '../music/chords';
  import { chordTapsTitle, notesFromChordTaps, type ChordTap } from '../music/chordTaps';
  import { chordInWords, FLAT_NAMES, isDiminishedQuality, isMinorQuality, noteNamesFor, type Key } from '../music/key';
  import { PITCH_CLASS_NAMES } from '../music/notes';
  import { NoteSynth } from '../music/synth';
  import { GUITAR_TUNING, guitarVoicings, pianoVoicing, type GuitarVoicing } from '../music/voicings';
  import { app } from '../state/app.svelte';
  import CircleOfFifths, { type CircleChord } from './CircleOfFifths.svelte';
  import { formatClockTenths } from './format';
  import GuitarDiagram from './GuitarDiagram.svelte';
  import Icon from './Icon.svelte';
  import PianoDiagram from './PianoDiagram.svelte';

  type Tab = 'chords' | 'circle';
  type Instrument = 'piano' | 'guitar';
  const TAB_KEY = 'earbud.reference.tab';
  const ROOT_KEY = 'earbud.reference.root';
  /** Shared with the sketch view's Chords section. */
  const INSTRUMENT_KEY = 'earbud.chords.instrument';

  function remembered<T extends string>(storageKey: string, allowed: readonly T[], fallback: T): T {
    try {
      const v = localStorage.getItem(storageKey) as T | null;
      return v && allowed.includes(v) ? v : fallback;
    } catch {
      return fallback;
    }
  }
  function remember(storageKey: string, value: string) {
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      // private mode: not remembered
    }
  }

  /** The roots down the side: each letter, then its flat (C♭ and F♭ are B and E), with the sharp it also is. */
  const ROOTS = [
    { pc: 9, name: 'A', flat: false, also: null },
    { pc: 8, name: 'A♭', flat: true, also: 'G♯' },
    { pc: 11, name: 'B', flat: false, also: null },
    { pc: 10, name: 'B♭', flat: true, also: 'A♯' },
    { pc: 0, name: 'C', flat: false, also: null },
    { pc: 2, name: 'D', flat: false, also: null },
    { pc: 1, name: 'D♭', flat: true, also: 'C♯' },
    { pc: 4, name: 'E', flat: false, also: null },
    { pc: 3, name: 'E♭', flat: true, also: 'D♯' },
    { pc: 5, name: 'F', flat: false, also: null },
    { pc: 7, name: 'G', flat: false, also: null },
    { pc: 6, name: 'G♭', flat: true, also: 'F♯' },
  ] as const;
  type RootName = (typeof ROOTS)[number]['name'];

  /** The chords of a root, in the order they are offered (the qualities the chord detector knows). */
  const VARIANTS = ['M', 'm', '7', 'maj7', 'm7', 'dim', 'aug', 'sus2', 'sus4', '6', 'm6', 'add9', '9', 'maj9', 'm9', 'm7b5', 'dim7', 'mMaj7', '7sus4'];

  let tab = $state<Tab>(remembered(TAB_KEY, ['chords', 'circle'] as const, 'chords'));
  let instrument = $state<Instrument>(remembered(INSTRUMENT_KEY, ['piano', 'guitar'] as const, 'piano'));
  let rootName = $state<RootName>(remembered(ROOT_KEY, ROOTS.map((r) => r.name), 'C'));
  let quality = $state('M');
  /** Which guitar shape is shown, per chord symbol. */
  let shapeIndex = $state<Record<string, number>>({});

  function setTab(next: Tab) {
    tab = next;
    remember(TAB_KEY, next);
  }
  function setInstrument(next: Instrument) {
    instrument = next;
    remember(INSTRUMENT_KEY, next);
  }
  function setRoot(name: RootName) {
    rootName = name;
    remember(ROOT_KEY, name);
  }

  const synth = new NoteSynth();
  onDestroy(() => synth.dispose());

  // ------------------------------------------------------------- a chord

  interface Shown {
    root: number;
    quality: string;
    symbol: string;
    words: string;
    names: readonly string[];
    tones: string[];
    piano: { left: number[]; right: number[] };
    guitar: GuitarVoicing[];
  }

  /** Note names for a chord: flats for a root named flat, else those of its key. */
  function namesFor(root: number, q: string, flat: boolean): readonly string[] {
    if (flat) return FLAT_NAMES;
    const mode = isMinorQuality(q) || isDiminishedQuality(q) ? 'minor' : 'major';
    return noteNamesFor({ tonic: root, mode });
  }

  function describe(root: number, q: string, flat: boolean): Shown {
    const names = namesFor(root, q, flat);
    const key: Key = { tonic: root, mode: isMinorQuality(q) || isDiminishedQuality(q) ? 'minor' : 'major' };
    return {
      root,
      quality: q,
      symbol: formatChord(root, q, null, names),
      words: chordInWords({ root, quality: q, bass: root }, flat ? null : key).replace(/^\S+/, names[root]),
      names,
      tones: chordTones({ root, quality: q }).map((pc) => names[pc]),
      piano: pianoVoicing(root, q),
      guitar: guitarVoicings(root, q, root, 4),
    };
  }

  function shapeOf(c: Shown): GuitarVoicing | null {
    return c.guitar[shapeIndex[c.symbol] ?? 0] ?? c.guitar[0] ?? null;
  }

  /** The pitches heard for a chord on the chosen instrument. */
  function pitchesOf(c: Shown): number[] {
    const shape = instrument === 'guitar' ? shapeOf(c) : null;
    if (shape) return shape.frets.flatMap((f, s) => (f >= 0 ? [GUITAR_TUNING[s] + f] : []));
    return [...c.piano.left, ...c.piano.right];
  }

  function play(c: Shown) {
    synth.unlock();
    synth.playChord(pitchesOf(c), 80, 1.6, instrument === 'guitar' ? 0.035 : 0.012);
  }

  function cycleShape(c: Shown, step: number) {
    const n = c.guitar.length;
    if (n < 2) return;
    shapeIndex = { ...shapeIndex, [c.symbol]: ((shapeIndex[c.symbol] ?? 0) + step + n) % n };
  }

  // ------------------------------------------------------------- chords tab

  const root = $derived(ROOTS.find((r) => r.name === rootName) ?? ROOTS[4]);
  const variants = $derived(VARIANTS.map((q) => describe(root.pc, q, root.flat)));
  const chosen = $derived(variants.find((v) => v.quality === quality) ?? variants[0]);

  function chooseVariant(v: Shown) {
    quality = v.quality;
    play(v);
  }

  // ------------------------------------------------------------- circle tab

  let picked = $state<{ root: number; family: CircleChord['family'] } | null>(null);
  const familyQuality = { major: 'M', minor: 'm', diminished: 'dim' } as const;
  const pickedChord = $derived(picked ? describe(picked.root, familyQuality[picked.family], false) : null);
  /** The picked chord's key (its wedge on the circle); none for a diminished chord. */
  const pickedKey = $derived<Key | null>(
    picked && picked.family !== 'diminished' ? { tonic: picked.root, mode: picked.family === 'major' ? 'major' : 'minor' } : null,
  );
  const circleChords = $derived<CircleChord[]>(
    picked && pickedChord ? [{ root: picked.root, family: picked.family, weight: 1, symbols: [pickedChord.symbol] }] : [],
  );

  /** Recording chords tapped on the circle: armed (no tap yet) or running from the first tap. */
  let taking = $state<{ taps: ChordTap[]; first: number | null } | null>(null);
  let now = $state(0);
  let ticker: number | undefined;
  let saving = $state(false);

  function onCircle(rootPc: number, family: CircleChord['family']) {
    picked = { root: rootPc, family };
    const c = describe(rootPc, familyQuality[family], false);
    play(c);
    if (taking) {
      const t = performance.now() / 1000;
      taking = { taps: [...taking.taps, { time: t, pitches: pitchesOf(c), symbol: c.symbol }], first: taking.first ?? t };
    }
  }

  function startTaking() {
    synth.unlock();
    taking = { taps: [], first: null };
    window.clearInterval(ticker);
    ticker = window.setInterval(() => (now = performance.now() / 1000), 100);
  }

  function discardTaking() {
    taking = null;
    window.clearInterval(ticker);
  }

  async function stopTaking() {
    const take = taking;
    const end = performance.now() / 1000;
    discardTaking();
    if (!take || take.taps.length === 0) return;
    const notes = notesFromChordTaps(take.taps, end);
    saving = true;
    try {
      await app.saveChordSketch(notes, chordTapsTitle(take.taps), take.taps.map((t) => t.symbol));
    } finally {
      saving = false;
    }
  }

  onDestroy(() => window.clearInterval(ticker));
</script>

{#snippet chordCard(c: Shown)}
  {@const shape = shapeOf(c)}
  <article class="card" aria-label={c.symbol}>
    <div class="card-head">
      <span class="symbol serif">{c.symbol}</span>
      <span class="words">{c.words}</span>
      <span class="spacer"></span>
      <button class="play" onclick={() => play(c)} aria-label="Play {c.symbol} on {instrument}"><Icon name="play" size={16} /></button>
    </div>
    <p class="tones">{c.tones.join(' · ')}</p>
    <div class="diagram" class:guitar={instrument === 'guitar'}>
      {#if instrument === 'piano'}
        <PianoDiagram left={c.piano.left} right={c.piano.right} names={c.names} />
      {:else if shape}
        <GuitarDiagram voicing={shape} names={c.names} />
      {:else}
        <p class="none">No comfortable guitar shape found.</p>
      {/if}
    </div>
    {#if instrument === 'guitar' && c.guitar.length > 1}
      <div class="shapes">
        <button onclick={() => cycleShape(c, -1)} aria-label="Previous shape for {c.symbol}"><Icon name="left" size={16} /></button>
        <span class="tabular">Shape {(shapeIndex[c.symbol] ?? 0) + 1} of {c.guitar.length}</span>
        <button onclick={() => cycleShape(c, 1)} aria-label="Next shape for {c.symbol}"><Icon name="right" size={16} /></button>
      </div>
    {/if}
  </article>
{/snippet}

{#snippet instrumentChoice()}
  <div class="segmented" role="group" aria-label="Instrument">
    <button aria-pressed={instrument === 'piano'} onclick={() => setInstrument('piano')}>Piano</button>
    <button aria-pressed={instrument === 'guitar'} onclick={() => setInstrument('guitar')}>Guitar</button>
  </div>
{/snippet}

<div class="reference">
  <header class="bar">
    <button class="icon-button" onclick={() => app.goHome()} aria-label="Back to the notebook">
      <Icon name="back" />
    </button>
    <h1 class="serif">Reference</h1>
    <span class="spacer"></span>
    <div class="segmented tabs" role="group" aria-label="Reference">
      <button aria-pressed={tab === 'chords'} onclick={() => setTab('chords')}>Chords</button>
      <button aria-pressed={tab === 'circle'} onclick={() => setTab('circle')}>Circle of fifths</button>
    </div>
  </header>

  {#if tab === 'chords'}
    <div class="chords">
      <nav class="roots" aria-label="Root">
        {#each ROOTS as r (r.name)}
          <button class="root" class:on={r.name === rootName} aria-pressed={r.name === rootName} onclick={() => setRoot(r.name)}>
            <span class="serif">{r.name}</span>
            {#if r.also}<span class="also">{r.also}</span>{/if}
          </button>
        {/each}
      </nav>
      <section class="content" aria-label="{root.name} chords">
        <div class="variants" role="group" aria-label="Chords on {root.name}">
          {#each variants as v (v.quality)}
            <button class="variant serif" class:on={v.quality === chosen.quality} aria-pressed={v.quality === chosen.quality} onclick={() => chooseVariant(v)}>
              {v.symbol}
            </button>
          {/each}
        </div>
        <div class="instrument">{@render instrumentChoice()}</div>
        {@render chordCard(chosen)}
      </section>
    </div>
  {:else}
    <div class="circle">
      <CircleOfFifths key={pickedKey} chords={circleChords} active={0} names={PITCH_CLASS_NAMES} onplay={onCircle} />
      <div class="circle-foot">
        <p class="status" aria-live="polite">
          {#if saving}
            Saving…
          {:else if taking && taking.first === null}
            <span class="dot" aria-hidden="true"></span> Tap chords to record. Recording starts with the first.
          {:else if taking}
            <span class="dot" aria-hidden="true"></span>
            <span class="tabular">{formatClockTenths(Math.max(0, now - (taking.first ?? now)))} · {taking.taps.length} chord{taking.taps.length === 1 ? '' : 's'}</span>
            <button class="link" onclick={discardTaking}>Discard</button>
          {:else if pickedChord}
            {pickedChord.words}
          {:else}
            Tap a chord to hear it and see how to play it.
          {/if}
        </p>
        <button
          class="record"
          class:on={!!taking}
          onclick={() => (taking ? stopTaking() : startTaking())}
          disabled={saving || !app.notebook}
          aria-pressed={!!taking}
          aria-label={taking ? 'Stop and save the chords as a sketch' : 'Record chords tapped on the circle as a sketch'}
          title={taking ? 'Stop and save' : 'Record chords'}
        >
          <span class="glyph" aria-hidden="true"></span>
        </button>
      </div>
      {#if pickedChord}
        <div class="instrument">{@render instrumentChoice()}</div>
        {@render chordCard(pickedChord)}
      {/if}
    </div>
  {/if}
</div>

<style>
  .reference {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--paper);
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
    padding: calc(var(--safe-top) + 8px) calc(var(--safe-right) + 10px) 8px calc(var(--safe-left) + 6px);
    border-bottom: 1px solid var(--rule);
    background: var(--paper);
  }
  h1 {
    margin: 0;
    font-size: 1.45rem;
    letter-spacing: -0.01em;
  }
  .spacer {
    flex: 1;
  }
  @media (max-width: 480px) {
    .tabs {
      order: 3;
      width: 100%;
      justify-content: center;
    }
    .tabs button {
      flex: 1;
    }
  }

  /* Chords: the roots down the side, the chosen root's chords on the right. */
  .chords {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 72px 1fr;
  }
  .roots {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 6px calc(var(--safe-bottom) + 8px) calc(var(--safe-left) + 6px);
    overflow-y: auto;
    border-right: 1px solid var(--rule);
    background: var(--paper-sunk);
  }
  .root {
    display: grid;
    justify-items: center;
    align-content: center;
    gap: 0;
    flex: none;
    height: 50px;
    padding: 4px 0;
    border-radius: var(--radius-sm);
    color: var(--ink-2);
    line-height: 1.1;
  }
  .root .serif {
    font-size: 1.2rem;
    font-weight: 700;
  }
  .root .also {
    font-size: 0.7rem;
    color: var(--ink-3);
  }
  .root:hover {
    background: var(--paper);
  }
  .root.on {
    background: var(--paper-raised);
    color: var(--chord);
    box-shadow: var(--shadow);
  }
  .content {
    min-width: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px calc(var(--safe-right) + 14px) calc(var(--safe-bottom) + 24px) 14px;
  }
  .variants {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .variant {
    min-width: 46px;
    min-height: 38px;
    padding: 0 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--rule);
    background: var(--paper-raised);
    font-weight: 700;
    color: var(--chord);
  }
  .variant:hover {
    border-color: var(--rule-strong);
  }
  .variant.on {
    background: var(--chord);
    border-color: var(--chord);
    color: var(--paper);
  }
  .instrument {
    display: flex;
  }

  /* A chord: its name, notes and how to play it. */
  .card {
    display: grid;
    gap: 8px;
    max-width: 560px;
    padding: 14px 16px 16px;
    border-radius: var(--radius);
    border: 1px solid var(--rule);
    background: var(--paper-raised);
  }
  .card-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }
  .symbol {
    font-size: 2rem;
    font-weight: 700;
    color: var(--chord);
    line-height: 1.1;
  }
  .words {
    min-width: 0;
    color: var(--ink-2);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .play {
    align-self: center;
    flex: none;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--ink);
    color: var(--paper);
  }
  .tones {
    margin: 0;
    font-size: 0.9rem;
    color: var(--ink-3);
    letter-spacing: 0.02em;
  }
  .diagram {
    max-width: 440px;
  }
  .diagram.guitar {
    width: 60%;
    max-width: 220px;
    justify-self: center;
  }
  .none {
    margin: 8px 0;
    color: var(--ink-3);
  }
  .shapes {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font-size: 0.85rem;
    color: var(--ink-3);
  }
  .shapes button {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 8px;
    color: var(--ink-2);
  }
  .shapes button:hover {
    background: var(--paper-sunk);
  }

  /* Circle of fifths, with the record button under it on the right. */
  .circle {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 16px calc(var(--safe-right) + 16px) calc(var(--safe-bottom) + 24px) calc(var(--safe-left) + 16px);
  }
  .circle > :global(svg) {
    width: min(100%, 440px);
    max-width: 440px;
  }
  .circle .card,
  .circle .instrument,
  .circle-foot {
    width: min(100%, 440px);
  }
  .circle-foot {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
  }
  .status {
    flex: 1;
    margin: 0;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 0.9rem;
    color: var(--ink-2);
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--accent);
    animation: blink 1s ease-in-out infinite;
  }
  @keyframes blink {
    50% {
      opacity: 0.3;
    }
  }
  .link {
    font-size: 0.85rem;
    color: var(--ink-3);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .record {
    flex: none;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 1.5px solid var(--rule-strong);
    background: var(--paper-raised);
  }
  .record .glyph {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--accent);
    transition: border-radius 120ms ease;
  }
  .record.on {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .record.on .glyph {
    width: 12px;
    height: 12px;
    border-radius: 2px;
  }
</style>
