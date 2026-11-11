/**
 * Extension point (not implemented in the MVP): visual piano-key and finger
 * tracking, combined with audio transcription.
 *
 * Intended iOS implementation: a native `analyzeVideo` command in
 * `tauri-plugin-capture` that reads the saved recording with AVAssetReader,
 * runs Apple Vision requests (e.g. VNDetectHumanHandPoseRequest plus a
 * keyboard-geometry model) on-device, and writes compact observations to a
 * JSON file next to the recording. As with audio extraction, no video frames
 * cross the JavaScript bridge; only the small result does.
 *
 * A `FusionEngine` can then use key-press evidence to confirm, reject or
 * re-pitch audio-only notes (octave errors, harmonics, missed soft notes) and
 * to attach fingering.
 */
import type { PianoNote } from '../transcription/types';

export type Hand = 'left' | 'right';

export interface KeyboardObservation {
  /** Seconds from the start of the recording. */
  time: number;
  /** MIDI pitches whose keys appear depressed in this frame. */
  pressedKeys: number[];
  fingers?: {
    hand: Hand;
    /** 1 = thumb … 5 = little finger. */
    finger: 1 | 2 | 3 | 4 | 5;
    /** Normalized image coordinates. */
    x: number;
    y: number;
    /** Key under the fingertip, when the keyboard is calibrated. */
    key?: number;
    confidence: number;
  }[];
}

export interface VisualAnalysisEngine {
  readonly id: string;
  analyze(videoPath: string, options?: { onProgress?: (fraction: number) => void }): Promise<KeyboardObservation[]>;
}

export interface FusedNote extends PianoNote {
  hand?: Hand;
  finger?: 1 | 2 | 3 | 4 | 5;
}

export interface FusionEngine {
  fuse(audioNotes: PianoNote[], observations: KeyboardObservation[]): FusedNote[];
}
