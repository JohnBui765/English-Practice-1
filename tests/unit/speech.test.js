// Voice choice: Apple ships basic and downloaded (Enhanced/Premium) copies of
// a voice under the same name; only voiceURI tells them apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceQuality, voiceName, voiceAccent, rankVoices, bestVoice } from '../../js/ui/speech.js';

const v = (voiceURI, name, lang = 'en-US', localService = true) => ({ voiceURI, name, lang, localService });

// Roughly what iOS 17/18 Safari reports after downloading two voices.
const IOS = [
  v('com.apple.voice.compact.en-US.Samantha', 'Samantha'),
  v('com.apple.voice.compact.en-GB.Daniel', 'Daniel', 'en-GB'),
  v('com.apple.eloquence.en-US.Reed', 'Reed'),
  v('com.apple.eloquence.en-US.Grandma', 'Grandma'),
  v('com.apple.speech.synthesis.voice.Albert', 'Albert'),
  v('com.apple.voice.enhanced.en-US.Samantha', 'Samantha'),
  v('com.apple.voice.premium.en-US.Zoe', 'Zoe'),
  v('com.apple.voice.compact.en-AU.Karen', 'Karen', 'en-AU'),
];

test('quality is read from the voice id, not only the name', () => {
  assert.equal(voiceQuality(IOS[0]), 'default');
  assert.equal(voiceQuality(IOS[5]), 'enhanced');
  assert.equal(voiceQuality(IOS[6]), 'premium');
  assert.equal(voiceQuality(IOS[2]), 'novelty');
  assert.equal(voiceQuality(IOS[4]), 'novelty');
  assert.equal(voiceQuality(v('com.apple.ttsbundle.Samantha-premium', 'Samantha')), 'enhanced'); // older iOS naming
  assert.equal(voiceQuality(v('com.apple.ttsbundle.Samantha-compact', 'Samantha')), 'default');
  assert.equal(voiceQuality(v('x', 'Ava (Premium)')), 'premium');
  assert.equal(voiceQuality(v('x', 'Evan (Enhanced)')), 'enhanced');
  assert.equal(voiceQuality(v('Microsoft Aria Online (Natural) - English (United States)', 'Microsoft Aria Online (Natural) - English (United States)')), 'premium');
  assert.equal(voiceQuality(v('com.apple.speech.synthesis.voice.Alex', 'Alex')), 'default');
});

test('automatic choice prefers Premium, then Enhanced, never the basic copy', () => {
  assert.equal(bestVoice(IOS).voiceURI, 'com.apple.voice.premium.en-US.Zoe');
  const noPremium = IOS.filter((x) => !x.voiceURI.includes('premium'));
  assert.equal(bestVoice(noPremium).voiceURI, 'com.apple.voice.enhanced.en-US.Samantha');
});

test('a saved basic voice is upgraded once its Enhanced copy is downloaded', () => {
  assert.equal(bestVoice(IOS, 'com.apple.voice.compact.en-US.Samantha').voiceURI, 'com.apple.voice.enhanced.en-US.Samantha');
  // A different saved voice is respected.
  assert.equal(bestVoice(IOS, 'com.apple.voice.compact.en-GB.Daniel').voiceURI, 'com.apple.voice.compact.en-GB.Daniel');
  // A saved voice that no longer exists falls back to the best one.
  assert.equal(bestVoice(IOS, 'gone').voiceURI, 'com.apple.voice.premium.en-US.Zoe');
});

test('ranking hides novelty voices and duplicates', () => {
  const ranked = rankVoices([...IOS, IOS[0]]);
  assert.ok(!ranked.some((x) => voiceQuality(x) === 'novelty'));
  assert.equal(ranked.length, new Set(ranked.map((x) => x.voiceURI)).size);
  assert.deepEqual(ranked.slice(0, 2).map((x) => x.voiceURI), ['com.apple.voice.premium.en-US.Zoe', 'com.apple.voice.enhanced.en-US.Samantha']);
});

test('names and accents for display', () => {
  assert.equal(voiceName(v('x', 'Ava (Premium)')), 'Ava');
  assert.equal(voiceAccent(IOS[1]), 'British');
  assert.equal(voiceAccent(v('x', 'Rishi', 'en-IN')), 'Indian');
  assert.equal(bestVoice([]), null);
});
