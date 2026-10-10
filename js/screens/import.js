// "New List" full-screen modal: paste a list, check the live preview, save.
// params: {} for a new list, { listId } to edit an existing list's text.
import { h, reducedMotion } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { screen, section, row, button, segmented, textArea, textField, posBadge, emptyState, actionSheet, toast } from '../ui/components.js';
import { pop, push } from '../ui/router.js';
import { readText } from '../ui/clipboard.js';
import { keepVisible } from '../ui/viewport.js';
import * as store from '../data/store.js';
import { parseList, detectFormat } from '../core/parse.js';
import { sentenceFromContext } from '../core/cloze.js';
import { rootsText } from '../core/families.js';
import { normalizeAnswer } from '../core/text.js';
import { uid, debounce, plural, formatDate } from '../core/util.js';

const PREVIEW_DELAY = 200;
const PREVIEW_MAX = 200;
const PASSAGE_PREVIEW = 100;

const KIND_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'vocab', label: 'Words' },
  { value: 'family', label: 'Families' },
  { value: 'passage', label: 'Passages' },
];

const FORMAT_LABEL = {
  oneline: 'Words (one-line format)',
  block: 'Words (block format)',
  family: 'Word families',
  passage: 'Passages',
  wordlist: 'Word list',
};

// Families: Claude builds them from root words, or they are pasted written out.
const FAMILY_OPTIONS = [
  { value: 'claude', label: 'Make with Claude' },
  { value: 'written', label: 'Already written' },
];

const FAMILY_HINT = {
  claude: 'Claude builds the families after you save.',
  written: 'Numbered forms, a blank line between families.',
};

const KIND_LABEL = { vocab: 'Words', family: 'Families', passage: 'Passages' };

// The text is kept as a draft while typing, so it survives iOS closing the
// app (e.g. while the user copies more words from their notes).
const DRAFT_DELAY = 250;
const DRAFT_TTL = 24 * 60 * 60 * 1000;
const draftKey = (listId) => `vs.import.draft.${listId || 'new'}`;

function readDraft(key) {
  try {
    const draft = JSON.parse(localStorage.getItem(key) || 'null');
    if (!draft || typeof draft.text !== 'string' || !(Date.now() - draft.at < DRAFT_TTL)) return null;
    return draft;
  } catch {
    return null;
  }
}

function writeDraft(key, draft) {
  try {
    if (draft) localStorage.setItem(key, JSON.stringify(draft));
    else localStorage.removeItem(key);
  } catch {
    /* storage blocked: the screen still works, the draft just is not kept */
  }
}

const PLACEHOLDER = '378.\n1. repository (n) /rɪˈpɑːzətɔːri/ : i) nơi lưu trữ... ii) ...\n2. acquit (v): ...';

export function itemCount(kind, n, format) {
  if (kind === 'family' && format === 'roots') return plural(n, 'word');
  if (kind === 'family') return plural(n, 'family', 'families');
  if (kind === 'passage') return plural(n, 'passage');
  return plural(n, 'word');
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/* ---------- Editing an existing list ---------- */

// A family is known by its root word, or by its model member when it was
// pasted written out (root '').
function familyKey(item) {
  return normalizeAnswer(item.root || item.members?.[0]?.word || '');
}

function itemKey(kind, item) {
  if (kind === 'family') return familyKey(item);
  if (kind === 'passage') return normalizeAnswer(item.text || '');
  return normalizeAnswer(item.word || '');
}

const mainPos = (pos) => String(pos || '').split('/')[0].trim();

// Word plus main part of speech, so "present (n)" and "present (v)" in one
// list keep their own ids however they are reordered.
function wordPosKey(item) {
  const word = itemKey('vocab', item);
  return word ? `${word}|${mainPos(item.pos)}` : '';
}

function poolBy(items, keyOf) {
  const pool = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    if (!pool.has(key)) pool.set(key, []);
    pool.get(key).push(item);
  }
  return pool;
}

// Families pasted written out: a family whose text is the same as when the
// list was saved keeps everything saved for it since (Claude's families, forms
// removed in the family sheet).
const writtenKey = (item) => JSON.stringify((item.members || []).map((m) => [m.word, m.pos, m.ipa, m.definition, m.example]));

