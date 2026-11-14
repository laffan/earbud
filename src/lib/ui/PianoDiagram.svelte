<script lang="ts">
  /**
   * A keyboard with a chord's keys marked: the left hand's bass in the chord
   * colour, the right hand's chord tones in the accent colour, each named
   * underneath. The keyboard runs from the C or F at or below the lowest key
   * to the E or B at or above the highest, so the keys stay large.
   */
  import { isBlackKey, pitchClass } from '../music/notes';

  interface Props {
    left: number[];
    right: number[];
    /** Note names by pitch class (spelled for the key). */
    names: readonly string[];
  }

  let { left, right, names }: Props = $props();

  const WHITE_W = 10;
  const WHITE_H = 44;
  const BLACK_W = 6.2;
  const BLACK_H = 27;
  const LABEL_H = 14;

  const all = $derived([...left, ...right]);
  const lo = $derived.by(() => {
    let p = Math.min(...all);
    while (pitchClass(p) !== 0 && pitchClass(p) !== 5) p--;
    return p;
  });
  const hi = $derived.by(() => {
    let p = Math.max(...all);
    while (pitchClass(p) !== 4 && pitchClass(p) !== 11) p++;
    return p;
  });

  /** White keys from lo to hi, with their x; black keys between them. */
  const keys = $derived.by(() => {
    const whites: { pitch: number; x: number }[] = [];
    const blacks: { pitch: number; x: number }[] = [];
    let x = 0;
    for (let p = lo; p <= hi; p++) {
      if (isBlackKey(p)) blacks.push({ pitch: p, x: x - BLACK_W / 2 });
      else {
        whites.push({ pitch: p, x });
        x += WHITE_W;
      }
    }
    return { whites, blacks, width: x };
  });

  const hand = (pitch: number): 'left' | 'right' | null =>
    left.includes(pitch) ? 'left' : right.includes(pitch) ? 'right' : null;
  /** Centre of a key (for its mark and name). */
  function centre(pitch: number): number {
    const k = isBlackKey(pitch) ? keys.blacks.find((b) => b.pitch === pitch) : keys.whites.find((w) => w.pitch === pitch);
    if (!k) return 0;
    return k.x + (isBlackKey(pitch) ? BLACK_W : WHITE_W) / 2;
  }
  const label = $derived(
    `Piano: left hand ${left.map((p) => names[pitchClass(p)]).join(' ')}; right hand ${right.map((p) => names[pitchClass(p)]).join(' ')}`,
  );
</script>

<svg
  class="piano"
  viewBox="-1 -1 {keys.width + 2} {WHITE_H + LABEL_H + 2}"
  role="img"
  aria-label={label}
  preserveAspectRatio="xMidYMid meet"
>
  {#each keys.whites as key (key.pitch)}
    <rect class="white" class:left={hand(key.pitch) === 'left'} class:right={hand(key.pitch) === 'right'} x={key.x} y="0" width={WHITE_W} height={WHITE_H} rx="1.2" />
  {/each}
  {#each keys.blacks as key (key.pitch)}
    <rect class="black" class:left={hand(key.pitch) === 'left'} class:right={hand(key.pitch) === 'right'} x={key.x} y="0" width={BLACK_W} height={BLACK_H} rx="1" />
  {/each}
  {#each all as pitch (pitch)}
    {@const x = centre(pitch)}
    {@const black = isBlackKey(pitch)}
    <circle class="dot {hand(pitch)}" cx={x} cy={black ? BLACK_H - 5 : WHITE_H - 6} r="2.6" />
    <text class="name {hand(pitch)}" x={x} y={WHITE_H + LABEL_H - 3} text-anchor="middle">{names[pitchClass(pitch)]}</text>
  {/each}
</svg>

<style>
  .piano {
    display: block;
    width: 100%;
    height: auto;
    max-height: 110px;
  }
  .white {
    fill: var(--paper-raised);
    stroke: var(--rule-strong);
    stroke-width: 0.6;
  }
  .white.left {
    fill: color-mix(in srgb, var(--chord) 22%, var(--paper-raised));
  }
  .white.right {
    fill: color-mix(in srgb, var(--accent) 18%, var(--paper-raised));
  }
  .black {
    fill: var(--ink);
  }
  .black.left {
    fill: color-mix(in srgb, var(--chord) 70%, var(--ink));
  }
  .black.right {
    fill: color-mix(in srgb, var(--accent) 70%, var(--ink));
  }
  .dot.left {
    fill: var(--chord);
  }
  .dot.right {
    fill: var(--accent);
  }
  .dot {
    stroke: var(--paper-raised);
    stroke-width: 0.6;
  }
  .name {
    font: 700 8px var(--font-ui);
  }
  .name.left {
    fill: var(--chord);
  }
  .name.right {
    fill: var(--accent);
  }
</style>
