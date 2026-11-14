import type { Sketch } from '../library/types';

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** m:ss.t, for precise positions (the waveform loupe). */
export function formatClockTenths(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const tenths = Math.floor(seconds * 10);
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${m}:${s.toString().padStart(2, '0')}.${tenths % 10}`;
}

export function formatDuration(ms: number | null | undefined): string {
  return ms == null ? '–:––' : formatClock(ms / 1000);
}

export function formatTimeOfDay(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: new Date(epochMs).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

export function dayLabel(epochMs: number, now = Date.now()): string {
  const day = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const diff = Math.round((day(now) - day(epochMs)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return formatDate(epochMs);
}

export function displayTitle(sketch: Pick<Sketch, 'title' | 'createdAt'>): string {
  return sketch.title.trim() || `Sketch, ${formatTimeOfDay(sketch.createdAt)}`;
}

/** File-name friendly default, e.g. "Earbud 2026-11-11 1042". */
export function exportBaseName(sketch: Pick<Sketch, 'title' | 'createdAt'>): string {
  if (sketch.title.trim()) return sketch.title.trim();
  const d = new Date(sketch.createdAt);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `Earbud ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function groupByDay<T extends { createdAt: number }>(items: T[]): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = dayLabel(item.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}
