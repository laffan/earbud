import { invoke, isTauri } from '../platform/tauri';
import type { Destination, IncomingAudio, Instrument, MidiEvent, MusicCapabilities, Parameter, Preset, RenderProgress } from './types';
const call = <T>(command: string, args?: Record<string, unknown>) => invoke<T>(`plugin:music|${command}`, args);
export const music = {
  capabilities: (): Promise<MusicCapabilities> => isTauri() ? call('capabilities') : Promise.resolve({ supportsAUv3Hosting: false, supportsCoreMIDIOutput: false, supportsAudioShareImport: false, supportsNativeInstrumentRendering: false }),
  destinations: () => call<{items: Destination[]}>('destinations').then(r => r.items),
  instruments: () => call<{items: Instrument[]}>('instruments').then(r => r.items),
  selectInstrument: (id: string) => call<{ presets: Preset[]; parameters: Parameter[] }>('select_instrument', { id }),
  preset: (number: number) => call<void>('set_preset', { number }),
  parameter: (address: string, value: number) => call<void>('set_parameter', { address, value }),
  showInterface: () => call<void>('show_interface'),
  play: (events: MidiEvent[], destinationId: string | null) => call<void>('play', { events, destinationId }),
  stop: () => call<void>('stop'),
  status: () => call<{ playing: boolean; error: string | null }>('transport_status'),
  render: (events: MidiEvent[], tail: number) => call<void>('render', { events, tail }),
  renderProgress: () => call<RenderProgress>('render_progress'),
  cancelRender: () => call<void>('cancel_render'),
  inbox: () => call<{items: IncomingAudio[]}>('inbox').then(r => r.items),
  copyIncoming: (id: string, mediaPath: string, analysisPath: string) => call<IncomingAudio>('copy_incoming', { id, mediaPath, analysisPath }),
  previewIncoming: (id: string) => call<void>('preview_incoming', { id }),
  stopPreview: () => call<void>('stop_preview'),
  acknowledge: (id: string) => call<void>('acknowledge', { id }),
  close: () => call<void>('close'),
};
