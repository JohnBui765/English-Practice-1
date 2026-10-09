// Word families: the first member is the model; the learner types every other
// form (one field per member, labelled with its part of speech).
import { h, reducedMotion } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { iconButton, textField, badge, posBadge } from '../../ui/components.js';
import { posLabel } from '../../core/text.js';
import { checkWord } from '../../core/grade.js';
import { shuffle } from '../../core/util.js';

/* ---------- labels ---------- */

// Short hint that tells two nouns (or two verbs...) apart, from the definition.
export function contextHint(definition) {
  const def = String(definition || '').trim();
  const d = def.toLowerCase();
  if (/\b(one|person|someone|somebody|people|those|anyone) (who|that)\b|^(a|an|the)\s+(person|people)\b/.test(d)) return 'person';
  if (/\b(act|action|actions|acts) of\b|\bprocess\b/.test(d)) return 'act or process';
  if (/\bquality of\b|\bqualities\b/.test(d)) return 'quality';
  if (/\bstate of\b|\bcondition\b/.test(d)) return 'state';
  return firstWords(def);
}

function firstWords(def) {
  const words = String(def || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  if (words.length <= 3) return words.join(' ').replace(/[\s,;:.]+$/, '');
  return `${words.slice(0, 3).join(' ').replace(/[\s,;:.]+$/, '')}…`;
}

// Labels for the answer rows, in display order. Parts of speech that occur
// once are plain ("verb"); repeated ones get a hint ("noun · person") or a
// number ("noun 2").
export function familyLabels(members, mode = 'contextual') {
  const count = new Map();
  for (const m of members) count.set(m.pos || '', (count.get(m.pos || '') || 0) + 1);
  const seen = new Map();
  const labels = members.map((m) => {
    const key = m.pos || '';
    const pos = posLabel(m.pos) || 'word';
    if (count.get(key) < 2) return { pos, extra: '', numbered: false };
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (mode === 'numbered') return { pos, extra: String(n), numbered: true, n };
    return { pos, extra: contextHint(m.definition), numbered: false, n };
  });
  if (mode !== 'numbered') {
    // Two rows with the same hint (two "quality" nouns, or no definitions):
    // use the definitions' own words, and if those clash too, numbers.
    const clashes = () => {
      const seenKeys = new Map();
      const key = (l) => `${l.pos}|${l.extra}`;
      labels.forEach((l) => l.n && seenKeys.set(key(l), (seenKeys.get(key(l)) || 0) + 1));
      return labels.map((l) => !!l.n && seenKeys.get(key(l)) > 1);
    };
    clashes().forEach((clash, i) => clash && (labels[i].extra = firstWords(members[i].definition)));
    clashes().forEach((clash, i) => {
      if (!clash) return;
      labels[i].extra = String(labels[i].n);
      labels[i].numbered = true;
    });
  }
  return labels.map((l) => ({ ...l, text: l.extra ? (l.numbered ? `${l.pos} ${l.extra}` : `${l.pos} · ${l.extra}`) : l.pos }));
}

// "impoverish" → "i _ _ _ _ _ _ _ _ _" (beginner hint).
export function letterHint(word) {
  const first = String(word || '').split(/\s+\/\s+|[;,]\s*/)[0].trim();
  let started = false;
  return first
    .split(/\s+/)
    .map((w) =>
      Array.from(w)
        .map((c) => {
          if (!/[\p{L}\p{N}]/u.test(c)) return c;
          if (!started) {
            started = true;
            return c;
          }
          return '_';
        })
        .join(' '),
    )
    .join('   ');
}

/* ---------- scrolling ---------- */

// Scrolls `node` fully into view inside its scroll container only (never the
// fixed app frame).
function scrollIntoScroller(node) {
  const scroller = node.closest('.scroll');
  if (!scroller || !node.isConnected) return;
  const box = scroller.getBoundingClientRect();
  const r = node.getBoundingClientRect();
  const pad = 12;
  let dy = 0;
  if (r.bottom > box.bottom - pad) dy = r.bottom - box.bottom + pad;
  if (r.top - dy < box.top + pad) dy = r.top - box.top - pad;
  if (Math.abs(dy) > 1) scroller.scrollBy({ top: dy, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

// Scrolls `node` up to the top of its scroll container (as far as it goes),
// so the rows below it come into view too.
function scrollToTop(node) {
  const scroller = node.closest('.scroll');
  if (!scroller || !node.isConnected) return;
  const dy = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
  if (dy > 1) scroller.scrollBy({ top: dy, behavior: reducedMotion() ? 'auto' : 'smooth' });
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

/* ---------- mode ---------- */

export function render(card, ctx) {
  const { item, settings } = ctx;
  const members = item.members || [];
  const model = members[0] || { word: '', pos: '', ipa: '', definition: '', example: '' };
  const difficulty = settings.familyDifficulty || 'intermediate';

  let order = members.slice(1);
  if (difficulty === 'advanced') order = shuffle(order, ctx.rng);
  const labels = familyLabels(order, settings.familyDuplicates === 'numbered' ? 'numbered' : 'contextual');

  let checked = false;

  // Once the iOS keyboard has finished moving, keep the focused row in view.
  let revealTimer = 0;
  const reveal = (node, delay = 320) => {
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => scrollIntoScroller(node), delay);
  };
  const onViewport = () => {
    const row = rows.find((r) => r.field === document.activeElement);
    if (row) reveal(row.rowEl, 120);
  };
  window.visualViewport?.addEventListener('resize', onViewport);

  const say = (word) => (e) => {
    e.stopPropagation();
    ctx.speak(word);
  };

  const hero = h(
    'div',
    { class: 'card fam-hero' },
    h('div', { class: 'fam-caption' }, 'Model'),
    h(
      'div',
      { class: 'fam-hero-line' },
      h('span', { class: 'fam-hero-word', lang: 'en' }, model.word),
      model.pos ? h('span', { class: 'fam-hero-pos' }, posLabel(model.pos)) : null,
    ),
    model.ipa ? h('div', { class: 'ipa fam-hero-ipa' }, `/${model.ipa}/`) : null,
    model.definition ? h('p', { class: 'fam-hero-def', lang: 'en' }, model.definition) : null,
    iconButton({ icon: 'speaker', label: `Say ${model.word}`, variant: 'filled', className: 'fam-hero-say', onTap: say(model.word) }),
  );

  const rows = order.map((m, i) => {
    const label = labels[i];
    const last = i === order.length - 1;
    const pos = posLabel(m.pos);
    const placeholder = difficulty === 'beginner' ? letterHint(m.word) : pos ? `Type the ${pos}` : 'Type the word';
    const field = textField({
      answer: true,
      placeholder,
      ariaLabel: label.text,
      enterkeyhint: last ? 'done' : 'next',
      className: ['fam-field', difficulty === 'beginner' && 'hinted'].filter(Boolean).join(' '),
      onInput: () => {
        if (!checked) ctx.setReady(rows.some((r) => r.field.value.trim() !== ''));
      },
      onEnter: () => {
        if (checked || last) ctx.submit();
        else rows[i + 1].field.focus({ preventScroll: true });
      },
    });
    const tag = posBadge(m.pos) || badge('word');
    if (label.numbered && label.extra) tag.append(` ${label.extra}`);
    const head = h(
      'div',
      { class: 'fam-row-head' },
      h('div', { class: 'fam-label' }, tag, !label.numbered && label.extra ? h('span', { class: 'fam-label-extra' }, label.extra) : null),
    );
    const rowEl = h('div', { class: 'fam-row' }, head, field);
    // With the keyboard already up the row can be revealed at once.
    field.addEventListener('focus', () => reveal(rowEl, document.documentElement.classList.contains('kb-open') ? 30 : 320));
    return { m, field, head, rowEl, label };
  });

  const el = h(
    'div',
    { class: 'fam' },
    hero,
    h('div', { class: 'fam-section' }, rows.length === 1 ? 'Fill in the other form' : 'Fill in the other forms'),
    h('div', { class: 'fam-rows' }, rows.map((r) => r.rowEl)),
  );

  // Which member each row is marked against. Rows told apart only by a
  // number ("noun 1", "noun 2") accept those forms in any order.
  function targets(opts) {
    const out = rows.map((r) => r.m);
    const groups = new Map();
    rows.forEach((r, i) => {
      if (!r.label.numbered) return;
      const key = r.m.pos || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    });
    for (const idx of groups.values()) {
      const free = new Set(idx.map((i) => rows[i].m));
      const pending = [];
      for (const i of idx) {
        const hit = [...free].find((m) => checkWord(rows[i].field.value, m.word, { ...opts, pos: m.pos }).correct);
        if (hit) {
          free.delete(hit);
          out[i] = hit;
        } else pending.push(i);
      }
      for (const i of pending) {
        const m = free.has(rows[i].m) ? rows[i].m : [...free][0];
        free.delete(m);
        out[i] = m;
      }
    }
    return out;
  }

  function check() {
    if (checked) return null;
    checked = true;
    const opts = { ignoreAccents: !!settings.ignoreAccents };
    const marked = targets(opts);
    let right = 0;
    rows.forEach((r, i) => {
      const m = marked[i];
      const res = checkWord(r.field.value, m.word, { ...opts, pos: m.pos });
      r.field.readOnly = true;
      r.field.placeholder = '';
      r.field.classList.add(res.correct ? 'is-right' : 'is-wrong');
      r.rowEl.classList.add(res.correct ? 'right' : 'wrong');
      if (res.correct) right++;
      r.head.append(iconButton({ icon: 'speaker', label: `Say ${m.word}`, className: 'fam-say', onTap: say(m.word) }));
      const extra = [];
      if (!res.correct) extra.push(h('div', { class: 'fam-fix', lang: 'en' }, icon('arrowRight', { size: 16 }), h('span', null, m.word)));
      if (m.example) extra.push(h('p', { class: 'fam-example', lang: 'en' }, m.example));
      else if (m.definition) extra.push(h('p', { class: 'fam-def', lang: 'en' }, m.definition));
      if (extra.length) r.rowEl.append(h('div', { class: 'fam-reveal' }, extra));
    });
    el.classList.add('fam-checked');
    const total = rows.length;
    const correct = right === total;
    // The corrections make every row taller: bring the first red one (and
    // the rows after it) up from under the footer.
    const firstWrong = rows.find((r) => r.rowEl.classList.contains('wrong'));
    clearTimeout(revealTimer);
    if (firstWrong) revealTimer = setTimeout(() => scrollToTop(firstWrong.rowEl), 60);
    return {
      correct,
      close: !correct && total > 0 && right / total >= 0.5,
      score: total ? right / total : 0,
      feedback: {
        title: `${right} of ${total} correct`,
        detail: correct ? 'Every form right!' : 'Check the forms in red.',
      },
    };
  }

  return {
    el,
    primaryLabel: 'Check',
    readyInitially: false,
    focus() {
      if (rows.length) focusSoon(rows[0].field);
    },
    check,
    destroy() {
      clearTimeout(revealTimer);
      window.visualViewport?.removeEventListener('resize', onViewport);
    },
  };
}
