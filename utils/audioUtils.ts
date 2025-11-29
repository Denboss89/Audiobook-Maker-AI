// utils/audioUtils.ts
import { INPUT_AUDIO_SAMPLE_RATE, NUM_AUDIO_CHANNELS, OUTPUT_AUDIO_SAMPLE_RATE } from '../constants';
// FIX: Import the Blob type from @google/genai and alias it to avoid conflict with native DOM Blob
import { Blob as GeminiApiBlob } from '@google/genai';

// Define a basic interface for the lamejs Encoder instance
// Fix: Added specific type definitions for Lame and LameEncoder
interface LameEncoder {
  encodeBuffer(pcm: Int16Array): Uint8Array;
  flush(): Uint8Array;
}

// FIX: Export LameConstructor interface to allow it to be imported by App.tsx
export interface LameConstructor {
  new(config: { output: string; bitrate?: number; samplerate: number; channels: number; }): LameEncoder;
}

// Declare Lame on the global object with the specific constructor type
// This clarifies to TypeScript the structure of the Lame object from the CDN script.
declare global {
  interface Window {
    Lame: LameConstructor;
  }
}

export function decodeBase64(base64: string): Uint8Array {
  const binaryString = globalThis.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

/**
 * Creates a PCM Blob suitable for @google/genai's Live API.
 * The Blob type here refers to the interface from @google/genai, not the native DOM Blob.
 */
// FIX: Changed return type to GeminiApiBlob to clarify it's the @google/genai Blob type
export function createPcmBlob(data: Float32Array): GeminiApiBlob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = Math.max(-1, Math.min(1, data[i])) * 0x7FFF; // Convert to 16-bit PCM
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return {
    data: globalThis.btoa(binary),
    mimeType: `audio/pcm;rate=${INPUT_AUDIO_SAMPLE_RATE}`,
  };
}

/**
 * Encodes an array of raw Float32Array PCM audio buffers into an MP3 Blob.
 * Assumes the global `Lame` object is available from the lamejs CDN.
 * @param audioBuffers An array of AudioBuffer objects from the same stream.
 * @param sampleRate The sample rate of the audio data.
 * @param numChannels The number of audio channels.
 * @returns A Promise that resolves with an MP3 Blob (native DOM Blob type).
 */
// FIX: Changed return type to native DOM Blob, which is simpler and clearer.
export function encodePCMToMP3(
  audioBuffers: Array<AudioBuffer>,
  sampleRate: number = OUTPUT_AUDIO_SAMPLE_RATE,
  numChannels: number = NUM_AUDIO_CHANNELS
): Promise<Blob> { // Use native DOM Blob type
  return new Promise((resolve, reject) => {
    console.log("encodePCMToMP3: Checking for globalThis.Lame. Typeof:", typeof globalThis.Lame); // DIAGNOSTIC LOG
    // Check for window.Lame explicitly
    if (typeof globalThis.Lame === 'undefined') {
      const errorMessage = 'lamejs library not loaded. MP3 export unavailable.';
      console.error(errorMessage);
      reject(new Error(errorMessage)); // Reject the promise
      return;
    }

    // Fix: Explicitly type the 'lame' instance to LameEncoder after construction.
    // This helps TypeScript recognize the callable methods 'encodeBuffer' and 'flush'.
    const lame: LameEncoder = new globalThis.Lame({
      output: 'blob',
      // The default bitrate will be chosen automatically if not specified.
      // For speech, 128kbps is usually good.
      bitrate: 128,
      samplerate: sampleRate,
      channels: numChannels,
    });

    // Explicitly type mp3data as Uint8Array[] to ensure correct type flow
    const mp3data: Uint8Array[] = [];

    // Combine all audio buffers into a single Float32Array
    let totalLength = 0;
    for (const buffer of audioBuffers) {
      totalLength += buffer.length;
    }

    const combinedBuffer = new Float32Array(totalLength);
    let offset = 0;
    for (const buffer of audioBuffers) {
      combinedBuffer.set(buffer.getChannelData(0), offset); // Assuming mono for simplicity
      offset += buffer.length;
    }

    // Convert Float32Array to Int16Array, which lamejs expects
    const pcm16 = new Int16Array(combinedBuffer.length);
    for (let i = 0; i < combinedBuffer.length; i++) {
      pcm16[i] = Math.max(-1, Math.min(1, combinedBuffer[i])) * 0x7FFF;
    }

    const MAX_CHUNK_SIZE = 1152; // Lame.js typical frame size for 44.1kHz, adjust for other rates if needed.
    let encodedByteCount = 0;

    for (let i = 0; i < pcm16.length; i += MAX_CHUNK_SIZE) {
      // Explicitly type mp3buf as Uint8Array to prevent 'any' from lame.encodeBuffer
      const mp3buf: Uint8Array = lame.encodeBuffer(pcm16.subarray(i, i + MAX_CHUNK_SIZE));
      if (mp3buf.length > 0) {
        mp3data.push(mp3buf);
        encodedByteCount += mp3buf.length;
      }
    }

    // Explicitly type mp3buf as Uint8Array to prevent 'any' from lame.flush
    const mp3buf: Uint8Array = lame.flush();
    if (mp3buf.length > 0) {
      mp3data.push(mp3buf);
      encodedByteCount += mp3buf.length;
    }

    if (encodedByteCount === 0) {
      const errorMessage = 'MP3 encoding resulted in an empty file. Input audio might be too short or invalid.';
      console.error(errorMessage);
      reject(new Error(errorMessage));
      return;
    }

    // FIX 1: Explicitly use native DOM Blob constructor
    const blob = new Blob(mp3data, { type: 'audio/mpeg' });
    resolve(blob);
  });
}