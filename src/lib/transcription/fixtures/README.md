# Recorded activations

Basic Pitch output (frame and onset activations) for short pieces rendered from sampled piano
notes, used by `noteCleanup.test.ts` so the held-note logic is tested against what the model
really produces without running it. Values are rounded to 0.001 and those under 0.12 (the model's
noise floor) are stored as 0. Coarser rounding makes neighbouring frames tie, and the decoder only
takes strict peaks as onsets. Format: see `src/lib/testing/activations.ts`.

| File | Piece |
| --- | --- |
| `held-chords.activations.gz` | G3 held for 8 s (0.5–8.5 s) while four louder chords are struck over it, two of them containing G4. |
| `repeats.activations.gz` | Repeated notes that must stay separate: C4 ×6 detached, G4 ×6 legato, C5 ×8 fast (4 per second), G3 ×5 soft legato. |
