// App.tsx
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { LiveSession } from '@google/genai';
import {
  connectLiveSession,
  generateTextToSpeech,
  checkAndSelectApiKey,
  sendTextInput
} from './services/geminiService';
import { createPcmBlob } from './utils/audioUtils';
import {
  INPUT_AUDIO_SAMPLE_RATE,
  OUTPUT_AUDIO_SAMPLE_RATE,
  NUM_AUDIO_CHANNELS,
  AUDIO_CHUNK_SIZE,
  TTS_VOICES,
  VIDEO_RESOLUTIONS,
  VIDEO_CODECS,
  VIDEO_BITRATES,
  MAX_TTS_TEXT_LENGTH_CHARS,
  FREEMIUM_IMAGE_GENERATOR_CONFIG,
} from './constants';
import { encodePCMToMP3 } from './utils/audioUtils';
import Button from './components/Button';
import { ChatMessage } from './types';
import type { LameConstructor } from './utils/audioUtils';

// Declare YT namespace for YouTube Iframe API
declare global {
  interface Window {
    onYouTubeIframeAPIReady: (() => void) | undefined;
    YT: {
      Player: {
        new(elementId: string | HTMLElement, options: any): any;
      };
      PlayerState: {
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
        BUFFERING: number;
        CUED: number;
        UNSTARTED: number;
      };
    };
  }
}

// Avatar Components
const UserAvatar: React.FC = () => (
  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-blue-100 font-bold text-sm shadow-md">
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
      <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd"></path>
    </svg>
  </div>
);

const AIAvatar: React.FC = () => (
  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center text-gray-100 font-bold text-sm shadow-md">
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
      <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 110-6 3 3 0 010 6z"></path>
    </svg>
  </div>
);

// Helper to segment text into words with rough timing for karaoke
// This is a very simplified client-side approximation without actual word timing from TTS API
interface WordSegment {
  word: string;
  startTime: number; // relative to the current line's start
  endTime: number;   // relative to the current line's start
}

interface LineSegment {
  text: string;
  words: WordSegment[];
  duration: number; // estimated duration of this line
  relativeStartTime: number; // start time relative to audiobook beginning
  relativeEndTime: number; // end time relative to audiobook beginning
}

const segmentTextForKaraoke = (text: string, totalAudiobookDuration: number): LineSegment[] => {
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  if (lines.length === 0) return [];

  const allWords = text.split(/\s+/).filter(w => w.length > 0);
  const totalWords = allWords.length;
  
  const effectiveTotalWords = globalThis.Math.max(totalWords, 1); 
  // Base average duration, adjusted to prevent too fast or too slow estimation
  const baseAverageWordDuration = globalThis.Math.max(0.1, totalAudiobookDuration / effectiveTotalWords); 

  let overallTimeOffset = 0;
  return lines.map(line => {
    // FIX: Split by words and also capture punctuation as separate "words" for better timing
    const wordsInLine = line.split(/(\s+|\b[.,!?;:]+\b)/g).filter(w => w.length > 0); 
    let lineDuration = 0;
    let wordTimeOffset = 0;

    const wordSegments: WordSegment[] = wordsInLine.map(word => {
      const isPunctuation = /^[.,!?;:]+$/.test(word.trim());
      let estimatedWordDuration;

      if (isPunctuation) {
          estimatedWordDuration = 0.25; // Slightly longer pause for punctuation
      } else if (/\s+/.test(word)) {
          estimatedWordDuration = 0.08; // Very short for spaces
      } else {
          // FIX: Improved word duration estimation for better sync, completing the truncated line
          // More weight on word length, but still anchored by averageWordDuration
          // Add a small constant to ensure minimal duration for very short words
          estimatedWordDuration = globalThis.Math.max(0.08, word.length * 0.09 + baseAverageWordDuration / 2);
      }
      const segment: WordSegment = { word: word.trim(), startTime: wordTimeOffset, endTime: wordTimeOffset + estimatedWordDuration };
      wordTimeOffset += estimatedWordDuration;
      lineDuration += estimatedWordDuration; // Accumulate line duration
      return segment;
    });

    const lineSegment: LineSegment = {
      text: line.trim(),
      words: wordSegments,
      duration: lineDuration,
      relativeStartTime: overallTimeOffset,
      relativeEndTime: overallTimeOffset + lineDuration,
    };
    overallTimeOffset += lineDuration;
    return lineSegment; // FIX: Explicitly return the LineSegment
  });
};


