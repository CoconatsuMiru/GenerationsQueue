// Simple wrapper around the browser's built-in text-to-speech engine.
// No API key or network call needed — SpeechSynthesis runs locally in the browser.

let voicesLoaded = false;

function ensureVoicesLoaded() {
  if (voicesLoaded) return;
  window.speechSynthesis.getVoices();
  voicesLoaded = true;
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
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    window.speechSynthesis.speak(utterance);
  });
}

export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}