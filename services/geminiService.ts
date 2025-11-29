// services/geminiService.ts
// FIX: Removed unused 'Chat' import and 'Blob as GenAIBlob' import as it's no longer necessary or used directly here.
import { GoogleGenAI, LiveSession, LiveServerMessage, Modality, FunctionDeclaration, Type, Blob as GeminiApiBlob } from '@google/genai';
import { createPcmBlob, decodeAudioData, decodeBase64 } from '../utils/audioUtils';
import {
  TTS_MODEL,
  LIVE_AUDIO_MODEL,
  OUTPUT_AUDIO_SAMPLE_RATE,
  NUM_AUDIO_CHANNELS,
  INPUT_AUDIO_SAMPLE_RATE,
  AUDIO_CHUNK_SIZE
} from '../constants';
import { ChatMessage } from '../types';

interface LiveSessionCallbacks {
  onAudioChunk: (buffer: AudioBuffer) => void;
  onTranscriptionUpdate: (type: 'user' | 'model', text: string, isFinal: boolean) => void;
  onSessionError: (error: ErrorEvent) => void;
  onSessionClose: (event: CloseEvent) => void;
}

let ai: GoogleGenAI | null = null;
let currentInputTranscription = '';
let currentOutputTranscription = '';

// Initialize Gemini API client
const getGeminiClient = (): GoogleGenAI => {
  if (!ai) {
    // API key is injected via process.env.API_KEY by the environment
    // Do not ask user for API key
    if (!process.env.API_KEY) {
      throw new Error('API_KEY is not set in environment variables.');
    }
    ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  }
  return ai;
};

/**
 * Connects to the Gemini Live API session.
 */
export async function connectLiveSession(
  callbacks: LiveSessionCallbacks,
  enableTranscription: boolean, // New parameter for transcription toggle
  mainAudioContext: AudioContext // Pass the main AudioContext
): Promise<LiveSession> {
  const genAI = getGeminiClient();

  // Reset transcriptions for new session
  currentInputTranscription = '';
  currentOutputTranscription = '';

  const liveConfig: Parameters<typeof genAI.live.connect>[0]['config'] = {
    model: LIVE_AUDIO_MODEL,
    responseModalities: [Modality.AUDIO],
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } }, // Changed default voice
    },
    systemInstruction: 'You are a friendly and helpful assistant. For audiobook creation, you will read the provided text aloud. In conversational mode, you will engage in a natural dialogue.',
  };

  if (enableTranscription) {
    liveConfig.inputAudioTranscription = {}; // Enable transcription for user input
    liveConfig.outputAudioTranscription = {}; // Enable transcription for model output
  }

  const sessionPromise = genAI.live.connect({
    model: LIVE_AUDIO_MODEL, // Model is also part of config (required for connect)
    callbacks: {
      onopen: () => {
        console.debug('Gemini Live session opened.');
      },
      onmessage: async (message: LiveServerMessage) => {
        // Handle audio output from the model
        const base64EncodedAudioString =
          message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
        if (base64EncodedAudioString) {
          const audioBuffer = await decodeAudioData(
            decodeBase64(base64EncodedAudioString),
            mainAudioContext, // Use the main AudioContext passed in
            OUTPUT_AUDIO_SAMPLE_RATE,
            NUM_AUDIO_CHANNELS,
          );
          callbacks.onAudioChunk(audioBuffer);
        }

        // Handle transcription updates ONLY if they are present in the message
        // The API itself will only send them if enabled in config
        if (message.serverContent?.outputTranscription) {
          const text = message.serverContent.outputTranscription.text;
          const isFinal = message.serverContent.outputTranscription.isFinal;
          currentOutputTranscription += text;
          callbacks.onTranscriptionUpdate('model', currentOutputTranscription, isFinal);
          if (isFinal) {
            currentOutputTranscription = ''; // Clear for next model turn
          }
        } else if (message.serverContent?.inputTranscription) {
          const text = message.serverContent.inputTranscription.text;
          const isFinal = message.serverContent.inputTranscription.isFinal;
          currentInputTranscription += text;
          callbacks.onTranscriptionUpdate('user', currentInputTranscription, isFinal);
          if (isFinal) {
            currentInputTranscription = ''; // Clear for next user turn
          }
        }

        if (message.serverContent?.turnComplete) {
          console.debug('Turn complete.');
          // You might want to finalize transcription here if not already done by isFinal
        }

        if (message.serverContent?.interrupted) {
          console.debug('Gemini Live session interrupted.');
          // Signal to stop current playback if any
        }
      },
      onerror: (e: ErrorEvent) => {
        console.error('Gemini Live session error:', e);
        callbacks.onSessionError(e);
      },
      onclose: (e: CloseEvent) => {
        console.debug('Gemini Live session closed:', e);
        callbacks.onSessionClose(e);
      },
    },
    config: liveConfig,
  });
  return sessionPromise;
}

