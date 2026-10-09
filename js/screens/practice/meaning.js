// "Meaning → Word" practice mode: read the Vietnamese meanings, type the
// English word. Mode contract: docs/architecture.md → Practice engine.
import { h, reducedMotion } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, iconButton, posBadge, textField } from '../../ui/components.js';
import { revealField } from '../../ui/viewport.js';
import { clozeParts, sentenceFromContext } from '../../core/cloze.js';
import { checkWord } from '../../core/grade.js';
import { pick } from '../../core/util.js';

const LETTER = /[\p{L}\p{N}]/u;
const HINT_GAP = 350; // ms: a double tap on Hint uses one hint, not two

// The form shown in the letter-pattern hint: first alternative, optional
// "(...)" parts dropped, no leading "to " for verbs.
function patternForm(word, pos) {
  let w = String(word || '').split(/\s+\/\s+|[;,]/)[0];
  w = w.replace(/\s*\([^)]*\)\s*/g, (m) => (/^\s|\s$/.test(m) ? ' ' : '')).replace(/\s+/g, ' ').trim();
  if (/(^|\/|\s)v(\/|$|\s)|phr v|verb/.test(String(pos || ''))) w = w.replace(/^to\s+(?=\S)/i, '');
  return w || String(word || '').trim();
}

// "a _ _ _ _ _": first letter shown, other letters as slots; hyphens,
// apostrophes and the gaps between words are kept.
function letterPattern(form) {
  let shown = false;
  let letters = 0;
  const words = form.split(' ').map((part) =>
    h(
      'span',
      { class: 'mn-pword' },
      Array.from(part).map((c) => {
        if (!LETTER.test(c)) return h('span', { class: 'mn-sep' }, c);
        letters += 1;
        if (!shown) {
          shown = true;
          return h('span', { class: 'mn-slot first' }, c);
        }
        return h('span', { class: 'mn-slot' });
      }),
    ),
  );
  const first = Array.from(form).find((c) => LETTER.test(c)) || '';
  const count = form.split(' ').length;
  const label = `Starts with "${first}", ${letters} letters${count > 1 ? `, ${count} words` : ''}`;
  const out = [];
  words.forEach((w, i) => {
    if (i) out.push(' ');
    out.push(w);
  });
  return h('div', { class: 'mn-pattern', role: 'img', 'aria-label': label }, out);
}

// A sentence that uses the word, with the word blanked out.
function contextClue(item, list, rng) {
  const saved = (list?.sentences || []).filter((s) => s.itemId === item.id && clozeParts(s.text));
  if (saved.length) return { parts: clozeParts(pick(saved, rng).text) };
  const blankIn = (text) => {
    const s = sentenceFromContext({ ...item, context: text });
    return s ? clozeParts(s.text) : null;
  };
  for (const example of item.examples || []) {
    const parts = blankIn(example);
    if (parts) return { parts };
  }
  if (item.context) {
    const parts = blankIn(item.context);
    if (parts) return { parts };
  }
  const synonyms = (item.synonyms || []).map((s) => String(s).trim()).filter(Boolean);
  if (synonyms.length) return { synonyms };
  return null;
}

