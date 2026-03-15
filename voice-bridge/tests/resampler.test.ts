/**
 * tests/resampler.test.ts
 */

import {
  resample,
  stereoToMono,
  normalizePeak,
  webrtcToStt,
  ttsToWebrtc,
} from "../src/audio/resampler";

function makeSine(
  freq: number,
  sampleRate: number,
  durationMs: number,
  amplitude = 16000
): Buffer {
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  const buf = Buffer.allocUnsafe(samples * 2);
  for (let i = 0; i < samples; i++) {
    const sample = Math.round(
      amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate)
    );
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

describe("stereoToMono", () => {
  it("halves the buffer size", () => {
    const stereo = Buffer.alloc(400); // 100 stereo frames
    const mono = stereoToMono(stereo);
    expect(mono.length).toBe(200);
  });

  it("averages L and R channels", () => {
    const stereo = Buffer.alloc(4);
    stereo.writeInt16LE(1000, 0); // L
    stereo.writeInt16LE(3000, 2); // R
    const mono = stereoToMono(stereo);
    expect(mono.readInt16LE(0)).toBe(2000);
  });

  it("handles silence (all zeros)", () => {
    const stereo = Buffer.alloc(8);
    const mono = stereoToMono(stereo);
    expect(mono.length).toBe(4);
    expect(mono.readInt16LE(0)).toBe(0);
  });
});

describe("resample", () => {
  it("returns same buffer when src === dst", () => {
    const buf = makeSine(440, 16000, 100);
    const out = resample(buf, 16000, 16000);
    expect(out).toBe(buf); // exact same reference
  });

  it("produces correct output length for 3x upsample", () => {
    const input = makeSine(440, 16000, 100); // 1600 samples
    const output = resample(input, 16000, 48000); // should be ~4800 samples
    const expectedSamples = Math.round(1600 * 3);
    expect(output.length / 2).toBeCloseTo(expectedSamples, -1);
  });

  it("produces correct output length for 3x downsample", () => {
    const input = makeSine(440, 48000, 100); // 4800 samples
    const output = resample(input, 48000, 16000);
    const expectedSamples = Math.round(4800 / 3);
    expect(output.length / 2).toBeCloseTo(expectedSamples, -1);
  });

  it("all samples are within int16 range after resample", () => {
    const input = makeSine(440, 48000, 50);
    const output = resample(input, 48000, 16000);
    for (let i = 0; i < output.length; i += 2) {
      const s = output.readInt16LE(i);
      expect(s).toBeGreaterThanOrEqual(-32768);
      expect(s).toBeLessThanOrEqual(32767);
    }
  });
});

describe("normalizePeak", () => {
  it("scales up quiet audio", () => {
    const buf = Buffer.alloc(4);
    buf.writeInt16LE(100, 0);
    buf.writeInt16LE(-100, 2);
    const out = normalizePeak(buf, 0.8);
    const peak = Math.max(
      Math.abs(out.readInt16LE(0)),
      Math.abs(out.readInt16LE(2))
    );
    expect(peak).toBeCloseTo(0.8 * 32767, -2);
  });

  it("returns silence unchanged", () => {
    const buf = Buffer.alloc(8);
    const out = normalizePeak(buf);
    expect(out.equals(buf)).toBe(true);
  });

  it("never clips above int16 max", () => {
    const buf = Buffer.alloc(4);
    buf.writeInt16LE(32767, 0);
    buf.writeInt16LE(-32768, 2);
    const out = normalizePeak(buf, 1.0);
    expect(Math.abs(out.readInt16LE(0))).toBeLessThanOrEqual(32767);
    expect(Math.abs(out.readInt16LE(2))).toBeLessThanOrEqual(32767);
  });
});

describe("webrtcToStt", () => {
  it("converts 48kHz stereo to 16kHz mono (3x shorter)", () => {
    const stereo48k = makeSine(440, 48000, 100); // 4800 stereo samples = 19200 bytes
    // Make it fake stereo by interleaving
    const stereoFull = Buffer.allocUnsafe(stereo48k.length * 2);
    for (let i = 0; i < stereo48k.length / 2; i++) {
      const s = stereo48k.readInt16LE(i * 2);
      stereoFull.writeInt16LE(s, i * 4);
      stereoFull.writeInt16LE(s, i * 4 + 2);
    }
    const out = webrtcToStt(stereoFull);
    // 4800 stereo samples → 4800 mono → ~1600 @ 16kHz
    expect(out.length / 2).toBeCloseTo(1600, -1);
  });
});

describe("ttsToWebrtc", () => {
  it("upsamples 22050 Hz mono to 48000 Hz", () => {
    const input = makeSine(440, 22050, 100); // ~2205 samples
    const out = ttsToWebrtc(input, 22050);
    const expectedSamples = Math.round(2205 * (48000 / 22050));
    expect(out.length / 2).toBeCloseTo(expectedSamples, -1);
  });

  it("upsamples 16000 Hz mono to 48000 Hz", () => {
    const input = makeSine(440, 16000, 100); // 1600 samples
    const out = ttsToWebrtc(input, 16000);
    expect(out.length / 2).toBeCloseTo(4800, -1);
  });
});
