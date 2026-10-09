// "In context" practice mode: fill the blank in a sentence written for one
// meaning of a word. Answer from a word bank (default) or by typing
// (settings.clozeAnswer). Mode contract: docs/architecture.md → Practice engine.
import { h, reducedMotion } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, iconButton, chip, posBadge, textField } from '../../ui/components.js';
import { revealField } from '../../ui/viewport.js';
import { clozeParts, formMatchesWord } from '../../core/cloze.js';
import { checkWord } from '../../core/grade.js';
import { normalizeAnswer } from '../../core/text.js';
import { shuffle, clamp } from '../../core/util.js';

const BANK_MAX = 12;
const HINT_GAP = 350; // ms: a double tap on Hint uses one hint, not two
const EMPTY = '​'; // keeps a text baseline inside the empty blank

// Sentence split around the blank. Tolerates a sentence saved without [[ ]].
function sentenceParts(sentence) {
  const parts = clozeParts(sentence?.text);
  const answer = String(sentence?.answer || parts?.answer || '').trim();
  if (parts) return { before: parts.before, after: parts.after, answer: answer || parts.answer };
  const text = String(sentence?.text || '').replace(/\[\[|\]\]/g, '');
  const at = answer ? text.toLowerCase().indexOf(answer.toLowerCase()) : -1;
  if (at >= 0) return { before: text.slice(0, at), after: text.slice(at + answer.length), answer };
  return { before: text ? `${text} ` : '', after: '', answer };
}

const mainPos = (pos) => String(pos || '').split('/')[0];