/**
 * Sends a text message to the Live API session for TTS (audiobook mode) or conversation.
 */
export async function sendTextInput(session: LiveSession, text: string): Promise<void> {
  await session.sendRealtimeInput({ message: text });
}

/**
 * Sends text to the Gemini TTS model (not Live API) for single-shot audiobook generation.
 * This is an alternative to Live API for cases where full conversation isn't needed,
 * but the prompt indicates Live API for "conversational voice apps", so this might be redundant
 * if Live API is used for both. Let's keep it in case a simpler TTS is preferred for pure text reading.
 */
export async function generateTextToSpeech(
  text: string,
  voiceName: string = 'Kore',
  mainAudioContext: AudioContext,
  maxRetries: number = 2
): Promise<AudioBuffer[]> {
  const genAI = getGeminiClient();
  const audioBuffers: AudioBuffer[] = [];
  let attempts = 0;

  while (attempts <= maxRetries) {
    try {
      const response = await genAI.models.generateContentStream({
        model: TTS_MODEL,
        contents: [{ parts: [{ text: text }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } },
          },
        },
      });

      for await (const chunk of response) {
        const base64Audio = chunk.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (base64Audio) {
          const audioBuffer = await decodeAudioData(
            decodeBase64(base64Audio),
            mainAudioContext, // Use the main AudioContext here
            OUTPUT_AUDIO_SAMPLE_RATE,
            NUM_AUDIO_CHANNELS,
          );
          audioBuffers.push(audioBuffer);
        }
      }
      return audioBuffers;

    } catch (error: any) {
      console.error(`Error generating text-to-speech (Attempt ${attempts + 1}/${maxRetries + 1}):`, error);

      if (attempts < maxRetries) {
        const delay = globalThis.Math.pow(2, attempts) * 1000; // Exponential backoff: 1s, 2s, 4s
        console.log(`Retrying in ${delay / 1000} seconds...`);
        await new Promise(resolve => globalThis.setTimeout(resolve, delay));
        attempts++;
      } else {
        // Final failure after retries
        throw error;
      }
    }
  }
  // Should not be reached, but as a fallback
  throw new Error('Failed to generate text-to-speech after multiple retries.');
}

/**
 * Checks for API key selection (for models that require explicit key selection).
 * Currently, Gemini 2.5 Native Audio does not require explicit key selection from the dialog.
 * This function is included as a placeholder based on general Gemini API guidance.
 */
export async function checkAndSelectApiKey(): Promise<boolean> {
  if (globalThis.aistudio && typeof globalThis.aistudio.hasSelectedApiKey === 'function') {
    const hasKey = await globalThis.aistudio.hasSelectedApiKey();
    if (!hasKey) {
      console.log('No API key selected. Opening key selection dialog.');
      await globalThis.aistudio.openSelectKey();
      // Assume success after opening dialog for race condition mitigation
      return true;
    }
    return true;
  }
  console.warn('aistudio API not available or hasSelectedApiKey function not found. Proceeding without explicit key selection.');
  return true;
}