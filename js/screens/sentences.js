// Sentences screen ("route B"). The app cannot write sentences itself, so the
// learner copies a prompt into the Claude app and pastes Claude's JSON reply
// back here. The reply box is kept as a draft in localStorage, so nothing is
// lost when iOS closes the app while the learner is away in Claude.
// params: { listId }
import { h, reducedMotion } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { screen, card, button, iconButton, segmented, toggle, textArea, badge, posBadge, ring, emptyState, confirm, toast } from '../ui/components.js';
import { pop } from '../ui/router.js';
import { copyText, readText } from '../ui/clipboard.js';
import { buildPrompt, parseReply, coverage, clozeParts } from '../core/cloze.js';
import { normalizeAnswer } from '../core/text.js';
import { plural } from '../core/util.js';
import * as store from '../data/store.js';

const CLAUDE_URL = 'https://claude.ai/new';
const INPUT_DELAY = 250; // ms: live parse + draft save while typing
const RETURN_WINDOW = 60 * 60 * 1000; // prompt copied this recently → open at step 2
const MODE_WINDOW = 12 * 60 * 60 * 1000; // remembered "New set" choice
const MAX_PROBLEMS = 5;
const MAX_MISSING = 6;

const draftKey = (id) => `vs.sentences.draft.${id}`;
const modeKey = (id) => `vs.sentences.mode.${id}`;
const copiedKey = (id) => `vs.sentences.copied.${id}`;

const PER_OPTIONS = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
];
const LEVEL_OPTIONS = [
  { value: 'B1', label: 'B1' },
  { value: 'B2', label: 'B2' },
  { value: 'C1', label: 'C1' },
];

/* ---------- small helpers ---------- */

