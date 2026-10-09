// One list: sentences status, practice modes, progress and every item.
// params: { listId }
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { screen, section, row, button, card, badge, posBadge, emptyState, actionSheet, confirm, sheet, textArea, toast, hasOpenOverlay } from '../ui/components.js';
import { push, pop, resetTo } from '../ui/router.js';
import { speak } from '../ui/speech.js';
import { keepVisible } from '../ui/viewport.js';
import * as store from '../data/store.js';
import { isDue, boxLabel, summary, newProgress } from '../core/srs.js';
import { coverage, clozeParts, sentenceFromContext } from '../core/cloze.js';
import { plural, formatDate, startOfDay, DAY } from '../core/util.js';
import { MODES, getSnapshot, liveCards } from './practice/session.js';

const ITEM_NOUN = {
  vocab: ['word', 'words'],
  family: ['family', 'families'],
  passage: ['passage', 'passages'],
};

const STAGES = [
  { key: 'new', label: 'New', color: 'var(--label-3)' },
  { key: 'learning', label: 'Learning', color: 'var(--orange)' },
  { key: 'review', label: 'Reviewing', color: 'var(--blue)' },
  { key: 'mastered', label: 'Mastered', color: 'var(--green)' },
];

const nounFor = (kind) => ITEM_NOUN[kind] || ITEM_NOUN.vocab;
const countOf = (kind, n) => plural(n, ...nounFor(kind));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

function say(text) {
  const s = store.settings();
  speak(text, { rate: s.speechRate, voiceURI: s.voiceURI });
}

