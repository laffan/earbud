/**
 * WebKit's audio session is separate from the native AVAudioSession. Web
 * Audio defaults to ambient audio, even when its context is running. Ask
 * for music playback in the gesture that starts sound, including when the
 * context is already running. An explicit playback session must be released
 * before capture: otherwise it can interrupt the native recorder.
 */
interface WebAudioSession {
  type: string;
  readonly state?: string;
}

type Log = (message: string) => void;
let captures = 0;

function session(): WebAudioSession | undefined {
  return typeof navigator === 'undefined'
    ? undefined
    : (navigator as Navigator & { audioSession?: WebAudioSession }).audioSession;
}

function setType(type: 'auto' | 'playback', log?: Log) {
  try {
    const audio = session();
    if (!audio || audio.type === type) return;
    audio.type = type;
    log?.(`web audio session: type=${audio.type}, state=${audio.state ?? 'unknown'}`);
  } catch (error) {
    // Experimental API: a rejected request must not prevent ordinary audio.
    log?.(`could not set web audio session to ${type}: ${String(error)}`);
  }
}

/** Call synchronously in a sound-producing gesture, before resume(). */
export function preparePlaybackSession(log?: Log) {
  setType(captures ? 'auto' : 'playback', log);
}

/** Hold automatic session selection through capture, including retries and saving. */
export function beginCaptureSession(log?: Log): () => void {
  captures++;
  setType('auto', log);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    captures--;
    // Leave it automatic until the next playback gesture, after native teardown.
  };
}

export function webAudioSessionSummary(): string {
  try {
    const audio = session();
    return audio ? `type=${audio.type} state=${audio.state ?? 'unknown'}` : 'API unavailable';
  } catch (error) {
    return `unavailable: ${String(error)}`;
  }
}