function readStore(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key, value) {
  try {
    if (value === null || value === undefined || value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the screen still works, the draft just is not kept */
  }
}

function readJson(key) {
  try {
    return JSON.parse(readStore(key) || 'null');
  } catch {
    return null;
  }
}

const unbracket = (s) => String(s ?? '').replace(/\[\[(.*?)\]\]/g, '$1');
const textKey = (s) => normalizeAnswer(unbracket(s));
const senseCount = (item) => Math.max(1, item?.senses?.length ?? 0);

// Keeps the sentences whose text is not already in `existing` (or earlier in the list).
function dedupe(sentences, existing) {
  const seen = new Set(existing.map((s) => textKey(s.text)));
  return sentences.filter((s) => {
    const key = textKey(s.text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// "w4 s2" → "Word 4, meaning 2"
function refLabel(ref) {
  if (!ref) return '';
  const w = /(?:^|\s)w(\S+)/.exec(ref)?.[1];
  const s = /(?:^|\s)s(\S+)/.exec(ref)?.[1];
  const text = [w && `Word ${w}`, s && `meaning ${s}`].filter(Boolean).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// The learner pasted our own prompt (the clipboard still held it).
function looksLikePrompt(text) {
  return /Write fill-in-the-blank sentences/.test(text) && /^Rules:$/m.test(text) && /^Words:$/m.test(text);
}

// parseReply's "no JSON found" result (its only problem has no ref and no text).
function isUnreadable(parsed) {
  return !parsed.sentences.length && !parsed.duplicates && parsed.problems.length === 1 && !parsed.problems[0].ref && !('text' in parsed.problems[0]);
}

function scrollToEl(scroller, el, { offset = 12, smooth = true } = {}) {
  if (!scroller || !el || !el.isConnected) return;
  const top = scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
  scroller.scrollTo({ top: Math.max(0, top), behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
}

function errorScreen(ctx, { title, message, iconName = 'books' }) {
  const s = screen({
    title: 'Sentences',
    largeTitle: false,
    back: { label: ctx.backLabel },
    className: 'sentences-screen',
    body: [emptyState({ icon: iconName, title, message, action: { label: 'Go back', onTap: () => pop() } })],
  });
  // missing: the router skips this dead end when it restores a saved stack.
  return { el: s.el, title: 'Sentences', missing: true };
}

/* ---------- screen ---------- */

export default async function create(params, ctx) {
  const listId = params.listId;
  let list = null;
  try {
    list = await store.getList(listId);
  } catch (err) {
    console.warn('Could not load list', err);
  }
  if (!list) return errorScreen(ctx, { title: 'List not found', message: 'It may have been deleted.' });
  if (list.kind && list.kind !== 'vocab') {
    return errorScreen(ctx, { title: 'No sentences here', message: 'Sentences are made for word lists. Practise this list from its own page.', iconName: 'sparkles' });
  }
  try {
    return build(list, ctx);
  } catch (err) {
    console.warn('Sentences screen failed', err);
    return errorScreen(ctx, { title: 'Something went wrong', message: 'Please go back and open the list again.', iconName: 'info' });
  }
}

function build(initialList, ctx) {
  const listId = initialList.id;
  let list = initialList;
  if (!Array.isArray(list.sentences)) list = { ...list, sentences: [] };

  const aiCount = () => list.sentences.filter((s) => s.origin === 'ai').length;
  const itemIndex = () => new Map(list.items.map((item) => [item.id, { item }]));

  // "New set" choice: on by default, remembered for a while so a reply pasted
  // after iOS reopened the app is saved the way the learner chose.
  const savedMode = readJson(modeKey(listId));
  let newSetOn = savedMode && Date.now() - (savedMode.at || 0) < MODE_WINDOW ? savedMode.newSet !== false : true;
  const isNewSet = () => newSetOn && aiCount() > 0;
  const setNewSet = (value) => {
    newSetOn = value;
    newSetToggle.setChecked(value);
    writeStore(modeKey(listId), JSON.stringify({ newSet: value, at: Date.now() }));
  };

  const copiedAt = Number(readStore(copiedKey(listId))) || 0;
  let copiedRecently = Date.now() - copiedAt < RETURN_WINDOW;

  /* ---------- coverage header ---------- */

  const cov0 = coverage(list);
  const covRing = ring({ fraction: cov0.total ? cov0.covered / cov0.total : 0, size: 58, stroke: 6, label: '', labelSize: 14 });
  const covValue = covRing.el.querySelector('.ring-value');
  const covTitle = h('div', { class: 'sn-cov-title' });
  const covSub = h('div', { class: 'sn-cov-sub tabular' });
  const covCard = card({
    className: 'sn-cov',
    children: [covRing.el, h('div', { class: 'sn-cov-text' }, covTitle, covSub)],
  });

  function updateCoverage() {
    const cov = coverage(list);
    const count = list.sentences.length;
    const missing = cov.total - cov.covered;
    const short = `${cov.covered}/${cov.total}`;
    const label = short.length > 5 ? `${Math.round((100 * cov.covered) / Math.max(1, cov.total))}%` : short;
    covRing.set(cov.total ? cov.covered / cov.total : 0, label);
    covValue.style.stroke = cov.total && !missing ? 'var(--green)' : 'var(--accent)';
    if (!cov.total) {
      covTitle.textContent = 'This list has no words';
      covSub.textContent = 'Add words to the list first.';
    } else if (!cov.covered) {
      covTitle.textContent = 'No sentences yet';
      covSub.textContent = `${plural(cov.total, 'meaning')} in ${plural(list.items.length, 'word')}`;
    } else if (!missing) {
      covTitle.textContent = 'Every meaning has a sentence';
      covSub.textContent = `${cov.covered}/${cov.total} meanings · ${plural(count, 'sentence')}`;
    } else {
      covTitle.textContent = `${plural(missing, 'meaning')} still ${missing === 1 ? 'needs' : 'need'} a sentence`;
      covSub.textContent = `${cov.covered}/${cov.total} meanings · ${plural(count, 'sentence')}`;
    }
  }

  /* ---------- step 1: copy the prompt ---------- */

  function stepHead(n, title, text) {
    const num = h('span', { class: 'sn-step-num', 'aria-hidden': 'true' }, String(n));
    const el = h(
      'div',
      { class: 'sn-step-head' },
      num,
      h('div', { class: 'sn-step-titles' }, h('h2', { class: 'sn-step-title' }, title), text ? h('p', { class: 'sn-step-text' }, text) : null),
    );
    return { el, num };
  }

  function markStepDone(num, done) {
    num.classList.toggle('done', done);
    num.replaceChildren(done ? icon('check', { size: 16 }) : num.dataset.n);
  }

  const step1 = stepHead(1, 'Copy the prompt', 'Claude writes a sentence for each meaning.');
  step1.num.dataset.n = '1';

  const optRow = (label, control, sub) =>
    h(
      'div',
      { class: 'sn-opt' },
      h('div', { class: 'sn-opt-label' }, h('div', null, label), sub ? h('div', { class: 'sn-opt-sub' }, sub) : null),
      control,
    );

  const st = store.settings();
  const perControl = segmented({
    options: PER_OPTIONS,
    value: Number(st.sentencesPerSense) === 2 ? 2 : 1,
    ariaLabel: 'Sentences per meaning',
    onChange: (v) => {
      store.setSetting('sentencesPerSense', v);
      refreshPromptBox();
    },
  });
  perControl.classList.add('sn-seg-2');
  const levelControl = segmented({
    options: LEVEL_OPTIONS,
    value: LEVEL_OPTIONS.some((o) => o.value === st.level) ? st.level : 'B2',
    ariaLabel: 'Level',
    onChange: (v) => {
      store.setSetting('level', v);
      refreshPromptBox();
    },
  });
  levelControl.classList.add('sn-seg-3');
  const newSetToggle = toggle({
    checked: newSetOn,
    label: 'New set — avoid current sentences',
    onChange: (v) => {
      setNewSet(v);
      refreshPromptBox();
      refresh({ force: true });
    },
  });
  const newSetRow = optRow('New set', newSetToggle, 'Avoid the current sentences');

  const promptOptions = () => {
    const s = store.settings();
    return { sentencesPerSense: Number(s.sentencesPerSense) === 2 ? 2 : 1, level: s.level || 'B2', fresh: isNewSet() };
  };
  const fullPrompt = () => buildPrompt(list, promptOptions());

  const copyBtn = button({ label: 'Copy prompt', icon: 'copy', size: 'large', block: true, onTap: copyPrompt });
  const openBtn = button({ label: 'Open Claude', icon: 'externalLink', variant: 'plain', className: 'sn-link', onTap: openClaude });
  const discloseLabel = h('span', null, 'Show prompt');
  const discloseBtn = h(
    'button',
    { type: 'button', class: 'btn plain sn-link sn-disclose', 'aria-expanded': 'false', onClick: () => setPromptOpen(promptBox.hidden) },
    discloseLabel,
    icon('chevronDown', { size: 18 }),
  );
  const promptBox = textArea({ value: '', rows: 9, className: 'sn-prompt', ariaLabel: 'Prompt for Claude' });
  promptBox.readOnly = true;
  promptBox.hidden = true;
  // Tap the box → everything is selected, so the iOS "Copy" bubble copies it all.
  promptBox.addEventListener('focus', () => {
    setTimeout(() => {
      try {
        promptBox.setSelectionRange(0, promptBox.value.length);
      } catch {
        /* ignore */
      }
    }, 0);
  });

  function setPromptOpen(open, text) {
    promptBox.hidden = !open;
    discloseBtn.setAttribute('aria-expanded', String(open));
    discloseLabel.textContent = open ? 'Hide prompt' : 'Show prompt';
    if (open) {
      promptBox.value = text ?? fullPrompt();
      promptBox.scrollTop = 0;
    }
  }

  function refreshPromptBox() {
    if (!promptBox.hidden) promptBox.value = fullPrompt();
  }

  const step1Card = card({
    className: 'sn-step',
    children: [
      step1.el,
      h('div', { class: 'sn-opts' }, optRow('Sentences per meaning', perControl), optRow('Level', levelControl), newSetRow),
      copyBtn,
      h('div', { class: 'sn-links' }, openBtn, discloseBtn),
      promptBox,
    ],
  });

  let copyFlashTimer = 0;
  function flashCopied() {
    const label = copyBtn.querySelector('span');
    copyBtn.querySelector('svg').replaceWith(icon('check'));
    label.textContent = 'Copied';
    clearTimeout(copyFlashTimer);
    copyFlashTimer = setTimeout(() => {
      copyBtn.querySelector('svg').replaceWith(icon('copy'));
      label.textContent = 'Copy prompt';
    }, 1600);
  }

  function markCopied() {
    copiedRecently = true;
    writeStore(copiedKey(listId), String(Date.now()));
    markStepDone(step1.num, true);
  }

  function copyPrompt() {
    const text = fullPrompt();
    if (!text) {
      toast('This list has no words to ask about', { icon: 'xCircle', tone: 'red' });
      return;
    }
    // iOS only allows clipboard writes inside the tap itself: copy first.
    copyText(text).then((ok) => {
      if (ok) {
        flashCopied();
        markCopied();
        toast('Prompt copied — paste it into Claude');
      } else {
        setPromptOpen(true, text);
        toast('Could not copy. Select the prompt below instead.', { icon: 'xCircle', tone: 'red', duration: 3200 });
        requestAnimationFrame(() => scrollToEl(scroller, promptBox));
      }
    });
  }

  function openClaude() {
    flushDraft();
    window.open(CLAUDE_URL, '_blank', 'noopener');
  }

  /* ---------- step 2: paste the reply ---------- */

  const step2 = stepHead(2, "Paste Claude's reply", "Copy Claude's whole answer (or tap the copy icon on its code block) and paste it here.");
  step2.num.dataset.n = '2';

  const pasteBtn = button({ label: 'Paste reply', icon: 'clipboard', variant: 'tinted', size: 'large', block: true, onTap: pasteReply });
  const reply = textArea({
    value: readStore(draftKey(listId)) || '',
    placeholder: "Claude's reply goes here",
    rows: 6,
    answer: true,
    className: 'sn-reply',
    ariaLabel: "Claude's reply",
    onInput: () => {
      clearTimeout(inputTimer);
      inputTimer = setTimeout(runNow, INPUT_DELAY);
    },
  });
  reply.addEventListener('paste', () => setTimeout(runNow, 0));
  reply.addEventListener('blur', () => flushDraft());
  reply.addEventListener('focus', () => {
    // Wait for the keyboard, then bring the box (and the result below it) up.
    setTimeout(() => {
      if (document.activeElement === reply) scrollToEl(scroller, reply);
    }, 350);
  });

  const hintEl = h('span', { class: 'sn-reply-hint' });
  const clearBtn = h('button', { type: 'button', class: 'sn-clear', onClick: clearReply }, 'Clear');
  const metaEl = h('div', { class: 'sn-reply-meta' }, hintEl, clearBtn);
  const resultEl = h('div', { class: 'sn-result', 'aria-live': 'polite' });

  const step2Card = card({
    className: 'sn-step sn-step-2',
    children: [step2.el, pasteBtn, reply, metaEl, resultEl],
  });

  let inputTimer = 0;
  let saved = false;
  let current = null; // the latest plan()
  let resultKey = null;

  function flushDraft() {
    if (saved) return;
    writeStore(draftKey(listId), reply.value.trim() ? reply.value : '');
  }

  function runNow() {
    clearTimeout(inputTimer);
    inputTimer = 0;
    flushDraft();
    refresh();
  }

  function setReply(text) {
    reply.value = text;
    runNow();
  }

  function clearReply() {
    const before = reply.value;
    if (!before) return;
    setReply('');
    toast('Reply cleared', { icon: 'trash', tone: 'accent', action: { label: 'Undo', onTap: () => setReply(before) } });
  }

  async function pasteReply() {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      // Focus now, while still inside the tap, so the keyboard and Paste bubble appear.
      reply.focus();
      toast('Tap and hold in the box, then tap Paste', { icon: 'info', tone: 'accent', duration: 3200 });
      return;
    }
    const text = await readText();
    if (text === null) {
      reply.focus();
      toast('Tap and hold in the box, then tap Paste', { icon: 'info', tone: 'accent', duration: 3200 });
      return;
    }
    if (!text.trim()) {
      toast("The clipboard is empty — copy Claude's reply first", { icon: 'info', tone: 'accent', duration: 3200 });
      return;
    }
    if (document.activeElement === reply) reply.blur();
    setReply(text);
    reply.scrollTop = 0;
    requestAnimationFrame(() => {
      const target = resultEl.firstChild ? resultEl : reply;
      const box = target.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      if (box.bottom > view.bottom - 8 || box.top < view.top) scrollToEl(scroller, reply);
    });
  }

  // What saving the current reply would do.
  function plan(text) {
    const newSet = isNewSet();
    if (looksLikePrompt(text)) {
      const parsed = { sentences: [], problems: [], missing: [], duplicates: 0 };
      return { text, newSet, parsed, fresh: [], duplicates: 0, result: list.sentences, understood: false, unreadable: false, isPrompt: true, missing: [] };
    }
    const kept = newSet ? list.sentences.filter((s) => s.origin !== 'ai') : list.sentences;
    const parsed = parseReply(text, { ...list, sentences: kept });
    const fresh = dedupe(parsed.sentences, kept);
    const duplicates = parsed.duplicates + (parsed.sentences.length - fresh.length);
    const result = [...kept, ...fresh];
    const understood = parsed.sentences.length + parsed.duplicates > 0;
    return {
      text,
      newSet,
      parsed,
      fresh,
      duplicates,
      result,
      understood,
      unreadable: isUnreadable(parsed),
      missing: understood ? coverage({ ...list, sentences: result }).missing : [],
    };
  }

  function note(tone, iconName, title, ...body) {
    return h(
      'div',
      { class: ['sn-note', tone] },
      h('span', { class: 'sn-note-icon' }, icon(iconName, { size: 20 })),
      h('div', { class: 'sn-note-body' }, h('div', { class: 'sn-note-title' }, title), body),
    );
  }

  function missingLabel(pair, index) {
    const entry = index.get(pair.itemId);
    if (!entry) return null;
    return senseCount(entry.item) > 1 ? `${entry.item.word} (meaning ${pair.sense + 1})` : entry.item.word;
  }

  function renderResult(p) {
    if (p.isPrompt) {
      resultEl.replaceChildren(note('warn', 'info', 'This is the prompt, not the reply', h('div', { class: 'sn-note-text' }, "Paste it into Claude first. Then copy Claude's answer and paste it here.")));
      return;
    }
    const parts = [];
    const ai = aiCount();
    if (p.fresh.length) {
      const sub = [];
      if (p.newSet && ai) sub.push(`They replace the current ${plural(ai, 'sentence')} from Claude.`);
      if (p.duplicates) sub.push(`${p.duplicates} already saved, so ${p.duplicates === 1 ? 'it is' : 'they are'} skipped.`);
      parts.push(note('ok', 'checkCircle', `${plural(p.fresh.length, 'sentence')} ready`, sub.length ? h('div', { class: 'sn-note-text' }, sub.join(' ')) : null));
    } else if (p.duplicates && !p.parsed.problems.length) {
      parts.push(note('info', 'info', p.duplicates === 1 ? 'This sentence is already saved' : `These ${p.duplicates} sentences are already saved`, h('div', { class: 'sn-note-text' }, 'Copy the prompt again to get a new set.')));
    }

    if (p.unreadable) {
      parts.push(note('warn', 'xCircle', 'No sentences found', h('div', { class: 'sn-note-text' }, p.parsed.problems[0].reason)));
    } else if (!p.understood && !p.parsed.problems.length) {
      parts.push(note('warn', 'xCircle', 'No sentences found', h('div', { class: 'sn-note-text' }, 'The reply has no sentences in it.')));
    } else if (p.parsed.problems.length) {
      const problems = p.parsed.problems;
      const shown = problems.slice(0, MAX_PROBLEMS);
      parts.push(
        note(
          'warn',
          'xCircle',
          `${plural(problems.length, 'sentence')} will be skipped`,
          h(
            'ul',
            { class: 'sn-note-list' },
            shown.map((pr) => {
              const ref = refLabel(pr.ref);
              return h('li', null, ref ? h('span', { class: 'sn-ref' }, `${ref}: `) : null, pr.reason);
            }),
            problems.length > shown.length ? h('li', { class: 'sn-more' }, `and ${problems.length - shown.length} more`) : null,
          ),
        ),
      );
    }

    if (p.missing.length) {
      const index = itemIndex();
      const names = p.missing.map((m) => missingLabel(m, index)).filter(Boolean);
      const shown = names.slice(0, MAX_MISSING);
      const rest = names.length - shown.length;
      const text = `Still missing: ${shown.join(', ')}${rest ? `, and ${rest} more` : ''}`;
      const copyMissingBtn = button({ label: 'Copy prompt for the missing ones', icon: 'copy', variant: 'tinted', block: true, className: 'sn-missing-btn', onTap: copyMissing });
      parts.push(
        h('div', { class: 'sn-note info sn-missing' }, h('span', { class: 'sn-note-icon' }, icon('info', { size: 20 })), h('div', { class: 'sn-note-body sn-note-text' }, text)),
        h(
          'div',
          { class: 'sn-missing-actions' },
          copyMissingBtn,
          p.fresh.length ? h('div', { class: 'sn-missing-foot' }, `Saves the ${plural(p.fresh.length, 'ready sentence')} first.`) : null,
        ),
      );
    }
    resultEl.replaceChildren(...parts);
  }

  function signature(p) {
    if (!p.text.trim()) return '';
    return JSON.stringify([
      p.fresh.length,
      p.duplicates,
      p.newSet,
      aiCount(),
      p.unreadable,
      p.understood,
      !!p.isPrompt,
      p.parsed.problems.map((x) => [x.ref, x.reason]),
      p.missing.map((m) => `${m.itemId}#${m.sense}`),
    ]);
  }

  function refresh({ force = false } = {}) {
    const has = !!reply.value.trim();
    current = has ? plan(reply.value) : null;
    const key = current ? signature(current) : '';
    if (force || key !== resultKey) {
      resultKey = key;
      if (current) renderResult(current);
      else resultEl.replaceChildren();
    }
    hintEl.textContent = has ? 'Kept as a draft until you save' : 'Or tap and hold in the box, then tap Paste';
    clearBtn.hidden = !has;
    const n = current ? current.fresh.length : 0;
    saveLabel.textContent = n ? `Save ${plural(n, 'sentence')}` : 'Save sentences';
    if (!saving) saveBtn.disabled = n === 0;
  }

  /* ---------- saving ---------- */

  let saving = false;
  const saveBtn = button({ label: 'Save sentences', size: 'large', block: true, disabled: true, onTap: save });
  const saveLabel = saveBtn.querySelector('span');

  // Applies the plan to the latest stored copy of the list.
  async function commit(p) {
    const latest = (await store.getList(listId)) || list;
    const base = Array.isArray(latest.sentences) ? latest.sentences : [];
    const kept = p.newSet ? base.filter((s) => s.origin !== 'ai') : base;
    const added = dedupe(p.fresh, kept);
    list = await store.saveList({ ...latest, sentences: [...kept, ...added] });
    return added.length;
  }

  async function save() {
    if (saving) return;
    runNow();
    const p = current;
    if (!p || !p.fresh.length) return;
    saving = true;
    saveBtn.disabled = true;
    try {
      const n = await commit(p);
      saved = true;
      clearTimeout(inputTimer);
      writeStore(draftKey(listId), '');
      writeStore(modeKey(listId), '');
      writeStore(copiedKey(listId), '');
      toast(`Saved ${plural(n, 'sentence')}`);
      const left = await pop();
      if (!left) {
        // Still here (navigation was busy): show the saved state.
        saved = false;
        reply.value = '';
        afterListChange();
      }
    } catch (err) {
      console.warn('Saving sentences failed', err);
      toast('Could not save. Please try again.', { icon: 'xCircle', tone: 'red' });
    } finally {
      saving = false;
      refresh();
    }
  }

  // "Copy prompt for the missing ones": copy first (inside the tap), then save
  // the sentences that are ready so the next paste cannot wipe them.
  function copyMissing() {
    runNow();
    const p = current;
    if (!p || !p.missing.length) return;
    const options = { ...promptOptions(), only: p.missing, fresh: p.newSet };
    const text = buildPrompt(p.newSet ? list : { ...list, sentences: p.result }, options);
    if (!text) return;
    copyText(text).then(async (ok) => {
      if (!ok) {
        setPromptOpen(true, text);
        toast('Could not copy. Select the prompt above instead.', { icon: 'xCircle', tone: 'red', duration: 3200 });
        requestAnimationFrame(() => scrollToEl(scroller, promptBox));
        return;
      }
      markCopied();
      if (!p.fresh.length || saving) {
        toast('Prompt copied — paste it into Claude');
        return;
      }
      saving = true;
      try {
        const n = await commit(p);
        // The new set is saved; what comes back next is added to it.
        setNewSet(false);
        reply.value = '';
        flushDraft();
        afterListChange();
        toast(`Saved ${plural(n, 'sentence')}. Prompt for the rest copied.`, { duration: 3200 });
      } catch (err) {
        console.warn('Saving sentences failed', err);
        toast('Prompt copied, but saving failed. Tap Save first.', { icon: 'xCircle', tone: 'red', duration: 3500 });
      } finally {
        saving = false;
        refresh({ force: true });
      }
    });
  }

  /* ---------- current sentences ---------- */

  const curCount = h('span', { class: 'sn-cur-count tabular' });
  const curHead = h(
    'button',
    { type: 'button', class: 'sn-cur-head', 'aria-expanded': 'false', onClick: () => setCurrentOpen(curBody.hidden) },
    h('span', { class: 'sn-cur-label' }, h('span', { class: 'sn-cur-title' }, 'Current sentences'), curCount),
    h('span', { class: 'sn-cur-chevron' }, icon('chevronDown', { size: 20 })),
  );
  const curBody = h('div', { class: 'sn-cur-body' });
  curBody.hidden = true;
  const curSection = h('section', { class: 'sn-current' }, curHead, curBody);
  let curBuilt = false;

  function setCurrentOpen(open) {
    curHead.setAttribute('aria-expanded', String(open));
    if (open && !curBuilt) buildCurrent();
    curBody.hidden = !open;
    if (open) {
      requestAnimationFrame(() => {
        const head = curHead.getBoundingClientRect();
        const view = scroller.getBoundingClientRect();
        if (head.top > view.top + view.height * 0.45) scrollToEl(scroller, curHead, { offset: 8 });
      });
    }
  }

  function sentenceText(text) {
    const parts = clozeParts(text);
    if (!parts) return unbracket(text);
    return [unbracket(parts.before), h('strong', { class: 'sn-answer' }, parts.answer), unbracket(parts.after)];
  }

  function sentenceRow(item, s) {
    const caption = [];
    if (senseCount(item) > 1) {
      const meaning = String(item.senses[s.sense] ?? '').trim();
      caption.push(h('span', { class: 'sn-sense' }, h('strong', null, `Meaning ${s.sense + 1}`), meaning ? ` · ${meaning}` : ''));
    }
    if (s.origin === 'user') caption.push(badge('From your notes', 'teal'));
    const rowEl = h(
      'div',
      { class: 'sn-row' },
      h(
        'div',
        { class: 'sn-row-main' },
        caption.length ? h('div', { class: 'sn-caption' }, caption) : null,
        h('p', { class: 'sn-text' }, sentenceText(s.text)),
        s.vi ? h('p', { class: 'sn-vi', lang: 'vi' }, s.vi) : null,
      ),
      iconButton({ icon: 'trash', label: 'Delete sentence', className: 'sn-trash', onTap: () => removeSentence(s, rowEl) }),
    );
    return rowEl;
  }

  function buildCurrent() {
    curBuilt = true;
    const byItem = new Map();
    for (const s of list.sentences) {
      if (!byItem.has(s.itemId)) byItem.set(s.itemId, []);
      byItem.get(s.itemId).push(s);
    }
    const groups = [];
    for (const item of list.items) {
      const sentences = byItem.get(item.id);
      if (!sentences || !sentences.length) continue;
      sentences.sort((a, b) => a.sense - b.sense || (a.createdAt || 0) - (b.createdAt || 0));
      groups.push(
        h(
          'div',
          { class: 'group sn-word-group' },
          h('div', { class: 'sn-word-head' }, h('span', { class: 'sn-word' }, item.word), posBadge(item.pos)),
          sentences.map((s) => sentenceRow(item, s)),
        ),
      );
    }
    curBody.replaceChildren(...groups);
  }

  function updateCurrentHeader() {
    const n = list.sentences.length;
    curCount.textContent = String(n);
    curSection.hidden = n === 0;
  }

  async function removeSentence(s, rowEl) {
    const plain = unbracket(s.text);
    const ok = await confirm({
      title: 'Delete this sentence?',
      message: plain.length > 140 ? `${plain.slice(0, 140)}…` : plain,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      const latest = (await store.getList(listId)) || list;
      list = await store.saveList({ ...latest, sentences: (latest.sentences || []).filter((x) => x.id !== s.id) });
    } catch (err) {
      console.warn('Deleting a sentence failed', err);
      toast('Could not delete. Please try again.', { icon: 'xCircle', tone: 'red' });
      return;
    }
    const group = rowEl.parentElement;
    const done = () => {
      rowEl.remove();
      if (group && !group.querySelector('.sn-row')) group.remove();
    };
    if (reducedMotion()) done();
    else {
      rowEl.style.pointerEvents = 'none';
      rowEl
        .animate([{ opacity: 1, transform: 'translate3d(0,0,0)' }, { opacity: 0, transform: 'translate3d(-24px,0,0)' }], { duration: 220, easing: 'ease-in', fill: 'forwards' })
        .finished.then(done, done);
    }
    afterListChange({ rebuild: false });
  }

  // Everything that depends on the saved list.
  function afterListChange({ rebuild = true } = {}) {
    updateCoverage();
    newSetRow.hidden = aiCount() === 0;
    updateCurrentHeader();
    if (rebuild) {
      curBuilt = false;
      if (!curBody.hidden) buildCurrent();
    }
    refreshPromptBox();
    refresh({ force: true });
  }

  /* ---------- layout ---------- */

  const s = screen({
    title: 'Sentences',
    subtitle: list.title || '',
    largeTitle: true,
    back: { label: ctx.backLabel },
    className: 'sentences-screen',
    body: [covCard, step1Card, step2Card, curSection],
    footer: [saveBtn],
  });
  const scroller = s.scroll;

  if (copiedRecently) markStepDone(step1.num, true);
  afterListChange({ rebuild: false });

  // Coming back from the Claude app (or reopened by iOS): start at step 2.
  const wantsStep2 = () => !!reply.value.trim() || copiedRecently;
  if (wantsStep2()) {
    // Runs after the router has inserted the screen, before the first paint.
    requestAnimationFrame(() => scrollToEl(scroller, step2Card, { offset: 8, smooth: false }));
  }

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      flushDraft();
    } else if (copiedRecently && !reply.value.trim() && document.activeElement !== reply) {
      scrollToEl(scroller, step2Card, { offset: 8 });
    }
  };
  const onPageHide = () => flushDraft();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);

  return {
    el: s.el,
    title: 'Sentences',
    onHide: () => flushDraft(),
    onDestroy: () => {
      clearTimeout(inputTimer);
      flushDraft();
      clearTimeout(copyFlashTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    },
  };
}
