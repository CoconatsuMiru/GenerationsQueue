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