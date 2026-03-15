/**
 * audio/resampler.ts
 *
 * Pure-Node PCM resampling utilities.
 * - Downsample 48 kHz stereo (WebRTC input) → 16 kHz mono (Deepgram STT)
 * - Upsample 22 kHz / 16 kHz (Piper/Whisper output) → 48 kHz mono (LiveKit publish)
 *
 * All buffers are signed 16-bit little-endian (int16 PCM) — the native
 * format for both WebRTC and Deepgram.
 *
 * Algorithm: linear interpolation — good enough for voice, no deps.
 */

/**
 * Resample a signed-16-bit PCM buffer from `srcRate` to `dstRate`.
 * Handles mono → mono only; call `stereoToMono` first for stereo input.
 */
export function resample(
  pcm16: Buffer,
  srcRate: number,
  dstRate: number
): Buffer {
  if (srcRate === dstRate) return pcm16;

  const inputSamples = pcm16.length / 2; // bytes → int16 count
  const ratio = dstRate / srcRate;
  const outputSamples = Math.round(inputSamples * ratio);
  const out = Buffer.allocUnsafe(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    // Position in the source at fractional precision
    const srcPos = i / ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;

    const s0 = pcm16.readInt16LE(Math.min(srcIndex, inputSamples - 1) * 2);
    const s1 = pcm16.readInt16LE(
      Math.min(srcIndex + 1, inputSamples - 1) * 2
    );

    // Linear interpolation
    const sample = Math.round(s0 + frac * (s1 - s0));
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }

  return out;
}

/**
 * Convert a stereo int16 PCM buffer to mono by averaging L+R channels.
 */
export function stereoToMono(pcm16Stereo: Buffer): Buffer {
  const frames = pcm16Stereo.length / 4; // 2 channels × 2 bytes
  const out = Buffer.allocUnsafe(frames * 2);

  for (let i = 0; i < frames; i++) {
    const left = pcm16Stereo.readInt16LE(i * 4);
    const right = pcm16Stereo.readInt16LE(i * 4 + 2);
    out.writeInt16LE(Math.round((left + right) / 2), i * 2);
  }

  return out;
}

/**
 * Normalize PCM volume to a target peak level.
 * `targetPeak` is a fraction of full-scale (0–1); default 0.8.
 */
export function normalizePeak(pcm16: Buffer, targetPeak = 0.8): Buffer {
  let maxAbs = 0;
  for (let i = 0; i < pcm16.length; i += 2) {
    maxAbs = Math.max(maxAbs, Math.abs(pcm16.readInt16LE(i)));
  }
  if (maxAbs === 0) return pcm16;

  const gain = (targetPeak * 32767) / maxAbs;
  const out = Buffer.allocUnsafe(pcm16.length);
  for (let i = 0; i < pcm16.length; i += 2) {
    const sample = Math.round(pcm16.readInt16LE(i) * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i);
  }
  return out;
}

/**
 * Convenience: take 48 kHz stereo WebRTC PCM and return 16 kHz mono
 * ready for Deepgram.
 */
export function webrtcToStt(pcm48kStereo: Buffer): Buffer {
  const mono = stereoToMono(pcm48kStereo);
  return resample(mono, 48000, 16000);
}

/**
 * Convenience: take TTS output (any sample rate, mono) and return
 * 48 kHz mono PCM ready for LiveKit publish.
 */
export function ttsToWebrtc(pcmMono: Buffer, srcRate: number): Buffer {
  return resample(pcmMono, srcRate, 48000);
}