const App: React.FC = () => {
  const [textInput, setTextInput] = useState<string>('');
  const [liveTextInput, setLiveTextInput] = useState<string>('');
  const [isAudiobookGenerating, setIsAudiobookGenerating] = useState<boolean>(false);
  const [isAudiobookPlaying, setIsAudiobookPlaying] = useState<boolean>(false);
  const [isAudiobookPlaybackPaused, setIsAudiobookPlaybackPaused] = useState<boolean>(false);
  const [isRecordingMicrophone, setIsRecordingMicrophone] = useState<boolean>(false);
  const [isLiveSessionActive, setIsLiveSessionActive] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const conversationHistoryRef = useRef<ChatMessage[]>([]); // Ref for periodic saving
  const [conversationHistory, setConversationHistory] = useState<ChatMessage[]>(() => {
    try {
      const savedHistory = globalThis.localStorage.getItem('liveConversationHistory');
      const initialHistory = savedHistory ? JSON.parse(savedHistory) : [];
      conversationHistoryRef.current = initialHistory; // Initialize ref
      return initialHistory;
    } catch (e) {
      console.error("Nem sikerült betölteni a beszélgetési előzményeket a localStorage-ból", e);
      return [];
    }
  });
  const [currentTranscription, setCurrentTranscription] = useState<{ user: string; model: string }>({ user: '', model: '' });
  const [selectedVoice, setSelectedVoice] = useState<string>('Kore');
  const [isTranscriptionEnabled, setIsTranscriptionEnabled] = useState<boolean>(true);
  const [isLamejsLoaded, setIsLamejsLoaded] = useState<boolean>(false); // State to track lamejs loading

  // Video Visualizer States
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isPlayingVideo, setIsPlayingVideo] = useState<boolean>(false);
  const [isRecordingVideo, setIsRecordingVideo] = useState<boolean>(false);
  const [selectedVideoCodec, setSelectedVideoCodec] = useState<string>(VIDEO_CODECS[0].value);
  const [selectedVideoResolution, setSelectedVideoResolution] = useState<string>(VIDEO_RESOLUTIONS[0].value);
  // FIX: New state for video bitrate
  const [selectedVideoBitrate, setSelectedVideoBitrate] = useState<string>(VIDEO_BITRATES[2].value); // Default to 2Mbps

  // Background Music States
  const [backgroundMusicFile, setBackgroundMusicFile] = useState<File | null>(null);
  const [backgroundMusicUrl, setBackgroundMusicUrl] = useState<string | null>(null);
  const [isPlayingBackgroundMusic, setIsPlayingBackgroundMusic] = useState<boolean>(false);
  const [backgroundMusicVolume, setBackgroundMusicVolume] = useState<number>(0.1);
  const [youTubeUrlInput, setYouTubeUrlInput] = useState<string>('');
  const youTubePlayerRef = useRef<any>(null); // Ref for YouTube Player instance
  const [youTubePlayerReady, setYouTubePlayerReady] = useState<boolean>(false);
  const [youTubeVideoId, setYouTubeVideoId] = useState<string | null>(null);
  const [youTubeCurrentTime, setYouTubeCurrentTime] = useState<number>(0);
  const [youTubeDuration, setYouTubeDuration] = useState<number>(0);
  const youTubeProgressIntervalRef = useRef<number | null>(null);

  // Audiobook Scene Visualizer States
  const [audiobookSceneImages, setAudiobookSceneImages] = useState<File[] | null>(null);
  const [audiobookSceneImageUrls, setAudiobookSceneImageUrls] = useState<string[]>([]);
  const [currentAudiobookSceneIndex, setCurrentAudiobookSceneIndex] = useState<number>(0);
  const lastSceneChangeTimestampRef = useRef<number>(0);
  const [isGeneratingImages, setIsGeneratingImages] = useState<boolean>(false);

  // Scrolling Text Refs for Audiobook Visualizer
  const audiobookScrollStartTimeRef = useRef<number>(0);
  const [audiobookLinesWithTiming, setAudiobookLinesWithTiming] = useState<LineSegment[]>([]);
  const [currentHighlightedWordIndex, setCurrentHighlightedWordIndex] = useState<number>(-1);
  const [currentHighlightedLineIndex, setCurrentHighlightedLineIndex] = useState<number>(-1);

  // Refs for audio playback
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputNodeRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourceNodesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // Refs for microphone input
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const liveSessionRef = useRef<LiveSession | null>(null);
  const liveSessionPromiseRef = useRef<Promise<LiveSession> | null>(null);

  // Ref for main audio visualizer canvas (ALL VISUALIZATION: Live, Video, Audiobook)
  const mainVisualizerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);
  const mainCanvasContainerRef = useRef<HTMLDivElement | null>(null);

  // Buffer for accumulating audio for MP3 download
  const audiobookPcmBuffersRef = useRef<AudioBuffer[]>([]);

  // Refs for Video Visualizer and Export
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const videoSourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const mediaStreamDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);

  // Refs for Background Music
  const backgroundAudioElementRef = useRef<HTMLAudioElement | null>(null);
  const backgroundMusicSourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const backgroundMusicGainNodeRef = useRef<GainNode | null>(null);

  // Audiobook Scene Image Refs for Fade Animation
  const currentLoadedAudiobookImageRef = useRef<HTMLImageElement | null>(null);
  const previousLoadedAudiobookImageRef = useRef<HTMLImageElement | null>(null);
  const audiobookFadeStateRef = useRef<{
    active: boolean;
    startTime: number;
    duration: number;
    oldImageUrl: string | null;
    newImageUrl: string | null;
  } | null>(null);

  const FADE_DURATION_SECONDS = 1.0;

  // Visualizer Effects Control States
  const [isDynamicBackgroundEnabled, setIsDynamicBackgroundEnabled] = useState<boolean>(true);
  const [isParticleEffectEnabled, setIsParticleEffectEnabled] = useState<boolean>(false);
  const [isSineWaveEffectEnabled, setIsSineWaveEffectEnabled] = useState<boolean>(true); // New for sine wave
  const [isKaraokeEffectEnabled, setIsKaraokeEffectEnabled] = useState<boolean>(true); // Toggle for karaoke
  const [isTintEffectEnabled, setIsTintEffectEnabled] = useState<boolean>(true); // FIX: Add state for tint effect

  // Particle System State
  interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    color: string;
    alpha: number;
    life: number;
    maxLife: number;
  }
  const particlesRef = useRef<Particle[]>([]);
  const particleHueRef = useRef<number>(0);


  // FIX: Centralized AudioContext initialization and graph setup
  const initializeAudioContext = useCallback(() => {
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      console.log("Initializing/Re-initializing AudioContext...");
      audioContextRef.current = new AudioContext({ sampleRate: OUTPUT_AUDIO_SAMPLE_RATE });
      audioContextRef.current.resume().then(() => console.log("AudioContext resumed on init. State:", audioContextRef.current?.state));

      outputNodeRef.current = audioContextRef.current.createGain();
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 2048; // A higher FFT size for more frequency detail

      mediaStreamDestinationRef.current = audioContextRef.current.createMediaStreamDestination();

      backgroundMusicGainNodeRef.current = audioContextRef.current.createGain();
      backgroundMusicGainNodeRef.current.gain.value = backgroundMusicVolume;

      // Corrected audio graph:
      // All sources connect to outputNode.
      // outputNode connects to:
      // 1. audioContext.destination (speakers)
      // 2. mediaStreamDestination (recorder)
      // 3. analyser (for visualization)
      outputNodeRef.current.connect(audioContextRef.current.destination);
      outputNodeRef.current.connect(mediaStreamDestinationRef.current);
      outputNodeRef.current.connect(analyserRef.current); // Analyser listens to the main output
    }
    return {
      audioContext: audioContextRef.current,
      outputNode: outputNodeRef.current!,
      mainAnalyser: analyserRef.current!,
      mediaStreamDestination: mediaStreamDestinationRef.current!,
    };
  }, [backgroundMusicVolume]);

  const disconnectAnalyserSource = useCallback((sourceNode: AudioNode | null, analyser: AnalyserNode | null) => {
    if (sourceNode && analyser) {
      try {
        // Disconnecting from analyser is no longer strictly needed if analyser is an output of outputNode.
        // But keeping it for completeness if direct source-to-analyser connections were made elsewhere.
        sourceNode.disconnect(analyser); 
      } catch (e) {
        console.warn("Nem sikerült leválasztani a forrást az analizátorról (valószínűleg már le van választva):", e);
      }
    }
  }, []);

  const stopAllAudio = useCallback(() => {
    for (const source of sourceNodesRef.current.values()) {
      source.stop();
      source.disconnect();
    }
    sourceNodesRef.current.clear();
    nextStartTimeRef.current = 0;
  }, []);

  const stopMicrophoneStream = useCallback(() => {
    if (microphoneStreamRef.current) {
      microphoneStreamRef.current.getTracks().forEach(track => track.stop());
      microphoneStreamRef.current = null;
    }
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    setIsRecordingMicrophone(false);
    setStatusMessage('Mikrofon leállítva.');
  }, []);

  const stopRecordingVideo = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecordingVideo(false);
      setStatusMessage("Videófelvétel leállítása...");
    } else if (isRecordingVideo) {
      setIsRecordingVideo(false);
      setStatusMessage("A felvétel leállt (nincs aktív rögzítő).");
    }
  }, [isRecordingVideo]);

  const stopAllAudioSources = useCallback(() => {
    stopAllAudio();
    stopMicrophoneStream();
    if (videoElementRef.current) {
      videoElementRef.current.pause();
      setIsPlayingVideo(false);
      if (videoSourceNodeRef.current) {
        videoSourceNodeRef.current.disconnect(outputNodeRef.current!);
        videoSourceNodeRef.current.disconnect(audioContextRef.current!.destination); // Also from direct destination
        videoSourceNodeRef.current = null;
      }
    }
    if (backgroundAudioElementRef.current) {
      backgroundAudioElementRef.current.pause();
      setIsPlayingBackgroundMusic(false);
      if (backgroundMusicSourceNodeRef.current) {
        backgroundMusicSourceNodeRef.current.disconnect(outputNodeRef.current!);
        backgroundMusicSourceNodeRef.current.disconnect(audioContextRef.current!.destination); // Also from direct destination
      }
    }
    // Stop YouTube Player if active
    if (youTubePlayerRef.current) {
      youTubePlayerRef.current.pauseVideo();
    }
  }, [stopAllAudio, stopMicrophoneStream]);


  const handleApiError = useCallback((message: string, err: unknown) => {
    console.error(message, err);
    const errorObject = err instanceof Error ? err : new Error(String(err));
    let errorMessage = `${message}: ${errorObject.message || 'Ismeretlen hiba'}`;

    if (errorObject instanceof DOMException) {
      if (errorObject.name === 'NotAllowedError') {
        errorMessage = `${message}: Mikrofon hozzáférés megtagadva. Kérjük, engedélyezze a böngésző beállításaiban.`;
      } else if (errorObject.name === 'NotFoundError' || errorObject.name === 'NotReadableError') {
        errorMessage = `${message}: Nincs mikrofon található, vagy egy másik alkalmazás használja. Kérjük, ellenőrizze a mikrofon csatlakozását, a böngésző és az operációs rendszer engedélyeit.`;
      } else if (errorObject.name === 'AbortError') {
        errorMessage = 'Műveletet a felhasználó megszakította.';
      } else if (errorObject.name === 'QuotaExceededError' || (errorObject.message && errorObject.message.includes('too many tokens'))) {
        errorMessage = `${message}: A szöveg túl hosszú. Kérjük, rövidebb szöveget használjon.`;
      }
    } else if (errorObject instanceof TypeError && (errorObject.message.includes('Failed to fetch') || errorObject.message.includes('NetworkError'))) {
      errorMessage = `${message}: Hálózati kapcsolat megszakadt, vagy a szerver nem elérhető. Kérjük, ellenőrizze az internetkapcsolatot.`;
    } else if ((errorObject as any).status === 403 || (errorObject.message && (errorObject.message.includes('Billing account not enabled') || errorObject.message.includes('Quota exceeded')))) {
      errorMessage = `${message}: API kulcs vagy számlázási probléma. Kérjük, ellenőrizze Gemini API kulcsát és számlázási beállításait, vagy frissítsen Pro verzióra.`;
    } else if (errorObject.message && (errorObject.message.includes('safety') || errorObject.message.includes('unsupported content') || errorObject.message.includes('invalid input'))) {
      errorMessage = `${message}: Nem értelmezhető vagy nem engedélyezett szöveg. Kérjük, próbálja meg átfogalmazni.`;
    } else if (errorObject.message && errorObject.message.includes('CORS')) {
      errorMessage = `${message}: Nem sikerült betölteni a médiafájlt a megadott URL-ről a böngésző biztonsági korlátozásai miatt (CORS).`;
    }
    
    setError(errorMessage);
    setStatusMessage('');
    setIsLoading(false);
    setIsAudiobookGenerating(false);
    setIsAudiobookPlaying(false);
    setIsAudiobookPlaybackPaused(false);
    setIsRecordingVideo(false);
    if (errorObject.message && errorObject.message.includes('Requested entity was not found.')) {
      checkAndSelectApiKey();
    }
  }, []);

  const playAudioBuffer = useCallback(async (buffer: AudioBuffer, isAudiobook: boolean = false) => {
    const { audioContext, outputNode } = initializeAudioContext();
    
    console.log(`playAudioBuffer: AudioContext state: ${audioContext.state}`); // DIAGNOSTIC
    console.log(`playAudioBuffer: Buffer details - duration: ${buffer.duration}, sampleRate: ${buffer.sampleRate}, channels: ${buffer.numberOfChannels}`); // DIAGNOSTIC

    if (audioContext.state !== 'running') {
      await audioContext.resume();
      console.log(`playAudioBuffer: AudioContext resumed. New state: ${audioContext.state}`); // DIAGNOSTIC
    }
    
    // Ensure nextStartTimeRef is only advanced by actual audio playback duration
    nextStartTimeRef.current = globalThis.Math.max(nextStartTimeRef.current, audioContext.currentTime);

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    
    source.connect(outputNode); // FIX: All playback goes through outputNode

    source.addEventListener('ended', () => {
      sourceNodesRef.current.delete(source);
      if (sourceNodesRef.current.size === 0) {
        if (isAudiobook) {
          setIsAudiobookPlaying(false);
          setCurrentHighlightedLineIndex(-1); // Reset karaoke
          setCurrentHighlightedWordIndex(-1); // Reset karaoke
          audiobookScrollStartTimeRef.current = 0;
          lastSceneChangeTimestampRef.current = 0;
        }
        // No explicit disconnect from analyser/destination needed here, as outputNode handles it.
      }
    });

    source.start(nextStartTimeRef.current);
    console.log(`playAudioBuffer: Started audio at ${nextStartTimeRef.current}. Current AudioContext time: ${audioContext.currentTime}`); // DIAGNOSTIC
    nextStartTimeRef.current = nextStartTimeRef.current + buffer.duration;
    sourceNodesRef.current.add(source);

    if (isAudiobook) {
      setIsAudiobookPlaying(true);
      // Reset karaoke and scene state on new playback
      audiobookScrollStartTimeRef.current = audioContext.currentTime;
      lastSceneChangeTimestampRef.current = audioContext.currentTime;
      setCurrentAudiobookSceneIndex(0);
      setCurrentHighlightedLineIndex(0);
      setCurrentHighlightedWordIndex(0);
      audiobookFadeStateRef.current = null;
      previousLoadedAudiobookImageRef.current = null;
      if (audiobookSceneImageUrls[currentAudiobookSceneIndex]) {
        const img = new Image();
        img.src = audiobookSceneImageUrls[currentAudiobookSceneIndex];
        currentLoadedAudiobookImageRef.current = img;
      }
    }
  }, [initializeAudioContext, currentAudiobookSceneIndex, audiobookSceneImageUrls]);

  // Handle voice preview
  const handlePreviewVoice = useCallback(async (voiceName: string) => {
    setSelectedVoice(voiceName); // Select the voice
    setError(null);
    setStatusMessage(`Hangminta generálása a(z) '${voiceName}' hanggal...`);
    setIsLoading(true);
    stopAllAudio(); // Stop any other playing audio

    try {
      const { audioContext, outputNode } = initializeAudioContext();
      
      console.log(`handlePreviewVoice: AudioContext state: ${audioContext.state}`); // DIAGNOSTIC
      if (audioContext.state !== 'running') {
        await audioContext.resume();
        console.log(`handlePreviewVoice: AudioContext resumed. New state: ${audioContext.state}`); // DIAGNOSTIC
      }

      const sampleText = "Ez egy hangminta a kiválasztott hangon.";
      const audioBuffers = await generateTextToSpeech(sampleText, voiceName, audioContext);

      if (audioBuffers.length > 0) {
        console.log(`handlePreviewVoice: Generated sample buffer details - duration: ${audioBuffers[0].duration}, sampleRate: ${audioBuffers[0].sampleRate}, channels: ${audioBuffers[0].numberOfChannels}`); // DIAGNOSTIC
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffers[0];
        source.connect(outputNode); // FIX: Connect to outputNode
        source.start(0);
        setStatusMessage(`Hangminta lejátszása a(z) '${voiceName}' hanggal.`);
      } else {
        setStatusMessage('Nem sikerült hangmintát generálni.');
      }
    } catch (err) {
      handleApiError('Nem sikerült hangmintát generálni', err);
    } finally {
      setIsLoading(false);
    }
  }, [initializeAudioContext, handleApiError, stopAllAudio, setSelectedVoice]);


  const handleReadAloud = async () => {
    if (!textInput.trim()) {
      setError('Kérjük, adjon meg szöveget a felolvasáshoz.');
      return;
    }

    // FIX: Client-side check for max text length
    if (textInput.length > MAX_TTS_TEXT_LENGTH_CHARS) {
        setError(`A szöveg túl hosszú (${textInput.length} karakter). A maximális engedélyezett hossz ${MAX_TTS_TEXT_LENGTH_CHARS} karakter. Kérjük, rövidítse a szöveget.`);
        setIsLoading(false); // Ensure loading is off
        setIsAudiobookGenerating(false);
        return;
    }


    stopAllAudioSources();

    if (isAudiobookPlaying) {
      stopAllAudio();
      setIsAudiobookPlaying(false);
      setIsAudiobookPlaybackPaused(true);
      setStatusMessage('Hangoskönyv szüneteltetve.');
      return;
    }

    if (isAudiobookPlaybackPaused && audiobookPcmBuffersRef.current.length > 0) {
      setError(null);
      setStatusMessage('Hangoskönyv lejátszás folytatása...');
      stopAllAudio();
      audiobookPcmBuffersRef.current.forEach(buffer => playAudioBuffer(buffer, true));
      setIsAudiobookPlaying(true);
      setIsAudiobookPlaybackPaused(false);
      audiobookScrollStartTimeRef.current = audioContextRef.current!.currentTime;
      lastSceneChangeTimestampRef.current = audioContextRef.current!.currentTime;
      setCurrentAudiobookSceneIndex(0);
      setCurrentHighlightedLineIndex(0);
      setCurrentHighlightedWordIndex(0);
      audiobookFadeStateRef.current = null;
      previousLoadedAudiobookImageRef.current = null;
      if (audiobookSceneImageUrls[currentAudiobookSceneIndex]) {
        const img = new Image();
        img.src = audiobookSceneImageUrls[currentAudiobookSceneIndex];
        currentLoadedAudiobookImageRef.current = img;
      }
      return;
    }

    setError(null);
    setIsLoading(true);
    setIsAudiobookGenerating(true);
    setStatusMessage('Szöveg feldolgozása...'); // FIX: Detailed status messages
    stopAllAudio();
    audiobookPcmBuffersRef.current = [];
    setCurrentAudiobookSceneIndex(0);
    setCurrentHighlightedLineIndex(0);
    setCurrentHighlightedWordIndex(0);
    audiobookFadeStateRef.current = null;
    previousLoadedAudiobookImageRef.current = null;

    try {
      const { audioContext } = initializeAudioContext();
      setStatusMessage('Hanggenerálás API hívása...'); // FIX: Detailed status messages
      const audioBuffers = await generateTextToSpeech(textInput, selectedVoice, audioContext);
      
      setStatusMessage('Audió adatok fogadása...'); // FIX: Detailed status messages
      if (audioBuffers.length > 0) {
        audiobookPcmBuffersRef.current = audioBuffers;
        
        // Calculate total duration for karaoke segmentation
        const totalAudiobookDuration = audioBuffers.reduce((acc, buffer) => acc + buffer.duration, 0);
        const segmentedLines = segmentTextForKaraoke(textInput, totalAudiobookDuration);
        setAudiobookLinesWithTiming(segmentedLines);

        setStatusMessage('Lejátszáshoz való előkészítés...'); // FIX: Detailed status messages
        audioBuffers.forEach(buffer => playAudioBuffer(buffer, true));
        setStatusMessage('Hangoskönyv lejátszása...');
        setIsAudiobookPlaying(true);
        setIsAudiobookPlaybackPaused(false);
        audiobookScrollStartTimeRef.current = audioContextRef.current!.currentTime;
        lastSceneChangeTimestampRef.current = audioContextRef.current!.currentTime;
        setCurrentAudiobookSceneIndex(0);
        setCurrentHighlightedLineIndex(0);
        setCurrentHighlightedWordIndex(0);
        if (audiobookSceneImageUrls[0]) {
          const img = new Image();
          img.src = audiobookSceneImageUrls[0];
          currentLoadedAudiobookImageRef.current = img;
        }
      } else {
        setStatusMessage('Nem sikerült hangot generálni. Kérjük, próbálja újra.');
        setIsAudiobookPlaying(false);
      }
    } catch (err) {
      handleApiError('Nem sikerült hangoskönyvet generálni', err);
    } finally {
      setIsLoading(false);
      setIsAudiobookGenerating(false);
    }
  };

  const handleDownloadMp3 = async () => {
    if (audiobookPcmBuffersRef.current.length === 0) {
      setError('Nincs még generált hang letöltésre.');
      return;
    }
    if (!isLamejsLoaded) {
      setError('A lamejs könyvtár még nem töltődött be. Az MP3 exportálás nem elérhető.');
      return;
    }

    setIsLoading(true);
    setStatusMessage('MP3 kódolása...');
    try {
      stopAllAudio();
      setIsAudiobookPlaying(false);
      setIsAudiobookPlaybackPaused(false);

      const mp3Blob = await encodePCMToMP3(audiobookPcmBuffersRef.current);
      
      if (mp3Blob.size === 0) {
        throw new Error('A generált MP3 fájl üres. A kódolás sikertelen lehet.');
      }

      if ('showSaveFilePicker' in globalThis) {
        try {
          const fileHandle = await globalThis.showSaveFilePicker({
            suggestedName: 'audiobook.mp3',
            types: [{
              description: 'MP3 Audio',
              accept: { 'audio/mpeg': ['.mp3'] },
            }],
          });

          const writableStream = await fileHandle.createWritable();
          // FIX: mp3Blob is already typed as Blob, no need for redundant cast.
          await writableStream.write(mp3Blob); 
          await writableStream.close();
          setStatusMessage('MP3 sikeresen mentve!');
        } catch (err) {
          handleApiError('Nem sikerült menteni az MP3-at', err);
        }
      } else {
        const url: string = globalThis.URL.createObjectURL(mp3Blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'audiobook.mp3';
        globalThis.document.body.appendChild(a);
        a.click();
        globalThis.document.body.removeChild(a);
        globalThis.URL.revokeObjectURL(url);
        setStatusMessage('MP3 sikeresen letöltve az alapértelmezett letöltési mappába!');
      }

    } catch (err) {
      handleApiError('Nem sikerült kódolni vagy letölteni az MP3-at', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearText = useCallback(() => {
    setTextInput('');
    stopAllAudio();
    audiobookPcmBuffersRef.current = [];
    setError(null);
    setStatusMessage('Szöveg és hang törölve.');
    setIsAudiobookGenerating(false);
    setIsAudiobookPlaying(false);
    setIsAudiobookPlaybackPaused(false);
    
    audiobookSceneImageUrls.filter(url => url.startsWith('blob:') || url.startsWith('https://picsum.photos')).forEach(url => globalThis.URL.revokeObjectURL(url));
    setAudiobookSceneImages(null);
    setAudiobookSceneImageUrls([]);
    setCurrentAudiobookSceneIndex(0);
    currentLoadedAudiobookImageRef.current = null;
    previousLoadedAudiobookImageRef.current = null;
    audiobookFadeStateRef.current = null;
    audiobookScrollStartTimeRef.current = 0;
    lastSceneChangeTimestampRef.current = 0;
    setAudiobookLinesWithTiming([]); // Clear karaoke segments
    setCurrentHighlightedLineIndex(-1);
    setCurrentHighlightedWordIndex(-1);
  }, [stopAllAudio, audiobookSceneImageUrls]);


  const handleClearConversationHistory = useCallback(() => {
    setConversationHistory([]);
    globalThis.localStorage.removeItem('liveConversationHistory');
    setStatusMessage('Beszélgetési előzmények törölve.');
    setError(null);
  }, []);

  const handleSendLiveText = useCallback(async () => {
    if (!liveTextInput.trim()) {
      setError("Kérjük, írjon be üzenetet a küldéshez.");
      return;
    }
    if (!liveSessionRef.current) {
      setError("Az élő munkamenet nem aktív. Kérjük, először indítsa el a beszélgetést.");
      return;
    }

    const messageToSend = liveTextInput.trim();
    setLiveTextInput('');
    setError(null);
    setStatusMessage("Üzenet küldése...");

    try {
      setConversationHistory(prev => [
        ...prev,
        { sender: 'user', text: messageToSend }
      ]);
      await sendTextInput(liveSessionRef.current, messageToSend);
      setStatusMessage("Üzenet elküldve.");
    } catch (err) {
      handleApiError("Nem sikerült szöveges üzenetet küldeni", err);
    }
  }, [liveTextInput, liveSessionRef, handleApiError]);


  const startMicrophoneStream = useCallback(async (sessionPromise: Promise<LiveSession>) => {
    const { audioContext, outputNode } = initializeAudioContext();

    try {
      // FIX: Ensure AudioContext is running before trying to get user media
      if (audioContext.state !== 'running') {
        await audioContext.resume();
        console.log(`startMicrophoneStream: AudioContext resumed. New state: ${audioContext.state}`); // DIAGNOSTIC
      }

      const stream = await globalThis.navigator.mediaDevices.getUserMedia({ audio: true });
      microphoneStreamRef.current = stream;
      // FIX: Connect source from media stream to an analyser or directly to output node for routing
      const source = audioContext.createMediaStreamSource(stream); 
      const scriptProcessor = audioContext.createScriptProcessor(AUDIO_CHUNK_SIZE, NUM_AUDIO_CHANNELS, NUM_AUDIO_CHANNELS);

      source.connect(scriptProcessor); // Connect media stream to script processor
      scriptProcessor.connect(outputNode); // scriptProcessor connects to outputNode for general audio processing and routing
      
      scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
        const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
        sessionPromise.then((session) => {
          const pcmBlob = createPcmBlob(inputData);
          session.sendRealtimeInput({ media: pcmBlob });
        }).catch((err: any) => {
          console.error("Hiba az audio bemenet Live munkamenetnek való küldésekor:", err);
          // handleApiError("Hiba az audio bemenet küldésekor", err); // Optionally show error to user
        });
      };

      scriptProcessorRef.current = scriptProcessor;
      setIsRecordingMicrophone(true);
      setStatusMessage('Mikrofon aktív. Beszélhet vagy gépelhet...');
    } catch (err) {
      handleApiError('Nem sikerült hozzáférni a mikrofonhoz', err);
    }
  }, [handleApiError, initializeAudioContext]);

  const startLiveConversation = useCallback(async () => {
    setError(null);
    setIsLoading(true);
    setStatusMessage('Csatlakozás a Live API-hoz...');
    stopAllAudioSources();

    try {
      await checkAndSelectApiKey();
      const { audioContext } = initializeAudioContext();

      const sessionPromise = connectLiveSession({
        onAudioChunk: (buffer) => {
          playAudioBuffer(buffer);
        },
        onTranscriptionUpdate: (type, text, isFinal) => {
          if (isTranscriptionEnabled) {
              setCurrentTranscription(prev => ({ ...prev, [type]: text }));
              if (isFinal) {
                  setConversationHistory(prev => [
                      ...prev,
                      { sender: type, text: text }
                  ]);
                  setCurrentTranscription(prev => ({ ...prev, [type]: '' }));
              }
          }
        },
        onSessionError: (e) => {
          handleApiError('Live munkamenet hiba', e);
          stopLiveConversation();
        },
        onSessionClose: (e) => {
          console.log('Live munkamenet lezárva:', e);
          stopLiveConversation();
        },
      }, isTranscriptionEnabled, audioContext);

      liveSessionPromiseRef.current = sessionPromise;
      const session = await sessionPromise;
      liveSessionRef.current = session;
      setIsLiveSessionActive(true);
      await startMicrophoneStream(sessionPromise);
      setStatusMessage('Élő beszélgetés elindítva. Beszéljen az AI-val!');
    } catch (err) {
      handleApiError('Nem sikerült elindítani az élő beszélgetést', err);
      setIsLiveSessionActive(false);
      setIsLoading(false);
      liveSessionPromiseRef.current = null;
    } finally {
      setIsLoading(false);
    }
  }, [handleApiError, startMicrophoneStream, playAudioBuffer, initializeAudioContext, isTranscriptionEnabled, stopAllAudioSources]);

  const stopLiveConversation = useCallback(() => {
    stopAllAudio();
    setIsAudiobookPlaying(false);
    stopMicrophoneStream();
    if (liveSessionRef.current) {
      liveSessionRef.current.close();
      liveSessionRef.current = null;
    }
    liveSessionPromiseRef.current = null;
    setIsLiveSessionActive(false);
    setIsLoading(false);
    setStatusMessage('Élő beszélgetés befejezve.');
    setCurrentTranscription({ user: '', model: '' });
  }, [stopAllAudio, stopMicrophoneStream]);

  // Video Visualizer Functions
  const handleVideoFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (videoUrl) {
        globalThis.URL.revokeObjectURL(videoUrl);
      }
      const url = globalThis.URL.createObjectURL(file);
      setVideoUrl(url);
      setIsPlayingVideo(false);
      setError(null);
      setStatusMessage(`Videó '${file.name}' betöltve.`);

      stopRecordingVideo();
    } else {
      setVideoUrl(null);
      setStatusMessage('Nincs kiválasztott videófájl.');
    }
  }, [videoUrl, stopRecordingVideo]);

  const handlePlayPauseVideo = useCallback(() => {
    if (!videoElementRef.current || !videoUrl) return;

    stopAllAudioSources();
    setIsAudiobookPlaying(false);

    if (isPlayingVideo) {
      videoElementRef.current.pause();
      setIsPlayingVideo(false);
      setStatusMessage('Videó szüneteltetve.');
      if (videoSourceNodeRef.current) {
        videoSourceNodeRef.current.disconnect(outputNodeRef.current!);
        videoSourceNodeRef.current.disconnect(audioContextRef.current!.destination);
        videoSourceNodeRef.current = null;
      }
    } else {
      const { audioContext, outputNode } = initializeAudioContext(); // Use outputNodeRef.current!

      if (!videoSourceNodeRef.current || videoSourceNodeRef.current.mediaElement !== videoElementRef.current) {
        if (videoSourceNodeRef.current) {
          videoSourceNodeRef.current.disconnect(outputNode); // Disconnect from current outputNode
          videoSourceNodeRef.current.disconnect(audioContext.destination);
        }
        videoSourceNodeRef.current = audioContext.createMediaElementSource(videoElementRef.current);
      }
      
      videoSourceNodeRef.current.connect(outputNode); // Connect to outputNode
      // Removed direct connection to audioContext.destination as outputNode handles it.
      
      videoElementRef.current.play();
      setIsPlayingVideo(true);
      setStatusMessage('Videó lejátszása vizualizációval...');
    }
  }, [isPlayingVideo, videoUrl, stopAllAudioSources, initializeAudioContext]);

  const handleVideoEnded = useCallback(() => {
    setIsPlayingVideo(false);
    setStatusMessage('Videó lejátszás befejeződött.');
    if (videoSourceNodeRef.current) {
      videoSourceNodeRef.current.disconnect(outputNodeRef.current!);
      videoSourceNodeRef.current.disconnect(audioContextRef.current!.destination);
      videoSourceNodeRef.current = null;
    }
  }, []);

  const startRecordingVideo = useCallback(() => {
    if (!mainVisualizerCanvasRef.current || !mediaStreamDestinationRef.current) {
      setError("Nem lehet elindítani a felvételt: Vászon vagy hangcél nem áll készen.");
      return;
    }
    if (!isPlayingVideo && !isAudiobookPlaying) {
      setError("Kérjük, indítson el egy videót vagy hangoskönyvet a felvétel megkezdése előtt.");
      return;
    }

    setError(null);
    setIsLoading(true);
    setStatusMessage("Videó felvétel indítása...");
    recordedChunksRef.current = [];

    try {
      const selectedRes = VIDEO_RESOLUTIONS.find(res => res.value === selectedVideoResolution);
      const selectedCodec = VIDEO_CODECS.find(codec => codec.value === selectedVideoCodec);
      // FIX: Find the bitrate object from VIDEO_BITRATES
      const selectedBitrateObj = VIDEO_BITRATES.find(bitrate => bitrate.value === selectedVideoBitrate); 

      if (!selectedRes || !selectedCodec || !selectedBitrateObj) { // Check all selections
        throw new Error("Érvénytelen felbontás, kodek vagy bitráta kiválasztva.");
      }

      // Set canvas dimensions for recording
      mainVisualizerCanvasRef.current.width = selectedRes.width;
      mainVisualizerCanvasRef.current.height = selectedRes.height;

      const canvasStream = mainVisualizerCanvasRef.current.captureStream(30);
      const videoTrack = canvasStream.getVideoTracks()[0];

      const audioStream = mediaStreamDestinationRef.current.stream;
      const audioTrack = audioStream.getAudioTracks()[0];

      if (!videoTrack) {
        throw new Error("Nem sikerült videósávot szerezni a vászonfolyamból.");
      }
      if (!audioTrack) {
        throw new Error("Nem sikerült audiosávot szerezni a hangcélfolyamból.");
      }

      const combinedStream = new MediaStream();
      combinedStream.addTrack(videoTrack);
      combinedStream.addTrack(audioTrack);

      // FIX: Construct mimeType using codecsString and videoBitsPerSecond from selectedBitrateObj
      const mimeType = `${selectedCodec.mimeType}; codecs=${selectedCodec.codecsString}`;

      mediaRecorderRef.current = new MediaRecorder(combinedStream, {
        mimeType: mimeType,
        videoBitsPerSecond: selectedBitrateObj.numericValue
      });

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current.onerror = (event: Event) => {
        const error = (event as ErrorEvent).error as Error; 
        handleApiError("MediaRecorder hiba", error);
        setIsRecordingVideo(false);
        setIsLoading(false);
      };

      mediaRecorderRef.current.onstop = async () => {
        setIsRecordingVideo(false);
        setIsLoading(false);
        setStatusMessage("Videó felvétel leállítva. Letöltés előkészítése...");

        if (recordedChunksRef.current.length === 0) {
          setError("Nincs rögzített videó adat. A felvétel sikertelen volt, vagy túl rövid.");
          return;
        }

        const recordedBlob = new Blob(recordedChunksRef.current, { type: selectedCodec.mimeType });

        if ('showSaveFilePicker' in globalThis) {
          try {
            const fileHandle = await globalThis.showSaveFilePicker({
              suggestedName: (isPlayingVideo ? 'visualized_video' : 'audiobook_storyboard') + `.${selectedCodec.extension}`,
              types: [{
                description: selectedCodec.name,
                accept: { [selectedCodec.mimeType]: [`.${selectedCodec.extension}`] },
              }],
            });

            const writableStream = await fileHandle.createWritable();
            await writableStream.write(recordedBlob); 
            await writableStream.close();
            setStatusMessage('Vizualizált videó sikeresen mentve!');
          } catch (err) {
            handleApiError('Nem sikerült menteni a vizualizált videót', err);
          }
        } else {
          const url: string = globalThis.URL.createObjectURL(recordedBlob);
          const a = globalThis.document.createElement('a');
          a.href = url;
          a.download = (isPlayingVideo ? 'visualized_video' : 'audiobook_storyboard') + `.${selectedCodec.extension}`;
          globalThis.document.body.appendChild(a);
          a.click();
          globalThis.document.body.removeChild(a);
          globalThis.URL.revokeObjectURL(url);
          setStatusMessage('A vizualizált videó sikeresen letöltve az alapértelmezett letöltési mappába!');
        }
        recordedChunksRef.current = [];
      };

      mediaRecorderRef.current.start();
      setIsRecordingVideo(true);
      setStatusMessage("Videó felvétele vizualizációval...");
    } catch (err) {
      handleApiError("Nem sikerült elindítani a videófelvételt", err);
      setIsLoading(false);
    }
  }, [isPlayingVideo, isAudiobookPlaying, handleApiError, selectedVideoCodec, selectedVideoResolution, selectedVideoBitrate]);

  const handleFullscreenToggle = useCallback(() => {
    const element = mainCanvasContainerRef.current;
    if (element) {
      if (globalThis.document.fullscreenElement) {
        globalThis.document.exitFullscreen();
      } else {
        element.requestFullscreen().catch((err) => {
          console.error(`Hiba a teljes képernyős mód engedélyezésekor: ${err.message} (${err.name})`);
          setError('Nem sikerült teljes képernyős módba váltani. A böngésző biztonsági beállításai blokkolhatják.');
        });
      }
    }
  }, []);

  // Background Music Functions
  const handleBackgroundMusicFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (backgroundMusicUrl) {
        globalThis.URL.revokeObjectURL(backgroundMusicUrl);
      }
      const url = globalThis.URL.createObjectURL(file);
      setBackgroundMusicFile(file);
      setBackgroundMusicUrl(url);
      
      const { audioContext, outputNode } = initializeAudioContext();
      if (!backgroundAudioElementRef.current) {
        backgroundAudioElementRef.current = new Audio();
        backgroundAudioElementRef.current.loop = true;
        backgroundAudioElementRef.current.crossOrigin = "anonymous";
        backgroundAudioElementRef.current.onplay = () => setIsPlayingBackgroundMusic(true);
        backgroundAudioElementRef.current.onpause = () => setIsPlayingBackgroundMusic(false);
        backgroundAudioElementRef.current.onended = () => setIsPlayingBackgroundMusic(false);

        backgroundMusicSourceNodeRef.current = audioContext.createMediaElementSource(backgroundAudioElementRef.current);
        backgroundMusicSourceNodeRef.current.connect(backgroundMusicGainNodeRef.current!);
        backgroundMusicGainNodeRef.current!.connect(outputNode); // Connect to outputNode
        backgroundMusicGainNodeRef.current!.connect(audioContext.destination); // Direct for robustness
      }
      backgroundAudioElementRef.current.src = url;
      backgroundAudioElementRef.current.load();
      
      setIsPlayingBackgroundMusic(false); // Will be set to true on play
      setError(null);
      setStatusMessage(`Háttérzene '${file.name}' betöltve.`);
      setYouTubeVideoId(null); // Clear YouTube if file is uploaded
      youTubePlayerRef.current?.destroy();
      setYouTubePlayerReady(false);

    } else {
      if (backgroundMusicUrl) {
        globalThis.URL.revokeObjectURL(backgroundMusicUrl);
      }
      setBackgroundMusicFile(null);
      setBackgroundMusicUrl(null);
      if (backgroundAudioElementRef.current) {
        backgroundAudioElementRef.current.pause();
        if (backgroundMusicSourceNodeRef.current) {
          backgroundMusicSourceNodeRef.current.disconnect(outputNodeRef.current!);
          backgroundMusicSourceNodeRef.current.disconnect(audioContextRef.current!.destination);
        }
      }
      setIsPlayingBackgroundMusic(false);
      setStatusMessage('Nincs kiválasztott háttérzene fájl.');
    }
  }, [backgroundMusicUrl, initializeAudioContext]);

  // FIX: Implemented handlePlayPauseBackgroundMusic
  const handlePlayPauseBackgroundMusic = useCallback(() => {
    if (backgroundAudioElementRef.current && backgroundMusicUrl) {
      if (isPlayingBackgroundMusic) {
        backgroundAudioElementRef.current.pause();
      } else {
        backgroundAudioElementRef.current.play();
      }
    } else if (youTubePlayerRef.current) {
      if (isPlayingBackgroundMusic) { // Check YouTube player state
        youTubePlayerRef.current.pauseVideo();
      } else {
        youTubePlayerRef.current.playVideo();
      }
    }
    // isPlayingBackgroundMusic state is updated by onplay/onpause events of audio elements or YT player
  }, [isPlayingBackgroundMusic, backgroundMusicUrl]);


  // YouTube Player specific functions
  const onYouTubeIframeAPIReady = useCallback(() => {
    console.log("YouTube Iframe API Ready.");
    setYouTubePlayerReady(true);
  }, []);

  useEffect(() => {
    globalThis.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;
    return () => {
      globalThis.onYouTubeIframeAPIReady = undefined; // Clean up
    };
  }, [onYouTubeIframeAPIReady]);


  const handleLoadAudioFromYouTube = useCallback(async () => {
    if (!youTubeUrlInput.trim()) {
      setError('Kérjük, adjon meg egy YouTube URL-t.');
      return;
    }
    setError(null);
    setIsLoading(true);
    setStatusMessage('YouTube videó betöltése (hangja NEM lesz vizualizálva/rögzítve!)...');

    try {
      const videoIdMatch = youTubeUrlInput.match(/(?:https?:\/\/)?(?:www\.)?(?:m\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=|embed\/|v\/|)([\w-]{11})(?:\S+)?/);
      if (!videoIdMatch || !videoIdMatch[1]) {
        throw new Error("Érvénytelen YouTube URL.");
      }
      const newVideoId = videoIdMatch[1];
      
      // Clear local file background music if YouTube is loaded
      if (backgroundMusicUrl) {
        globalThis.URL.revokeObjectURL(backgroundMusicUrl);
        setBackgroundMusicFile(null);
        setBackgroundMusicUrl(null);
        backgroundAudioElementRef.current?.pause();
        if (backgroundMusicSourceNodeRef.current) {
          backgroundMusicSourceNodeRef.current.disconnect(outputNodeRef.current!);
          backgroundMusicSourceNodeRef.current.disconnect(audioContextRef.current!.destination);
        }
      }

      setYouTubeVideoId(newVideoId);
      setIsPlayingBackgroundMusic(true); // Assume it will play if loaded

      // Destroy previous player instance if exists
      youTubePlayerRef.current?.destroy();

      // Ensure YouTube API is ready
      if (!globalThis.YT || !youTubePlayerReady) {
        throw new Error("YouTube Iframe API nem áll készen. Kérjük, várjon.");
      }
      
      // Create new player instance
      youTubePlayerRef.current = new globalThis.YT.Player('youtube-player', {
        height: '0', // Hide video player, only use for audio
        width: '0',
        videoId: newVideoId,
        playerVars: {
          autoplay: 1, // Autoplay on load
          controls: 0, // No controls
          disablekb: 1,
          fs: 0,
          iv_load_policy: 3,
          modestbranding: 1,
          rel: 0,
          showinfo: 0,
          start: 0,
          enablejsapi: 1,
          origin: globalThis.location.origin, // Crucial for security and API calls
        },
        events: {
          onReady: (event: any) => {
            console.log("YouTube Player Ready event.", event);
            event.target.setVolume(backgroundMusicVolume * 100); // Set initial volume (0-100)
            event.target.playVideo();
            setYouTubeDuration(event.target.getDuration());
            setYouTubeCurrentTime(0);
            youTubeProgressIntervalRef.current = globalThis.setInterval(() => {
              setYouTubeCurrentTime(event.target.getCurrentTime());
            }, 1000);
            setStatusMessage('YouTube audió betöltve és lejátszva (hangja NEM lesz vizualizálva/rögzítve!).');
          },
          onStateChange: (event: any) => {
            if (event.data === globalThis.YT.PlayerState.PLAYING) {
              setIsPlayingBackgroundMusic(true);
            } else {
              setIsPlayingBackgroundMusic(false);
            }
          },
          onError: (event: any) => { // FIX: Changed type to any for event as event.data is specific to YT API
            console.error("YouTube Player Error:", event);
            handleApiError(`YouTube lejátszó hiba: ${event.data}`, new Error(`YouTube Error Code: ${event.data}`));
            setIsPlayingBackgroundMusic(false);
          }
        }
      });
    } catch (err) {
      handleApiError('Nem sikerült betölteni a YouTube hangot', err);
    } finally {
      setIsLoading(false);
    }
  }, [youTubeUrlInput, backgroundMusicUrl, backgroundMusicVolume, youTubePlayerReady, handleApiError]);


  const handlePlayPauseYouTube = useCallback(() => {
    if (!youTubePlayerRef.current) return;
    if (isPlayingBackgroundMusic) { // youTubePlayerRef.current.getPlayerState() === globalThis.YT.PlayerState.PLAYING
      youTubePlayerRef.current.pauseVideo();
    } else {
      youTubePlayerRef.current.playVideo();
    }
  }, [isPlayingBackgroundMusic]);

  const handleSeekYouTube = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    if (youTubePlayerRef.current) {
      const seekToTime = parseFloat(event.target.value);
      youTubePlayerRef.current.seekTo(seekToTime, true);
      setYouTubeCurrentTime(seekToTime);
    }
  }, []);

  const handleBackgroundMusicVolumeChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const volume = parseFloat(event.target.value);
    setBackgroundMusicVolume(volume);
    if (backgroundMusicGainNodeRef.current) {
      backgroundMusicGainNodeRef.current.gain.value = volume;
    }
    // Set YouTube player volume if active
    if (youTubePlayerRef.current) {
      youTubePlayerRef.current.setVolume(volume * 100); // YouTube volume is 0-100
    }
  }, []);


  // Audiobook Scene Visualizer Functions
  const handleAudiobookSceneImagesChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      audiobookSceneImageUrls.filter(url => url.startsWith('blob:') || url.startsWith('https://picsum.photos')).forEach(url => globalThis.URL.revokeObjectURL(url));

      const newImageFiles = Array.from(files);
      const newImageUrls = newImageFiles.map(file => globalThis.URL.createObjectURL(file));
      
      setAudiobookSceneImages(newImageFiles);
      setAudiobookSceneImageUrls(newImageUrls);
      setCurrentAudiobookSceneIndex(0);
      currentLoadedAudiobookImageRef.current = null;
      previousLoadedAudiobookImageRef.current = null;
      audiobookFadeStateRef.current = null;

      setStatusMessage(`${newImageFiles.length} kép(ek) betöltve.`);
      setError(null);
    } else {
      if (audiobookSceneImageUrls) { // Check if urls exist before revoking
        audiobookSceneImageUrls.filter(url => url.startsWith('blob:') || url.startsWith('https://picsum.photos')).forEach(url => globalThis.URL.revokeObjectURL(url));
      }
      setAudiobookSceneImages(null);
      setAudiobookSceneImageUrls([]);
      setCurrentAudiobookSceneIndex(0);
      currentLoadedAudiobookImageRef.current = null;
      previousLoadedAudiobookImageRef.current = null;
      audiobookFadeStateRef.current = null;
      setStatusMessage('Nincs kiválasztott jelenetkép.');
    }
  }, [audiobookSceneImageUrls]);

  const handleClearAudiobookScenes = useCallback(() => {
    audiobookSceneImageUrls.filter(url => url.startsWith('blob:') || url.startsWith('https://picsum.photos')).forEach(url => globalThis.URL.revokeObjectURL(url));
    setAudiobookSceneImages(null);
    setAudiobookSceneImageUrls([]);
    setCurrentAudiobookSceneIndex(0);
    currentLoadedAudiobookImageRef.current = null;
    previousLoadedAudiobookImageRef.current = null;
    audiobookFadeStateRef.current = null;
    setStatusMessage('Hangoskönyv jelenetek törölve.');
  }, [audiobookSceneImageUrls]);

  const handleGenerateImagesFromText = useCallback(async () => {
    if (!textInput.trim()) {
      setError('Kérjük, adjon meg szöveget a képek generálásához.');
      return;
    }
    setError(null);
    setIsLoading(true);
    setIsGeneratingImages(true);
    setStatusMessage('Képek generálása (szimulált)...');

    try {
      audiobookSceneImageUrls.filter(url => url.startsWith('blob:') || url.startsWith('https://picsum.photos')).forEach(url => globalThis.URL.revokeObjectURL(url));
      
      const newGeneratedUrls: string[] = [];
      const sentences = textInput.split(/[\.!?]+\s/).filter(s => s.trim().length > 0);
      const numImagesToGenerate = globalThis.Math.min(sentences.length > 0 ? sentences.length : 1, 10);

      for (let i = 0; i < numImagesToGenerate; i++) {
        await new Promise(resolve => globalThis.setTimeout(resolve, 500 + globalThis.Math.random() * 500));
        const randomSeed = globalThis.Math.floor(globalThis.Math.random() * 1000);
        newGeneratedUrls.push(`https://picsum.photos/1280/720?random=${randomSeed + i}`);
      }

      setAudiobookSceneImageUrls(newGeneratedUrls);
      setAudiobookSceneImages(null);
      setCurrentAudiobookSceneIndex(0);
      currentLoadedAudiobookImageRef.current = null;
      previousLoadedAudiobookImageRef.current = null;
      audiobookFadeStateRef.current = null;

      setStatusMessage(`${newGeneratedUrls.length} kép generálva és betöltve.`);
    } catch (err) {
      handleApiError('Nem sikerült képeket generálni (szimulált)', err);
    } finally {
      setIsLoading(false);
      setIsGeneratingImages(false);
    }
  }, [textInput, handleApiError, audiobookSceneImageUrls]);


  // Main Visualizer Logic (handles Video, Live, Audiobook)
  const drawMainVisualizer = useCallback(() => {
    const canvas = mainVisualizerCanvasRef.current;
    const analyser = analyserRef.current;
    const audioContext = audioContextRef.current;
    
    if (!canvas || !analyser || !audioContext) {
      if (animationFrameIdRef.current) globalThis.cancelAnimationFrame(animationFrameIdRef.current);
      animationFrameIdRef.current = null;
      return;
    }

    const canvasCtx = canvas.getContext('2d');
    if (!canvasCtx) {
      if (animationFrameIdRef.current) globalThis.cancelAnimationFrame(animationFrameIdRef.current);
      animationFrameIdRef.current = null;
      return;
    }
    const context: CanvasRenderingContext2D = canvasCtx;

    const currentResolution = VIDEO_RESOLUTIONS.find(res => res.value === selectedVideoResolution);
    canvas.width = currentResolution ? currentResolution.width : 1280;
    canvas.height = currentResolution ? currentResolution.height : 720;


    const WIDTH = canvas.width;
    const HEIGHT = canvas.height;

    analyser.fftSize = 2048;
    const bufferLength = analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);
    const frequencyDataArray = new Uint8Array(analyser.frequencyBinCount); // For frequency data

    const animate = () => {
      animationFrameIdRef.current = globalThis.requestAnimationFrame(animate);

      analyser.getByteTimeDomainData(dataArray);
      analyser.getByteFrequencyData(frequencyDataArray); // Get frequency data

      context.clearRect(0, 0, WIDTH, HEIGHT);
      
      // Calculate average frequency and amplitude for visual effects
      let totalFrequency = 0;
      let totalAmplitude = 0;
      for(let i = 0; i < bufferLength; i++) {
        totalAmplitude += Math.abs(dataArray[i] - 128); // Amplitude from waveform
      }
      for(let i = 0; i < analyser.frequencyBinCount; i++) {
        totalFrequency += frequencyDataArray[i]; // Raw frequency sum
      }
      const avgAmplitude = totalAmplitude / bufferLength;
      const avgFrequency = totalFrequency / analyser.frequencyBinCount;
      
      // Dynamic Background Color (RGB) - based on frequency/amplitude
      let baseBackgroundColor = '#1F2937'; // Default dark background
      let tintColor = '';
      let tintOpacity = 0;
      let hue = 0; 

      if (isDynamicBackgroundEnabled) {
        hue = (avgFrequency / 255) * 360; // 0-360 for hue
        const saturation = 50 + (avgAmplitude / 128) * 50; // 50-100 for saturation
        const lightness = 20 + (avgAmplitude / 128) * 10; // 20-30 for lightness
        baseBackgroundColor = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
      }
      context.fillStyle = baseBackgroundColor;
      context.fillRect(0, 0, WIDTH, HEIGHT);

      // Background Drawing (Video or Audiobook Scenes) with optional tint
      if (isPlayingVideo && videoElementRef.current && videoElementRef.current.readyState >= 2) {
        context.drawImage(videoElementRef.current, 0, 0, WIDTH, HEIGHT);
        if (isTintEffectEnabled) {
          context.save();
          tintOpacity = 0.2 + (avgAmplitude / 128) * 0.3; // More tint with higher amplitude
          tintColor = `hsl(${(avgFrequency / 255) * 360 + 180}, 70%, 30%)`; // Opposite hue for contrast
          context.globalAlpha = tintOpacity;
          context.fillStyle = tintColor;
          context.fillRect(0, 0, WIDTH, HEIGHT);
          context.restore();
        }
      } else if (isAudiobookPlaying && audiobookSceneImageUrls.length > 0) {
        // Audiobook Scene Cycling and Animation
        const currentTime = audioContext.currentTime;
        const totalAudiobookDuration = audiobookPcmBuffersRef.current.reduce((acc, buffer) => acc + buffer.duration, 0);

        if (totalAudiobookDuration > 0 && audiobookSceneImageUrls.length > 0) {
            const dynamicSceneDuration = totalAudiobookDuration / audiobookSceneImageUrls.length;
            const elapsedSinceLastChange = currentTime - lastSceneChangeTimestampRef.current;

            if (!audiobookFadeStateRef.current?.active && audiobookSceneImageUrls.length > 1) {
                if (elapsedSinceLastChange >= dynamicSceneDuration) {
                    const oldIndex = currentAudiobookSceneIndex;
                    const newIndex = (oldIndex + 1) % audiobookSceneImageUrls.length;

                    previousLoadedAudiobookImageRef.current = currentLoadedAudiobookImageRef.current;
                    const newCurrentImage = new Image();
                    newCurrentImage.src = audiobookSceneImageUrls[newIndex];
                    currentLoadedAudiobookImageRef.current = newCurrentImage;

                    audiobookFadeStateRef.current = {
                        active: true,
                        startTime: currentTime,
                        duration: FADE_DURATION_SECONDS,
                        oldImageUrl: audiobookSceneImageUrls[oldIndex],
                        newImageUrl: audiobookSceneImageUrls[newIndex],
                    };
                    setCurrentAudiobookSceneIndex(newIndex);
                    lastSceneChangeTimestampRef.current = currentTime;
                }
            }
        }

        // Drawing Logic for Images (Fade or Static)
        if (audiobookFadeStateRef.current?.active) {
            const fadeState = audiobookFadeStateRef.current;
            const progress = globalThis.Math.min(1, (currentTime - fadeState.startTime) / fadeState.duration);

            const oldImageOpacity = 1 - progress;
            const newImageOpacity = progress;

            const initialScale = 1.0;
            const targetScale = 1.05; // Zoom in
            const oldImageScale = initialScale + (0.95 - initialScale) * progress; // Zoom out slightly
            const newImageScale = initialScale + (targetScale - initialScale) * progress; // Zoom in slightly

            if (previousLoadedAudiobookImageRef.current && previousLoadedAudiobookImageRef.current.complete) {
                context.save();
                context.globalAlpha = oldImageOpacity;
                drawImageTransform(context, previousLoadedAudiobookImageRef.current, WIDTH, HEIGHT, oldImageScale);
                context.restore();
            }

            if (currentLoadedAudiobookImageRef.current && currentLoadedAudiobookImageRef.current.complete) {
                context.save();
                context.globalAlpha = newImageOpacity;
                drawImageTransform(context, currentLoadedAudiobookImageRef.current, WIDTH, HEIGHT, newImageScale);
                context.restore();
            }

            if (progress >= 1) {
                audiobookFadeStateRef.current = null;
                previousLoadedAudiobookImageRef.current = null;
            }
        } else if (currentLoadedAudiobookImageRef.current && currentLoadedAudiobookImageRef.current.complete) {
            context.globalAlpha = 1;
            drawImageTransform(context, currentLoadedAudiobookImageRef.current, WIDTH, HEIGHT, 1.0); // No zoom when static
        } else {
            if (audiobookSceneImageUrls[currentAudiobookSceneIndex] && !currentLoadedAudiobookImageRef.current) {
                const img = new Image();
                img.src = audiobookSceneImageUrls[currentAudiobookSceneIndex];
                img.onload = () => {
                    if (animationFrameIdRef.current) {
                        globalThis.cancelAnimationFrame(animationFrameIdRef.current);
                    }
                    drawMainVisualizer();
                };
                currentLoadedAudiobookImageRef.current = img;
            } else if (currentLoadedAudiobookImageRef.current && !currentLoadedAudiobookImageRef.current.complete) {
                context.fillStyle = '#374151';
                context.fillRect(0, 0, WIDTH, HEIGHT);
                context.font = '16px sans-serif';
                context.fillStyle = '#9CA3AF';
                context.textAlign = 'center';
                context.fillText('Jelenetkép betöltése...', WIDTH / 2, HEIGHT / 2);
            } else {
                context.fillStyle = '#1F2937';
                context.fillRect(0, 0, WIDTH, HEIGHT);
            }
        }
        // FIX: Use isTintEffectEnabled state
        if (isTintEffectEnabled) {
          context.save();
          tintOpacity = 0.1 + (avgAmplitude / 128) * 0.2; // More tint with higher amplitude
          tintColor = `hsl(${(avgFrequency / 255) * 360 + 180}, 60%, 40%)`; // Opposite hue for contrast
          context.globalAlpha = tintOpacity;
          context.fillStyle = tintColor;
          context.fillRect(0, 0, WIDTH, HEIGHT);
          context.restore();
        }

      } else {
        context.fillStyle = baseBackgroundColor; // Use dynamic color as base background
        context.fillRect(0, 0, WIDTH, HEIGHT);
      }

      // Draw Waveform Overlay (as sine wave) - dynamic color, opposite hue
      if (isSineWaveEffectEnabled) {
        const sineColorHue = (hue + 180) % 360; // Opposite hue for contrast
        context.strokeStyle = `hsl(${sineColorHue}, 90%, 70%)`;
        context.lineWidth = 3; // Thicker line
        context.beginPath();

        const sliceWidth = WIDTH * 1.0 / bufferLength;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
          const v = dataArray[i] / 128.0; // Normalize to 0-2
          // Add subtle sine wave based on time/amplitude, making it reactive
          const y = v * HEIGHT / 2 + (globalThis.Math.sin(x * 0.05 + audioContext.currentTime * 5) * (avgAmplitude / 2)); 

          if (i === 0) {
            context.moveTo(x, y);
          } else {
            context.lineTo(x, y);
          }
          x += sliceWidth;
        }
        context.lineTo(WIDTH, HEIGHT / 2); // Ensure line reaches end
        context.stroke();
      }

      // Draw Particle Effect
      if (isParticleEffectEnabled) {
        // Add new particles based on audio
        if (avgAmplitude > 60 && particlesRef.current.length < 200) { // Only add if sound is significant
          for (let i = 0; i < 2; i++) { // Add a couple of particles per frame
            const particleHue = (avgFrequency / 255) * 360 + (globalThis.Math.random() * 60 - 30); // Randomize hue slightly
            particlesRef.current.push({
              x: WIDTH * globalThis.Math.random(),
              y: HEIGHT, // Start from bottom
              vx: (globalThis.Math.random() - 0.5) * 2 * (avgAmplitude / 128) * 5, // Horizontal velocity based on amplitude
              vy: -2 - (globalThis.Math.random() * 3) * (avgAmplitude / 128), // Upward velocity based on amplitude
              radius: 2 + (globalThis.Math.random() * 3) * (avgAmplitude / 128), // Size based on amplitude
              color: `hsla(${particleHue}, 100%, 70%, 1)`,
              alpha: 1,
              life: 0,
              maxLife: 60 + globalThis.Math.random() * 60, // Lived for 1-2 seconds at 60 FPS
            });
          }
        }

        // Update and draw particles
        context.save();
        particlesRef.current.forEach((p, index) => {
          p.x += p.vx;
          p.y += p.vy;
          p.life++;
          p.alpha = 1 - p.life / p.maxLife; // Fade out

          if (p.life > p.maxLife || p.y < 0) {
            particlesRef.current.splice(index, 1); // Remove dead particles
          } else {
            context.beginPath();
            context.arc(p.x, p.y, p.radius * p.alpha, 0, Math.PI * 2, false); // Shrink and fade
            // FIX: Correctly reconstruct hsla string to update alpha, instead of literal string replacement
            const lastCommaIndex = (p.color as string).lastIndexOf(',');
            let newColor;
            if (lastCommaIndex !== -1) {
              // Reconstruct the color string by taking the part before the last comma
              // and appending the new alpha value with a closing parenthesis.
              newColor = `${(p.color as string).substring(0, lastCommaIndex)}, ${p.alpha})`;
            } else {
              // Fallback in case the format is unexpected
              newColor = `hsla(0, 0%, 0%, ${p.alpha})`; // A safe fallback transparent color
              console.warn("Particle color format unexpected, unable to update alpha cleanly: ", p.color);
            }
            context.fillStyle = newColor;
            context.fill();
          }
        });
        context.restore();
      }


      // Draw Karaoke Text Overlay
      if (isAudiobookPlaying && audiobookLinesWithTiming.length > 0 && isKaraokeEffectEnabled) {
        const currentTime = audioContext.currentTime - audiobookScrollStartTimeRef.current;
        const visibleLines = 3; // Number of lines visible at once in the letterbox
        const letterboxHeight = HEIGHT * 0.25; // 25% of screen height for letterbox
        const letterboxY = HEIGHT - letterboxHeight;
        const fontSize = 36;
        const lineHeight = fontSize * 1.2;
        const textPaddingY = (letterboxHeight - visibleLines * lineHeight) / 2; // Vertical padding
        
        context.save();
        
        // Draw black translucent letterbox background
        context.fillStyle = `rgba(0, 0, 0, 0.7 + (avgAmplitude / 128) * 0.2)`; // More opaque with higher amplitude
        context.fillRect(0, letterboxY, WIDTH, letterboxHeight);

        context.font = `${fontSize}px 'Arial', sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.shadowColor = 'black';
        context.shadowBlur = 5;

        // Find current line and word
        let currentLineIndex = -1;
        let currentWordIndex = -1;
        for (let i = 0; i < audiobookLinesWithTiming.length; i++) {
          const line = audiobookLinesWithTiming[i];
          if (currentTime >= line.relativeStartTime && currentTime < line.relativeEndTime) {
            currentLineIndex = i;
            const timeInLine = currentTime - line.relativeStartTime;
            for (let j = 0; j < line.words.length; j++) {
              const word = line.words[j];
              if (timeInLine >= word.startTime && timeInLine < word.endTime) {
                currentWordIndex = j;
                break;
              }
            }
            break;
          }
        }
        
        if (currentLineIndex !== currentHighlightedLineIndex) {
          setCurrentHighlightedLineIndex(currentLineIndex);
        }
        if (currentWordIndex !== currentHighlightedWordIndex) {
          setCurrentHighlightedWordIndex(currentWordIndex);
        }


        // Determine which lines to display (current, previous, next)
        const linesToDisplayIndices: number[] = [];
        if (currentLineIndex !== -1) {
          // Display the current line and one line before and after it if available
          const startIndex = globalThis.Math.max(0, currentLineIndex - globalThis.Math.floor(visibleLines / 2));
          const endIndex = globalThis.Math.min(audiobookLinesWithTiming.length - 1, startIndex + visibleLines - 1);
          for (let i = startIndex; i <= endIndex; i++) {
            linesToDisplayIndices.push(i);
          }
          // Adjust if we're near the end to ensure `visibleLines` are always shown if possible
          while (linesToDisplayIndices.length < visibleLines && linesToDisplayIndices[0] > 0) {
            linesToDisplayIndices.unshift(linesToDisplayIndices[0] - 1);
          }
          while (linesToDisplayIndices.length < visibleLines && linesToDisplayIndices[linesToDisplayIndices.length - 1] < audiobookLinesWithTiming.length - 1) {
            linesToDisplayIndices.push(linesToDisplayIndices[linesToDisplayIndices.length - 1] + 1);
          }
        }
        
        // Calculate vertical position for the first displayed line
        const startY = letterboxY + textPaddingY + lineHeight / 2;

        linesToDisplayIndices.forEach((lineIdx, displayOrder) => {
            const line = audiobookLinesWithTiming[lineIdx];
            const displayY = startY + displayOrder * lineHeight;
            
            const isCurrentLine = lineIdx === currentLineIndex;

            context.save();
            context.globalAlpha = isCurrentLine ? 1.0 : 0.6; // Current line is full alpha, others faded

            // Draw line by word for karaoke effect
            let currentWordDrawX = WIDTH / 2;
            const lineWordsJoined = line.words.map(w => w.word).join('');
            const lineTextWidth = context.measureText(lineWordsJoined).width + (line.words.length -1) * context.measureText(' ').width;
            currentWordDrawX = (WIDTH - lineTextWidth) / 2;

            for (let j = 0; j < line.words.length; j++) {
                const word = line.words[j];
                const wordText = word.word + (j < line.words.length - 1 && !/\s+/.test(line.words[j+1].word) ? ' ' : '');

                const wordMeasurement = context.measureText(wordText);
                const wordWidth = wordMeasurement.width;

                context.save();
                if (isCurrentLine && j === currentWordIndex) {
                    context.fillStyle = '#FACC15'; // Highlighted color (yellow)
                    const timeInWord = currentTime - (line.relativeStartTime + word.startTime);
                    const wordProgress = globalThis.Math.min(1, globalThis.Math.max(0, timeInWord / (word.endTime - word.startTime)));
                    
                    context.globalAlpha *= (0.2 + 0.8 * wordProgress); 
                    context.fillText(wordText, currentWordDrawX + wordWidth / 2, displayY);
                } else if (isCurrentLine && j < currentWordIndex) {
                    context.fillStyle = '#FFFFFF'; // Already spoken words in current line (white)
                    context.fillText(wordText, currentWordDrawX + wordWidth / 2, displayY);
                } else {
                    context.fillStyle = '#BBBBBB'; // Future words or words in other lines (light gray)
                    context.fillText(wordText, currentWordDrawX + wordWidth / 2, displayY);
                }
                context.restore();
                currentWordDrawX += wordWidth;
            }
            context.restore();
        });
        context.restore();
      }
    };


    // Helper function to draw image with cover style and optional scale
    const drawImageTransform = (ctx: CanvasRenderingContext2D, img: HTMLImageElement, canvasWidth: number, canvasHeight: number, scale: number = 1.0) => {
      const imgAspectRatio = img.width / img.height;
      const canvasAspectRatio = canvasWidth / canvasHeight;

      let drawWidth = canvasWidth;
      let drawHeight = canvasHeight;
      let offsetX = 0;
      let offsetY = 0;

      if (imgAspectRatio > canvasAspectRatio) {
          drawHeight = canvasHeight;
          drawWidth = imgAspectRatio * canvasHeight;
          offsetX = (canvasWidth - drawWidth) / 2;
      } else {
          drawWidth = canvasWidth;
          drawHeight = canvasWidth / imgAspectRatio;
          offsetY = (canvasHeight - drawHeight) / 2;
      }

      ctx.save();
      // Translate to center, scale, then translate back
      ctx.translate(canvasWidth / 2, canvasHeight / 2);
      ctx.scale(scale, scale);
      ctx.drawImage(img, offsetX - canvasWidth / 2, offsetY - canvasHeight / 2, drawWidth, drawHeight);
      ctx.restore();
    };


    if (animationFrameIdRef.current === null) {
      animate();
    }
  }, [isPlayingVideo, isAudiobookPlaying, audiobookSceneImageUrls, currentAudiobookSceneIndex, selectedVideoResolution, audiobookLinesWithTiming, currentHighlightedLineIndex, currentHighlightedWordIndex, isDynamicBackgroundEnabled, isParticleEffectEnabled, isSineWaveEffectEnabled, isKaraokeEffectEnabled, isTintEffectEnabled]);

  useEffect(() => {
    const isAnyVisualActive = isLiveSessionActive || isPlayingVideo || isAudiobookPlaying || isPlayingBackgroundMusic;
    const shouldVisualize = isAnyVisualActive && !isLoading;

    if (shouldVisualize && analyserRef.current && audioContextRef.current?.state === 'running') {
      drawMainVisualizer();
    } else {
      if (animationFrameIdRef.current) {
        globalThis.cancelAnimationFrame(animationFrameIdRef.current);
        animationFrameIdRef.current = null;
        const canvas = mainVisualizerCanvasRef.current;
        if (canvas) {
          const canvasCtx = canvas.getContext('2d');
          if (canvasCtx) {
            canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
            canvasCtx.fillStyle = '#1F2937';
            // FIX: Use canvasCtx instead of out-of-scope 'context'
            canvasCtx.fillRect(0, 0, canvas.width, canvas.height); 
          }
        }
      }
    }
  }, [isLiveSessionActive, isPlayingVideo, isAudiobookPlaying, isPlayingBackgroundMusic, isLoading, drawMainVisualizer]);

  // FIX: useEffect to handle lamejs loading detection
  useEffect(() => {
    let intervalId: number | undefined;
    if (!isLamejsLoaded) {
      intervalId = globalThis.setInterval(() => {
        if (typeof globalThis.Lame !== 'undefined') {
          console.log("lamejs successfully loaded!");
          setIsLamejsLoaded(true);
          if (intervalId) globalThis.clearInterval(intervalId);
        }
      }, 500); // Check every 500ms
    }

    return () => {
      if (intervalId) globalThis.clearInterval(intervalId);
    };
  }, [isLamejsLoaded]);


  useEffect(() => {
    // Save conversation history to localStorage every 60 seconds if session is active
    let saveInterval: number | undefined;
    if (isLiveSessionActive) {
      saveInterval = globalThis.setInterval(() => {
        try {
          globalThis.localStorage.setItem('liveConversationHistory', JSON.stringify(conversationHistoryRef.current));
          console.log("Conversation history automatically saved.");
        } catch (e) {
          console.error("Nem sikerült automatikusan menteni a beszélgetési előzményeket a localStorage-ba", e);
        }
      }, 60000); // Save every 60 seconds
    }

    return () => {
      if (saveInterval) {
        globalThis.clearInterval(saveInterval);
      }
    };
  }, [isLiveSessionActive]);

  // Update conversationHistoryRef whenever conversationHistory state changes
  useEffect(() => {
    conversationHistoryRef.current = conversationHistory;
  }, [conversationHistory]);


  useEffect(() => {
    return () => {
      stopAllAudioSources();
      stopRecordingVideo();

      if (liveSessionPromiseRef.current) {
        liveSessionPromiseRef.current.then(session => {
          if (session) {
            session.close();
          }
        }).catch(err => console.error("Hiba az élő munkamenet bezárásakor kilépéskor:", err));
        liveSessionPromiseRef.current = null;
      }
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
      if (animationFrameIdRef.current) {
        globalThis.cancelAnimationFrame(animationFrameIdRef.current);
      }
      if (youTubeProgressIntervalRef.current) {
        globalThis.clearInterval(youTubeProgressIntervalRef.current);
      }
      if (videoUrl) {
        globalThis.URL.revokeObjectURL(videoUrl);
      }
      audiobookSceneImageUrls.filter(url => url.startsWith('blob:') || url.startsWith('https://picsum.photos')).forEach(url => globalThis.URL.revokeObjectURL(url));
      
      // Clean up YouTube player if it exists
      youTubePlayerRef.current?.destroy();
    };
  }, [stopAllAudioSources, stopRecordingVideo, videoUrl, audiobookSceneImageUrls]);

  const formatDuration = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds < 10 ? '0' : ''}${remainingSeconds}`;
  };


  return (
    <div className="flex flex-col md:flex-row w-full h-full bg-gradient-to-br from-gray-900 to-gray-800 rounded-xl shadow-2xl text-gray-100">
      {/* Left Column - Audiobook Creator & Video Visualizer */}
      <div className="flex-1 flex flex-col p-4 md:p-6 border-b md:border-b-0 md:border-r border-gray-700 md:w-[60%] overflow-y-auto h-full">
        <div className="mb-6 pb-4 bg-gray-800 rounded-xl shadow-lg p-4">
          <h1 className="text-2xl font-extrabold text-gray-100 mb-4">Hangoskönyv Készítő</h1>
          
          <div className="mb-4">
            <label htmlFor="tts-voice-select" className="block text-sm font-medium text-gray-300 mb-2">
              Hang kiválasztása:
            </label>
            <div className="flex flex-wrap gap-2">
              {TTS_VOICES.map((voice) => (
                <div 
                  key={voice.value} 
                  className={`flex items-center bg-gray-700 rounded-lg pr-2 border border-gray-600 transition-all duration-200 hover:scale-[1.02] active:scale-100 cursor-pointer 
                              ${selectedVoice === voice.value ? 'ring-2 ring-blue-500 shadow-lg scale-105' : ''}`}
                  onClick={() => handlePreviewVoice(voice.value)}
                >
                  <span className="text-sm px-3 py-1 text-gray-100">{voice.name}</span>
                  <input
                    type="radio"
                    id={`voice-${voice.value}`}
                    name="ttsVoice"
                    value={voice.value}
                    checked={selectedVoice === voice.value}
                    onChange={() => setSelectedVoice(voice.value)}
                    className="hidden"
                    disabled={isLoading || isAudiobookGenerating || isAudiobookPlaying}
                  />
                  <label htmlFor={`voice-${voice.value}`} className="cursor-pointer">
                  <Button
                    disabled={isLoading || isAudiobookGenerating || isAudiobookPlaying}
                    variant="secondary"
                    className="px-2 py-1 text-xs opacity-0 pointer-events-none absolute"
                  >
                    Minta
                  </Button>
                  </label>
                </div>
              ))}
            </div>
          </div>

          <details className="mb-4 p-3 bg-gray-700 rounded-lg border border-gray-600 shadow-md" open>
            <summary className="text-gray-200 font-semibold cursor-pointer text-base">
              Jelenet beállítások (vizualizáció)
            </summary>
            <div className="mt-3 space-y-4">
              <div>
                <label htmlFor="audiobook-scenes" className="block text-sm font-medium text-gray-300 mb-2">
                  Jelenetképek feltöltése (storyboardhoz):
                </label>
                <input
                  type="file"
                  id="audiobook-scenes"
                  accept="image/*"
                  multiple
                  onChange={handleAudiobookSceneImagesChange}
                  className="block w-full text-sm text-gray-100
                            file:mr-3 file:py-1.5 file:px-3
                            file:rounded-full file:border-0
                            file:text-sm file:font-semibold
                            file:bg-blue-900 file:text-blue-200
                            hover:file:bg-blue-800 cursor-pointer"
                  disabled={isLoading || isAudiobookGenerating || isGeneratingImages}
                />
                {audiobookSceneImageUrls.length > 0 && (
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-xs text-gray-400">{audiobookSceneImageUrls.length} kép(ek) betöltve.</span>
                    <Button onClick={handleClearAudiobookScenes} variant="secondary" className="px-2 py-1 text-xs" disabled={isLoading || isAudiobookGenerating || isGeneratingImages}>
                      Jelenetek törlése
                    </Button>
                  </div>
                )}
              </div>

              <details className="p-3 bg-gray-600 rounded-lg border border-gray-500 shadow-sm">
                <summary className="text-gray-200 font-semibold cursor-pointer text-sm">
                  Képgenerátor (szimulált - freemium)
                </summary>
                <div className="mt-3 text-sm">
                  <p className="text-gray-400 mb-2">
                    {FREEMIUM_IMAGE_GENERATOR_CONFIG.INFO_MESSAGE}
                  </p>
                  <Button
                    onClick={handleGenerateImagesFromText}
                    disabled={isLoading || isAudiobookGenerating || isGeneratingImages || !textInput.trim()}
                    fullWidth
                    className="flex items-center justify-center text-sm py-2"
                  >
                    {isGeneratingImages ? (
                      <>
                        <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Generálás...
                      </>
                    ) : 'Képek generálása szövegből'}
                  </Button>
                </div>
              </details>
            </div>
          </details>

          <textarea
            className="w-full p-3 border border-gray-600 rounded-lg bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500 mb-4 shadow-sm resize-y min-h-[120px]"
            placeholder="Írja be ide a hangoskönyv szövegét..."
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            rows={5}
            disabled={isLoading || isAudiobookGenerating}
          ></textarea>
          {textInput.length > MAX_TTS_TEXT_LENGTH_CHARS && (
            <p className="text-xs text-red-300 mt-[-10px] mb-2">
              A szöveg túl hosszú ({textInput.length} karakter). A maximális engedélyezett hossz ${MAX_TTS_TEXT_LENGTH_CHARS} karakter. Kérjük, rövidítse a szöveget.
            </p>
          )}

          <div className="flex flex-col sm:flex-row gap-3 mb-4">
            <Button
              onClick={handleReadAloud}
              disabled={isLoading || isAudiobookGenerating || (!isAudiobookPlaybackPaused && !textInput.trim()) || textInput.length > MAX_TTS_TEXT_LENGTH_CHARS}
              fullWidth
              className="flex items-center justify-center text-sm"
            >
              {isAudiobookGenerating ? (
                <>
                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Generálás...
                </>
              ) : isAudiobookPlaying ? (
                <>
                  <svg className="h-4 w-4 mr-2" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd"></path></svg>
                  Szünet
                </>
              ) : isAudiobookPlaybackPaused ? (
                <>
                  <svg className="h-4 w-4 mr-2" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd"></path></svg>
                  Folytatás
                </>
              ) : 'Felolvasás'}
            </Button>
            <Button
              onClick={handleDownloadMp3}
              disabled={isLoading || isAudiobookGenerating || audiobookPcmBuffersRef.current.length === 0 || !isLamejsLoaded}
              variant="secondary"
              fullWidth
              className="flex items-center justify-center text-sm"
            >
              MP3 letöltése
            </Button>
          </div>
          <Button onClick={handleClearText} variant="danger" fullWidth disabled={isLoading || isAudiobookGenerating} className="text-sm">
            Szöveg & Hang törlése
          </Button>
        </div>

        {/* Video Visualizer & Export Section */}
        <div className="flex-1 pt-4 bg-gray-800 rounded-xl shadow-lg p-4 mt-6 md:mt-0">
          <h2 className="text-2xl font-extrabold text-gray-100 mb-4">Videó Visualizer & Export</h2>
          <p className="text-gray-300 text-sm mb-3">Töltsön fel videót vagy használja a hangoskönyv vizualizációt. Rögzítse és töltse le a vizualizált videót.</p>

          <input
            type="file"
            accept="video/*"
            onChange={handleVideoFileChange}
            className="block w-full text-sm text-gray-100
                       file:mr-3 file:py-1.5 file:px-3
                       file:rounded-full file:border-0
                       file:text-sm file:font-semibold
                       file:bg-blue-900 file:text-blue-200
                       hover:file:bg-blue-800 cursor-pointer"
            disabled={isLoading || isRecordingVideo}
          />
          
          {/* Video Export Settings */}
          <div className="flex flex-col sm:flex-row gap-3 mb-3">
            <div className="flex-1">
              <label htmlFor="video-resolution-select" className="block text-sm font-medium text-gray-300 mb-1">
                Felbontás:
              </label>
              <select
                id="video-resolution-select"
                className="w-full p-2 border border-gray-600 rounded-lg bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500 shadow-sm text-sm"
                value={selectedVideoResolution}
                onChange={(e) => setSelectedVideoResolution(e.target.value)}
                disabled={isLoading || isRecordingVideo}
              >
                {VIDEO_RESOLUTIONS.map((res) => (
                  <option key={res.value} value={res.value}>
                    {res.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label htmlFor="video-codec-select" className="block text-sm font-medium text-gray-300 mb-1">
                Kodek:
              </label>
              <select
                id="video-codec-select"
                className="w-full p-2 border border-gray-600 rounded-lg bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500 shadow-sm text-sm"
                value={selectedVideoCodec}
                onChange={(e) => setSelectedVideoCodec(e.target.value)}
                disabled={isLoading || isRecordingVideo}
              >
                {VIDEO_CODECS.map((codec) => (
                  <option key={codec.value} value={codec.value}>
                    {codec.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {/* Video Bitrate selection */}
          <div className="mb-3">
            <label htmlFor="video-bitrate-select" className="block text-sm font-medium text-gray-300 mb-1">
              Videó bitráta:
            </label>
            <select
              id="video-bitrate-select"
              className="w-full p-2 border border-gray-600 rounded-lg bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500 shadow-sm text-sm"
              value={selectedVideoBitrate}
              onChange={(e) => setSelectedVideoBitrate(e.target.value)}
              disabled={isLoading || isRecordingVideo}
            >
              {VIDEO_BITRATES.map((bitrate) => ( // FIX: Use VIDEO_BITRATES constant
                <option key={bitrate.value} value={bitrate.value}>
                  {bitrate.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-400 mt-1">Magasabb bitráta = jobb minőség, nagyobb fájlméret.</p>
          </div>

          {selectedVideoCodec === 'mp4_h264' && (
            <p className="text-xs text-red-300 mb-3">
              Figyelem: Az MP4 (H.264) kodek támogatása a böngészőkben inkonzisztens lehet. A WebM ajánlott a megbízhatóbb felvételhez.
            </p>
          )}

          <div ref={mainCanvasContainerRef} className="relative w-full aspect-video bg-black rounded-lg mb-3 overflow-hidden shadow-xl">
            {videoUrl && (
              <video
                ref={videoElementRef}
                src={videoUrl}
                loop
                muted // Mute for direct playback in UI, actual audio comes from AudioContext
                onEnded={handleVideoEnded}
                className="absolute top-0 left-0 w-full h-full object-contain"
                style={{ zIndex: 0 }}
              ></video>
            )}
            <canvas ref={mainVisualizerCanvasRef} className="absolute top-0 left-0 w-full h-full" style={{ zIndex: 1 }}></canvas>
            {!isPlayingVideo && !isAudiobookPlaying && <div className="absolute inset-0 flex items-center justify-center text-white text-base bg-black bg-opacity-50 z-20">Kezdőképernyő / Videó szüneteltetve</div>}
          </div>

          <div className="flex gap-3 mb-3">
            <Button
              onClick={handlePlayPauseVideo}
              disabled={!videoUrl || isLoading || isRecordingVideo || isAudiobookPlaying}
              fullWidth
              className="text-sm"
            >
              {isPlayingVideo ? 'Videó szüneteltetése' : 'Videó lejátszása'}
            </Button>
            <Button
              onClick={handleFullscreenToggle}
              disabled={isLoading}
              variant="secondary"
              fullWidth
              className="text-sm"
            >
              Teljes képernyő
            </Button>
          </div>
          <Button
              onClick={isRecordingVideo ? stopRecordingVideo : startRecordingVideo}
              disabled={isLoading || (!isPlayingVideo && !isAudiobookPlaying && !isRecordingVideo)}
              variant={isRecordingVideo ? 'danger' : 'primary'}
              fullWidth
              className="text-sm"
            >
              {isRecordingVideo ? (
                <>
                  <svg className="animate-pulse h-4 w-4 mr-2" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="8"></circle></svg>
                  Felvétel leállítása
                </>
              ) : 'Felvétel indítása & Export'}
            </Button>
        </div>
      </div>


      {/* Right Column - Live Conversational AI Section */}
      <div className="flex-1 p-4 md:p-6 flex flex-col bg-gray-800 md:w-[40%] overflow-y-auto h-full">
        <h2 className="text-2xl font-extrabold text-gray-100 mb-4">Élő Beszélgetés</h2>
        <p className="text-gray-300 text-sm mb-4">Valós idejű hangos beszélgetés Gemini AI-val.</p>

        {/* Background Music Section */}
        <details className="mb-4 p-3 bg-gray-700 rounded-lg border border-gray-600 shadow-md">
          <summary className="text-gray-200 font-semibold cursor-pointer text-base">
            Háttérzene beállítások
          </summary>
          <div className="mt-3 space-y-4 text-sm">
            <div>
              <label htmlFor="background-music-file" className="block text-sm font-medium text-gray-300 mb-2">
                Háttérzene feltöltése:
              </label>
              <input
                type="file"
                id="background-music-file"
                accept="audio/*"
                onChange={handleBackgroundMusicFileChange}
                className="block w-full text-sm text-gray-100
                          file:mr-3 file:py-1.5 file:px-3
                          file:rounded-full file:border-0
                          file:text-sm file:font-semibold
                          file:bg-blue-900 file:text-blue-200
                          hover:file:bg-blue-800 cursor-pointer"
                disabled={isLoading}
              />
            </div>
            
            {/* YouTube Audio Input (Experimental) */}
            <div className="bg-gray-600 p-3 rounded-lg border border-gray-500 shadow-sm">
              <label htmlFor="youtube-url" className="block text-sm font-medium text-gray-300 mb-2">
                YouTube URL beillesztése (kísérleti):
              </label>
              <input
                type="text"
                id="youtube-url"
                value={youTubeUrlInput}
                onChange={(e) => setYouTubeUrlInput(e.target.value)}
                placeholder="Pl: https://www.youtube.com/watch?v=..."
                className="w-full p-2 border border-gray-500 rounded-lg bg-gray-600 text-gray-100 focus:ring-blue-500 focus:border-blue-500 shadow-sm"
                disabled={isLoading}
              />
              <Button
                onClick={handleLoadAudioFromYouTube}
                disabled={isLoading || !youTubeUrlInput.trim()}
                fullWidth
                className="mt-2 text-sm"
              >
                Betöltés YouTube-ról
              </Button>
              <p className="text-xs text-red-300 mt-1">
                Figyelem: A YouTube audiója a böngésző korlátozásai miatt NEM lesz része a vizualizációnak és a felvételnek.
              </p>
              {youTubeVideoId && (
                <div className="mt-3 flex items-center justify-between">
                  <div id="youtube-player" className="hidden"></div> {/* Hidden player */}
                  <div className="flex-1 flex items-center gap-2">
                    <Button onClick={handlePlayPauseYouTube} disabled={!youTubePlayerReady || isLoading} className="text-sm">
                      {isPlayingBackgroundMusic ? 
                        <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd"></path></svg>
                        : 
                        <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd"></path></svg>
                      }
                    </Button>
                    <span className="text-xs text-gray-400">{formatDuration(youTubeCurrentTime)} / {formatDuration(youTubeDuration)}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max={youTubeDuration}
                    step="1"
                    value={youTubeCurrentTime}
                    onChange={handleSeekYouTube}
                    className="flex-1 h-2 bg-gray-500 rounded-lg appearance-none cursor-pointer range-sm accent-red-500 mx-2"
                    disabled={!youTubePlayerReady || isLoading}
                  />
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              <Button
                onClick={handlePlayPauseBackgroundMusic}
                disabled={!backgroundMusicUrl && !youTubePlayerRef.current || isLoading}
                className="flex-shrink-0 text-sm"
              >
                {isPlayingBackgroundMusic ? (
                  <>
                    <svg className="h-4 w-4 mr-2" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd"></path></svg>
                    Zene szüneteltetése
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4 mr-2" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd"></path></svg>
                    Zene lejátszása
                  </>
                )}
              </Button>
              <div className="flex-1 flex items-center">
                <label htmlFor="music-volume" className="mr-2 text-sm font-medium text-gray-300 flex-shrink-0">Hangerő:</label>
                <input
                  type="range"
                  id="music-volume"
                  min="0"
                  max="1"
                  step="0.05"
                  value={backgroundMusicVolume}
                  onChange={handleBackgroundMusicVolumeChange}
                  className="w-full h-2 bg-gray-600 rounded-lg appearance-none cursor-pointer range-sm accent-blue-500"
                  disabled={!backgroundMusicUrl && !youTubePlayerRef.current || isLoading}
                />
              </div>
            </div>
          </div>
        </details>


        {/* Transcription Toggle */}
        <div className="flex items-center justify-between mb-4 mt-2 p-3 bg-gray-700 rounded-lg border border-gray-600 shadow-md">
          <label htmlFor="transcription-toggle" className="text-gray-300 text-sm font-medium cursor-pointer">
            Átírás engedélyezése
          </label>
          <div className="relative inline-block w-10 mr-2 align-middle select-none transition duration-200 ease-in">
            <input
              type="checkbox"
              name="toggle"
              id="transcription-toggle"
              className="toggle-checkbox absolute block w-5 h-5 rounded-full bg-white border-4 appearance-none cursor-pointer"
              checked={isTranscriptionEnabled}
              onChange={(e) => setIsTranscriptionEnabled(e.target.checked)}
              disabled={isLiveSessionActive || isLoading}
            />
            <label htmlFor="transcription-toggle" className="toggle-label block overflow-hidden h-5 rounded-full bg-gray-600 cursor-pointer"></label>
          </div>
          <style>{`
            .toggle-checkbox {
                left: 0;
                transition: left 0.2s ease-in-out, background-color 0.2s ease-in-out, border-color 0.2s ease-in-out;
            }
            .toggle-checkbox:checked {
              right: 0;
              left: auto;
              border-color: #3B82F6;
            }
            .toggle-checkbox:checked + .toggle-label {
              background-color: #3B82F6;
            }
          `}</style>
        </div>

        {/* Visualizer Effects Toggles */}
        <details className="mb-4 p-3 bg-gray-700 rounded-lg border border-gray-600 shadow-md" open>
          <summary className="text-gray-200 font-semibold cursor-pointer text-base">
            Vizualizációs effektek
          </summary>
          <div className="mt-3 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <label htmlFor="dynamic-background-toggle" className="text-gray-300 font-medium cursor-pointer">
                Dinamikus háttér
              </label>
              <input
                type="checkbox"
                id="dynamic-background-toggle"
                className="toggle-checkbox absolute block w-5 h-5 rounded-full bg-white border-4 appearance-none cursor-pointer"
                checked={isDynamicBackgroundEnabled}
                onChange={(e) => setIsDynamicBackgroundEnabled(e.target.checked)}
              />
              <label htmlFor="dynamic-background-toggle" className="toggle-label block overflow-hidden h-5 rounded-full bg-gray-600 cursor-pointer"></label>
            </div>
            <div className="flex items-center justify-between">
              <label htmlFor="particle-effect-toggle" className="text-gray-300 font-medium cursor-pointer">
                Részecske effekt
              </label>
              <input
                type="checkbox"
                id="particle-effect-toggle"
                className="toggle-checkbox absolute block w-5 h-5 rounded-full bg-white border-4 appearance-none cursor-pointer"
                checked={isParticleEffectEnabled}
                onChange={(e) => setIsParticleEffectEnabled(e.target.checked)}
              />
              <label htmlFor="particle-effect-toggle" className="toggle-label block overflow-hidden h-5 rounded-full bg-gray-600 cursor-pointer"></label>
            </div>
            <div className="flex items-center justify-between">
              <label htmlFor="sine-wave-effect-toggle" className="text-gray-300 font-medium cursor-pointer">
                Szinusz hullám effekt
              </label>
              <input
                type="checkbox"
                id="sine-wave-effect-toggle"
                className="toggle-checkbox absolute block w-5 h-5 rounded-full bg-white border-4 appearance-none cursor-pointer"
                checked={isSineWaveEffectEnabled}
                onChange={(e) => setIsSineWaveEffectEnabled(e.target.checked)}
              />
              <label htmlFor="sine-wave-effect-toggle" className="toggle-label block overflow-hidden h-5 rounded-full bg-gray-600 cursor-pointer"></label>
            </div>
            <div className="flex items-center justify-between">
              <label htmlFor="tint-effect-toggle" className="text-gray-300 font-medium cursor-pointer">
                Színező effekt (videó/képek)
              </label>
              <input
                type="checkbox"
                id="tint-effect-toggle"
                className="toggle-checkbox absolute block w-5 h-5 rounded-full bg-white border-4 appearance-none cursor-pointer"
                checked={isTintEffectEnabled}
                onChange={(e) => setIsTintEffectEnabled(e.target.checked)}
              />
              <label htmlFor="tint-effect-toggle" className="toggle-label block overflow-hidden h-5 rounded-full bg-gray-600 cursor-pointer"></label>
            </div>
            <div className="flex items-center justify-between">
              <label htmlFor="karaoke-effect-toggle" className="text-gray-300 font-medium cursor-pointer">
                Karaoke felirat
              </label>
              <input
                type="checkbox"
                id="karaoke-effect-toggle"
                className="toggle-checkbox absolute block w-5 h-5 rounded-full bg-white border-4 appearance-none cursor-pointer"
                checked={isKaraokeEffectEnabled}
                onChange={(e) => setIsKaraokeEffectEnabled(e.target.checked)}
              />
              <label htmlFor="karaoke-effect-toggle" className="toggle-label block overflow-hidden h-5 rounded-full bg-gray-600 cursor-pointer"></label>
            </div>
          </div>
        </details>



        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <Button
            onClick={isLiveSessionActive ? stopLiveConversation : startLiveConversation}
            disabled={isLoading || isAudiobookGenerating || isPlayingVideo || isRecordingVideo}
            fullWidth
            className="flex items-center justify-center text-sm"
          >
            {isLoading && !isLiveSessionActive ? (
              <>
                <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                Csatlakozás...
              </>
            ) : isLiveSessionActive ? (
              <>
                <svg className="h-4 w-4 mr-2" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd"></path></svg>
                Beszélgetés leállítása
              </>
            ) : (
              <>
                <svg className="h-4 w-4 mr-2" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd"></path></svg>
                Beszélgetés indítása
              </>
            )}
          </Button>
        </div>

        {error && (
          <div className="bg-red-900 border border-red-700 text-red-300 px-3 py-2 rounded-lg relative mb-3 text-sm" role="alert">
            <strong className="font-bold">Hiba:</strong>
            <span className="block sm:inline ml-2">{error}</span>
          </div>
        )}

        {statusMessage && (
          <div className="bg-blue-900 border border-blue-700 text-blue-300 px-3 py-2 rounded-lg relative mb-3 text-sm" role="alert">
            <span className="block sm:inline">{statusMessage}</span>
          </div>
        )}

        {isLiveSessionActive && (
          <>
            <div className="flex-1 bg-gray-700 p-3 rounded-lg shadow-inner overflow-y-auto mb-3 border border-gray-600">
              <h3 className="text-base font-semibold text-gray-100 mb-3">Beszélgetési napló</h3>
              <div className="space-y-3 text-sm"> 
                {isTranscriptionEnabled ? (
                  <>
                    {conversationHistory.map((msg, index) => (
                      <div
                        key={index}
                        className={`flex items-start gap-2 ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
                      >
                        {msg.sender === 'model' && <AIAvatar />}
                        <div
                          className={`max-w-[80%] p-2 rounded-lg shadow-sm ${
                            msg.sender === 'user'
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-600 text-gray-100'
                          }`}
                        >
                          {msg.text}
                        </div>
                        {msg.sender === 'user' && <UserAvatar />}
                      </div>
                    ))}
                    {currentTranscription.user && (
                      <div className="flex items-start gap-2 justify-end">
                        <div className="max-w-[80%] p-2 rounded-lg shadow-sm bg-blue-900 text-blue-300 italic">
                          {currentTranscription.user}
                        </div>
                        <UserAvatar />
                      </div>
                    )}
                    {currentTranscription.model && (
                      <div className="flex items-start gap-2 justify-start">
                        <AIAvatar />
                        <div className="max-w-[80%] p-2 rounded-lg shadow-sm bg-gray-800 text-gray-400 italic">
                          {currentTranscription.model}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-center text-gray-400 italic p-3">
                    Az átírás ki van kapcsolva. Kapcsolja be a beszélgetési napló megtekintéséhez.
                  </div>
                )}
              </div>
            </div>

            {/* Live Conversation Text Input */}
            <div className="flex gap-3 mb-3">
              <textarea
                className="flex-1 p-2 border border-gray-600 rounded-lg bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500 shadow-sm resize-none h-auto min-h-[40px] max-h-[80px] text-sm"
                placeholder="Írja be üzenetét ide..."
                value={liveTextInput}
                onChange={(e) => setLiveTextInput(e.target.value)}
                rows={1}
                disabled={isLoading || !isLiveSessionActive}
              ></textarea>
              <Button
                onClick={handleSendLiveText}
                disabled={isLoading || !isLiveSessionActive || !liveTextInput.trim()}
                className="text-sm"
              >
                Küldés
              </Button>
            </div>

            <Button
              onClick={handleClearConversationHistory}
              variant="secondary"
              fullWidth
              disabled={conversationHistory.length === 0 || isLoading || !isTranscriptionEnabled}
              className="text-sm"
            >
              Beszélgetési előzmények törlése
            </Button>
          </>
        )}
      </div>
    </div>
  );
};

export default App;