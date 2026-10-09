// Practice screen: full-screen modal that runs a session card by card.
// Mode modules (cloze, meaning, flashcard, family, dictation) render the card
// body; this screen owns the header, the footer (Check → feedback → Continue)
// and moving between cards.
import { h } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, progressBar, emptyState, alert, iconButton, hasOpenOverlay, toast } from '../../ui/components.js';
import { pop, replace } from '../../ui/router.js';
import { speak as tts, stop as stopSpeech } from '../../ui/speech.js';
import { reducedMotion } from '../../ui/dom.js';
import { revealField } from '../../ui/viewport.js';
import * as store from '../../data/store.js';
import { MODES, buildCards, buildReviewCards, createSession, currentCard, answer, isFinished, progressFraction, commit, summarize, getSnapshot, clearSnapshot, liveCards, recoverSnapshot, commitPausedSession } from './session.js';
import * as cloze from './cloze.js';
import * as meaning from './meaning.js';
import * as flashcard from './flashcard.js';
import * as family from './family.js';
import * as dictation from './dictation.js';

const RENDERERS = { cloze, meaning, flashcard, family, dictation };
const PRAISE = ['Correct!', 'Nice!', 'Great!', 'Well done!', 'Spot on!'];
// After the footer changes (Check → Continue, Show answer → grade buttons,
// a new card), taps are ignored this long: the second tap of a double tap
// would otherwise hit the button that just took the first one's place.
const SETTLE_MS = 350;

