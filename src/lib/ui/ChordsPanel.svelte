<script lang="ts">
  /**
   * The sketch's harmony, under its tracks: the key, then two tabs.
   *  - Chords: the progression in order (tap a chord to go there and hear
   *    it), and a card for each chord used, with its name, its roman numeral
   *    in the key, and how to play it on piano or guitar (tap to hear that
   *    voicing).
   *  - Circle of fifths: where those chords sit on the circle, the key's
   *    wedge, and the path the progression takes; any chord can be tried.
   * Everything comes from the notes of the tracks being heard (mute and
   * solo apply), together, on the sketch's timeline.
   */
  import type { ChordSegment } from '../music/chords';
  import {
    chordInWords,
    isDiminishedQuality,
    isMinorQuality,
    keyName,
    noteNamesFor,
    romanNumeral,
    spellChord,
    type KeyEstimate,
  } from '../music/key';
  import { GUITAR_TUNING, guitarVoicings, pianoVoicing, type GuitarVoicing } from '../music/voicings';
  import CircleOfFifths, { type CircleChord } from './CircleOfFifths.svelte';
  import GuitarDiagram from './GuitarDiagram.svelte';
  import Icon from './Icon.svelte';
  import PianoDiagram from './PianoDiagram.svelte';

  interface Props {
    /** Chords of the tracks being heard, on the sketch's timeline. */
    chords: ChordSegment[];
    key: KeyEstimate | null;
    currentTime: number;
    /** 'pending': nothing transcribed yet; 'ready': notes to analyse (chords or not). */
    status: 'pending' | 'ready' | 'empty';
    /** Several tracks are combined. */
    combined: boolean;
    /** Play these pitches together (spread: seconds between them, bass first). */
    onplay: (pitches: number[], spread: number) => void;
    onseek: (time: number) => void;
  }

  let { chords, key, currentTime, status, combined, onplay, onseek }: Props = $props();

  type Tab = 'chords' | 'circle';
  type Instrument = 'piano' | 'guitar';
  const TAB_KEY = 'earbud.chords.tab';
  const INSTRUMENT_KEY = 'earbud.chords.instrument';

  function remembered<T extends string>(storageKey: string, allowed: T[], fallback: T): T {
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

  let tab = $state<Tab>(remembered(TAB_KEY, ['chords', 'circle'], 'chords'));
  let instrument = $state<Instrument>(remembered(INSTRUMENT_KEY, ['piano', 'guitar'], 'piano'));
  /** Which guitar shape each chord shows (by symbol). */
  let shapeIndex = $state<Record<string, number>>({});

  function setTab(next: Tab) {
    tab = next;
    remember(TAB_KEY, next);
  }
  function setInstrument(next: Instrument) {
    instrument = next;
    remember(INSTRUMENT_KEY, next);
  }

  const names = $derived(noteNamesFor(key));

  interface Entry {
    symbol: string;
    chord: ChordSegment;
    numeral: string | null;
    words: string;
    count: number;
    seconds: number;
    piano: { left: number[]; right: number[] };
    guitar: GuitarVoicing[];
  }

  /** Each chord used, once, in the order it first appears. */
  const entries = $derived.by(() => {
    const bySymbol = new Map<string, Entry>();
    let previous: string | null = null;
    for (const chord of chords) {
      const symbol = spellChord(chord, key);
      let entry = bySymbol.get(symbol);
      if (!entry) {
        entry = {
          symbol,
          chord,
          numeral: key ? romanNumeral(chord, key) : null,
          words: chordInWords(chord, key),
          count: 0,
          seconds: 0,
          piano: pianoVoicing(chord.root, chord.quality, chord.bass),
          guitar: guitarVoicings(chord.root, chord.quality, chord.bass, 3),
        };
        bySymbol.set(symbol, entry);
      }
      if (symbol !== previous) entry.count++;
      entry.seconds += chord.endTime - chord.startTime;
      previous = symbol;
    }
    return [...bySymbol.values()];
  });

  /** The progression: consecutive chords, repeats merged. */
  const progression = $derived.by(() => {
    const out: { symbol: string; numeral: string | null; start: number; end: number; chord: ChordSegment }[] = [];
    for (const chord of chords) {
      const symbol = spellChord(chord, key);
      const last = out[out.length - 1];
      if (last && last.symbol === symbol) last.end = chord.endTime;
      else out.push({ symbol, numeral: key ? romanNumeral(chord, key) : null, start: chord.startTime, end: chord.endTime, chord });
    }
    return out;
  });
  const PROGRESSION_LIMIT = 48;

  const activeIndex = $derived(progression.findIndex((p) => currentTime >= p.start && currentTime < p.end));
  const activeSymbol = $derived(activeIndex >= 0 ? progression[activeIndex].symbol : null);

  // ---------------------------------------------------------------- circle

  const familyOf = (quality: string): CircleChord['family'] =>
    isDiminishedQuality(quality) ? 'diminished' : isMinorQuality(quality) ? 'minor' : 'major';

  const circle = $derived.by(() => {
    const total = entries.reduce((s, e) => s + e.seconds, 0) || 1;
    const list: CircleChord[] = [];
    const indexOf = new Map<string, number>();
    for (const e of entries) {
      const id = `${familyOf(e.chord.quality)}:${e.chord.root}`;
      let index = indexOf.get(id);
      if (index === undefined) {
        index = list.length;
        indexOf.set(id, index);
        list.push({ root: e.chord.root, family: familyOf(e.chord.quality), weight: 0, symbols: [] });
      }
      list[index].weight += e.seconds / total;
      list[index].symbols.push(e.symbol);
    }
    const at = (chord: ChordSegment) => indexOf.get(`${familyOf(chord.quality)}:${chord.root}`) ?? -1;
    return {
      chords: list,
      path: progression.slice(0, PROGRESSION_LIMIT).map((p) => at(p.chord)),
      active: activeIndex >= 0 ? at(progression[activeIndex].chord) : -1,
    };
  });

  // ------------------------------------------------------------------ play

  function playEntry(entry: Entry) {
    if (instrument === 'guitar' && entry.guitar.length) {
      const shape = entry.guitar[shapeIndex[entry.symbol] ?? 0] ?? entry.guitar[0];
      onplay(guitarPitches(shape), 0.035);
    } else onplay([...entry.piano.left, ...entry.piano.right], 0.012);
  }

  function guitarPitches(shape: GuitarVoicing): number[] {
    return shape.frets.flatMap((f, s) => (f >= 0 ? [GUITAR_TUNING[s] + f] : []));
  }

  function goTo(step: (typeof progression)[number]) {
    onseek(step.start);
    const v = pianoVoicing(step.chord.root, step.chord.quality, step.chord.bass);
    onplay([...v.left, ...v.right], 0.012);
  }

  function playOnCircle(root: number, family: CircleChord['family']) {
    const quality = family === 'major' ? 'M' : family === 'minor' ? 'm' : 'dim';
    const v = pianoVoicing(root, quality);
    onplay([...v.left, ...v.right], 0.012);
  }

  function cycleShape(entry: Entry, step: number) {
    const n = entry.guitar.length;
    const current = shapeIndex[entry.symbol] ?? 0;
    shapeIndex = { ...shapeIndex, [entry.symbol]: (current + step + n) % n };
  }

  function seconds(s: number): string {
    return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
  }
</script>

<section class="analysis" aria-labelledby="chords-title">
  <header class="head">
    <h2 id="chords-title">Chords</h2>
    {#if key}
      <span class="key serif" title="Detected from the notes">
        {keyName(key)}{#if key.alternative}<span class="alt"> or {keyName(key.alternative)}</span>{/if}
      </span>
    {/if}
    <span class="spacer"></span>
    <div class="segmented" role="group" aria-label="Chords view">
      <button aria-pressed={tab === 'chords'} onclick={() => setTab('chords')}>Chords</button>
      <button aria-pressed={tab === 'circle'} onclick={() => setTab('circle')}>Circle of fifths</button>
    </div>
  </header>

  {#if status === 'pending'}
    <p class="empty">Chords appear here once the recording is transcribed.</p>
  {:else if chords.length === 0}
    <p class="empty">
      No clear chords yet. Chords are named where three or more notes sound together{combined ? ' (across the tracks you hear)' : ''}.
    </p>
  {:else if tab === 'chords'}
    <ol class="progression" aria-label="Progression">
      {#each progression.slice(0, PROGRESSION_LIMIT) as step, i (step.start)}
        <li>
          <button class="step" class:active={i === activeIndex} onclick={() => goTo(step)} aria-label="Go to {step.symbol} and hear it">
            <span class="symbol serif">{step.symbol}</span>
            {#if step.numeral}<span class="numeral serif">{step.numeral}</span>{/if}
          </button>
        </li>
      {/each}
      {#if progression.length > PROGRESSION_LIMIT}<li class="more">+{progression.length - PROGRESSION_LIMIT} more</li>{/if}
    </ol>

    <div class="instrument">
      <span class="label">How to play</span>
      <div class="segmented" role="group" aria-label="Instrument">
        <button aria-pressed={instrument === 'piano'} onclick={() => setInstrument('piano')}>Piano</button>
        <button aria-pressed={instrument === 'guitar'} onclick={() => setInstrument('guitar')}>Guitar</button>
      </div>
    </div>

    <ul class="cards" class:wide={instrument === 'piano'}>
      {#each entries as entry (entry.symbol)}
        {@const shape = entry.guitar[shapeIndex[entry.symbol] ?? 0] ?? entry.guitar[0]}
        <li class="card" class:active={entry.symbol === activeSymbol}>
          <button class="card-head" onclick={() => playEntry(entry)} aria-label="Play {entry.symbol} on {instrument}">
            <span class="symbol serif">{entry.symbol}</span>
            {#if entry.numeral}<span class="numeral serif">{entry.numeral}</span>{/if}
            <span class="spacer"></span>
            <span class="play-icon"><Icon name="play" size={13} /></span>
          </button>
          <p class="words">{entry.words}</p>
          <div class="diagram" class:guitar={instrument === 'guitar'}>
            {#if instrument === 'piano'}
              <PianoDiagram left={entry.piano.left} right={entry.piano.right} {names} />
            {:else if shape}
              <GuitarDiagram voicing={shape} {names} />
            {:else}
              <p class="none">No comfortable guitar shape found.</p>
            {/if}
          </div>
          <div class="foot">
            <span class="meta tabular">{entry.count}× · {seconds(entry.seconds)}</span>
            {#if instrument === 'guitar' && entry.guitar.length > 1}
              <span class="shapes">
                <button onclick={() => cycleShape(entry, -1)} aria-label="Previous shape for {entry.symbol}"><Icon name="left" size={14} /></button>
                <span class="tabular">{(shapeIndex[entry.symbol] ?? 0) + 1}/{entry.guitar.length}</span>
                <button onclick={() => cycleShape(entry, 1)} aria-label="Next shape for {entry.symbol}"><Icon name="right" size={14} /></button>
              </span>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
    {#if instrument === 'piano'}
      <p class="legend">
        <span class="swatch left"></span> left hand (bass) <span class="swatch right"></span> right hand
      </p>
    {/if}
  {:else}
    <CircleOfFifths {key} chords={circle.chords} path={circle.path} active={circle.active} {names} onplay={playOnCircle} />
    <p class="legend">
      {#if key}The shaded wedge holds the chords of {keyName(key)}: I, IV and V outside, vi, ii and iii in the middle, vii° inside.{' '}{/if}Chords
      next to each other share most of their notes. Filled chords are the ones played, the line follows the
      progression, and any chord can be tapped to hear it.
    </p>
  {/if}
  {#if combined && status !== 'pending'}
    <p class="source">From the tracks you hear together (mute or solo tracks to change what is analysed).</p>
  {/if}
</section>

<style>
  .analysis {
    display: grid;
    gap: 12px;
    padding: 14px;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: var(--paper-raised);
    min-width: 0;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
  }
  h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  .key {
    font-weight: 700;
    color: var(--chord);
  }
  .key .alt {
    font-weight: 400;
    color: var(--ink-3);
  }
  .spacer {
    flex: 1;
  }
  .empty {
    margin: 4px 0;
    color: var(--ink-3);
    font-size: 0.9rem;
  }
  .progression {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .step {
    display: grid;
    justify-items: center;
    min-width: 44px;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--rule);
    background: var(--paper);
    line-height: 1.15;
  }
  .step .symbol {
    font-weight: 700;
    color: var(--chord);
  }
  .step .numeral {
    font-size: 0.72rem;
    color: var(--ink-3);
  }
  .step.active {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .step.active .symbol {
    color: var(--accent);
  }
  .more {
    align-self: center;
    font-size: 0.8rem;
    color: var(--ink-3);
  }
  .instrument {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .label {
    font-size: 0.78rem;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--ink-3);
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /* Keyboards need the width: one card per row on phones. */
  .cards.wide {
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  }
  .card {
    display: grid;
    gap: 4px;
    align-content: start;
    padding: 8px 10px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--rule);
    background: var(--paper);
    min-width: 0;
  }
  .card.active {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .card-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    text-align: left;
    min-width: 0;
  }
  .card-head .symbol {
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--chord);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card.active .card-head .symbol {
    color: var(--accent);
  }
  .card-head .numeral {
    color: var(--ink-2);
  }
  .play-icon {
    align-self: center;
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--paper-sunk);
    color: var(--ink-2);
  }
  .words {
    margin: 0;
    font-size: 0.78rem;
    color: var(--ink-3);
    min-height: 2.2em;
  }
  .diagram {
    padding: 2px 0;
  }
  .diagram.guitar {
    width: 72%;
    max-width: 130px;
    justify-self: center;
  }
  .none {
    margin: 8px 0;
    font-size: 0.8rem;
    color: var(--ink-3);
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-height: 24px;
  }
  .meta {
    font-size: 0.75rem;
    color: var(--ink-3);
  }
  .shapes {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    font-size: 0.75rem;
    color: var(--ink-3);
  }
  .shapes button {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    color: var(--ink-2);
  }
  .shapes button:hover {
    background: var(--paper-sunk);
  }
  .legend,
  .source {
    margin: 0;
    font-size: 0.78rem;
    color: var(--ink-3);
  }
  .swatch {
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    margin: 0 2px 0 8px;
    vertical-align: -1px;
  }
  .swatch.left {
    background: var(--chord);
    margin-left: 0;
  }
  .swatch.right {
    background: var(--accent);
  }
  @media (max-width: 400px) {
    .head .segmented button {
      padding: 0 9px;
      font-size: 0.8rem;
    }
  }
</style>