function unchangedFamilies(old, parsed) {
  if (parsed.kind !== 'family' || parsed.format === 'roots' || !String(old?.rawText || '').trim()) return new Set();
  try {
    return new Set(parseList(old.rawText, { kind: 'family' }).items.map(writtenKey));
  } catch (err) {
    console.error(err);
    return new Set();
  }
}

// Keeps item ids for unchanged words (so progress and sentences survive),
// keeps the learner's "Seen in" sentence, and drops sentences whose item or
// meaning no longer exists. Words are matched on word + part of speech
// first, then on the word alone (e.g. a corrected part of speech).
export function mergeItems(old, parsed, now = Date.now()) {
  const sameKind = old && old.kind === parsed.kind;
  const oldItems = sameKind ? old.items || [] : [];
  const unchanged = sameKind ? unchangedFamilies(old, parsed) : new Set();
  const used = new Set();
  const take = (pool, key) => {
    const queue = key ? pool.get(key) : null;
    while (queue?.length) {
      const item = queue.shift();
      if (!used.has(item)) {
        used.add(item);
        return item;
      }
    }
    return null;
  };
  const exact = parsed.kind === 'vocab' ? poolBy(oldItems, wordPosKey) : new Map();
  const loose = poolBy(oldItems, (item) => itemKey(parsed.kind, item));
  const prevs = parsed.items.map((item) => (parsed.kind === 'vocab' ? take(exact, wordPosKey(item)) : null));
  parsed.items.forEach((item, i) => {
    if (!prevs[i]) prevs[i] = take(loose, itemKey(parsed.kind, item));
  });
  const contextChanged = new Set();
  const items = parsed.items.map((item, i) => {
    const prev = prevs[i];
    if (!prev) {
      if (item.context) contextChanged.add(item.id);
      return item;
    }
    if (unchanged.has(writtenKey(item))) return prev;
    const next = { ...item, id: prev.id };
    // Roots read again keep the families Claude already built for them.
    if (parsed.format === 'roots' && !(item.members || []).length) {
      next.members = prev.members || [];
      next.note = prev.note || '';
    }
    if (parsed.kind === 'vocab') {
      if (!next.context && prev.context) next.context = prev.context;
      if ((next.context || '') !== (prev.context || '')) contextChanged.add(next.id);
    }
    return next;
  });
  if (parsed.kind !== 'vocab') return { items, sentences: [] };

  const byId = new Map(items.map((i) => [i.id, i]));
  const kept = (sameKind ? old.sentences || [] : []).filter((s) => {
    const item = byId.get(s.itemId);
    if (!item) return false;
    if (s.origin === 'user' && contextChanged.has(s.itemId)) return false;
    return Number.isInteger(s.sense) && s.sense >= 0 && s.sense < Math.max(1, item.senses.length);
  });
  for (const id of contextChanged) {
    const s = sentenceFromContext(byId.get(id), now);
    if (s) kept.push(s);
  }
  return { items, sentences: kept };
}

const hasRoot = (f) => String(f?.root || '').trim() !== '';

// Rebuilds editable text for a list saved without its original paste.
function textFromItems(list) {
  const items = list.items || [];
  if (list.kind === 'passage') return items.map((p) => p.text).join('\n\n');
  if (list.kind === 'family' && items.some(hasRoot)) return rootsText(items);
  if (list.kind === 'family') {
    return items
      .map((f) => (f.members || []).map((m, i) => `${i + 1}. ${m.word}${m.pos ? ` (${m.pos})` : ''}${m.ipa ? ` /${m.ipa}/` : ''}: ${m.definition || ''}${m.example ? `\nExample: ${m.example}` : ''}`).join('\n'))
      .join('\n\n');
  }
  const roman = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];
  return items
    .map((it, i) => {
      const senses = it.senses.length > 1 ? it.senses.map((s, k) => `${roman[k] || k + 1}) ${s}.`).join(' ') : it.senses[0] || '';
      const syn = it.synonyms?.length ? ` [=${it.synonyms.join(', ')}]` : '';
      return `${i + 1}. ${it.word}${it.pos ? ` (${it.pos})` : ''}${it.ipa ? ` /${it.ipa}/` : ''}: ${senses}${syn}`;
    })
    .join('\n');
}

// Does `text` read back as the roots of these families, in order?
function readsAsRoots(text, items) {
  if (!String(text || '').trim()) return false;
  const roots = parseList(text, { kind: 'family', roots: true }).items;
  return roots.length === items.length && roots.every((r, i) => familyKey(r) === familyKey(items[i]));
}

