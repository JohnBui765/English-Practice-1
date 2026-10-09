// Text-to-speech using the device's built-in English voices (offline on iOS).
// speak() is synchronous on purpose: iOS only allows speech that starts inside
// a tap handler, so we must not await anything before calling it.

export const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

let cachedVoices = [];

function loadVoices() {
  if (!supported) return [];
  const all = window.speechSynthesis.getVoices() || [];
  cachedVoices = all.filter((v) => /^en([-_]|$)/i.test(v.lang));
  return cachedVoices;
}

// Resolves with English voices once the browser has loaded them (≤ 1.5 s).
export function englishVoices() {
  if (!supported) return Promise.resolve([]);
  const now = loadVoices();
  if (now.length) return Promise.resolve(sortVoices(now));
  return new Promise((resolve) => {
    const done = () => resolve(sortVoices(loadVoices()));
    window.speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

const PREFERRED = ['Samantha', 'Daniel', 'Karen', 'Moira', 'Serena', 'Arthur', 'Ava', 'Allison', 'Tom', 'Alex', 'Google US English', 'Google UK English'];

function score(v) {
  let s = 0;
  if (/enhanced|premium|neural|natural/i.test(v.name)) s += 40;
  const pref = PREFERRED.findIndex((n) => v.name.startsWith(n));
  if (pref >= 0) s += 30 - pref;
  if (/en[-_]US/i.test(v.lang)) s += 8;
  else if (/en[-_]GB/i.test(v.lang)) s += 6;
  if (v.localService) s += 5;
  if (/eloquence|bad news|bells|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|albert|bahh|boing|fred|junior|ralph|kathy|grandma|grandpa|rocko|shelley|sandy|flo|eddy|reed/i.test(v.name)) s -= 100;
  return s;
}

function sortVoices(voices) {
  return voices.slice().sort((a, b) => score(b) - score(a));
}

function pickVoice(voiceURI) {
  const voices = cachedVoices.length ? cachedVoices : loadVoices();
  if (voiceURI) {
    const exact = voices.find((v) => v.voiceURI === voiceURI);
    if (exact) return exact;
  }
  return sortVoices(voices)[0] || null;
}

export function speak(text, { rate = 0.9, voiceURI = '', lang = 'en-US', onEnd } = {}) {
  if (!supported) return false;
  const clean = String(text || '').replace(/\[\[|\]\]/g, '').trim();
  if (!clean) return false;
  const synth = window.speechSynthesis;
  const utter = new SpeechSynthesisUtterance(clean);
  const voice = pickVoice(voiceURI);
  if (voice) {
    utter.voice = voice;
    utter.lang = voice.lang;
  } else {
    utter.lang = lang;
  }
  utter.rate = rate;
  if (onEnd) utter.onend = onEnd;
  if (synth.speaking || synth.pending) {
    synth.cancel();
    // iOS drops an utterance queued in the same tick as cancel().
    setTimeout(() => synth.speak(utter), 60);
  } else {
    synth.speak(utter);
  }
  return true;
}

export function stop() {
  if (supported) window.speechSynthesis.cancel();
}

// Call once from the first user tap so later speech is allowed on iOS.
export function unlock() {
  if (!supported) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
  } catch {
    /* ignore */
  }
  loadVoices();
}
