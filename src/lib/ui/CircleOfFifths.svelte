<script lang="ts" module>
  /** A chord as the circle places it: its root and family (the ring it sits on). */
  export interface CircleChord {
    root: number;
    family: 'major' | 'minor' | 'diminished';
    /** Share of the playing time it takes (0–1), for its emphasis. */
    weight: number;
    /** The symbols played that sit here (e.g. A minor's Am and Am7). */
    symbols: string[];
  }
</script>

<script lang="ts">
  /**
   * The circle of fifths with three rings: major chords outside, their
   * relative minors in the middle, the diminished chord of each key inside,
   * so each key's seven chords form a wedge (I, IV, V outside; vi, ii, iii in
   * the middle; vii° inside). The sketch's key is shaded, the chords it uses
   * are filled (stronger for more time), so the areas a recording covers
   * stand out, and the chord at the playhead is lit. Tap any chord to hear it.
   */
  import type { Key } from '../music/key';

  interface Props {
    key: Key | null;
    chords: CircleChord[];
    /** Index into `chords` of the chord at the playhead, or -1. */
    active: number;
    /** Note names by pitch class (spelled for the key). */
    names: readonly string[];
    onplay: (root: number, family: CircleChord['family']) => void;
  }

  let { key, chords, active, names, onplay }: Props = $props();

  const C = 160;
  const RINGS = {
    major: { inner: 112, outer: 156, label: 134 },
    minor: { inner: 74, outer: 112, label: 93 },
    diminished: { inner: 42, outer: 74, label: 58 },
  } as const;
  type Family = keyof typeof RINGS;
  const FAMILIES: Family[] = ['major', 'minor', 'diminished'];

  /** Root of the chord at circle position `i` (0 = top, clockwise by fifths) on a ring. */
  function rootAt(i: number, family: Family): number {
    const major = (i * 7) % 12;
    return family === 'major' ? major : family === 'minor' ? (major + 9) % 12 : (major + 11) % 12;
  }
  function positionOf(root: number, family: Family): number {
    for (let i = 0; i < 12; i++) if (rootAt(i, family) === root) return i;
    return 0;
  }
  const angle = (i: number) => ((i * 30 - 90) * Math.PI) / 180;
  function point(i: number, r: number): [number, number] {
    return [C + r * Math.cos(angle(i)), C + r * Math.sin(angle(i))];
  }
  /** Path of the ring sector for position `i`. */
  function sector(i: number, inner: number, outer: number, span = 1): string {
    const a0 = angle(i - span / 2);
    const a1 = angle(i + span / 2);
    const p = (r: number, a: number) => `${(C + r * Math.cos(a)).toFixed(2)} ${(C + r * Math.sin(a)).toFixed(2)}`;
    const large = span > 6 ? 1 : 0;
    return `M ${p(outer, a0)} A ${outer} ${outer} 0 ${large} 1 ${p(outer, a1)} L ${p(inner, a1)} A ${inner} ${inner} 0 ${large} 0 ${p(inner, a0)} Z`;
  }

  /** Where the key's wedge is centred (its relative major's position). */
  const keyPosition = $derived(key ? positionOf(key.mode === 'major' ? key.tonic : (key.tonic + 3) % 12, 'major') : null);
  const tonicFamily = $derived<Family | null>(key ? (key.mode === 'major' ? 'major' : 'minor') : null);

  const used = $derived(new Map(chords.map((c, index) => [`${c.family}:${c.root}`, { chord: c, index }])));
  const maxWeight = $derived(Math.max(0.0001, ...chords.map((c) => c.weight)));

  function labelFor(root: number, family: Family): string {
    return `${names[root]}${family === 'minor' ? 'm' : family === 'diminished' ? '°' : ''}`;
  }
  const familyWords = { major: 'major', minor: 'minor', diminished: 'diminished' };

  function onKey(e: KeyboardEvent, root: number, family: Family) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onplay(root, family);
    }
  }
</script>

<svg class="circle" viewBox="0 0 320 320" role="group" aria-label="Circle of fifths">
  <!-- The key's wedge: I, IV, V and vi, ii, iii, and vii°. -->
  {#if keyPosition !== null}
    <path class="wedge" d={sector(keyPosition, RINGS.minor.inner, RINGS.major.outer, 3)} />
    <path class="wedge" d={sector(keyPosition, RINGS.diminished.inner, RINGS.diminished.outer)} />
  {/if}

  {#each FAMILIES as family (family)}
    {@const ring = RINGS[family]}
    {#each Array.from({ length: 12 }, (_, i) => i) as i (i)}
      {@const root = rootAt(i, family)}
      {@const hit = used.get(`${family}:${root}`)}
      {@const [lx, ly] = point(i, ring.label)}
      {@const tonic = keyPosition === i && tonicFamily === family}
      <g
        class="cell"
        class:used={!!hit}
        class:active={!!hit && hit.index === active}
        class:tonic
        role="button"
        tabindex="0"
        aria-label="{labelFor(root, family)}{hit ? `, played (${hit.chord.symbols.join(', ')})` : ''}. Play {names[root]} {familyWords[family]}"
        onclick={() => onplay(root, family)}
        onkeydown={(e) => onKey(e, root, family)}
      >
        <path
          class="sector"
          d={sector(i, ring.inner, ring.outer)}
          style:--weight={hit ? 0.25 + 0.75 * (hit.chord.weight / maxWeight) : 0}
        />
        <text class="label {family}" x={lx} y={ly} text-anchor="middle" dominant-baseline="central">{labelFor(root, family)}</text>
      </g>
    {/each}
  {/each}
</svg>

<style>
  .circle {
    display: block;
    width: 100%;
    max-width: 380px;
    margin: 0 auto;
    height: auto;
    touch-action: manipulation;
  }
  .wedge {
    fill: color-mix(in srgb, var(--chord) 10%, transparent);
    stroke: color-mix(in srgb, var(--chord) 45%, transparent);
    stroke-width: 1.2;
    pointer-events: none;
  }
  .sector {
    fill: color-mix(in srgb, var(--chord) calc(var(--weight) * 55%), transparent);
    stroke: var(--rule);
    stroke-width: 0.8;
    cursor: pointer;
  }
  .cell:hover .sector,
  .cell:focus-visible .sector {
    stroke: var(--ink-3);
  }
  .cell:focus,
  .cell:focus-visible {
    outline: none;
  }
  .cell.active .sector {
    fill: color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .label {
    pointer-events: none;
    fill: var(--ink-3);
    font: 500 11px var(--font-serif);
  }
  .label.major {
    font-size: 13px;
  }
  .label.diminished {
    font-size: 9px;
  }
  .used .label {
    fill: var(--ink);
    font-weight: 700;
  }
  .active .label {
    fill: var(--accent);
  }
  .tonic .sector {
    stroke: var(--chord);
    stroke-width: 2;
  }
</style>
