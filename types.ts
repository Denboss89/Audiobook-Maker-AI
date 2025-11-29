// types.ts

export interface ChatMessage {
  sender: 'user' | 'model';
  text: string;
  audioUrl?: string; // Base64 encoded audio URL for playback
}

export interface DecodedAudioData {
  buffer: AudioBuffer;
  duration: number;
}