// The list's headwords (one chip per distinct word). More than 12 → the
// answer plus 11 others, same part of speech first. Shuffled once per card.
function bankEntries(item, items, rng, norm) {
  const answer = { id: item.id, word: String(item.word || '').trim(), pos: item.pos || '', answer: true };
  const seen = new Set([norm(answer.word)]);
  let others = [];
  for (const it of items || []) {
    const word = String(it?.word || '').trim();
    const key = norm(word);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    others.push({ id: it.id, word, pos: it.pos || '', answer: false });
  }
  others = shuffle(others, rng);
  if (others.length > BANK_MAX - 1) {
    const pos = mainPos(item.pos);
    if (pos) others = [...others.filter((o) => mainPos(o.pos) === pos), ...others.filter((o) => mainPos(o.pos) !== pos)];
    others = others.slice(0, BANK_MAX - 1);
  }
  return shuffle([answer, ...others], rng);
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

// Buttons next to a text field must not steal its focus (the iOS keyboard
// would drop). Desktop: cancel the mousedown; iOS: refocus inside the tap.
function keepFocus(btn, getField) {
  let had = false;
  btn.addEventListener('pointerdown', () => {
    const f = getField();
    had = !!f && document.activeElement === f;
  });
  btn.addEventListener('mousedown', (e) => {
    if (getField()) e.preventDefault();
  });
  return () => {
    const f = getField();
    if (had && f && f.isConnected && document.activeElement !== f) f.focus({ preventScroll: true });
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
  const { item, settings = {} } = ctx;
  const rng = ctx.rng || Math.random;
  const typeMode = settings.clozeAnswer === 'type';
  const opts = { ignoreAccents: !!settings.ignoreAccents };
  const norm = (s) => normalizeAnswer(s, opts);
  const parts = sentenceParts(ctx.sentence);
  const answer = parts.answer;
  const senses = Array.isArray(item.senses) ? item.senses : [];
  const sense = String(senses[ctx.sentence?.sense] ?? senses[0] ?? '').trim();
  const fullText = `${parts.before}${answer}${parts.after}`.replace(/\s+/g, ' ').trim();

  let checked = false;
  let destroyed = false;
  let chosen = null; // bank entry
  let field = null;
  let focusTimer = 0;

  /* ---------- sentence + blank ---------- */

  const blank = h(typeMode ? 'span' : 'button', {
    type: typeMode ? undefined : 'button',
    class: 'cz-blank',
    style: { '--cz-w': `${clamp(answer.length * 0.6, 3.5, 9)}em` },
    'aria-label': typeMode ? 'Blank' : 'Blank. Choose a word below.',
    onClick: typeMode
      ? undefined
      : () => {
          if (!checked && chosen) select(null);
        },
  }, EMPTY);

  const sentenceEl = h('p', { class: 'cz-sentence' }, parts.before, blank, parts.after);

  function showChosen(word) {
    blank.classList.toggle('filled', !!word);
    if (word) {
      blank.replaceChildren(h('span', { class: 'cz-fill' }, word));
      blank.setAttribute('aria-label', `Blank: ${word}. Tap to clear.`);
    } else {
      blank.replaceChildren(EMPTY);
      blank.setAttribute('aria-label', 'Blank. Choose a word below.');
    }
  }

  function showResult(correct, given, close = false) {
    blank.classList.remove('filled');
    blank.classList.add(correct ? 'is-right' : 'is-wrong');
    if (close) blank.classList.add('is-close');
    blank.setAttribute('aria-disabled', 'true');
    const ans = h('span', { class: 'cz-fill cz-ans' }, answer);
    if (correct || !given) {
      blank.replaceChildren(ans);
      blank.setAttribute('aria-label', `Answer: ${answer}`);
    } else {
      blank.replaceChildren(h('s', { class: 'cz-was' }, given), ' ', ans);
      blank.setAttribute('aria-label', `Your answer: ${given}. Answer: ${answer}`);
    }
  }

  /* ---------- answer area: word bank or text field ---------- */

  let entries = [];
  const chips = new Map(); // entry -> chip element
  let answerArea;

  if (typeMode) {
    field = textField({
      answer: true,
      enterkeyhint: 'done',
      placeholder: 'Type the missing word',
      ariaLabel: 'Missing word',
      className: 'cz-field',
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
    answerArea = field;
  } else {
    entries = bankEntries(item, ctx.items, rng, norm);
    for (const entry of entries) {
      const el = chip({
        label: entry.word,
        onTap: (e) => {
          onChip(entry);
          // A tapped chip keeps focus in desktop/Android browsers, so Enter
          // would toggle it off instead of checking. Keyboard users (detail 0)
          // keep focus on it.
          if (e.detail > 0) el.blur();
        },
      });
      el.setAttribute('aria-pressed', 'false');
      chips.set(entry, el);
    }
    answerArea = h('div', { class: 'cz-bank', role: 'group', 'aria-label': 'Word bank' }, [...chips.values()]);
  }

  function select(entry) {
    if (chosen) {
      const prev = chips.get(chosen);
      prev.classList.remove('selected');
      prev.setAttribute('aria-pressed', 'false');
    }
    chosen = entry;
    if (entry) {
      const el = chips.get(entry);
      el.classList.add('selected');
      el.setAttribute('aria-pressed', 'true');
    }
    showChosen(entry ? entry.word : '');
    ctx.setReady(!!entry);
  }

  function onChip(entry) {
    if (checked || chips.get(entry).disabled) return;
    select(chosen === entry ? null : entry);
  }

  /* ---------- hints ---------- */

  const hintText = h('div', { class: 'cz-callout-text' });
  const callout = h('div', { class: 'cz-callout', hidden: true, role: 'status' }, icon('lightbulb', { size: 18 }), hintText);

  const steps = [];
  if (sense) {
    steps.push(() => {
      hintText.append(h('p', { lang: 'vi' }, sense));
      callout.hidden = false;
    });
  }
  if (typeMode && answer) {
    steps.push(() => {
      const first = Array.from(answer)[0];
      field.placeholder = `${first}…`;
      hintText.append(h('p', { class: 'cz-callout-extra' }, `Starts with "${first}"`));
      callout.hidden = false;
    });
  } else if (!typeMode && entries.length - 1 >= 2) {
    steps.push(() => {
      const wrong = entries.filter((e) => !e.answer);
      const dim = shuffle(wrong, rng).slice(0, Math.floor(wrong.length / 2));
      for (const entry of dim) {
        if (chosen === entry) select(null);
        const el = chips.get(entry);
        el.classList.add('dim');
        el.disabled = true;
      }
    });
  }
  let hints = 0;
  let lastHintAt = -Infinity;

  const hintBtn = button({ label: 'Hint', icon: 'lightbulb', variant: 'tinted', size: 'small', className: 'cz-hint-btn', onTap: onHint });
  const refocusAfterHint = keepFocus(hintBtn, () => field);
  const hintArea = h('div', { class: 'cz-hints' }, hintBtn, callout);
  if (!steps.length) hintArea.hidden = true;

  function onHint() {
    if (checked || hints >= steps.length) return;
    if (performance.now() - lastHintAt < HINT_GAP) {
      refocusAfterHint();
      return;
    }
    lastHintAt = performance.now();
    flip([callout, answerArea], () => {
      steps[hints]();
      hints += 1;
      if (hints >= steps.length) hintBtn.hidden = true;
      else hintBtn.querySelector('span').textContent = 'Another hint';
    });
    refocusAfterHint();
    // The callout pushes the field down: keep it above the footer/keyboard.
    if (field && document.activeElement === field) revealField(field);
  }

  /* ---------- reveal (after checking) ---------- */

  function buildReveal() {
    const translation = String(ctx.sentence?.vi || '').trim();
    const vi = translation || sense;
    const speakBtn = iconButton({
      icon: 'speaker',
      label: `Listen to ${item.word}`,
      variant: 'filled',
      className: 'cz-speak',
      onTap: () => {
        ctx.speak(item.word);
        refocusSpeak();
      },
    });
    const refocusSpeak = keepFocus(speakBtn, () => field);
    return h(
      'div',
      { class: 'cz-reveal' },
      vi ? h('p', { class: 'cz-vi', lang: 'vi' }, vi) : null,
      h(
        'div',
        { class: 'cz-word' },
        h('span', { class: 'cz-word-main' }, h('span', { class: 'cz-word-text' }, item.word), item.ipa ? h('span', { class: 'ipa' }, `/${item.ipa}/`) : null),
        speakBtn,
      ),
      // The meaning in full here; the footer banner keeps to one short line.
      translation && sense ? h('p', { class: 'cz-sense', lang: 'vi' }, sense) : null,
    );
  }

  /* ---------- layout ---------- */

  const cardEl = h(
    'div',
    { class: 'card cz-card' },
    h('div', { class: 'cz-head' }, h('span', { class: 'cz-caption' }, 'Fill in the blank'), posBadge(item.pos)),
    sentenceEl,
    hintArea,
  );
  const el = h('div', { class: ['cz', typeMode ? 'cz-type' : 'cz-bank-mode'] }, cardEl, answerArea);

  /* ---------- check ---------- */

  function check() {
    if (checked) return null;
    let correct = false;
    let rightWord = false; // right word, but not the form the sentence needs
    let close = false;
    let given = '';
    if (typeMode) {
      given = field.value.trim();
      if (!given) return null;
      const typed = norm(given);
      const accepted = answer.split('/').map(norm).filter(Boolean);
      if (accepted.includes(typed)) correct = true;
      else if (formMatchesWord(given, item.word)) correct = rightWord = true;
      else close = checkWord(given, answer, opts).close;
    } else {
      if (!chosen) return null;
      given = chosen.word;
      correct = chosen.id === card.itemId || norm(chosen.word) === norm(item.word);
    }
    checked = true;
    // Speech must start inside the tap that called check() (iOS).
    if (settings.autoSpeak) ctx.speak(fullText);

    showResult(correct, given, close);
    if (field) {
      field.readOnly = true;
      field.classList.add(correct ? 'is-right' : close ? 'is-close' : 'is-wrong');
    }
    for (const [entry, chipEl] of chips) {
      chipEl.disabled = true;
      chipEl.classList.remove('selected');
      if (entry.answer) chipEl.classList.add('right');
      else if (entry === chosen) chipEl.classList.add('wrong');
    }
    const reveal = buildReveal();
    flip([answerArea], () => {
      hintArea.replaceWith(reveal);
    });

    let feedback;
    if (rightWord) feedback = { title: 'Right word!', detail: `The sentence needs "${answer}".` };
    else if (correct) feedback = {};
    else feedback = { title: close ? 'Almost — check the spelling' : undefined, detail: `Answer: ${answer}` };
    return { correct, close: !correct && close, hinted: correct && hints > 0, feedback };
  }

  return {
    el,
    focus() {
      if (field) {
        if (field.isConnected) field.focus();
        else focusWhenAttached(field, () => destroyed || checked);
        return;
      }
      // Word bank: no keyboard needed (a typed card before this one may have left it up).
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) active.blur();
    },
    check,
    readyInitially: false,
    destroy() {
      destroyed = true;
      clearTimeout(focusTimer);
    },
  };
}