// The text Edit list starts from: the original paste, except for a family
// list whose families Claude built and whose paste no longer reads as their
// roots (families pasted written out, rebuilt by Claude since): its roots.
function editText(list) {
  const raw = list.rawText || '';
  const items = list.items || [];
  if (list.kind === 'family' && items.length && items.every(hasRoot) && !readsAsRoots(raw, items)) return rootsText(items);
  return raw || textFromItems(list);
}

/* ---------- Screen ---------- */

export default async function create(params = {}) {
  let editing = null;
  try {
    editing = params.listId ? await store.getList(params.listId) : null;
  } catch (err) {
    console.error(err);
  }
  if (params.listId && !editing) {
    const s = screen({
      title: 'Edit List',
      largeTitle: false,
      left: [{ label: 'Cancel', onTap: () => pop() }],
      body: [emptyState({ icon: 'books', title: 'List not found', message: 'It may have been deleted.', action: { label: 'Close', onTap: () => pop() } })],
    });
    return { el: s.el, title: 'Edit List', missing: true };
  }

  const screenTitle = editing ? 'Edit List' : 'New List';
  const today = formatDate(Date.now());
  const initialText = editing ? editText(editing) : '';
  const initialTitle = editing ? editing.title || '' : '';
  const initialSource = editing ? editing.source || '' : '';

  let choice = 'auto';
  if (editing && initialText.trim()) {
    const auto = parseList(initialText);
    if (auto.kind !== editing.kind) choice = editing.kind;
  }
  // Families only: 'claude' | 'written' picked by the learner; null follows the
  // text. A list of Claude's families opens on "Make with Claude" however its
  // text looks, so saving it again keeps them.
  let familyPick = editing?.kind === 'family' && (editing.items || []).some(hasRoot) && readsAsRoots(initialText, editing.items) ? 'claude' : null;
  let parsed = null;
  let titleTouched = !!editing;

  const draftId = draftKey(editing?.id);
  const draft = readDraft(draftId);
  if (draft && KIND_OPTIONS.some((o) => o.value === draft.kind)) choice = draft.kind;
  if (draft && 'familyPick' in draft) familyPick = FAMILY_OPTIONS.some((o) => o.value === draft.familyPick) ? draft.familyPick : null;
  if (draft && typeof draft.title === 'string' && draft.titleTouched) titleTouched = true;
  let saving = false;
  let saved = false;

  const autoTitle = () => (parsed?.items?.length && parsed.title) || `List · ${today}`;

  /* ---------- controls ---------- */

  const pasteBtn = button({
    label: 'Paste from clipboard',
    icon: 'clipboard',
    variant: 'tinted',
    size: 'large',
    block: true,
    className: 'imp-paste',
    onTap: () => pasteFromClipboard(),
  });

  const ta = textArea({
    value: draft ? draft.text : initialText,
    placeholder: PLACEHOLDER,
    rows: 7,
    className: 'imp-text',
    ariaLabel: 'Your list',
    onInput: () => {
      schedulePreview();
      scheduleDraft();
    },
  });
  ta.setAttribute('autocomplete', 'off');
  ta.setAttribute('autocorrect', 'off');
  ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('spellcheck', 'false');

  const kindControl = segmented({
    options: KIND_OPTIONS,
    value: choice,
    ariaLabel: 'List type',
    onChange: (v) => {
      choice = v;
      updatePreview();
    },
  });
  const detectedEl = h('div', { class: 'imp-detected' });
  const familyControl = segmented({
    options: FAMILY_OPTIONS,
    value: familyPick || 'claude',
    ariaLabel: 'Families',
    onChange: (v) => {
      familyPick = v;
      updatePreview();
    },
  });
  const familyHint = h('div', { class: 'imp-detected imp-family-hint' });
  const familyWrap = h('div', { class: 'imp-family' }, familyControl, familyHint);
  familyWrap.hidden = true;

  const titleField = textField({
    value: draft && draft.titleTouched && typeof draft.title === 'string' ? draft.title : initialTitle,
    placeholder: `List · ${today}`,
    ariaLabel: 'Title',
    enterkeyhint: 'next',
    className: 'imp-input',
    onInput: () => {
      titleTouched = true;
      scheduleDraft();
    },
    onEnter: () => sourceField.focus(),
  });
  const sourceField = textField({
    value: draft && typeof draft.source === 'string' ? draft.source : initialSource,
    placeholder: 'Book, podcast, news…',
    ariaLabel: 'Source (optional)',
    enterkeyhint: 'done',
    className: 'imp-input',
    onEnter: () => sourceField.blur(),
    onInput: () => scheduleDraft(),
  });
  titleField.addEventListener('focus', () => keepVisible(titleField));
  sourceField.addEventListener('focus', () => keepVisible(sourceField));

  const fieldRow = (label, field) => h('label', { class: 'imp-field-row' }, h('span', { class: 'imp-field-label' }, label), field);

  const warnHost = h('div', { class: 'imp-warn-host' });
  const previewHost = h('div', { class: 'imp-preview-host' });

  const footerSave = button({ label: 'Save', size: 'large', block: true, disabled: true, onTap: () => save() });
  const footerLabel = footerSave.querySelector('span');

  const s = screen({
    title: screenTitle,
    largeTitle: false,
    className: 'import-screen',
    // One Save, in the footer (thumb zone); it stays above the keyboard.
    left: [{ label: 'Cancel', onTap: () => pop() }],
    body: [
      pasteBtn,
      section({ header: 'Your list', children: [ta] }),
      section({ header: 'Type', plain: true, className: 'imp-kind', children: [kindControl, detectedEl, familyWrap] }),
      section({
        header: 'Details',
        footer: 'Where did these come from? Add a book, podcast or news site if you like.',
        children: [fieldRow('Title', titleField), fieldRow('Source', sourceField)],
      }),
      warnHost,
      previewHost,
    ],
    footer: [footerSave],
  });

  /* ---------- preview ---------- */

  function vocabRow(item) {
    const senses = item.senses.length > 1 ? item.senses.map((x, i) => `${i + 1}. ${x}`).join('  ') : item.senses[0] || '';
    return row({
      className: 'imp-item',
      title: h(
        'span',
        { class: 'imp-item-head' },
        h('span', { class: 'imp-n tabular' }, String(item.n)),
        h('span', { class: 'imp-word' }, item.word),
        posBadge(item.pos),
        item.ipa ? h('span', { class: 'ipa' }, `/${item.ipa}/`) : null,
      ),
      subtitle: h(
        'span',
        { class: 'imp-senses' },
        senses,
        item.synonyms?.length ? h('span', { class: 'imp-syn' }, ` ≈ ${item.synonyms.join(', ')}`) : null,
      ),
    });
  }

  function familyRow(item, index) {
    const members = item.members || [];
    const words = [];
    members.forEach((m, i) => {
      if (i) words.push(h('span', { class: 'imp-dot' }, ' · '));
      words.push(h('span', { class: 'imp-member' }, m.word, m.pos ? h('span', { class: 'imp-pos' }, ` ${m.pos}`) : null));
    });
    return row({
      className: 'imp-item',
      title: h('span', { class: 'imp-item-head' }, h('span', { class: 'imp-n tabular' }, String(index + 1)), h('span', { class: 'imp-members' }, words)),
      subtitle: members[0]?.definition || null,
    });
  }

  // A root word Claude will build a family from: word, part of speech, meaning.
  function rootRow(item, index) {
    return row({
      className: 'imp-item',
      title: h('span', { class: 'imp-item-head' }, h('span', { class: 'imp-n tabular' }, String(index + 1)), h('span', { class: 'imp-word' }, item.root), posBadge(item.rootPos)),
      subtitle: item.rootMeaning ? h('span', { class: 'imp-senses', lang: 'vi' }, item.rootMeaning) : null,
    });
  }

  function passageRow(item, index) {
    return row({
      className: 'imp-item',
      title: h('span', { class: 'imp-item-head' }, h('span', { class: 'imp-n tabular' }, String(index + 1)), h('span', { class: 'imp-passage' }, clip(item.text.replace(/\s+/g, ' '), PASSAGE_PREVIEW))),
    });
  }

  function renderWarnings() {
    const warnings = parsed?.warnings || [];
    if (!warnings.length) return warnHost.replaceChildren();
    const rows = warnings.map((w) =>
      row({
        className: 'imp-warn-row',
        title: h('span', { class: 'imp-warn-text' }, w.text),
        subtitle: h('span', null, h('span', { class: 'imp-warn-line' }, `Line ${w.line}`), ` · ${w.reason}`),
      }),
    );
    warnHost.replaceChildren(
      section({
        className: 'imp-warn',
        header: h('span', { class: 'imp-warn-header' }, icon('info', { size: 16 }), `Couldn't read ${plural(warnings.length, 'line')}`),
        footer:
          parsed.format === 'roots'
            ? 'Put one word or short phrase on each line — like “authority” or “4. decide (v): quyết định”. Fix the lines above, or save without them.'
            : 'Each word needs a number, the word, then “:” and its meaning — like “4. acquit (v): tuyên vô tội”. Fix the lines above, or save without them.',
        children: rows,
      }),
    );
  }

  function renderPreview() {
    const items = parsed?.items || [];
    if (!parsed) {
      previewHost.replaceChildren(
        h(
          'div',
          { class: 'imp-hint' },
          h('div', { class: 'imp-hint-icon' }, icon('listBullet')),
          h('div', { class: 'imp-hint-title' }, 'Your words will appear here'),
          h('div', { class: 'imp-hint-text' }, 'Paste a numbered list: one word per line, then “:” and the meaning.'),
        ),
      );
      return;
    }
    const roots = parsed.format === 'roots';
    if (!items.length) {
      previewHost.replaceChildren(
        h(
          'div',
          { class: 'imp-hint' },
          h('div', { class: 'imp-hint-title' }, 'Nothing to save yet'),
          h(
            'div',
            { class: 'imp-hint-text' },
            roots
              ? 'Put one word on each line, like “authority”.'
              : parsed.kind === 'family'
                ? 'Number each form from 1, like “1. strength (noun): …”, with a blank line between families.'
                : 'Start each word on a new line with its number, like “1. repository (n): …”.',
          ),
        ),
      );
      return;
    }
    const shown = items.slice(0, PREVIEW_MAX);
    const make = roots ? rootRow : parsed.kind === 'family' ? familyRow : parsed.kind === 'passage' ? passageRow : (item) => vocabRow(item);
    const rows = shown.map((item, i) => make(item, i));
    const more = items.length - shown.length;
    const count = itemCount(parsed.kind, items.length, parsed.format);
    previewHost.replaceChildren(
      section({
        className: roots ? 'imp-preview imp-roots' : 'imp-preview',
        header: roots ? h('span', { class: 'imp-roots-head' }, icon('sparkles', { size: 16 }), h('span', null, `${count} — Claude will build their families next`)) : count,
        footer: more > 0 ? `And ${more} more.` : null,
        children: rows,
      }),
    );
  }

  function updateDetected(text, format) {
    if (!text.trim()) {
      detectedEl.textContent = 'Auto works out the type from your text.';
      return;
    }
    const detected = FORMAT_LABEL[format] || 'Words';
    detectedEl.textContent = choice === 'auto' || KIND_LABEL[choice] === undefined ? `Detected: ${detected}` : `Detected: ${detected} · reading as ${KIND_LABEL[choice]}`;
  }

  // Families: "Make with Claude" / "Already written" — the learner's pick, or
  // what the text looks like (blank-line blocks numbered from 1 → written).
  const familyMode = (format) => familyPick || (format === 'family' ? 'written' : 'claude');

  function updateFamilyControl(format) {
    const show = parsed?.kind === 'family';
    if (show) {
      const mode = familyMode(format);
      familyControl.setValue(mode);
      familyHint.textContent = FAMILY_HINT[mode];
    }
    if (familyWrap.hidden === show) {
      familyWrap.hidden = !show;
      if (show && !reducedMotion()) familyWrap.animate([{ opacity: 0, transform: 'translate3d(0,-4px,0)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'ease-out' });
    }
  }

  function updateSave() {
    const n = parsed?.items.length || 0;
    const ok = n > 0 && !saving;
    footerSave.disabled = !ok;
    footerLabel.textContent = n ? `Save ${itemCount(parsed.kind, n, parsed.format)}` : 'Save';
  }

  function parseText(text, format) {
    const result = parseList(text, choice === 'auto' ? {} : { kind: choice });
    if (result.kind !== 'family') return result;
    const wantRoots = familyMode(format) === 'claude';
    if (wantRoots === (result.format === 'roots')) return result;
    return parseList(text, wantRoots ? { kind: 'family', roots: true } : { kind: 'family' });
  }

  function updatePreview() {
    scheduleDraft();
    const text = ta.value;
    // Emptied: the next text picks its own family mode again.
    if (!text.trim()) familyPick = null;
    const format = text.trim() ? detectFormat(text) : null;
    parsed = text.trim() ? parseText(text, format) : null;
    // A title only from text that reads as a list (not "authority" from words read as written families).
    if (!titleTouched) titleField.value = parsed?.items.length ? parsed.title || '' : '';
    titleField.placeholder = autoTitle();
    updateDetected(text, format);
    updateFamilyControl(format);
    renderWarnings();
    renderPreview();
    updateSave();
  }

  const schedulePreview = debounce(updatePreview, PREVIEW_DELAY);

  /* ---------- actions ---------- */

  async function pasteFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      // Focus inside the tap so iOS shows the keyboard and its Paste menu.
      ta.focus();
      toast('Tap the box below and choose Paste', { icon: 'info', tone: 'accent' });
      return;
    }
    const text = await readText();
    if (text === null) {
      toast('Tap the box below and choose Paste', { icon: 'info', tone: 'accent' });
      ta.focus();
      return;
    }
    if (!text.trim()) {
      toast('The clipboard is empty', { icon: 'info', tone: 'accent' });
      return;
    }
    const before = ta.value;
    const pickBefore = familyPick;
    // New text picks its own family mode again.
    if (before !== text) familyPick = null;
    ta.value = text;
    ta.scrollTop = 0;
    updatePreview();
    if (before.trim() && before !== text) {
      toast('Replaced your text', {
        icon: 'clipboard',
        tone: 'accent',
        duration: 4000,
        action: {
          label: 'Undo',
          onTap: () => {
            ta.value = before;
            familyPick = pickBefore;
            updatePreview();
          },
        },
      });
    }
  }

  async function save() {
    // Pick up the last keystrokes the debounce has not parsed yet.
    updatePreview();
    if (saving || !parsed || !parsed.items.length) return;
    saving = true;
    updateSave();
    const now = Date.now();
    const title = titleField.value.trim() || autoTitle();
    const source = sourceField.value.trim();
    const rawText = ta.value;
    try {
      if (editing) {
        const latest = (await store.getList(editing.id)) || editing;
        const merged = mergeItems(latest, parsed, now);
        await store.saveList({ ...latest, kind: parsed.kind, title, source, rawText, items: merged.items, sentences: merged.sentences });
        saved = true;
        dropDraft();
        await pop();
        toast('Changes saved');
      } else {
        const fromContext = parsed.kind === 'vocab' ? parsed.items.map((i) => sentenceFromContext(i, now)).filter(Boolean) : [];
        const list = await store.saveList({
          id: uid(),
          kind: parsed.kind,
          title,
          source,
          rawText,
          items: parsed.items,
          sentences: fromContext,
          createdAt: now,
          updatedAt: now,
          lastPracticedAt: null,
        });
        saved = true;
        dropDraft();
        await pop();
        push('list', { listId: list.id });
      }
    } catch (err) {
      console.error(err);
      saving = false;
      updateSave();
      toast('Could not save. Please try again.', { icon: 'xCircle', tone: 'red', duration: 3500 });
    }
  }

  /* ---------- draft ---------- */

  let draftTimer = 0;
  let left = false; // saved or discarded: the draft must not come back

  function flushDraft() {
    clearTimeout(draftTimer);
    draftTimer = 0;
    if (saved || left) return;
    writeDraft(draftId, isDirty() ? { text: ta.value, title: titleField.value, titleTouched, source: sourceField.value, kind: choice, familyPick, at: Date.now() } : null);
  }

  function scheduleDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(flushDraft, DRAFT_DELAY);
  }

  function dropDraft() {
    left = true;
    clearTimeout(draftTimer);
    writeDraft(draftId, null);
  }

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flushDraft();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', flushDraft);

  function isDirty() {
    if (ta.value !== initialText) return Boolean(ta.value.trim() || initialText.trim());
    if (titleTouched && titleField.value !== initialTitle) return true;
    return sourceField.value !== initialSource;
  }

  updatePreview();

  return {
    el: s.el,
    title: screenTitle,
    async beforeLeave() {
      if (saved || !isDirty()) return true;
      const v = await actionSheet({
        actions: [{ label: editing ? 'Discard changes' : 'Discard list', value: 'discard', style: 'destructive' }],
        cancelLabel: 'Keep editing',
      });
      return v === 'discard';
    },
    // Only reached once the user has saved, discarded or changed nothing.
    onDestroy() {
      dropDraft();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flushDraft);
    },
  };
}
