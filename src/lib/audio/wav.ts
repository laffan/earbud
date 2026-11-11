/** Minimal RIFF/WAVE reader and writer (PCM 8/16/24/32-bit and float32). */

export interface PcmAudio {
  sampleRate: number;
  /** One Float32Array per channel, samples in [-1, 1]. */
  channels: Float32Array[];
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

function fourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

export function decodeWav(buffer: ArrayBuffer): PcmAudio {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12 || fourCC(view, 0) !== 'RIFF' || fourCC(view, 8) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }
  let offset = 12;
  let format = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= buffer.byteLength) {
    const id = fourCC(view, offset);
    let size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channelCount = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      if (format === WAVE_FORMAT_EXTENSIBLE && size >= 40) {
        format = view.getUint16(body + 24, true);
      }
    } else if (id === 'data') {
      dataOffset = body;
      // Streams written without a final size (or truncated by a crash)
      // report 0 / 0xffffffff: use whatever is actually there.
      if (size === 0 || size === 0xffffffff || body + size > buffer.byteLength) {
        size = buffer.byteLength - body;
      }
      dataLength = size;
      break;
    }
    offset = body + size + (size % 2);
  }

  if (dataOffset < 0) throw new Error('WAV file has no data chunk');
  if (channelCount < 1 || sampleRate <= 0) throw new Error('WAV file has an invalid fmt chunk');
  if (format !== WAVE_FORMAT_PCM && format !== WAVE_FORMAT_IEEE_FLOAT) {
    throw new Error(`Unsupported WAV encoding (format ${format})`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameBytes = bytesPerSample * channelCount;
  const frames = Math.floor(dataLength / frameBytes);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const p = dataOffset + i * frameBytes + c * bytesPerSample;
      let value: number;
      if (format === WAVE_FORMAT_IEEE_FLOAT) {
        value = bitsPerSample === 64 ? view.getFloat64(p, true) : view.getFloat32(p, true);
      } else if (bitsPerSample === 16) {
        value = view.getInt16(p, true) / 32768;
      } else if (bitsPerSample === 24) {
        const raw = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16);
        value = raw / 8388608;
      } else if (bitsPerSample === 32) {
        value = view.getInt32(p, true) / 2147483648;
      } else if (bitsPerSample === 8) {
        value = (view.getUint8(p) - 128) / 128;
      } else {
        throw new Error(`Unsupported WAV bit depth ${bitsPerSample}`);
      }
      channels[c][i] = value;
    }
  }
  return { sampleRate, channels };
}

/** Encode mono or multichannel float samples as 16-bit PCM WAV. */
export function encodeWav16(channels: Float32Array[], sampleRate: number): Uint8Array {
  const channelCount = channels.length;
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * channelCount * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, WAVE_FORMAT_PCM, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(p, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
      p += 2;
    }
  }
  return out;
}

/** Average all channels into one. */
export function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const frames = channels[0].length;
  const out = new Float32Array(frames);
  for (const ch of channels) {
    for (let i = 0; i < frames; i++) out[i] += ch[i];
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < frames; i++) out[i] *= scale;
  return out;
}
