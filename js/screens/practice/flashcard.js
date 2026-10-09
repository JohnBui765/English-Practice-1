// Word → Meaning: a self-graded flashcard. The front shows the English word;
// "Show answer" (or a tap on the card) flips it to the meanings, and the
// learner grades themselves with "Didn't know" / "Knew it" in the footer.
import { h, reducedMotion } from '../../ui/dom.js';
import { iconButton, posBadge } from '../../ui/components.js';

const FLIP_MS = 450;
const FADE_MS = 200;
const FLIP_EASE = 'cubic-bezier(0.45, 0, 0.2, 1)';

export function render(card, ctx) {
  const { item, settings } = ctx;
  const senses = (item.senses || []).filter(Boolean);
  const synonyms = (item.synonyms || []).filter(Boolean);
  const examples = (item.examples || []).filter(Boolean);

  let revealed = false; // the answer has been shown at least once
  let flipped = false; // the back face is showing
  let anim = [];

  const say = (e) => {
    e.stopPropagation();
    ctx.speak(item.word);
  };
  const speaker = () => iconButton({ icon: 'speaker', label: `Say ${item.word}`, variant: 'filled', className: 'fc-say', onTap: say });

  // The speaker sits in the top-right corner on both faces, so it stays put
  // when the card turns and the middle of the card is free for tapping.
  const front = h(
    'div',
    { class: 'fc-face fc-front' },
    speaker(),
    h(
      'div',
      { class: 'fc-front-main' },
      h('div', { class: 'fc-word', lang: 'en' }, item.word),
      item.ipa ? h('div', { class: 'ipa fc-ipa' }, `/${item.ipa}/`) : null,
      posBadge(item.pos),
    ),
    h('div', { class: 'fc-hint' }, 'Tap to reveal'),
  );

  const numbered = senses.length > 1;
  const back = h(
    'div',
    { class: 'fc-face fc-back', 'aria-hidden': 'true' },
    h(
      'div',
      { class: 'fc-back-head' },
      h('div', { class: 'fc-back-title' }, h('span', { class: 'fc-back-word', lang: 'en' }, item.word), posBadge(item.pos)),
      speaker(),
    ),
    h(
      'ol',
      { class: ['fc-senses', numbered && 'numbered'] },
      (senses.length ? senses : ['—']).map((s, i) => h('li', { class: 'fc-sense', lang: 'vi' }, numbered ? h('span', { class: 'fc-num tabular', 'aria-hidden': 'true' }, String(i + 1)) : null, h('span', { class: 'fc-sense-text' }, s))),
    ),
    synonyms.length ? h('p', { class: 'fc-syn', lang: 'en' }, h('span', { class: 'fc-syn-mark', 'aria-hidden': 'true' }, '≈'), h('span', { class: 'visually-hidden' }, 'Similar: '), ' ', synonyms.join(', ')) : null,
    examples.length ? h('div', { class: 'fc-examples', lang: 'en' }, examples.map((x) => h('p', { class: 'fc-example' }, x))) : null,
    item.context ? h('p', { class: 'fc-context', lang: 'en' }, h('span', { class: 'fc-context-label' }, 'Seen in: '), item.context) : null,
  );

  // A plain tap surface (not role=button: it holds the speaker buttons, and
  // screen readers should read the meanings). "Show answer" in the footer is
  // the accessible control; Enter on a keyboard goes there too.
  const cardEl = h('div', { class: 'fc-card', onClick: () => onCardTap() }, front, back);

  const el = h('div', { class: 'fc' }, h('div', { class: 'fc-scene' }, cardEl));

  function animating() {
    return anim.some((a) => a.playState === 'running');
  }

  function flip(to) {
    if (to === flipped || animating()) return;
    flipped = to;
    cardEl.classList.toggle('is-flipped', to);
    front.setAttribute('aria-hidden', String(to));
    back.setAttribute('aria-hidden', String(!to));
    if (typeof cardEl.animate !== 'function') return;
    cardEl.classList.add('is-animating');
    if (reducedMotion()) {
      // Cross-fade instead of turning the card over.
      const [shown, hidden] = to ? [back, front] : [front, back];
      // The incoming face (raised in CSS) fades in over the outgoing one,
      // which stays opaque so the card never looks washed out.
      anim = [
        shown.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'linear' }),
        hidden.animate([{ opacity: 1 }, { opacity: 1 }], { duration: FADE_MS }),
      ];
    } else {
      const from = to ? 0 : 180;
      const end = to ? 180 : 0;
      anim = [
        cardEl.animate(
          [
            { transform: `rotateY(${from}deg) scale(1)` },
            { transform: `rotateY(90deg) scale(0.94)` },
            { transform: `rotateY(${end}deg) scale(1)` },
          ],
          { duration: FLIP_MS, easing: FLIP_EASE },
        ),
      ];
    }
    const done = () => {
      // The class already holds the final state, so ending the animation
      // never jumps.
      if (!animating()) cardEl.classList.remove('is-animating');
    };
    anim.forEach((a) => a.finished.then(done, done));
  }

  function reveal() {
    if (revealed) return;
    revealed = true;
    flip(true);
    if (settings.autoSpeak) ctx.speak(item.word);
    ctx.showGradeButtons();
  }

  function onCardTap() {
    // The first tap goes through the footer so practice.js stays in charge
    // of state; afterwards the card just turns over and back.
    if (!revealed) ctx.submit();
    else flip(!flipped);
  }

  return {
    el,
    primaryLabel: 'Show answer',
    readyInitially: true,
    check() {
      reveal();
      return null;
    },
    grade(correct) {
      if (!flipped) flip(true);
      return {
        correct,
        feedback: {
          title: correct ? 'Nice!' : 'Keep practising',
          detail: senses.join(' · '),
        },
      };
    },
    destroy() {
      anim.forEach((a) => a.cancel());
      anim = [];
    },
  };
}
