// Simple wrapper around the browser's built-in text-to-speech engine.
// No API key or network call needed — SpeechSynthesis runs locally in the browser.

let voicesLoaded = false;

function ensureVoicesLoaded() {
  if (voicesLoaded) return;
  window.speechSynthesis.getVoices();
  voicesLoaded = true;
}

const VOICE_STORAGE_KEY = 'pickleQueueVoiceURI';

// The chosen voice is a per-device/browser preference (available voices
// differ by device), so it's stored in localStorage rather than synced
// through Supabase — a voice picked on one device might not even exist
// on another.
export function getSavedVoiceURI(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(VOICE_STORAGE_KEY) ?? '';
}

export function setSavedVoiceURI(voiceURI: string) {
  if (typeof window === 'undefined') return;
  if (voiceURI === '') {
    window.localStorage.removeItem(VOICE_STORAGE_KEY);
  } else {
    window.localStorage.setItem(VOICE_STORAGE_KEY, voiceURI);
  }
}

// Keeps only English voices (lang codes starting with "en", e.g. "en-US",
// "en-GB", "en-AU") — the venue only needs English announcements, so
// filtering here keeps the dropdown short instead of listing every
// language the device happens to have installed.
function filterEnglishVoices(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  return voices.filter((voice) => voice.lang.toLowerCase().startsWith('en'));
}

// Voices often load asynchronously in the browser — the very first call
// can return an empty list even though voices are on their way. This
// waits for the browser's "voiceschanged" signal if nothing is ready yet.
export function getAvailableVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      resolve([]);
      return;
    }

    const existing = window.speechSynthesis.getVoices();
    if (existing.length > 0) {
      resolve(filterEnglishVoices(existing));
      return;
    }

    window.speechSynthesis.onvoiceschanged = () => {
      resolve(filterEnglishVoices(window.speechSynthesis.getVoices()));
    };
  });
}

// Returns a promise that resolves once the browser has finished speaking
// this utterance — lets callers wait for one announcement to fully finish
// before starting the next one.
export function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      resolve();
      return;
    }

    ensureVoicesLoaded();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.pitch = 1;

    const savedVoiceURI = getSavedVoiceURI();
    if (savedVoiceURI) {
      const match = window.speechSynthesis
        .getVoices()
        .find((v) => v.voiceURI === savedVoiceURI);
      if (match) utterance.voice = match;
    }

    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    window.speechSynthesis.speak(utterance);
  });
}

let primed = false;

// iOS Safari only allows the speech engine to start if the very first
// speak() call on the page happens inside a genuine user tap. Our
// announcements fire automatically from app logic (a court filling up,
// overtime hitting), not from a tap, so without this the very first
// announcement could be silently dropped on iPad/iPhone. Calling this once
// on page load arms a one-time listener that "unlocks" the speech engine
// off whatever the user taps first (adding a player, tapping a button,
// anything), before any real announcement needs to play.
export function primeSpeechOnFirstInteraction() {
  if (primed || typeof window === 'undefined' || !window.speechSynthesis) return;

  function unlock() {
    if (primed) return;
    primed = true;

    const utterance = new SpeechSynthesisUtterance(' ');
    utterance.volume = 0;
    window.speechSynthesis.speak(utterance);

    document.removeEventListener('touchstart', unlock);
    document.removeEventListener('click', unlock);
  }

  document.addEventListener('touchstart', unlock, { once: true });
  document.addEventListener('click', unlock, { once: true });
}

export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}