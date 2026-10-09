// Dictation: read (or only hear) a passage, then write it from memory. The
// check shows a word-by-word diff: wrong words struck through in red with the
// right word in green, missed words underlined, extra words in orange.
import { h, reducedMotion } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, textArea } from '../../ui/components.js';
import { stop as stopSpeech } from '../../ui/speech.js';
import { diffWords } from '../../core/grade.js';
import { wordCount } from '../../core/text.js';
import { plural } from '../../core/util.js';

// Diff ops → inline nodes. Runs of correct words become one text node.
export function diffNodes(ops) {
  const out = [];
  let plain = '';
  let gap = false; // a space is due before the next word
  const word = (node) => {
    if (plain) {
      out.push(plain);
      plain = '';
    }
    out.push(node);
  };
  for (const op of ops) {
    if (op.type === 'break') {
      if (plain) out.push(plain);
      plain = '';
      out.push(h('br'));
      gap = false;
      continue;
    }
    const sep = gap ? ' ' : '';
    gap = true;
    if (op.type === 'equal') {
      plain += sep + op.expected;
      continue;
    }
    plain += sep;
    if (op.type === 'wrong') {
      word(h('span', { class: 'dw-pair' }, h('del', { class: 'dw-typed' }, op.actual), ' ', h('ins', { class: 'dw-fix' }, op.expected)));
    } else if (op.type === 'missing') {
      word(h('ins', { class: 'dw-missing' }, op.expected));
    } else if (op.type === 'extra') {
      word(h('del', { class: 'dw-extra' }, op.actual));
    }
  }
  if (plain) out.push(plain);
  return out;
}

const LEGEND = [
  { type: 'wrong', cls: 'dw-typed', label: 'Your word' },
  { type: 'wrong', cls: 'dw-fix', label: 'Correct' },
  { type: 'missing', cls: 'dw-missing', label: 'Missed' },
  { type: 'extra', cls: 'dw-extra', label: 'Not needed' },
];

function fadeIn(node, delay = 0) {
  if (reducedMotion() || typeof node.animate !== 'function') return;
  node.animate(
    [
      { opacity: 0, transform: 'translate3d(0, 10px, 0)' },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' },
    ],
    { duration: 300, delay, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'backwards' },
  );
}

