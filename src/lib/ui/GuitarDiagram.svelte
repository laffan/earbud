<script lang="ts">
  /**
   * A guitar chord box: strings low E to high E from left to right, four
   * frets from the shape's position down (the nut drawn at the first fret),
   * a dot per fretted note, a bar for a barre, ○ for open and × for muted
   * strings, and the sounding notes named underneath.
   */
  import { pitchClass } from '../music/notes';
  import { GUITAR_TUNING, type GuitarVoicing } from '../music/voicings';

  interface Props {
    voicing: GuitarVoicing;
    /** Note names by pitch class (spelled for the key). */
    names: readonly string[];
  }

  let { voicing, names }: Props = $props();

  const LEFT = 16;
  const TOP = 14;
  const GAP = 12;
  const FRET_H = 15;
  const FRETS = 4;
  const width = LEFT + GAP * 5 + 10;
  const boardBottom = TOP + FRET_H * FRETS;
  const height = boardBottom + 14;

  /** First fret shown: the nut for shapes near it, else the shape's lowest fret. */
  const start = $derived(voicing.position <= 2 ? 1 : voicing.position);
  const x = (string: number) => LEFT + string * GAP;
  const y = (fret: number) => TOP + (fret - start + 0.5) * FRET_H;
  const label = $derived(
    `Guitar, low E to high E: ${voicing.frets.map((f) => (f < 0 ? 'muted' : f === 0 ? 'open' : `fret ${f}`)).join(', ')}`,
  );
</script>

<svg class="guitar" viewBox="0 0 {width} {height}" role="img" aria-label={label}>
  {#if start === 1}
    <rect class="nut" x={x(0) - 1} y={TOP - 3} width={GAP * 5 + 2} height="3" />
  {:else}
    <text class="position" x={LEFT - 5} y={y(start) + 3} text-anchor="end">{start}</text>
  {/if}
  {#each Array.from({ length: FRETS + 1 }, (_, i) => i) as i (i)}
    <line class="fret" x1={x(0)} x2={x(5)} y1={TOP + i * FRET_H} y2={TOP + i * FRET_H} />
  {/each}
  {#each voicing.frets as _f, s (s)}
    <line class="string" x1={x(s)} x2={x(s)} y1={TOP} y2={boardBottom} />
  {/each}
  {#if voicing.barre}
    {@const b = voicing.barre}
    <rect class="barre" x={x(b.from) - 4} y={y(b.fret) - 4} width={x(b.to) - x(b.from) + 8} height="8" rx="4" />
  {/if}
  {#each voicing.frets as fret, s (s)}
    {#if fret < 0}
      <text class="mark" x={x(s)} y={TOP - 5} text-anchor="middle">×</text>
    {:else if fret === 0}
      <circle class="open" cx={x(s)} cy={TOP - 7.5} r="2.6" />
    {:else if !voicing.barre || fret !== voicing.barre.fret || s < voicing.barre.from}
      <circle class="dot" cx={x(s)} cy={y(fret)} r="4.2" />
    {/if}
    {#if fret >= 0}
      <text class="name" x={x(s)} y={height - 3} text-anchor="middle">{names[pitchClass(GUITAR_TUNING[s] + fret)]}</text>
    {/if}
  {/each}
</svg>

<style>
  .guitar {
    display: block;
    width: 100%;
    height: auto;
    max-height: 150px;
  }
  .nut {
    fill: var(--ink);
  }
  .fret {
    stroke: var(--rule-strong);
    stroke-width: 0.8;
  }
  .string {
    stroke: var(--ink-2);
    stroke-width: 0.8;
  }
  .dot,
  .barre {
    fill: var(--accent);
  }
  .open {
    fill: none;
    stroke: var(--ink-2);
    stroke-width: 1;
  }
  .mark {
    font: 600 8px var(--font-ui);
    fill: var(--ink-3);
  }
  .position {
    font: 600 7px var(--font-ui);
    fill: var(--ink-3);
  }
  .name {
    font: 600 6.5px var(--font-ui);
    fill: var(--ink-2);
  }
</style>