function flip(nodes, mutate) {
  // Only nodes rendered before the change (a hidden node has no box to slide from).
  const live = nodes.filter((n) => n && n.isConnected && n.getClientRects().length);
  if (reducedMotion() || !live.length) return mutate();
  const before = live.map((n) => n.getBoundingClientRect().top);
  mutate();
  live.forEach((n, i) => {
    if (!n.isConnected) return;
    const dy = before[i] - n.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) return;
    n.animate([{ transform: `translate3d(0, ${dy}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }], { duration: 300, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  });
}

// Keeps the answer field focused (and the iOS keyboard up) when a button
// next to it is tapped.
function keepFocus(btn, field) {
  let had = false;
  btn.addEventListener('pointerdown', () => {
    had = document.activeElement === field;
  });
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  return () => {
    if (had && field.isConnected && document.activeElement !== field) field.focus({ preventScroll: true });
    had = false;
  };
}

// The first card is rendered before the router attaches the screen, so
// focus() then finds a detached field. Focus it once it is in the document
// (unless the learner has focused something else meanwhile).
function focusWhenAttached(field, isDone) {
  let frames = 0;
  const step = () => {
    if (isDone()) return;
    if (field.isConnected) {
      const active = document.activeElement;
      if (!active || active === document.body) field.focus({ preventScroll: true });
      return;
    }
    if (frames++ < 90) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function render(card, ctx) {
  const { item, list, settings = {} } = ctx;
  const rng = ctx.rng || Math.random;
  const word = String(item.word || '').trim();
  const senses = (Array.isArray(item.senses) ? item.senses : []).map((s) => String(s).trim()).filter(Boolean);
  const synonyms = (item.synonyms || []).map((s) => String(s).trim()).filter(Boolean);

  let checked = false;
  let destroyed = false;
  let focusTimer = 0;

  /* ---------- meanings ---------- */

  let sensesEl;
  if (senses.length > 1) {
    sensesEl = h(
      'ol',
      { class: 'mn-senses', lang: 'vi' },
      senses.map((s, i) => h('li', null, h('span', { class: 'mn-num tabular', 'aria-hidden': 'true' }, String(i + 1)), h('span', { class: 'mn-text' }, s))),
    );
  } else if (senses.length === 1) {
    sensesEl = h('p', { class: 'mn-sense', lang: 'vi' }, senses[0]);
  } else {
    sensesEl = h('p', { class: 'mn-sense mn-none' }, 'No meaning saved for this word.');
  }

  /* ---------- answer field ---------- */

  const field = textField({
    answer: true,
    enterkeyhint: 'done',
    placeholder: 'Type the word',
    ariaLabel: 'English word',
    className: 'mn-field',
    onInput: (value) => {
      if (!checked) ctx.setReady(value.trim() !== '');
    },
    onEnter: () => ctx.submit(),
  });
  field.addEventListener('focus', () => {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      if (document.activeElement === field) field.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }, 360);
  });

  /* ---------- hints ---------- */

  const hintBody = h('div', { class: 'mn-callout-body' });
  const callout = h('div', { class: 'mn-callout', hidden: true, role: 'status' }, icon('lightbulb', { size: 18 }), hintBody);
  const clue = contextClue(item, list, rng);

  const steps = [];
  if (word) {
    steps.push(() => {
      hintBody.append(letterPattern(patternForm(word, item.pos)));
    });
  }
  if (clue) {
    steps.push(() => {
      if (clue.parts) {
        hintBody.append(h('p', { class: 'mn-clue' }, clue.parts.before, h('span', { class: 'mn-clue-blank', 'aria-label': 'blank' }), clue.parts.after));
      } else {
        hintBody.append(h('p', { class: 'mn-clue' }, h('span', { class: 'mn-clue-label' }, 'Similar: '), clue.synonyms.join(', ')));
      }
    });
  }
  let hints = 0;
  let lastHintAt = -Infinity;

  const hintBtn = button({ label: 'Hint', icon: 'lightbulb', variant: 'tinted', size: 'small', className: 'mn-hint-btn', onTap: onHint });
  const refocusAfterHint = keepFocus(hintBtn, field);
  const hintArea = h('div', { class: 'mn-hints' }, hintBtn, callout);
  if (!steps.length) hintArea.hidden = true;

  function onHint() {
    if (checked || hints >= steps.length) return;
    if (performance.now() - lastHintAt < HINT_GAP) {
      refocusAfterHint();
      return;
    }
    lastHintAt = performance.now();
    flip([callout, field], () => {
      steps[hints]();
      hints += 1;
      callout.hidden = false;
      if (hints >= steps.length) hintBtn.hidden = true;
      else hintBtn.querySelector('span').textContent = 'Another hint';
    });
    refocusAfterHint();
    // The callout pushes the field down: keep it above the footer/keyboard.
    if (document.activeElement === field) revealField(field);
  }

  /* ---------- layout ---------- */

  const cardEl = h(
    'div',
    { class: 'card mn-card' },
    h('div', { class: 'mn-head' }, h('span', { class: 'mn-caption' }, 'Type the English word'), posBadge(item.pos)),
    sensesEl,
    hintArea,
  );
  const el = h('div', { class: 'mn' }, cardEl, field);

  function buildReveal(correct) {
    const speakBtn = iconButton({
      icon: 'speaker',
      label: `Listen to ${word}`,
      variant: 'filled',
      className: 'mn-speak',
      onTap: () => {
        ctx.speak(word);
        refocusSpeak();
      },
    });
    const refocusSpeak = keepFocus(speakBtn, field);
    return h(
      'div',
      { class: ['mn-reveal', correct ? 'right' : 'wrong'] },
      h(
        'div',
        { class: 'mn-answer' },
        h('div', { class: 'mn-answer-main' }, h('div', { class: 'mn-word' }, word), item.ipa ? h('div', { class: 'ipa mn-ipa' }, `/${item.ipa}/`) : null),
        speakBtn,
      ),
      synonyms.length ? h('p', { class: 'mn-syn' }, h('span', { class: 'mn-clue-label' }, 'Similar: '), synonyms.join(', ')) : null,
    );
  }

  /* ---------- check ---------- */

  function check() {
    if (checked) return null;
    const given = field.value.trim();
    if (!given) return null;
    const res = checkWord(given, word, { pos: item.pos, ignoreAccents: !!settings.ignoreAccents });
    checked = true;
    // Speech must start inside the tap that called check() (iOS).
    if (settings.autoSpeak) ctx.speak(word);

    field.readOnly = true;
    field.classList.add(res.correct ? 'is-right' : res.close ? 'is-close' : 'is-wrong');
    const reveal = buildReveal(res.correct);
    flip([field], () => hintArea.replaceWith(reveal));

    if (res.correct) return { correct: true, hinted: hints > 0 };
    return { correct: false, close: !!res.close, feedback: { title: res.close ? 'Almost — check the spelling' : undefined, detail: `Answer: ${word}` } };
  }

  return {
    el,
    focus() {
      if (field.isConnected) field.focus();
      else focusWhenAttached(field, () => destroyed || checked);
    },
    check,
    readyInitially: false,
    destroy() {
      destroyed = true;
      clearTimeout(focusTimer);
    },
  };
}
