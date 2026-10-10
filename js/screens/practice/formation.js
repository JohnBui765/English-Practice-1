// "Word formation" practice mode: the family's root in capitals, one member's
// example with a blank, and the learner types the form the sentence needs
// (like the word formation part of Cambridge exams).
// Mode contract: docs/architecture.md → Practice engine.
import { h, reducedMotion } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, iconButton, chip, textField } from '../../ui/components.js';
import { revealField } from '../../ui/viewport.js';
import { checkFormation, memberForms } from '../../core/families.js';
import { normalizeAnswer, posLabel } from '../../core/text.js';
import { clamp } from '../../core/util.js';
import { familyRoot, formationTarget } from './session.js';

const HINT_GAP = 350; // ms: a double tap on Hint uses one hint, not two
const EMPTY = '\u200b'; // keeps a text baseline inside the empty blank
const LETTER = /[\p{L}\p{N}]/u;

const article = (word) => (/^[aeiou]/i.test(word) ? 'an' : 'a');
const loose = (s) => normalizeAnswer(s, { ignoreAccents: true });

// An accepted spelling typed in another case reads like the sentence:
// "Authorised" for "authorized" → "authorised".
function matchCase(given, answer) {
  const lower = given.toLowerCase();
  const first = Array.from(answer)[0] || '';
  return first && first !== first.toLowerCase() ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
}

// Measures `nodes`, runs `mutate`, then slides each node from where it was
// (FLIP) so content below a change glides instead of jumping.
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

// Buttons next to the answer field must not steal its focus (the iOS
// keyboard would drop). Desktop: cancel the mousedown; iOS: refocus inside
// the tap.
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

// The family's forms for the hint chips: each member's first spelling, once.
function familyForms(members) {
  const seen = new Set();
  const out = [];
  for (const m of members || []) {
    const form = memberForms(m)[0];
    if (form && !seen.has(form.toLowerCase())) {
      seen.add(form.toLowerCase());
      out.push(form);
    }
  }
  return out;
}

