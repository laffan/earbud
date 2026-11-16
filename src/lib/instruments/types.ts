import type { PianoNote } from '../transcription/types';
export interface MidiEvent { time: number; bytes: number[] }
export interface MusicCapabilities {
  supportsAUv3Hosting: boolean; supportsCoreMIDIOutput: boolean;
  supportsAudioShareImport: boolean; supportsNativeInstrumentRendering: boolean;
}
export interface Destination { id: string; name: string; transport: string }
export interface Instrument { id: string; name: string; manufacturer: string }
export interface Preset { number: number; name: string }
export interface Parameter { address: string; name: string; min: number; max: number; value: number }
export interface MidiSnapshot {
  notes: PianoNote[]; tempoBpm: number | null; metadata: Record<string, unknown>;
}
export interface MidiSession {
  id: string; sourceId: string; sourceTitle: string; snapshot: MidiSnapshot;
  midiHash: string; destination: Record<string, unknown>; createdAt: number;
  status: 'pending' | 'importing' | 'completed' | 'cancelled' | 'archived';
  resultId: string | null; importId: string | null;
}
export interface IncomingAudio { error?: string; id: string; name: string; size: number; durationMs: number; mime: string; extension: string }
export interface RenderProgress { state: 'idle' | 'rendering' | 'complete' | 'cancelled' | 'failed'; fraction: number; error?: string; audio?: IncomingAudio }
