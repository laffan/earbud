/**
 * Choosing the microphone and the output, separately (Settings → Audio).
 *
 * - In a browser or a desktop web view: any microphone the system lists
 *   (getUserMedia with its device id), and any output where the web view can
 *   route Web Audio (`AudioContext.setSinkId`: Chromium, so Chrome, Edge and
 *   the Windows app; not Safari or the macOS and Linux web views, where the
 *   system's output is used).
 * - On iOS the choice is a kind of microphone and speaker or automatic
 *   output, applied by the native recorder (see CapturePlugin.swift).
 *
 * Every AudioContext that plays something goes through `routeOutput`, which
 * sends it to the chosen output now and whenever the choice changes.
 */

export interface AudioDevice {
  id: string;
  label: string;
}

/** The microphone kinds iOS can be asked for, and its outputs while recording. */
export type IosInput = 'auto' | 'builtIn' | 'bluetooth' | 'wired';
export type IosOutput = 'auto' | 'speaker';

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };

/** The web view can send Web Audio to a chosen output. */
export function canChooseOutput(): boolean {
  return typeof AudioContext !== 'undefined' && typeof (AudioContext.prototype as SinkContext).setSinkId === 'function';
}

/** The web view can list and open a chosen microphone. */
export function canChooseInput(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.enumerateDevices && !!navigator.mediaDevices.getUserMedia;
}

/**
 * The microphones and outputs the system lists. Names are only given once
 * the page may use the microphone (`named` false: call `revealDeviceNames`).
 */
export async function listAudioDevices(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[]; named: boolean }> {
  if (!canChooseInput()) return { inputs: [], outputs: [], named: false };
  const all = await navigator.mediaDevices.enumerateDevices();
  const named = all.some((d) => d.label);
  const pick = (kind: MediaDeviceKind) =>
    all
      // "default" and "communications" are aliases of real devices (Chromium).
      .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${kind === 'audioinput' ? 'Microphone' : 'Output'} ${i + 1}` }));
  return { inputs: pick('audioinput'), outputs: pick('audiooutput'), named };
}

/** Ask for the microphone once (and let it go), so the system gives the devices' names. */
export async function revealDeviceNames(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) track.stop();
}

// ---------------------------------------------------------------- output

let outputId = '';
const contexts = new Set<SinkContext>();
let log: (message: string) => void = () => {};

/** Where diagnostics about routing go (the app's capture log). */
export function setDeviceLog(fn: (message: string) => void) {
  log = fn;
}

function apply(ctx: SinkContext) {
  if (typeof ctx.setSinkId !== 'function' || ctx.state === 'closed') return;
  if ((ctx.sinkId ?? '') === outputId) return;
  ctx.setSinkId(outputId).catch((error: unknown) => {
    log(`could not send sound to the chosen output (${outputId || 'default'}): ${error instanceof Error ? error.message : String(error)}`);
    // The device is gone: the system's output.
    if (outputId) void ctx.setSinkId!('').catch(() => {});
  });
}

/** Send `ctx` to the chosen output, now and after every change of the choice (until it is closed). */
export function routeOutput<T extends AudioContext>(ctx: T): T {
  const c = ctx as SinkContext;
  if (typeof c.setSinkId !== 'function') return ctx;
  contexts.add(c);
  c.addEventListener?.('statechange', () => {
    if (c.state === 'closed') contexts.delete(c);
  });
  apply(c);
  return ctx;
}

/** The output every routed context plays to ('' = the system's). */
export function setOutputDevice(id: string) {
  if (id === outputId) return;
  outputId = id;
  for (const ctx of contexts) apply(ctx);
}

export function currentOutputDevice(): string {
  return outputId;
}