// practice.js renders the first card before the screen is in the document,
// so focus as soon as it is (hardware keyboards; on iOS a tap opens it).
function focusSoon(field) {
  if (field.isConnected) {
    field.focus({ preventScroll: true });
    return;
  }
  let tries = 0;
  const tick = () => {
    if (field.isConnected) {
      const active = document.activeElement;
      if (!active || active === document.body) field.focus({ preventScroll: true });
    } else if (++tries < 90) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function render(card, ctx) {
  const { item, settings } = ctx;
  const text = item.text || '';
  const words = wordCount(text);
  const listenFirst = settings.dictationStart === 'listen';
  const hideAfter = Number(settings.dictationHideAfter) || 0;

  let phase = listenFirst ? 'write' : 'read';
  let checked = false;
  let plays = 0;
  let hideTimer = null;
  let revealTimer = 0;

  /* ---------- phase 1: read ---------- */
  const readPanel = listenFirst
    ? null
    : h(
        'div',
        { class: 'dict-read' },
        h('div', { class: 'dict-caption' }, 'Read and remember'),
        h(
          'div',
          { class: 'card dict-passage' },
          h('p', { class: 'dict-text', lang: 'en' }, text),
          h('div', { class: 'dict-passage-foot' }, button({ label: 'Listen', icon: 'speaker', variant: 'tinted', className: 'dict-listen', onTap: () => ctx.speak(text) }), h('span', { class: 'dict-count' }, plural(words, 'word'))),
        ),
        h('p', { class: 'dict-note' }, 'When you’re ready, the text hides and you write it from memory.'),
      );

  /* ---------- phase 2: write ---------- */
  const input = textArea({
    answer: true,
    rows: 6,
    placeholder: 'Write the passage from memory',
    className: 'dict-input',
    onInput: (value) => {
      if (!checked && phase === 'write') ctx.setReady(value.trim() !== '');
    },
  });
  input.setAttribute('enterkeyhint', 'enter');
  input.setAttribute('lang', 'en');
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    // Return types a new line; Ctrl/Cmd+Return checks (hardware keyboards).
    if (checked || e.metaKey || e.ctrlKey) {
      e.preventDefault();
      ctx.submit();
    }
  });

  let playStatus = null;
  let playBtn = null;
  const play = () => {
    const ok = ctx.speak(text);
    if (ok === false) {
      playStatus.textContent = 'Sound isn’t available on this device.';
      return;
    }
    plays += 1;
    playStatus.textContent = `Played ${plays}×`;
    playBtn.setAttribute('aria-label', `Play again (played ${plays} times)`);
  };
  const listenPanel = listenFirst
    ? h(
        'div',
        { class: 'card dict-player' },
        (playBtn = h('button', { type: 'button', class: 'dict-play', 'aria-label': 'Play the passage', onClick: play }, icon('play', { size: 28 }))),
        h('div', { class: 'dict-player-text' }, h('div', { class: 'dict-player-title' }, 'Listen and write'), (playStatus = h('div', { class: 'dict-player-status' }, `Tap play · ${plural(words, 'word')}`))),
        h('span', { class: 'dict-player-icon', 'aria-hidden': 'true' }, icon('headphones', { size: 22 })),
      )
    : null;

  const resultSlot = h('div', { class: 'dict-result-slot' });
  const writePanel = h(
    'div',
    { class: 'dict-write' },
    listenPanel,
    h('div', { class: 'dict-caption' }, listenFirst ? 'Your answer' : `Write it from memory · ${plural(words, 'word')}`),
    input,
    resultSlot,
  );

  const el = h('div', { class: 'dict' }, listenFirst ? writePanel : readPanel);

  // Keeps `node` in view inside the practice scroller (never the app frame):
  // bottom edge first, but never pushing its top out of sight.
  function reveal(node, delay) {
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => {
      const scroller = node.closest('.scroll');
      if (!scroller || !node.isConnected) return;
      const box = scroller.getBoundingClientRect();
      const r = node.getBoundingClientRect();
      const dy = Math.min(r.top - box.top - 12, r.bottom - box.bottom + 12);
      if (dy > 1) scroller.scrollBy({ top: dy, behavior: reducedMotion() ? 'auto' : 'smooth' });
    }, delay);
  }
  const onViewport = () => {
    if (document.activeElement === input && !checked) reveal(input, 120);
  };
  window.visualViewport?.addEventListener('resize', onViewport);

  function startWriting() {
    phase = 'write';
    stopSpeech();
    const scroller = el.closest('.scroll');
    if (scroller) scroller.scrollTop = 0;
    const old = readPanel;
    if (reducedMotion() || typeof old.animate !== 'function') {
      old.remove();
    } else {
      old.style.top = `${old.offsetTop}px`; // stays put under a "Try again" tag
      old.classList.add('dict-leaving');
      const out = old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'linear', fill: 'forwards' });
      out.finished.then(() => old.remove(), () => old.remove());
    }
    el.appendChild(writePanel);
    fadeIn(writePanel, 80);
    // Still inside the tap, so iOS opens the keyboard.
    input.focus({ preventScroll: true });
    ctx.setPrimaryLabel('Check');
    ctx.setReady(input.value.trim() !== '');
  }

  function showResult(diff) {
    const pct = Math.round(diff.score * 100);
    const toFix = diff.ops.filter((op) => op.type !== 'equal' && op.type !== 'break').length;
    const tone = diff.correct ? 'green' : pct >= 70 ? 'orange' : 'red';
    const present = new Set(diff.ops.map((op) => op.type));

    const body = h(
      'div',
      { class: 'dict-result-body' },
      h('p', { class: 'dict-diff', lang: 'en' }, diffNodes(diff.ops)),
      diff.correct
        ? null
        : h(
            'div',
            { class: 'dict-legend', 'aria-hidden': 'true' },
            LEGEND.filter((l) => present.has(l.type)).map((l) => h('span', { class: 'dict-key' }, h('span', { class: l.cls }, l.label))),
          ),
    );
    const hiddenRow = h(
      'button',
      {
        type: 'button',
        class: 'dict-hidden-row',
        hidden: true,
        onClick: () => {
          hiddenRow.hidden = true;
          body.hidden = false;
          fadeIn(body);
        },
      },
      icon('eyeSlash', { size: 20 }),
      h('span', null, 'Result hidden — tap to show'),
    );

    const resultCard = h(
      'div',
      { class: ['card', 'dict-result', `tone-${tone}`] },
      h(
        'div',
        { class: 'dict-score' },
        h('span', { class: 'dict-score-icon' }, icon(diff.correct ? 'checkCircle' : 'pencil', { size: 20 })),
        h('span', { class: 'dict-score-text tabular' }, h('strong', null, `${pct}%`), ' · ', diff.correct ? 'No mistakes' : `${plural(toFix, 'word')} to fix`),
      ),
      body,
      hiddenRow,
    );
    resultSlot.replaceChildren(resultCard);
    fadeIn(resultCard);

    if (hideAfter > 0) {
      hideTimer = setTimeout(() => {
        hideTimer = null;
        if (!resultCard.isConnected) return;
        body.hidden = true;
        hiddenRow.hidden = false;
        fadeIn(hiddenRow);
      }, hideAfter * 1000);
    }

    // Bring the corrections into view once the keyboard has gone down.
    reveal(resultCard, 360);
  }

  function check() {
    if (checked) return null;
    if (phase === 'read') {
      startWriting();
      return null;
    }
    checked = true;
    const diff = diffWords(text, input.value, { ignoreAccents: !!settings.ignoreAccents });
    input.readOnly = true;
    // The corrections need the room: let the keyboard go down.
    input.blur();
    el.classList.add('dict-checked');
    showResult(diff);
    return {
      correct: diff.correct,
      // Same threshold as the orange result card above.
      close: !diff.correct && Math.round(diff.score * 100) >= 70,
      score: diff.score,
      noAutoAdvance: true,
      feedback: {
        title: diff.correct ? 'Perfect!' : `${Math.round(diff.score * 100)}% right`,
        detail: diff.correct ? '' : 'Compare with the corrections above.',
      },
    };
  }

  return {
    el,
    primaryLabel: listenFirst ? 'Check' : "I'm ready",
    readyInitially: !listenFirst,
    focus() {
      if (phase === 'write') focusSoon(input);
    },
    check,
    destroy() {
      clearTimeout(hideTimer);
      clearTimeout(revealTimer);
      hideTimer = null;
      window.visualViewport?.removeEventListener('resize', onViewport);
    },
  };
}