export function render(card, ctx) {
  const { item, settings = {} } = ctx;
  const members = item.members || [];
  // practice.js only shows cards that resolve; the fallback keeps a card
  // whose member vanished mid-render from throwing.
  const target = formationTarget(card, item) || { member: members[card.member] || { word: '' }, blank: { before: '', answer: '', after: '' } };
  const { member, blank: parts } = target;
  const answer = parts.answer.trim();
  const root = familyRoot(item);
  const word = String(member.word || '').trim();
  const sayWord = memberForms(member)[0] || word;
  const pos = posLabel(member.pos);
  const meaning = String(member.vi || member.definition || '').trim();
  const meaningLang = member.vi ? 'vi' : 'en';
  const translation = String(member.exampleVi || '').trim();
  const fullText = `${parts.before}${answer}${parts.after}`.replace(/\s+/g, ' ').trim();

  let checked = false;
  let destroyed = false;
  let focusTimer = 0;

  /* ---------- sentence + blank ---------- */

  const blank = h('span', { class: 'wf-blank', style: { '--wf-w': `${clamp(answer.length * 0.6, 3.5, 9)}em` }, 'aria-label': 'Blank' }, EMPTY);
  const sentenceEl = h('p', { class: 'wf-sentence', lang: 'en' }, parts.before, blank, parts.after);

  function showResult(correct, given, close) {
    blank.classList.add(correct ? 'is-right' : 'is-wrong');
    if (close) blank.classList.add('is-close');
    const ans = h('span', { class: 'wf-fill wf-ans' }, answer);
    if (correct) {
      // An accepted other spelling ("authorised") shows as the learner wrote it.
      const shown = loose(given) === loose(answer) ? answer : matchCase(given, answer);
      blank.replaceChildren(h('span', { class: 'wf-fill wf-ans' }, shown));
      blank.setAttribute('aria-label', `Answer: ${shown}`);
    } else {
      blank.replaceChildren(h('s', { class: 'wf-was' }, given), ' ', ans);
      blank.setAttribute('aria-label', `Your answer: ${given}. Answer: ${answer}`);
    }
  }

  /* ---------- answer field ---------- */

  const field = textField({
    answer: true,
    enterkeyhint: 'done',
    placeholder: 'Type the right form',
    ariaLabel: `Form of ${root} for the blank`,
    className: 'wf-field',
    onInput: (value) => {
      if (!checked) ctx.setReady(value.trim() !== '');
    },
    onEnter: () => ctx.submit(),
  });
  // Once the keyboard has opened, make sure the field is not hidden under it.
  field.addEventListener('focus', () => {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      if (document.activeElement === field) field.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }, 360);
  });

  /* ---------- hints ---------- */

  const hintText = h('div', { class: 'wf-callout-text' });
  const callout = h('div', { class: 'wf-callout', hidden: true, role: 'status' }, icon('lightbulb', { size: 18 }), hintText);

  // A family form tapped in hint 2 goes into the field, ready to edit
  // ("authorize" → "authorized").
  function useForm(form) {
    if (checked) return;
    field.value = form;
    ctx.setReady(true);
    if (document.activeElement !== field) field.focus({ preventScroll: true });
    try {
      field.setSelectionRange(form.length, form.length);
    } catch {
      /* not supported for this input */
    }
    revealField(field);
  }

  const steps = [];
  if (pos || meaning) {
    // 1) The part of speech the sentence needs, and the member's meaning.
    steps.push(() => {
      if (pos) hintText.append(h('p', { class: 'wf-callout-strong' }, `Needs ${article(pos)} ${pos}`));
      if (meaning) hintText.append(h('p', { lang: meaningLang }, meaning));
    });
  }
  // Not the member asked for when the sentence needs it as it is (the chip
  // would be the answer); an inflected answer keeps its base form to edit.
  const forms = familyForms(members.filter((m) => !memberForms(m).some((f) => loose(f) === loose(answer))));
  if (forms.length >= 2) {
    // 2) The whole family: tap a form to put it in the field.
    steps.push(() => {
      const row = h(
        'div',
        { class: 'wf-forms', role: 'group', 'aria-label': 'Word family — tap a form to use it' },
        forms.map((form) => {
          const el = chip({ label: form, className: 'wf-form' });
          const refocus = keepFocus(el, field);
          el.lang = 'en';
          el.addEventListener('click', () => {
            useForm(form);
            refocus();
          });
          return el;
        }),
      );
      hintText.append(h('p', { class: 'wf-callout-label' }, 'Tap a form to edit it'), row);
    });
  }
  const first = Array.from(answer).find((c) => LETTER.test(c));
  if (first) {
    // 3) The first letter.
    steps.push(() => {
      field.placeholder = `${first}…`;
      hintText.append(h('p', { class: 'wf-callout-strong' }, `Starts with "${first}"`));
    });
  }
  let hints = 0;
  let lastHintAt = -Infinity;

  const hintBtn = button({ label: 'Hint', icon: 'lightbulb', variant: 'tinted', size: 'small', className: 'wf-hint-btn', onTap: onHint });
  const refocusAfterHint = keepFocus(hintBtn, field);
  const hintArea = h('div', { class: 'wf-hints' }, hintBtn, callout);
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
    // The callout pushes the field down: keep it above the footer/keyboard,
    // with the sentence still in view when both fit.
    if (document.activeElement === field) revealField(field, { above: sentenceEl });
  }

  /* ---------- reveal (after checking) ---------- */

  // Right: the footer shows the member's meaning, so the card does not repeat it.
  function buildReveal(correct) {
    const speakBtn = iconButton({
      icon: 'speaker',
      label: `Listen to ${sayWord}`,
      variant: 'filled',
      className: 'wf-speak',
      onTap: () => {
        ctx.speak(sayWord);
        refocusSpeak();
      },
    });
    const refocusSpeak = keepFocus(speakBtn, field);
    const top = translation || (correct ? '' : meaning);
    return h(
      'div',
      { class: 'wf-reveal' },
      top ? h('p', { class: 'wf-vi', lang: translation ? 'vi' : meaningLang }, top) : null,
      h(
        'div',
        { class: 'wf-word' },
        h(
          'span',
          { class: 'wf-word-main' },
          h('span', { class: 'wf-word-text', lang: 'en' }, word),
          pos ? h('span', { class: 'wf-word-pos' }, pos) : null,
          member.ipa ? h('span', { class: 'ipa' }, `/${member.ipa}/`) : null,
        ),
        speakBtn,
      ),
      // The meaning in full here; the footer banner shows the answer.
      translation && meaning && !correct ? h('p', { class: 'wf-meaning', lang: meaningLang }, meaning) : null,
    );
  }

  /* ---------- layout ---------- */

  const cardEl = h(
    'div',
    { class: 'card wf-card' },
    h('div', { class: 'wf-head' }, h('span', { class: 'wf-caption' }, 'Word formation'), h('span', { class: 'wf-root', lang: 'en' }, root)),
    sentenceEl,
    hintArea,
  );
  const el = h('div', { class: 'wf' }, cardEl, field);

  /* ---------- check ---------- */

  function check() {
    if (checked) return null;
    const given = field.value.trim();
    if (!given) return null;
    const res = checkFormation(given, answer, member, { ignoreAccents: !!settings.ignoreAccents, members });
    checked = true;
    // Speech must start inside the tap that called check() (iOS).
    if (settings.autoSpeak) ctx.speak(fullText);

    const close = !res.correct && res.close;
    showResult(res.correct, given, close);
    field.readOnly = true;
    field.classList.add(res.correct ? 'is-right' : close ? 'is-close' : 'is-wrong');
    const reveal = buildReveal(res.correct);
    flip([field], () => hintArea.replaceWith(reveal));

    if (res.correct) return { correct: true, hinted: hints > 0, feedback: { detail: meaning } };
    if (res.rightWordWrongForm) return { correct: false, feedback: { title: 'Right word, wrong form', detail: `The sentence needs "${answer}".` } };
    if (close) return { correct: false, close: true, feedback: { title: 'Almost — check the spelling', detail: `Answer: ${answer}` } };
    return { correct: false, feedback: { title: 'Not quite', detail: `Answer: ${answer}` } };
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
