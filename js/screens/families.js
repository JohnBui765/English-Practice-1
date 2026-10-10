// "Make word families" screen (route B, like Sentences). The app cannot build
// word families itself, so the learner copies a prompt into the Claude app and
// pastes Claude's JSON reply back here. The reply box is kept as a draft in
// localStorage, so nothing is lost when iOS closes the app while the learner
// is away in Claude (the router then brings this screen back).
// params: { listId }
import { h, reducedMotion } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { screen, card, button, segmented, toggle, textArea, badge, posBadge, ring, emptyState, toast } from '../ui/components.js';
import { pop } from '../ui/router.js';
import { copyText, readText } from '../ui/clipboard.js';
import { buildFamilyPrompt, parseFamilyReply, familyStatus, isFamilyReady, applyFamilies, memberForms, modelIndex } from '../core/families.js';
import { plural } from '../core/util.js';
import * as store from '../data/store.js';

const CLAUDE_URL = 'https://claude.ai/new';
const INPUT_DELAY = 250; // ms: live parse + draft save while typing
const RETURN_WINDOW = 60 * 60 * 1000; // prompt copied this recently → open at step 2
const REDO_WINDOW = 12 * 60 * 60 * 1000; // remembered "Redo every family" choice
const MAX_PROBLEMS = 5;
const MAX_MISSING = 6;

const draftKey = (id) => `vs.families.draft.${id}`;
const redoKey = (id) => `vs.families.redo.${id}`;
const copiedKey = (id) => `vs.families.copied.${id}`;

const LEVEL_OPTIONS = [
  { value: 'B1', label: 'B1' },
  { value: 'B2', label: 'B2' },
  { value: 'C1', label: 'C1' },
];

const families = (n) => plural(n, 'family', 'families');

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

// The word a family is known by: the pasted root, or its model member.
function familyName(item) {
  const root = String(item?.root ?? '').trim();
  if (root) return root;
  const members = item?.members || [];
  const model = members[modelIndex(item)];
  return model ? memberForms(model)[0] || model.word : '';
}

// The learner pasted our own prompt (the clipboard still held it).
function looksLikePrompt(text) {
  return /give me its word family/.test(text) && /^Words:$/m.test(text);
}

// parseFamilyReply's "no JSON found" result: one problem with no ref, text or skipped.
function isUnreadable(parsed) {
  if (parsed.families.length || parsed.problems.length !== 1) return false;
  const p = parsed.problems[0];
  return !p.ref && !('text' in p) && !('skipped' in p);
}

