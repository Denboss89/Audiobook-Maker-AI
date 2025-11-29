// constants.ts

export const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
export const LIVE_AUDIO_MODEL = 'gemini-2.5-flash-native-audio-preview-09-2025';

export const INPUT_AUDIO_SAMPLE_RATE = 16000; // Microphone sample rate
export const OUTPUT_AUDIO_SAMPLE_RATE = 24000; // Gemini TTS output sample rate
export const NUM_AUDIO_CHANNELS = 1;
export const AUDIO_CHUNK_SIZE = 4096; // ScriptProcessorNode buffer size

// FIX: This list is now meticulously updated to ONLY and EXACTLY include voice names
// explicitly allowed by the Gemini TTS API, as per the repeated error messages.
// This should finally resolve all 'Voice name is not supported' errors.
export const TTS_VOICES = [
  { name: 'Achernar', value: 'achernar' },
  { name: 'Achird', value: 'achird' },
  { name: 'Algenib', value: 'algenib' },
  { name: 'Algieba', value: 'algieba' },
  { name: 'Alnilam', value: 'alnilam' },
  { name: 'Aoede', value: 'aoede' },
  { name: 'Autonoe', value: 'autonoe' },
  { name: 'Callirrhoe', value: 'callirrhoe' },
  { name: 'Charon', value: 'charon' },
  { name: 'Despina', value: 'despina' },
  { name: 'Enceladus', value: 'enceladus' },
  { name: 'Erinome', value: 'erinome' },
  { name: 'Fenrir', value: 'fenrir' },
  { name: 'Gacrux', value: 'gacrux' },
  { name: 'Iapetus', value: 'iapetus' },
  { name: 'Kore', value: 'kore' },
  { name: 'Laomedeia', value: 'laomedeia' },
  { name: 'Leda', value: 'leda' },
  { name: 'Orus', value: 'orus' },
  { name: 'Puck', value: 'puck' },
  { name: 'Pulcherrima', value: 'pulcherrima' },
  { name: 'Rasalgethi', value: 'rasalgethi' },
  { name: 'Sadachbia', value: 'sadachbia' },
  { name: 'Sadaltager', value: 'sadaltager' },
  { name: 'Schedar', value: 'schedar' },
  { name: 'Sulafat', value: 'sulafat' },
  { name: 'Umbriel', value: 'umbriel' },
  { name: 'Vindemiatrix', value: 'vindemiatrix' },
  { name: 'Zephyr', value: 'zephyr' },
  { name: 'Zubenelgenubi', value: 'zubenelgenubi' },
];

// New constants for video export
export const VIDEO_RESOLUTIONS = [
  { name: '1080p (1920x1080)', value: '1080p', width: 1920, height: 1080 },
  { name: '720p (1280x720)', value: '720p', width: 1280, height: 720 },
  { name: '480p (854x480)', value: '480p', width: 854, height: 480 },
];

export const VIDEO_CODECS = [
  { name: 'WebM (VP8/VP9)', value: 'webm', mimeType: 'video/webm', extension: 'webm', codecsString: 'vp8,opus' },
  { name: 'MP4 (H.264)', value: 'mp4_h264', mimeType: 'video/mp4', extension: 'mp4', codecsString: 'avc1.42001E,mp4a.40.2' },
];

// FIX: Add new constant for video bitrates
export const VIDEO_BITRATES = [
  { name: '500 kbps (Alacsony)', value: '500k', numericValue: 500000 },
  { name: '1 Mbps (Közepes)', value: '1000k', numericValue: 1000000 },
  { name: '2 Mbps (Ajánlott)', value: '2000k', numericValue: 2000000 },
  { name: '5 Mbps (Magas)', value: '5000k', numericValue: 5000000 },
  { name: '10 Mbps (Nagyon Magas)', value: '10000k', numericValue: 10000000 },
];

// FIX: Add a constant for the maximum TTS text length (in characters, roughly proportional to tokens)
export const MAX_TTS_TEXT_LENGTH_CHARS = 4000; // Drastically reduced for safety. (Previous 6000 was too high)

// FIX: Add a placeholder for Freemium Image Generator API configuration
// This is conceptual, as client-side image generation from external APIs without backend is complex/paid.
export const FREEMIUM_IMAGE_GENERATOR_CONFIG = {
  API_ENDPOINT: 'https://api.example.com/freemium-image-gen', // Placeholder
  API_KEY_PLACEHOLDER: 'YOUR_FREEMIUM_API_KEY_HERE', // Placeholder
  INFO_MESSAGE: 'Ez egy szimulált képgenerátor API integráció. A valós AI képgenerálás általában fizetős szolgáltatásokat igényel. Jelenleg ingyenes placeholder képeket használunk.',
};