// "today" | "tomorrow" | "in 3 days"
function whenText(due, now) {
  if (due <= now) return 'today';
  const days = Math.round((startOfDay(due) - startOfDay(now)) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

function statusText(p, now) {
  if (!p || !p.seen) return 'New · not practised yet';
  if (isDue(p, now)) return `${boxLabel(p.box)} · due for review`;
  return `${boxLabel(p.box)} · next review ${whenText(p.due, now)}`;
}

// Sentence with its [[answer]] in bold and the brackets removed.
function sentenceText(text) {
  const parts = clozeParts(text);
  const unwrap = (s) => s.replace(/\[\[|\]\]/g, '');
  if (!parts) return [unwrap(text)];
  return [unwrap(parts.before), h('strong', { class: 'ld-answer' }, parts.answer), unwrap(parts.after)];
}

function subtitleOf(list) {
  if (list.source) return list.source;
  return `${countOf(list.kind, (list.items || []).length)} · added ${formatDate(list.createdAt || Date.now())}`;
}

// Pop once the router is free (onShow runs while it is still busy).
async function leave(tries = 8) {
  if (await pop()) return;
  if (tries > 0) setTimeout(() => leave(tries - 1), 120);
  else resetTo('lists');
}

function missingScreen(ctx) {
  const s = screen({
    title: 'List',
    largeTitle: false,
    back: { label: ctx.backLabel },
    body: [emptyState({ icon: 'books', title: 'List not found', message: 'It may have been deleted.', action: { label: 'Go back', onTap: () => leave() } })],
  });
  // missing: the router skips this screen when it restores a saved stack.
  return { el: s.el, title: 'List', missing: true };
}

async function loadProgress(list) {
  if (list.kind !== 'vocab') return new Map();
  try {
    // One index query instead of a transaction per word (big lists).
    return await store.getProgressForList(list.id);
  } catch (err) {
    console.error(err);
    return new Map();
  }
}

export default async function create(params, ctx) {
  let list = null;
  try {
    list = params.listId ? await store.getList(params.listId) : null;
  } catch (err) {
    console.error(err);
  }
  if (!list) return missingScreen(ctx);
  list = { ...list, items: list.items || [], sentences: list.sentences || [] };
  let progress = await loadProgress(list);

  const body = h('div', { class: 'ld-body' });
  const s = screen({
    title: list.title || 'Untitled list',
    subtitle: subtitleOf(list),
    back: { label: ctx.backLabel },
    className: 'list-detail-screen',
    actions: [{ icon: 'ellipsis', ariaLabel: 'More', onTap: () => more() }],
    body: [body],
  });

  const inst = { el: s.el, title: list.title || 'List' };
  let destroyed = false;
  let openSheet = null;

  const goSentences = () => push('sentences', { listId: list.id });
  const practise = (mode) => push('practice', { listId: list.id, mode }, { modal: true });

  /* ---------- sentences ---------- */

  function sentencesBlock() {
    const n = (list.sentences || []).length;
    if (!n) {
      return h(
        'div',
        { class: 'section' },
        card({
          className: 'ld-hero',
          children: [
            h('div', { class: 'ld-hero-top' }, h('span', { class: 'ld-hero-icon' }, icon('sparkles')), h('div', { class: 'ld-hero-title' }, 'Make context sentences')),
            h('p', { class: 'ld-hero-text' }, 'Copy a prompt to the Claude app and paste the reply back. About a minute — then practise every word in real sentences.'),
            button({ label: 'Make sentences', block: true, onTap: goSentences }),
          ],
        }),
      );
    }
    const missing = coverage(list).missing.length;
    return section({
      className: 'ld-sentences',
      children: [
        row({
          icon: 'sparkles',
          iconBg: 'var(--accent)',
          title: plural(n, 'sentence'),
          subtitle: missing ? h('span', { class: 'ld-missing' }, `${plural(missing, 'meaning')} missing`) : 'Every meaning covered',
          onTap: goSentences,
        }),
      ],
    });
  }

  /* ---------- paused session ---------- */

  // iOS may close the app mid-practice; the router then brings back this
  // screen (practice itself is not restored), so offer the saved session here.
  function resumeBlock() {
    const snap = getSnapshot();
    if (!snap || snap.listId !== list.id) return null;
    // Its words may have been deleted (or its sentences replaced) since.
    if (!liveCards(snap, new Map([[list.id, list]])).length) return null;
    const mode = MODES[snap.mode];
    if (!mode) return null;
    const done = Math.min(snap.done, snap.originalCount);
    return section({
      className: 'ld-resume',
      children: [
        row({
          icon: mode.icon,
          iconBg: mode.color,
          title: 'Continue practising',
          subtitle: `${mode.label} · ${done}\u00a0of\u00a0${snap.originalCount}`,
          accessory: h('span', { class: 'ld-resume-go' }, 'Resume', icon('chevronRight', { size: 18 })),
          onTap: () => push('practice', { resume: true }, { modal: true }),
        }),
      ],
    });
  }

  /* ---------- practice modes ---------- */

  function modeCount(key) {
    const items = list.items || [];
    if (key === 'cloze') {
      const ids = new Set(items.map((i) => i.id));
      const pairs = new Set((list.sentences || []).filter((x) => ids.has(x.itemId)).map((x) => `${x.itemId}:${x.sense}`));
      return pairs.size;
    }
    if (key === 'family') return items.filter((f) => (f.members || []).length > 1).length;
    return items.length;
  }

  function modeCard(mode, wide) {
    const n = modeCount(mode.key);
    const needs = mode.key === 'cloze' && n === 0;
    const countText = needs ? 'Needs sentences' : mode.key === 'cloze' ? plural(n, 'card') : countOf(list.kind, n);
    return card({
      className: ['ld-mode', wide ? 'wide' : '', needs ? 'needs' : ''].filter(Boolean).join(' '),
      ariaLabel: `${mode.label}, ${countText}`,
      onTap: () => (needs ? goSentences() : practise(mode.key)),
      children: h(
        'span',
        { class: 'ld-mode-inner' },
        h('span', { class: 'ld-mode-icon', style: { background: mode.color } }, icon(mode.icon)),
        h('span', { class: 'ld-mode-count tabular' }, countText),
        // If the label wraps on a narrow phone, it breaks after the arrow.
        h('span', { class: 'ld-mode-label' }, mode.label.replace(/ → /g, '\u00a0→ ')),
        h('span', { class: 'ld-mode-text' }, mode.short),
      ),
    });
  }

  function practiseBlock() {
    const modes = Object.values(MODES).filter((m) => m.key !== 'review' && m.kinds.includes(list.kind));
    const cards = modes.map((m, i) => modeCard(m, modes.length % 2 === 1 && i === 0));
    return section({ header: 'Practise', plain: true, className: 'ld-practise', children: h('div', { class: 'ld-modes' }, cards) });
  }

  /* ---------- progress ---------- */

  function progressBlock() {
    const now = Date.now();
    const items = list.items || [];
    if (!items.length) return null;
    const records = items.map((i) => progress.get(i.id) || newProgress(i.id, list.id));
    const sum = summary(records, now);
    const practised = items.map((i) => progress.get(i.id)).filter(Boolean);
    const due = practised.filter((p) => isDue(p, now)).length;

    const bar = h(
      'div',
      { class: 'ld-stack', role: 'img', 'aria-label': STAGES.map((st) => `${sum[st.key]} ${st.label.toLowerCase()}`).join(', ') },
      STAGES.filter((st) => sum[st.key] > 0).map((st) => h('span', { class: 'ld-stack-seg', style: { flexGrow: String(sum[st.key]), background: st.color } })),
    );
    const legend = h(
      'div',
      { class: 'ld-legend' },
      STAGES.map((st) =>
        h(
          'span',
          { class: ['ld-legend-item', sum[st.key] === 0 && 'zero'] },
          h('span', { class: 'ld-legend-dot', style: { background: st.color } }),
          h('span', { class: 'ld-legend-label' }, st.label),
          h('span', { class: 'ld-legend-n tabular' }, String(sum[st.key])),
        ),
      ),
    );
    let next;
    if (!practised.length) next = 'Not practised yet';
    else if (due) next = `Next review: today · ${due} due`;
    else next = `Next review: ${whenText(Math.min(...practised.map((p) => Number(p.due) || 0)), now)}`;
    return section({
      header: 'Progress',
      plain: true,
      className: 'ld-progress',
      children: h(
        'div',
        { class: 'card ld-progress-card' },
        bar,
        legend,
        h('div', { class: ['ld-next', due && 'due'] }, icon(due ? 'flame' : 'calendar', { size: 18 }), h('span', null, next)),
      ),
    });
  }

  /* ---------- items ---------- */

  // A tappable row that can hold its own speaker button (no nested buttons).
  function tappableRow(opts, onOpen) {
    const el = row(opts);
    el.classList.add('tappable');
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.addEventListener('click', onOpen);
    el.addEventListener('keydown', (e) => {
      if (e.target === el && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        onOpen();
      }
    });
    return el;
  }

  function speakerButton(text, label) {
    return h(
      'button',
      {
        type: 'button',
        class: 'icon-btn ld-speak',
        'aria-label': label,
        onClick: (e) => {
          e.stopPropagation();
          say(text);
        },
      },
      icon('speaker'),
    );
  }

  function vocabRow(item) {
    return tappableRow(
      {
        className: 'ld-item',
        title: h(
          'span',
          { class: 'ld-item-head' },
          h('span', { class: 'ld-item-word' }, item.word),
          posBadge(item.pos),
          item.ipa ? h('span', { class: 'ipa' }, `/${item.ipa}/`) : null,
        ),
        subtitle: (item.senses || []).join(' · '),
        accessory: speakerButton(item.word, `Say ${item.word}`),
        ariaLabel: item.word,
      },
      () => openWord(item.id),
    );
  }

  function familyRow(item) {
    const members = item.members || [];
    return row({
      className: 'ld-item',
      title: h('span', { class: 'ld-family-words' }, members.map((m) => m.word).join(' · ')),
      subtitle: members[0]?.definition || null,
      onTap: () => openFamily(item.id),
    });
  }

  function passageRow(item) {
    return row({
      className: 'ld-item ld-passage-row',
      title: clip((item.text || '').replace(/\s+/g, ' '), 120),
      onTap: () => openPassage(item.id),
    });
  }

  function itemsBlock() {
    const items = list.items || [];
    const make = list.kind === 'family' ? familyRow : list.kind === 'passage' ? passageRow : vocabRow;
    if (!items.length) {
      return section({ header: nounFor(list.kind)[1], children: [row({ title: h('span', { class: 'muted' }, 'This list is empty. Tap More › Edit list to add some.') })] });
    }
    return section({ header: countOf(list.kind, items.length), className: 'ld-items', children: items.map(make) });
  }

  /* ---------- sheets ---------- */

  function sentencesFor(itemId) {
    return (list.sentences || []).filter((x) => x.itemId === itemId).sort((a, b) => a.sense - b.sense || (a.origin === 'user') - (b.origin === 'user'));
  }

  function renderSentenceCards(item) {
    const list_ = sentencesFor(item.id);
    if (!list_.length) {
      return section({
        header: 'Sentences',
        children: [row({ title: h('span', { class: 'muted' }, 'No sentences yet'), accent: false })],
        footer: list.kind === 'vocab' ? 'Make sentences for the list, or paste where you met this word below.' : null,
      });
    }
    const multi = (item.senses || []).length > 1;
    return section({
      header: plural(list_.length, 'sentence'),
      children: list_.map((x) =>
        h(
          'div',
          { class: 'row ld-sentence' },
          h(
            'span',
            { class: 'row-main' },
            // Caption → sentence → translation, as on the Sentences screen.
            multi || x.origin === 'user'
              ? h('span', { class: 'ld-sentence-meta' }, [multi ? `Meaning ${x.sense + 1}` : null, x.origin === 'user' ? 'From you' : null].filter(Boolean).join(' · '))
              : null,
            h('span', { class: 'ld-sentence-text' }, sentenceText(x.text)),
            x.vi ? h('span', { class: 'ld-sentence-vi' }, x.vi) : null,
          ),
        ),
      ),
    });
  }

  function openWord(itemId) {
    const item = list.items.find((i) => i.id === itemId);
    if (!item) return;
    const now = Date.now();
    const p = progress.get(item.id);
    const sentenceHost = h('div', null, renderSentenceCards(item));

    let savedContext = item.context || '';
    const saveBtn = button({ label: 'Save', variant: 'tinted', block: true, disabled: true, onTap: () => saveContext() });
    const ta = textArea({
      value: savedContext,
      placeholder: 'Paste the sentence here',
      rows: 3,
      className: 'ld-context',
      ariaLabel: 'Seen in',
      onInput: (v) => {
        saveBtn.disabled = v.trim() === savedContext.trim();
      },
    });
    ta.setAttribute('enterkeyhint', 'done');
    ta.addEventListener('focus', () => keepVisible(ta));
    // The keyboard's "done" key: save (or just close the keyboard), not a new line.
    ta.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      if (!saveBtn.disabled) saveContext();
      else ta.blur();
    });

    async function saveContext() {
      const context = ta.value.replace(/\s+/g, ' ').trim();
      saveBtn.disabled = true;
      try {
        const latest = (await store.getList(list.id)) || list;
        const items = latest.items.map((i) => (i.id === item.id ? { ...i, context } : i));
        const updated = items.find((i) => i.id === item.id);
        const sentences = (latest.sentences || []).filter((x) => !(x.itemId === item.id && x.origin === 'user'));
        const made = context && updated ? sentenceFromContext(updated) : null;
        if (made) sentences.push(made);
        list = await store.saveList({ ...latest, items, sentences });
        savedContext = context;
        ta.value = context;
        ta.blur();
        sentenceHost.replaceChildren(renderSentenceCards(updated || item));
        render();
        if (made) toast('Saved as a practice sentence');
        else if (context) toast(`Saved — “${item.word}” isn't in it, so it can't be practised`, { icon: 'info', tone: 'accent', duration: 3500 });
        else toast('Removed');
      } catch (err) {
        console.error(err);
        saveBtn.disabled = false;
        toast('Could not save. Please try again.', { icon: 'xCircle', tone: 'red' });
      }
    }

    const senses = item.senses || [];
    const content = h(
      'div',
      { class: 'ld-ws' },
      h(
        'div',
        { class: 'ld-ws-hero' },
        h(
          'div',
          { class: 'ld-ws-main' },
          h('div', { class: 'ld-ws-word' }, item.word),
          h('div', { class: 'ld-ws-meta' }, item.ipa ? h('span', { class: 'ipa' }, `/${item.ipa}/`) : null, posBadge(item.pos)),
        ),
        iconButtonFilled('speaker', `Say ${item.word}`, () => say(item.word)),
      ),
      section({
        header: senses.length > 1 ? plural(senses.length, 'meaning') : 'Meaning',
        children: senses.map((m, i) =>
          h('div', { class: 'row ld-sense' }, senses.length > 1 ? h('span', { class: 'ld-sense-n tabular' }, String(i + 1)) : null, h('span', { class: 'row-main' }, m)),
        ),
      }),
      item.synonyms?.length ? section({ header: 'Similar', children: [h('div', { class: 'row' }, h('span', { class: 'row-main' }, `≈ ${item.synonyms.join(', ')}`))] }) : null,
      item.examples?.length
        ? section({ header: item.examples.length > 1 ? 'Examples' : 'Example', children: item.examples.map((ex) => h('div', { class: 'row ld-example' }, h('span', { class: 'row-main' }, ex))) })
        : null,
      item.family ? section({ header: 'Word family', children: [h('div', { class: 'row' }, h('span', { class: 'row-main' }, item.family))] }) : null,
      section({
        header: 'Progress',
        children: [
          h(
            'div',
            { class: 'row ld-ws-status' },
            h('span', { class: 'ld-ws-dot', style: { background: stageColor(p) } }),
            h('span', { class: 'row-main' }, statusText(p, now)),
            p && p.seen ? h('span', { class: 'row-detail tabular' }, `${p.right || 0}/${p.seen} right`) : null,
          ),
        ],
      }),
      sentenceHost,
      section({
        header: 'Seen in',
        footer: 'Paste the sentence where you met this word — it becomes a practice sentence.',
        children: [ta],
      }),
      saveBtn,
    );
    const wordSheet = sheet({
      title: item.word,
      content,
      className: 'ld-sheet ld-word-sheet',
      onClose: () => {
        openSheet = null;
      },
    });
    openSheet = wordSheet;
    // The big word heads the sheet; the bar shows it only once that scrolls away.
    wordSheet.body.addEventListener('scroll', () => wordSheet.el.classList.toggle('scrolled', wordSheet.body.scrollTop > 44), { passive: true });
  }

  function stageColor(p) {
    if (!p || !p.seen) return 'var(--label-3)';
    const b = Number(p.box) || 0;
    if (b >= 5) return 'var(--green)';
    if (b >= 3) return 'var(--blue)';
    return 'var(--orange)';
  }

  function iconButtonFilled(name, label, onTap) {
    return h('button', { type: 'button', class: 'icon-btn filled ld-ws-speak', 'aria-label': label, onClick: onTap }, icon(name));
  }

  function openFamily(itemId) {
    const item = list.items.find((i) => i.id === itemId);
    if (!item) return;
    const members = item.members || [];
    openSheet = sheet({
      title: members[0]?.word || 'Word family',
      className: 'ld-sheet',
      onClose: () => (openSheet = null),
      content: section({
        header: plural(members.length, 'form'),
        children: members.map((m) =>
          h(
            'div',
            { class: 'row ld-member' },
            h(
              'span',
              { class: 'row-main' },
              h('span', { class: 'ld-item-head' }, h('span', { class: 'ld-item-word' }, m.word), posBadge(m.pos), m.ipa ? h('span', { class: 'ipa' }, `/${m.ipa}/`) : null),
              m.definition ? h('span', { class: 'ld-member-def' }, m.definition) : null,
              m.example ? h('span', { class: 'ld-member-ex' }, m.example) : null,
            ),
            speakerButton(m.word, `Say ${m.word}`),
          ),
        ),
      }),
    });
  }

  function openPassage(itemId) {
    const item = list.items.find((i) => i.id === itemId);
    if (!item) return;
    openSheet = sheet({
      title: 'Passage',
      className: 'ld-sheet',
      onClose: () => (openSheet = null),
      content: [
        h('div', { class: 'card ld-passage' }, item.text),
        button({ label: 'Listen', icon: 'speaker', variant: 'tinted', block: true, onTap: () => say(item.text) }),
      ],
    });
  }

  /* ---------- more menu ---------- */

  async function more() {
    const actions = [{ label: 'Edit list', value: 'edit' }];
    if (list.kind === 'vocab') actions.push({ label: (list.sentences || []).length ? 'Make new sentences' : 'Make sentences', value: 'sentences' });
    actions.push({ label: 'Delete list', value: 'delete', style: 'destructive' });
    const choice = await actionSheet({ title: list.title, actions });
    if (choice === 'edit') push('import', { listId: list.id }, { modal: true });
    else if (choice === 'sentences') goSentences();
    else if (choice === 'delete') {
      const ok = await confirm({
        title: `Delete “${list.title}”?`,
        message: 'Its words, sentences and progress will be removed from this phone.',
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return;
      await store.deleteList(list.id);
      toast('List deleted', { icon: 'trash', tone: 'accent' });
      leave();
    }
  }

  /* ---------- render / refresh ---------- */

  function render() {
    const parts = [resumeBlock()];
    if (list.kind === 'vocab') parts.push(sentencesBlock());
    parts.push(practiseBlock());
    if (list.kind === 'vocab') parts.push(progressBlock());
    parts.push(cachedItemsBlock());
    body.replaceChildren(...parts.filter(Boolean));
  }

  // The rows only depend on the list's words, so returning from practice
  // (new progress, same words) reuses them instead of rebuilding every row.
  let itemsCache = null;
  function cachedItemsBlock() {
    const key = `${list.updatedAt}|${list.kind}|${list.items.length}`;
    if (!itemsCache || itemsCache.key !== key) itemsCache = { key, el: itemsBlock() };
    return itemsCache.el;
  }

  async function refresh() {
    let fresh;
    try {
      fresh = await store.getList(params.listId);
    } catch (err) {
      console.error(err);
      return; // keep showing what we have
    }
    if (destroyed) return;
    if (!fresh) {
      if (openSheet) {
        const open = openSheet;
        openSheet = null; // so leave() is not held back by the closing sheet
        open.close();
      }
      leave();
      return;
    }
    list = { ...fresh, items: fresh.items || [], sentences: fresh.sentences || [] };
    progress = await loadProgress(list);
    if (destroyed) return;
    const title = list.title || 'Untitled list';
    s.setTitle(title);
    s.setSubtitle(subtitleOf(list));
    inst.title = title;
    render();
  }

  render();

  inst.onShow = (opts = {}) => {
    if (opts.returning) refresh();
  };
  // Escape (iPad / desktop keyboards) should close a sheet or menu, not also
  // leave this screen. The overlay closes itself before the router's Escape
  // handler runs, so remember that this Escape belonged to an overlay.
  let overlayEscape = false;
  const onEscape = (e) => {
    if (e.key !== 'Escape' || !hasOpenOverlay()) return;
    overlayEscape = true;
    setTimeout(() => (overlayEscape = false), 0);
  };
  document.addEventListener('keydown', onEscape, true);
  // hasOpenOverlay() turns false as soon as a sheet starts closing, so Back
  // works straight away (openSheet is only cleared after the fade-out).
  inst.beforeLeave = () => !overlayEscape && !hasOpenOverlay();

  inst.onDestroy = () => {
    destroyed = true;
    document.removeEventListener('keydown', onEscape, true);
    if (openSheet) openSheet.close();
  };
  return inst;
}