function scrollToEl(scroller, el, { offset = 12, smooth = true } = {}) {
  if (!scroller || !el || !el.isConnected) return;
  const top = scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
  scroller.scrollTo({ top: Math.max(0, top), behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
}

function errorScreen(ctx, { title, message, iconName = 'books' }) {
  const s = screen({
    title: 'Word families',
    largeTitle: false,
    back: { label: ctx.backLabel },
    className: 'families-screen',
    body: [emptyState({ icon: iconName, title, message, action: { label: 'Go back', onTap: () => pop() } })],
  });
  // missing: the router skips this dead end when it restores a saved stack.
  return { el: s.el, title: 'Word families', missing: true };
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
  if (list.kind !== 'family') {
    return errorScreen(ctx, { title: 'No families here', message: 'Word families are made for family lists. Practise this list from its own page.', iconName: 'family' });
  }
  try {
    return build(list, ctx);
  } catch (err) {
    console.warn('Word families screen failed', err);
    return errorScreen(ctx, { title: 'Something went wrong', message: 'Please go back and open the list again.', iconName: 'info' });
  }
}

function build(initialList, ctx) {
  const listId = initialList.id;
  let list = { ...initialList, items: initialList.items || [] };

  const itemById = (id) => list.items.find((item) => item.id === id) || null;
  const formCount = (items) => items.reduce((n, item) => n + (isFamilyReady(item) ? (item.members || []).length : 0), 0);

  // "Redo every family": off by default, remembered for a while so the prompt
  // and the result read the same after iOS reopens the app.
  const savedRedo = readJson(redoKey(listId));
  let redoOn = !!(savedRedo && Date.now() - (savedRedo.at || 0) < REDO_WINDOW && savedRedo.redo);
  const isRedo = () => redoOn && familyStatus(list).ready > 0;

  const copiedAt = Number(readStore(copiedKey(listId))) || 0;
  let copiedRecently = Date.now() - copiedAt < RETURN_WINDOW;

  /* ---------- status header ---------- */

  const st0 = familyStatus(list);
  const statusRing = ring({ fraction: st0.total ? st0.ready / st0.total : 0, size: 58, stroke: 6, label: '', labelSize: 14 });
  const ringValue = statusRing.el.querySelector('.ring-value');
  const statusTitle = h('div', { class: 'fm-status-title' });
  const statusSub = h('div', { class: 'fm-status-sub tabular' });
  const statusCard = card({
    className: 'fm-status',
    children: [statusRing.el, h('div', { class: 'fm-status-text' }, statusTitle, statusSub)],
  });

  function updateStatus() {
    const st = familyStatus(list);
    const waiting = st.pending.length;
    const short = `${st.ready}/${st.total}`;
    const label = short.length > 5 ? `${Math.round((100 * st.ready) / Math.max(1, st.total))}%` : short;
    statusRing.set(st.total ? st.ready / st.total : 0, label);
    ringValue.style.stroke = st.total && !waiting ? 'var(--green)' : 'var(--accent)';
    const forms = plural(formCount(list.items), 'form');
    if (!st.total) {
      statusTitle.textContent = 'This list has no words';
      statusSub.textContent = 'Add words to the list first.';
    } else if (!st.ready) {
      statusTitle.textContent = 'No families yet';
      statusSub.textContent = `${plural(st.total, 'word')} waiting for Claude`;
    } else if (!waiting) {
      statusTitle.textContent = 'Every word has its family';
      statusSub.textContent = `${families(st.ready)} · ${forms}`;
    } else {
      statusTitle.textContent = `${plural(waiting, 'word')} still ${waiting === 1 ? 'needs' : 'need'} a family`;
      statusSub.textContent = `${st.ready}/${st.total} words · ${forms}`;
    }
  }

  /* ---------- step 1: copy the prompt ---------- */

  function stepHead(n, title, text) {
    const num = h('span', { class: 'fm-step-num', 'aria-hidden': 'true', dataset: { n } }, String(n));
    const textEl = h('p', { class: 'fm-step-text' }, text || '');
    const el = h('div', { class: 'fm-step-head' }, num, h('div', { class: 'fm-step-titles' }, h('h2', { class: 'fm-step-title' }, title), textEl));
    return { el, num, textEl };
  }

  function markStepDone(num, done) {
    num.classList.toggle('done', done);
    num.replaceChildren(done ? icon('check', { size: 16 }) : num.dataset.n);
  }

  const step1 = stepHead(1, 'Copy the prompt', '');

  const optRow = (label, control, sub) => {
    const subEl = sub ? h('div', { class: 'fm-opt-sub' }, sub) : null;
    const el = h('div', { class: 'fm-opt' }, h('div', { class: 'fm-opt-label' }, h('div', null, label), subEl), control);
    return { el, subEl };
  };

  const st = store.settings();
  const levelControl = segmented({
    options: LEVEL_OPTIONS,
    value: LEVEL_OPTIONS.some((o) => o.value === st.level) ? st.level : 'B2',
    ariaLabel: 'Level',
    onChange: (v) => {
      store.setSetting('level', v);
      refreshPromptBox();
    },
  });
  levelControl.classList.add('fm-seg-3');
  const translateToggle = toggle({
    checked: st.familyTranslate !== false,
    label: 'Vietnamese translations',
    onChange: (v) => {
      store.setSetting('familyTranslate', v);
      refreshPromptBox();
    },
  });
  const redoToggle = toggle({
    checked: redoOn,
    label: 'Redo every family',
    onChange: (v) => {
      redoOn = v;
      writeStore(redoKey(listId), JSON.stringify({ redo: v, at: Date.now() }));
      updateStep1();
      refreshPromptBox();
      refresh({ force: true });
    },
  });
  const levelRow = optRow('Level', levelControl);
  const translateRow = optRow('Vietnamese translations', translateToggle, 'For every example');
  const redoRow = optRow('Redo every family', redoToggle, ' ');

  const promptOptions = () => {
    const s = store.settings();
    return {
      level: LEVEL_OPTIONS.some((o) => o.value === s.level) ? s.level : 'B2',
      translate: s.familyTranslate !== false,
      only: isRedo() ? null : familyStatus(list).pending,
    };
  };
  const fullPrompt = () => buildFamilyPrompt(list, promptOptions());

  const copyBtn = button({ label: 'Copy prompt', icon: 'copy', size: 'large', block: true, onTap: copyPrompt });
  const openBtn = button({ label: 'Open Claude', icon: 'externalLink', variant: 'plain', className: 'fm-link', onTap: openClaude });
  const discloseLabel = h('span', null, 'Show prompt');
  const discloseBtn = h(
    'button',
    { type: 'button', class: 'btn plain fm-link fm-disclose', 'aria-expanded': 'false', onClick: () => setPromptOpen(promptBox.hidden) },
    discloseLabel,
    icon('chevronDown', { size: 18 }),
  );
  const promptBox = textArea({ value: '', rows: 9, className: 'fm-prompt', ariaLabel: 'Prompt for Claude' });
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
      promptBox.value = text ?? (fullPrompt() || nothingToAsk());
      promptBox.scrollTop = 0;
    }
  }

  function refreshPromptBox() {
    if (!promptBox.hidden) promptBox.value = fullPrompt() || nothingToAsk();
  }

  const nothingToAsk = () => (list.items.length ? 'Every word has its family. Turn on “Redo every family” to ask Claude again.' : 'This list has no words yet.');

  function updateStep1() {
    const stat = familyStatus(list);
    redoRow.el.hidden = stat.ready === 0;
    if (!stat.total) step1.textEl.textContent = 'Add words to the list first.';
    else if (!stat.pending.length && !isRedo()) step1.textEl.textContent = 'Every word has its family. Turn on Redo to ask Claude again.';
    else step1.textEl.textContent = "Claude finds each word's family and writes an example for every form.";
    redoRow.subEl.textContent = stat.pending.length ? `Also ask again for the ${stat.ready === 1 ? 'ready one' : `${stat.ready} ready ones`}` : 'Ask Claude again for every word';
    // Nothing to ask for: the step text says to turn on Redo.
    copyBtn.disabled = !stat.total || (!stat.pending.length && !isRedo());
  }

  const step1Card = card({
    className: 'fm-step',
    children: [step1.el, h('div', { class: 'fm-opts' }, levelRow.el, translateRow.el, redoRow.el), copyBtn, h('div', { class: 'fm-links' }, openBtn, discloseBtn), promptBox],
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
      if (list.items.length) toast('Every word has its family — turn on Redo to ask again', { icon: 'info', tone: 'accent', duration: 3200 });
      else toast('This list has no words to ask about', { icon: 'xCircle', tone: 'red' });
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

  const pasteBtn = button({ label: 'Paste reply', icon: 'clipboard', variant: 'tinted', size: 'large', block: true, onTap: pasteReply });
  const reply = textArea({
    value: readStore(draftKey(listId)) || '',
    placeholder: "Claude's reply goes here",
    rows: 6,
    answer: true,
    className: 'fm-reply',
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

  const hintEl = h('span', { class: 'fm-reply-hint' });
  const clearBtn = h('button', { type: 'button', class: 'fm-clear', onClick: clearReply }, 'Clear');
  const metaEl = h('div', { class: 'fm-reply-meta' }, hintEl, clearBtn);
  const resultEl = h('div', { class: 'fm-result', 'aria-live': 'polite' });

  const step2Card = card({
    className: 'fm-step fm-step-2',
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

  // "w2" / "w2 member 3" → the id of word 2; null for other refs.
  function refItemId(ref) {
    const m = /^w(\d+)(?: member \d+)?$/.exec(ref || '');
    return m ? list.items[Number(m[1]) - 1]?.id ?? null : null;
  }

  // What saving the current reply would do.
  function plan(text) {
    if (looksLikePrompt(text)) {
      return { text, isPrompt: true, families: [], forms: 0, replaced: 0, problems: [], missing: [], doubtful: [], unreadable: false, understood: false };
    }
    const parsed = parseFamilyReply(text, list);
    const ids = new Set(list.items.map((item) => item.id));
    const found = parsed.families.filter((f) => ids.has(f.itemId));
    // Only complete families are saved: a lone word that came back must not
    // replace a family the learner already has. It is listed as skipped.
    const ready = found.filter((f) => isFamilyReady(f));
    const lone = new Set(found.filter((f) => !isFamilyReady(f)).map((f) => f.itemId));
    const problems = parsed.problems.filter((x) => !lone.has(refItemId(x.ref)));
    list.items.forEach((item, i) => {
      if (lone.has(item.id)) problems.push({ ref: `w${i + 1}`, reason: 'Only one word came back for this family.', skipped: true });
    });
    problems.sort((a, b) => refOrder(a.ref) - refOrder(b.ref));
    // A family kept on a word it may not belong to: Save keeps it, but
    // "Copy prompt for the missing ones" asks for it again instead.
    const readyById = new Map(ready.map((f) => [f.itemId, f]));
    const doubtful = problems
      .filter((x) => x.skipped === false && /is the word number right\?$/.test(x.reason))
      .map((x) => refItemId(x.ref))
      .filter((id) => readyById.has(id));
    const understood = found.length > 0;
    return {
      text,
      families: ready,
      forms: ready.reduce((n, f) => n + f.members.length, 0),
      replaced: ready.filter((f) => isFamilyReady(itemById(f.itemId))).length,
      problems,
      unreadable: isUnreadable(parsed),
      understood,
      // Still pending after saving: a word whose family is already saved never is.
      missing: understood ? list.items.filter((item) => !isFamilyReady(readyById.get(item.id) || item)).map((item) => item.id) : [],
      doubtful,
    };
  }

  // Word order of a problem ref: unnumbered first, then w1, w1 member 2, w2…
  function refOrder(ref) {
    const m = /^w(\d+)(?: member (\d+))?$/.exec(ref || '');
    if (m) return Number(m[1]) * 1000 + Number(m[2] || 0);
    return ref == null ? -1 : Infinity;
  }

  function note(tone, iconName, title, ...body) {
    return h(
      'div',
      { class: ['fm-note', tone] },
      h('span', { class: 'fm-note-icon' }, icon(iconName, { size: 20 })),
      h('div', { class: 'fm-note-body' }, h('div', { class: 'fm-note-title' }, title), body),
    );
  }

  // "w2" → "demonstrate", "w2 member 3" → "demonstrate, form 3".
  function refLabel(ref) {
    if (!ref) return '';
    const m = /^w(\d+)(?: member (\d+))?$/.exec(ref);
    if (!m) return ref;
    const item = list.items[Number(m[1]) - 1];
    const name = (item && familyName(item)) || `Word ${m[1]}`;
    return m[2] ? `${name}, form ${m[2]}` : name;
  }

  function problemList(problems) {
    const shown = problems.slice(0, MAX_PROBLEMS);
    return h(
      'ul',
      { class: 'fm-note-list' },
      shown.map((pr) => {
        const ref = refLabel(pr.ref);
        return h('li', null, ref ? h('span', { class: 'fm-ref' }, `${ref}: `) : null, pr.reason);
      }),
      problems.length > shown.length ? h('li', { class: 'fm-more' }, `and ${problems.length - shown.length} more`) : null,
    );
  }

  function skippedTitle(skipped) {
    const fams = skipped.filter((p) => !/ member /.test(p.ref || '')).length;
    const forms = skipped.length - fams;
    const parts = [];
    if (fams) parts.push(families(fams));
    if (forms) parts.push(plural(forms, 'form'));
    return `${parts.join(' and ')} will be skipped`;
  }

  function renderResult(p) {
    if (p.isPrompt) {
      resultEl.replaceChildren(note('warn', 'info', 'This is the prompt, not the reply', h('div', { class: 'fm-note-text' }, "Paste it into Claude first. Then copy Claude's answer and paste it here.")));
      return;
    }
    const parts = [];
    if (p.families.length) {
      const all = p.replaced === p.families.length;
      let sub = '';
      if (p.replaced === 1) sub = all ? 'It replaces the saved family.' : 'One of them replaces a saved family.';
      else if (p.replaced) sub = all ? 'They replace the saved families.' : `${p.replaced} of them replace saved families.`;
      parts.push(note('ok', 'checkCircle', `${families(p.families.length)} · ${plural(p.forms, 'form')} ready`, sub ? h('div', { class: 'fm-note-text' }, sub) : null));
    }

    const skipped = p.problems.filter((x) => x.skipped === true);
    const flawed = p.problems.filter((x) => x.skipped === false);
    if (p.unreadable) {
      parts.push(note('warn', 'xCircle', 'No families found', h('div', { class: 'fm-note-text' }, p.problems[0].reason)));
    } else if (!p.understood && !p.problems.length) {
      parts.push(note('warn', 'xCircle', 'No families found', h('div', { class: 'fm-note-text' }, 'The reply has no word families in it.')));
    } else {
      if (!p.understood && p.problems.length) {
        parts.push(note('warn', 'xCircle', 'No families found', problemList(p.problems)));
      } else {
        if (skipped.length) parts.push(note('warn', 'xCircle', skippedTitle(skipped), problemList(skipped)));
        if (flawed.length) parts.push(note('warn', 'info', 'Kept, but worth a check', problemList(flawed)));
      }
    }

    if (p.missing.length) {
      const names = p.missing.map((id) => familyName(itemById(id))).filter(Boolean);
      const shown = names.slice(0, MAX_MISSING);
      const rest = names.length - shown.length;
      const text = `Still missing: ${shown.join(', ')}${rest ? `, and ${rest} more` : ''}`;
      const copyMissingBtn = button({ label: 'Copy prompt for the missing ones', icon: 'copy', variant: 'tinted', block: true, className: 'fm-missing-btn', onTap: copyMissing });
      const first = autoSaved(p).length;
      const again = p.doubtful.map((id) => familyName(itemById(id))).filter(Boolean).join(', ');
      let foot = first ? (first === 1 ? 'Saves the ready family first' : `Saves the ${first} ready families first`) : '';
      if (again) foot = first ? `${foot}, and asks again for ${again}` : `Also asks again for ${again}`;
      parts.push(
        h('div', { class: 'fm-note info fm-missing' }, h('span', { class: 'fm-note-icon' }, icon('info', { size: 20 })), h('div', { class: 'fm-note-body fm-note-text' }, text)),
        h('div', { class: 'fm-missing-actions' }, copyMissingBtn, foot ? h('div', { class: 'fm-missing-foot' }, `${foot}.`) : null),
      );
    }
    resultEl.replaceChildren(...parts);
  }

  function signature(p) {
    if (!p.text.trim()) return '';
    return JSON.stringify([
      p.families.map((f) => `${f.itemId}:${f.members.length}:${f.note ? 1 : 0}`),
      p.forms,
      p.replaced,
      p.unreadable,
      p.understood,
      !!p.isPrompt,
      p.problems.map((x) => [x.ref, x.reason, x.skipped]),
      p.missing,
      p.doubtful,
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
    const n = current ? current.families.length : 0;
    saveLabel.textContent = n ? `Save ${families(n)}` : 'Save families';
    if (!saving) saveBtn.disabled = n === 0;
  }

  /* ---------- saving ---------- */

  let saving = false;
  const saveBtn = button({ label: 'Save families', size: 'large', block: true, disabled: true, onTap: save });
  const saveLabel = saveBtn.querySelector('span');

  // Writes the reply's families into the latest stored copy of the list:
  // members (and note) of the families that came back, every other family kept.
  async function commit(p) {
    const latest = (await store.getList(listId)) || list;
    const items = latest.items || [];
    const ids = new Set(items.map((item) => item.id));
    const found = p.families.filter((f) => ids.has(f.itemId) && isFamilyReady(f));
    list = await store.saveList({ ...latest, items: applyFamilies(items, found) });
    return found.length;
  }

  async function save() {
    if (saving) return;
    runNow();
    const p = current;
    if (!p || !p.families.length) return;
    saving = true;
    saveBtn.disabled = true;
    try {
      const n = await commit(p);
      saved = true;
      clearTimeout(inputTimer);
      writeStore(draftKey(listId), '');
      writeStore(redoKey(listId), '');
      writeStore(copiedKey(listId), '');
      toast(`Saved ${families(n)}`);
      const left = await pop();
      if (!left) {
        // Still here (navigation was busy): show the saved state.
        saved = false;
        reply.value = '';
        afterListChange();
      }
    } catch (err) {
      console.warn('Saving families failed', err);
      toast('Could not save. Please try again.', { icon: 'xCircle', tone: 'red' });
    } finally {
      saving = false;
      refresh();
    }
  }

  // The families "Copy prompt for the missing ones" saves on its own: not one
  // whose word number looks wrong (only Save keeps that one).
  const autoSaved = (p) => p.families.filter((f) => !p.doubtful.includes(f.itemId));

  // "Copy prompt for the missing ones": copy first (inside the tap), then save
  // the families that are ready so the next paste cannot wipe them.
  function copyMissing() {
    runNow();
    const p = current;
    if (!p || !p.missing.length) return;
    const text = buildFamilyPrompt(list, { ...promptOptions(), only: [...p.missing, ...p.doubtful] });
    if (!text) return;
    copyText(text).then(async (ok) => {
      if (!ok) {
        setPromptOpen(true, text);
        toast('Could not copy. Select the prompt above instead.', { icon: 'xCircle', tone: 'red', duration: 3200 });
        requestAnimationFrame(() => scrollToEl(scroller, promptBox));
        return;
      }
      markCopied();
      const first = autoSaved(p);
      if (!first.length || saving) {
        toast('Prompt copied — paste it into Claude');
        return;
      }
      saving = true;
      try {
        const n = await commit({ families: first });
        reply.value = '';
        flushDraft();
        afterListChange();
        toast(`Saved ${families(n)}. Prompt for the rest copied.`, { duration: 3200 });
      } catch (err) {
        console.warn('Saving families failed', err);
        toast('Prompt copied, but saving failed. Tap Save first.', { icon: 'xCircle', tone: 'red', duration: 3500 });
      } finally {
        saving = false;
        refresh({ force: true });
      }
    });
  }

  /* ---------- current families ---------- */

  const curCount = h('span', { class: 'fm-cur-count tabular' });
  const curHead = h(
    'button',
    { type: 'button', class: 'fm-cur-head', 'aria-expanded': 'false', onClick: () => setCurrentOpen(curBody.hidden) },
    h('span', { class: 'fm-cur-label' }, h('span', { class: 'fm-cur-title' }, 'Families'), curCount),
    h('span', { class: 'fm-cur-chevron' }, icon('chevronDown', { size: 20 })),
  );
  const curBody = h('div', { class: 'fm-cur-body' });
  curBody.hidden = true;
  const curSection = h('section', { class: 'fm-current' }, curHead, curBody);
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

  // waitingBadge: some families are ready, so the waiting ones are marked
  // (when none is, the status card already says so).
  function familyRow(item, index, waitingBadge) {
    const ready = isFamilyReady(item);
    const members = item.members || [];
    const model = modelIndex(item);
    const pos = String(item.rootPos || '').trim() || (members[model]?.pos ?? '');
    let detail;
    if (!ready) {
      detail = item.rootMeaning ? h('span', { class: 'fm-fam-detail fm-fam-meaning', lang: 'vi' }, item.rootMeaning) : null;
    } else if (members.length === 1) {
      detail = h('span', { class: 'fm-fam-words' }, item.note);
    } else {
      const others = members.filter((_, i) => i !== model).map((m) => memberForms(m)[0] || m.word);
      detail = h('span', { class: 'fm-fam-words' }, others.join(' · '));
    }
    return h(
      'div',
      { class: ['fm-fam', !ready && 'pending'] },
      h('span', { class: 'fm-fam-n tabular' }, String(index + 1)),
      h(
        'div',
        { class: 'fm-fam-main' },
        h('div', { class: 'fm-fam-head' }, h('span', { class: 'fm-fam-root' }, familyName(item)), posBadge(pos), !ready && waitingBadge ? badge('Waiting', 'accent') : null),
        detail,
      ),
    );
  }

  function buildCurrent() {
    curBuilt = true;
    const someReady = familyStatus(list).ready > 0;
    curBody.replaceChildren(h('div', { class: 'group fm-fam-group' }, list.items.map((item, i) => familyRow(item, i, someReady))));
  }

  function updateCurrentHeader() {
    const stat = familyStatus(list);
    curCount.textContent = stat.ready && stat.ready < stat.total ? `${stat.ready} of ${stat.total} ready` : String(stat.total);
    curSection.hidden = stat.total === 0;
  }

  // Everything that depends on the saved list.
  function afterListChange() {
    updateStatus();
    updateStep1();
    updateCurrentHeader();
    curBuilt = false;
    if (!curBody.hidden) buildCurrent();
    refreshPromptBox();
    refresh({ force: true });
  }

  /* ---------- layout ---------- */

  const s = screen({
    title: 'Word families',
    subtitle: list.title || '',
    largeTitle: true,
    back: { label: ctx.backLabel },
    className: 'families-screen',
    body: [statusCard, step1Card, step2Card, curSection],
    footer: [saveBtn],
  });
  const scroller = s.scroll;

  if (copiedRecently) markStepDone(step1.num, true);
  afterListChange();

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
    title: 'Word families',
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
