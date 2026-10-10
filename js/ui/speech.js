// Text-to-speech using the device's built-in English voices (offline on iOS).
// speak() is synchronous on purpose: iOS only allows speech that starts inside
// a tap handler, so we must not await anything before calling it.

export const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

let cachedVoices = [];

if (supported && window.speechSynthesis.addEventListener) {
  window.speechSynthesis.addEventListener('voiceschanged', () => loadVoices());
}

function loadVoices() {
  if (!supported) return [];
  const all = window.speechSynthesis.getVoices() || [];
  cachedVoices = all.filter((v) => /^en([-_]|$)/i.test(v.lang));
  return cachedVoices;
}

// Every voice the browser offers, in every language, exactly as reported —
// for the Settings diagnostics. Waits up to 2 s for the list to load.
export function allVoicesRaw() {
  if (!supported) return Promise.resolve([]);
  const read = () => (window.speechSynthesis.getVoices() || []).map((v) => ({
    name: v.name,
    lang: v.lang,
    voiceURI: v.voiceURI,
    localService: v.localService,
    default: v.default,
  }));
  const now = read();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => resolve(read());
    window.speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 2000);
  });
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

// Apple ships several qualities of the same voice, often with the SAME name
// ("Samantha"): the quality is only in the voice id, e.g.
//   com.apple.voice.compact.en-US.Samantha    (basic, robotic)
//   com.apple.voice.enhanced.en-US.Samantha   (downloaded "Enhanced")
//   com.apple.voice.premium.en-US.Zoe         (downloaded "Premium")
//   com.apple.ttsbundle.Samantha-premium      (older iOS name for Enhanced)
// so quality must be read from voiceURI as well as the name.
const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;

export const QUALITY_RANK = { premium: 3, enhanced: 2, default: 1, novelty: 0 };
export const QUALITY_LABEL = { premium: 'Premium', enhanced: 'Enhanced', default: 'Standard', novelty: 'Novelty' };

export function voiceQuality(v) {
  const uri = String(v?.voiceURI || '').toLowerCase();
  const name = String(v?.name || '');
  const both = `${uri} ${name.toLowerCase()}`;
  if (uri.includes('eloquence') || NOVELTY.test(name)) return 'novelty';
  if (/ttsbundle\..*-premium/.test(uri)) return 'enhanced';
  if (/\bpremium\b|\.premium\.|neural|\(natural\)|\bnatural\b/.test(both)) return 'premium';
  if (/enhanced|siri/.test(both)) return 'enhanced';
  return 'default';
}

// "Samantha (Enhanced)" → "Samantha"
export function voiceName(v) {
  return String(v?.name || '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim() || 'Voice';
}

const ACCENTS = { US: 'American', GB: 'British', AU: 'Australian', IE: 'Irish', ZA: 'South African', IN: 'Indian', NZ: 'New Zealand', CA: 'Canadian', SG: 'Singaporean' };

export function voiceAccent(v) {
  const region = String(v?.lang || '').split(/[-_]/)[1]?.toUpperCase();
  return ACCENTS[region] || (region ? `English (${region})` : 'English');
}

const PREFERRED = ['Ava', 'Zoe', 'Evan', 'Nathan', 'Samantha', 'Allison', 'Susan', 'Tom', 'Daniel', 'Serena', 'Arthur', 'Kate', 'Karen', 'Moira', 'Alex', 'Google US English', 'Google UK English'];

function score(v) {
  let s = QUALITY_RANK[voiceQuality(v)] * 100;
  const pref = PREFERRED.findIndex((n) => voiceName(v).startsWith(n));
  if (pref >= 0) s += 30 - pref;
  if (/en[-_]US/i.test(v.lang)) s += 8;
  else if (/en[-_]GB/i.test(v.lang)) s += 6;
  if (v.localService) s += 2;
  return s;
}

// Best first; novelty voices are left out; duplicates (same id) removed.
export function rankVoices(voices) {
  const seen = new Set();
  return voices
    .filter((v) => voiceQuality(v) !== 'novelty' && !seen.has(v.voiceURI) && seen.add(v.voiceURI))
    .sort((a, b) => score(b) - score(a));
}

function sortVoices(voices) {
  return rankVoices(voices);
}

// The voice to use: the saved one, upgraded to a better-quality copy of the
// same voice when one has been downloaded since; otherwise the best voice.
export function bestVoice(voices, voiceURI = '') {
  const ranked = rankVoices(voices);
  if (voiceURI) {
    const saved = voices.find((v) => v.voiceURI === voiceURI);
    if (saved) {
      const better = ranked.find(
        (v) => voiceName(v) === voiceName(saved) && v.lang === saved.lang && QUALITY_RANK[voiceQuality(v)] > QUALITY_RANK[voiceQuality(saved)],
      );
      return better || saved;
    }
  }
  return ranked[0] || null;
}

function pickVoice(voiceURI) {
  const voices = cachedVoices.length ? cachedVoices : loadVoices();
  return bestVoice(voices, voiceURI);
}

// The voice that speak() will use with these settings (for the Settings screen).
export function currentVoice(voiceURI = '') {
  return pickVoice(voiceURI);
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