// params:
//   { listId, mode }                     practise one list in a mode
//   { listId, mode, itemIds }            only these items (e.g. mistakes)
//   { mode: 'review' }                   words due today across lists
//   { mode: 'review', missed: [{ itemId, listId }] }   review mistakes
//   { resume: true }                     continue the saved session
export default async function create(params) {
  const settings = store.settings();
  const lists = new Map();
  let session = null;
  let emptyMessage = null;

  if (params.resume) {
    const snap = getSnapshot();
    if (snap) {
      const ids = new Set(snap.queue.map((c) => c.listId));
      for (const id of ids) {
        const l = await store.getList(id);
        if (l) lists.set(id, l);
      }
      // Its words may have been deleted (or its sentences replaced) since.
      if (liveCards(snap, lists).length) session = snap;
      else {
        recoverSnapshot().catch((err) => console.error(err));
        emptyMessage = { title: 'Nothing to resume', message: 'The words in that session were changed or deleted. Your answers have been saved.' };
      }
    } else {
      emptyMessage = { title: 'Nothing to resume', message: 'That session has already finished.' };
    }
  } else if (params.mode === 'review') {
    let { cards, lists: all } = await buildReviewCards({ limit: settings.reviewLimit || 20 });
    all.forEach((l) => lists.set(l.id, l));
    if (params.missed?.length) {
      const wanted = new Set(params.missed.map((m) => m.itemId));
      const out = [];
      for (const m of params.missed) {
        const list = lists.get(m.listId) || (await store.getList(m.listId));
        if (!list) continue;
        lists.set(list.id, list);
        const sentences = (list.sentences || []).filter((s) => s.itemId === m.itemId);
        out.push(sentences.length ? { listId: list.id, type: 'cloze', itemId: m.itemId, sentenceId: sentences[Math.floor(Math.random() * sentences.length)].id } : { listId: list.id, type: 'meaning', itemId: m.itemId });
      }
      cards = out.filter((c) => wanted.has(c.itemId));
    }
    if (cards.length) session = createSession({ mode: 'review', title: 'Review', cards });
    else emptyMessage = { title: 'All caught up', message: 'No words are due right now. Come back tomorrow, or practise a list.' };
  } else {
    const list = await store.getList(params.listId);
    if (!list) {
      emptyMessage = { title: 'List not found', message: 'It may have been deleted.' };
    } else {
      lists.set(list.id, list);
      const cards = buildCards(list, params.mode, { itemIds: params.itemIds || null });
      if (cards.length) session = createSession({ mode: params.mode, listId: list.id, title: list.title, cards });
      else if (params.mode === 'cloze') emptyMessage = { title: 'No sentences yet', message: 'Make context sentences for this list first — it takes about a minute with the Claude app.' };
      else emptyMessage = { title: 'Nothing to practise', message: 'This list has no items for this mode.' };
    }
  }

  /* ---------- layout ---------- */
  const bar = progressBar(session ? progressFraction(session) : 0);
  const counter = h('span', { class: 'pt-count tabular' });
  const closeBtn = iconButton({ icon: 'close', label: 'End practice', variant: 'gray', onTap: () => (session ? requestClose() : pop()) });
  const top = h('header', { class: 'practice-top' }, closeBtn, h('div', { class: 'pt-progress' }, bar.el), counter);
  const stage = h('div', { class: 'practice-stage' });
  const scroller = h('div', { class: 'scroll practice-scroll' }, stage);

  const fbIcon = h('span', { class: 'pf-icon' });
  const fbTitle = h('div', { class: 'pf-title' });
  const fbDetail = h('div', { class: 'pf-detail' });
  const feedback = h('div', { class: 'pf-feedback', 'aria-live': 'polite' }, fbIcon, h('div', { class: 'pf-text' }, fbTitle, fbDetail));
  const primary = button({ label: 'Check', size: 'large', block: true, onTap: () => (session ? onPrimaryTap() : pop()) });
  const primaryLabel = primary.querySelector('span');
  const timerBar = h('div', { class: 'pf-timer' });
  primary.appendChild(timerBar);
  const knewBtn = button({ label: 'Knew it', variant: 'success', size: 'large', block: true, icon: 'check', onTap: () => grade(true) });
  const forgotBtn = button({ label: "Didn't know", variant: 'destructive', size: 'large', block: true, icon: 'close', onTap: () => grade(false) });
  const gradeRow = h('div', { class: 'pf-grade' }, forgotBtn, knewBtn);
  const footer = h('footer', { class: 'practice-footer', dataset: { state: 'idle' } }, feedback, h('div', { class: 'pf-actions' }, primary, gradeRow));

  const el = h('section', { class: 'screen practice' }, top, scroller, footer);

  let state = 'idle'; // idle | right | close | wrong | grade | finishing | empty
  let current = null; // the mode renderer's object for the current card
  let currentEl = null;
  let autoTimer = null;
  let settleUntil = 0;
  let settleTimer = 0;
  let shown = false; // the router has put this screen on the page
  let finishPending = false;
  let committing = null; // Promise<{ summary, saved }> once saving has started
  let pausedSave = null; // saving an older paused session (see commitPausedSession)

  if (!session) {
    scroller.replaceChildren(emptyState({ icon: params.mode === 'cloze' ? 'sparkles' : 'checkCircle', title: emptyMessage.title, message: emptyMessage.message }));
    primaryLabel.textContent = 'Close';
    footer.dataset.state = 'empty';
    counter.textContent = '';
    return { el, title: 'Practice', swipeBack: false };
  }

  /* ---------- card flow ---------- */

  const speakText = (text) => {
    const s = store.settings();
    return tts(text, { rate: s.speechRate, voiceURI: s.voiceURI });
  };

  function setPrimary(label, { ready = true, tone = 'primary' } = {}) {
    primaryLabel.textContent = label;
    primary.disabled = !ready;
    primary.classList.remove('primary', 'success', 'danger');
    primary.classList.add(tone);
  }

  function setState(next, fb = {}) {
    state = next;
    footer.dataset.state = next;
    settle();
    if (answered()) {
      fbIcon.replaceChildren(icon(next === 'right' ? 'checkCircle' : next === 'close' ? 'pencil' : 'xCircle', { size: 26 }));
      fbTitle.textContent = fb.title || '';
      fbDetail.textContent = fb.detail || '';
      fbDetail.hidden = !fb.detail;
    }
  }

  // Blocks the footer buttons for SETTLE_MS (the CSS class makes taps fall
  // through to the footer; the time check also covers Enter and card taps).
  function settle() {
    settleUntil = performance.now() + SETTLE_MS;
    footer.classList.add('settling');
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => footer.classList.remove('settling'), SETTLE_MS);
  }

  const settling = () => performance.now() < settleUntil;
  // The card has a result and the footer shows Continue.
  const answered = () => state === 'right' || state === 'close' || state === 'wrong';

  function updateHeader() {
    bar.set(progressFraction(session));
    counter.textContent = `${Math.min(session.done, session.originalCount)}/${session.originalCount}`;
  }

  function makeCtx(card, list, item, sentence) {
    return {
      card,
      list,
      item,
      sentence,
      items: list.items,
      settings: store.settings(),
      retry: card.retry,
      rng: Math.random,
      speak: speakText,
      setReady: (ready) => {
        if (state === 'idle') primary.disabled = !ready;
      },
      setPrimaryLabel: (label) => {
        if (state === 'idle') primaryLabel.textContent = label;
      },
      submit: () => onPrimary(),
      showGradeButtons: () => {
        if (state !== 'idle') return;
        setState('grade');
      },
    };
  }

  function mount(node) {
    const old = currentEl;
    currentEl = node;
    node.classList.add('practice-card');
    stage.appendChild(node);
    scroller.scrollTop = 0;
    // The first card is built before the router puts this screen on the
    // page; onShow focuses it once it is there.
    if (current.focus && el.isConnected) current.focus();
    if (old) {
      if (reducedMotion()) {
        old.remove();
      } else {
        old.classList.add('leaving');
        const out = old.animate([{ transform: 'translate3d(0,0,0)', opacity: 1 }, { transform: 'translate3d(-48px,0,0)', opacity: 0 }], { duration: 220, easing: 'ease-in', fill: 'forwards' });
        out.finished.then(() => old.remove(), () => old.remove());
        node.animate([{ transform: 'translate3d(56px,0,0)', opacity: 0 }, { transform: 'translate3d(0,0,0)', opacity: 1 }], { duration: 340, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', delay: 60, fill: 'backwards' });
      }
    }
  }

  function showCard() {
    clearAuto();
    let card = currentCard(session);
    // Skip cards whose item/sentence was deleted since the session started.
    while (card) {
      const list = lists.get(card.listId);
      const item = list?.items.find((i) => i.id === card.itemId);
      const sentence = card.sentenceId ? list?.sentences?.find((s) => s.id === card.sentenceId) : null;
      if (item && (!card.sentenceId || sentence)) break;
      session.index += 1;
      session.done += 1;
      card = currentCard(session);
    }
    if (!card) {
      // Never navigate while the router is still building this screen.
      if (shown) finish();
      else finishPending = true;
      return;
    }
    const list = lists.get(card.listId);
    const item = list.items.find((i) => i.id === card.itemId);
    const sentence = card.sentenceId ? list.sentences.find((s) => s.id === card.sentenceId) : null;
    if (current?.destroy) current.destroy();
    setState('idle');
    const renderer = RENDERERS[card.type];
    current = renderer.render(card, makeCtx(card, list, item, sentence));
    setPrimary(current.primaryLabel || 'Check', { ready: !!current.readyInitially });
    if (card.retry) current.el.prepend(h('div', { class: 'retry-tag' }, icon('refresh', { size: 14 }), 'Try again'));
    mount(current.el);
    updateHeader();
  }

  function onResult(result) {
    if (!result || state !== 'idle') return;
    currentEl.classList.add('checked');
    const fb = result.feedback || {};
    const title = result.correct ? fb.title || (result.hinted ? 'Correct — with a hint' : PRAISE[Math.floor(Math.random() * PRAISE.length)]) : fb.title || 'Not quite';
    // Nearly right (a one-letter slip, most family forms) shows in orange.
    setState(result.correct ? 'right' : result.close ? 'close' : 'wrong', { title, detail: fb.detail });
    if (!Object.keys(session.outcomes).length) pausedSave = commitPausedSession(session.id);
    answer(session, result);
    // Save as soon as the last card is answered: iOS may close the app
    // before Continue is tapped.
    if (isFinished(session)) saveSession();
    updateHeader();
    keepFieldVisible();
    // Continue stays the one accent button; the banner carries right/wrong.
    setPrimary('Continue');
    const s = store.settings();
    if (result.correct && s.autoAdvance > 0 && !result.noAutoAdvance) startAuto(s.autoAdvance * 1000);
  }

  function grade(correct) {
    if (state !== 'grade' || settling()) return;
    state = 'idle';
    onResult(current.grade ? current.grade(correct) : { correct });
  }

  function onPrimary() {
    if (settling()) return;
    if (state === 'idle') {
      if (primary.disabled) return;
      const result = current.check();
      if (result) onResult(result);
    } else if (answered()) {
      next();
    }
  }

  // The footer button must not take focus from the answer field: the iOS
  // keyboard would drop on Check and come back on Continue. Desktop: cancel
  // the mousedown; iOS: put focus back inside the tap, before the card
  // handles it (dictation then blurs its field on purpose).
  const typingField = () => {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && stage.contains(a) ? a : null;
  };
  let fieldAtTap = null;
  primary.addEventListener('pointerdown', () => {
    fieldAtTap = typingField();
  });
  primary.addEventListener('mousedown', (e) => {
    if (typingField()) e.preventDefault();
  });

  function onPrimaryTap() {
    const field = fieldAtTap;
    fieldAtTap = null;
    if (field && field.isConnected && document.activeElement !== field) field.focus({ preventScroll: true });
    onPrimary();
  }

  // A taller footer (feedback banner) or the keyboard can cover the focused
  // answer field near the bottom of the card: bring it back into view.
  function keepFieldVisible() {
    const field = typingField();
    if (field) revealField(field);
  }

  function next() {
    clearAuto();
    stopSpeech();
    if (isFinished(session)) return finish();
    showCard();
  }

  function startAuto(ms) {
    timerBar.style.transition = 'none';
    timerBar.style.transform = 'scaleX(0)';
    timerBar.getBoundingClientRect();
    timerBar.style.transition = `transform ${ms}ms linear`;
    timerBar.style.transform = 'scaleX(1)';
    autoTimer = setTimeout(() => {
      // Never move on under an alert (e.g. "End this session?").
      if (hasOpenOverlay()) clearAuto();
      else next();
    }, ms);
  }

  function clearAuto() {
    clearTimeout(autoTimer);
    autoTimer = null;
    timerBar.style.transition = 'none';
    timerBar.style.transform = 'scaleX(0)';
  }

  // Starts saving once; later calls get the same promise.
  function saveSession() {
    if (!committing) {
      // Let an older paused session finish saving first: both may update
      // the same word's progress.
      committing = Promise.resolve(pausedSave)
        .catch(() => {})
        .then(() => commit(session))
        .then(
          (summary) => ({ summary, saved: true }),
          (err) => {
            console.error('Could not save the session', err);
            return { summary: summarize(session), saved: false };
          },
        );
    }
    return committing;
  }

  async function finish() {
    if (state === 'finishing') return;
    state = 'finishing';
    clearAuto();
    const { summary, saved } = await saveSession();
    // The snapshot is kept, so the answers are saved on the next launch.
    if (!saved) toast('Could not save this session. Your answers are kept; open the app again to save.', { icon: 'xCircle', tone: 'red', duration: 4000 });
    // The router may be busy for a moment; never leave a dead screen behind.
    for (let tries = 0; tries < 10; tries++) {
      if (!el.isConnected) return;
      if (await replace('results', { summary })) return;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    closing = true;
    if (!(await pop({ force: true }))) closing = false;
  }

  let closing = false;
  async function requestClose() {
    if (state === 'finishing' || closing) return;
    // Auto-continue must not change the card under the alert.
    clearAuto();
    const answered = Object.keys(session.outcomes).length;
    if (!answered) {
      clearSnapshot(session.id);
      closing = true;
      const left = await pop();
      if (!left) closing = false;
      return;
    }
    const choice = await alert({
      title: 'End this session?',
      message: 'Your answers so far will be saved.',
      actions: [
        { label: 'Keep going', value: 'stay', style: 'cancel' },
        { label: 'End session', value: 'end', style: 'destructive' },
      ],
    });
    if (choice === 'end') finish();
  }

  // Enter key (iPad / desktop keyboards) outside text fields.
  const onKey = (e) => {
    if (e.key !== 'Enter' || e.isComposing || hasOpenOverlay()) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
    e.preventDefault();
    if (state === 'grade') return;
    onPrimary();
  };
  document.addEventListener('keydown', onKey);

  showCard();

  return {
    el,
    title: session.title || MODES[session.mode]?.label || 'Practice',
    swipeBack: false,
    onShow({ first } = {}) {
      shown = true;
      if (finishPending) {
        finishPending = false;
        finish();
        return;
      }
      if (first && state === 'idle' && current?.focus) current.focus();
    },
    // Escape (iPad / desktop keyboards) asks before ending, like the close button.
    beforeLeave() {
      if (closing || state === 'finishing') return true;
      if (!Object.keys(session.outcomes).length) {
        clearSnapshot(session.id);
        return true;
      }
      requestClose();
      return false;
    },
    onDestroy() {
      clearAuto();
      clearTimeout(settleTimer);
      stopSpeech();
      document.removeEventListener('keydown', onKey);
      if (current?.destroy) current.destroy();
    },
  };
}
