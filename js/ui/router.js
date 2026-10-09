// Navigation stack with iOS-style push/pop/modal transitions, an interactive
// left-edge swipe-back, and persistence so the app reopens on the same screen
// after iOS evicts it (e.g. while the user is away in the Claude app).
import { h, reducedMotion } from './dom.js';
import { hasOpenOverlay } from './components.js';

const NAV_KEY = 'vs.nav';
const RESTORE_WINDOW = 12 * 60 * 60 * 1000;
const DURATION = 420;
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const PARALLAX = -0.3; // the covered screen moves 30% left
const DIM = 0.1;
const EDGE = 28; // px from the left edge that starts a swipe-back

const registry = new Map();
const stack = [];
let host = null;
let busy = false;
let currentTab = 'today';

export function register(name, factory, { persist = true } = {}) {
  registry.set(name, { factory, persist });
}

export function current() {
  const top = stack[stack.length - 1];
  return top ? { name: top.name, params: top.params, modal: top.modal } : null;
}

export function currentTabName() {
  return currentTab;
}

export function depth() {
  return stack.length;
}

function save() {
  try {
    const entries = stack
      .filter((e) => registry.get(e.name)?.persist !== false)
      .map(({ name, params, modal }) => ({ name, params, modal }));
    localStorage.setItem(NAV_KEY, JSON.stringify({ at: Date.now(), tab: currentTab, stack: entries }));
  } catch {
    /* storage unavailable: navigation still works, it just is not restored */
  }
}

async function build(name, params, modal) {
  const reg = registry.get(name);
  if (!reg) throw new Error(`Unknown screen "${name}"`);
  const prev = stack[stack.length - 1];
  const inst = await reg.factory(params || {}, {
    params: params || {},
    backLabel: prev?.inst?.title || 'Back',
    modal,
  });
  if (!inst || !inst.el) throw new Error(`Screen "${name}" did not return an element`);
  const el = inst.el;
  el.classList.add('screen');
  if (modal) el.classList.add('modal');
  const dim = h('div', { class: 'screen-dim', 'aria-hidden': 'true' });
  el.appendChild(dim);
  return { name, params: params || {}, modal, el, inst, dim };
}

function animate(el, keyframes, duration = DURATION) {
  if (reducedMotion()) duration = 1;
  const anim = el.animate(keyframes, { duration, easing: EASE, fill: 'both' });
  return anim.finished.then(
    () => anim,
    () => anim,
  );
}

function settle(entry) {
  // Remove animation residue so the element sits in its natural position.
  entry.el.getAnimations().forEach((a) => a.cancel());
  entry.dim.getAnimations().forEach((a) => a.cancel());
  entry.el.style.transform = '';
  entry.dim.style.opacity = '';
}

function cover(entry, covered) {
  entry.el.classList.toggle('covered', covered);
  entry.el.style.visibility = covered ? 'hidden' : '';
  if (covered) entry.el.setAttribute('aria-hidden', 'true');
  else entry.el.removeAttribute('aria-hidden');
  entry.el.inert = covered;
}

async function lock(fn) {
  if (busy) return false;
  busy = true;
  host.classList.add('busy');
  try {
    return await fn();
  } finally {
    busy = false;
    host.classList.remove('busy');
  }
}

export function push(name, params = {}, { modal = false, animate: anim = true } = {}) {
  return lock(async () => {
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    const entry = await build(name, params, modal);
    const prev = stack[stack.length - 1];
    host.appendChild(entry.el);
    stack.push(entry);
    save();
    if (prev && anim) {
      const w = host.clientWidth;
      if (modal) {
        await animate(entry.el, [{ transform: 'translate3d(0, 100%, 0)' }, { transform: 'translate3d(0, 0, 0)' }], 460);
      } else {
        await Promise.all([
          animate(entry.el, [{ transform: `translate3d(${w}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }]),
          animate(prev.el, [{ transform: 'translate3d(0, 0, 0)' }, { transform: `translate3d(${w * PARALLAX}px, 0, 0)` }]),
          animate(prev.dim, [{ opacity: 0 }, { opacity: DIM }]),
        ]);
      }
    }
    if (prev) {
      settle(prev);
      cover(prev, true);
      prev.inst.onHide && prev.inst.onHide();
    }
    settle(entry);
    entry.inst.onShow && entry.inst.onShow({ first: true });
    return true;
  });
}

async function canLeave(entry) {
  if (!entry.inst.beforeLeave) return true;
  try {
    return (await entry.inst.beforeLeave()) !== false;
  } catch {
    return true;
  }
}

async function finishPop(top, prev) {
  stack.pop();
  top.el.remove();
  top.inst.onDestroy && top.inst.onDestroy();
  settle(prev);
  save();
  prev.inst.onShow && prev.inst.onShow({ returning: true });
}

export function pop({ force = false, animate: anim = true } = {}) {
  return lock(async () => {
    if (stack.length < 2) return false;
    const top = stack[stack.length - 1];
    if (!force && !(await canLeave(top))) return false;
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    const prev = stack[stack.length - 2];
    cover(prev, false);
    if (anim) {
      const w = host.clientWidth;
      if (top.modal) {
        await animate(top.el, [{ transform: 'translate3d(0, 0, 0)' }, { transform: 'translate3d(0, 100%, 0)' }], 400);
      } else {
        await Promise.all([
          animate(top.el, [{ transform: 'translate3d(0, 0, 0)' }, { transform: `translate3d(${w}px, 0, 0)` }]),
          animate(prev.el, [{ transform: `translate3d(${w * PARALLAX}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }]),
          animate(prev.dim, [{ opacity: DIM }, { opacity: 0 }]),
        ]);
      }
    }
    await finishPop(top, prev);
    return true;
  });
}

// Replace the top screen (e.g. practice → results) with a cross-fade.
export function replace(name, params = {}, { modal } = {}) {
  return lock(async () => {
    const old = stack[stack.length - 1];
    const isModal = modal ?? old?.modal ?? false;
    const entry = await build(name, params, isModal);
    host.appendChild(entry.el);
    if (old) await animate(entry.el, [{ opacity: 0 }, { opacity: 1 }], 260);
    settle(entry);
    if (old) {
      stack.pop();
      old.el.remove();
      old.inst.onDestroy && old.inst.onDestroy();
    }
    stack.push(entry);
    save();
    entry.inst.onShow && entry.inst.onShow({ first: true });
    return true;
  });
}

function clearStack() {
  while (stack.length) {
    const e = stack.pop();
    e.el.remove();
    e.inst.onDestroy && e.inst.onDestroy();
  }
}

// Switch to a tab root (no animation, like iOS).
export function resetTo(tab = 'today') {
  return lock(async () => {
    currentTab = tab;
    const entry = await build(tab, {}, false);
    clearStack();
    host.appendChild(entry.el);
    stack.push(entry);
    save();
    entry.inst.onShow && entry.inst.onShow({ first: true });
    return true;
  });
}

// Pop everything above the tab root.
export async function popToRoot() {
  while (stack.length > 1) {
    const ok = await pop({ force: true, animate: stack.length === 2 });
    if (!ok) break;
  }
}

/* ---------- Interactive swipe-back ---------- */

function setupSwipeBack() {
  let track = null;

  host.addEventListener(
    'touchstart',
    (e) => {
      if (busy || stack.length < 2 || hasOpenOverlay() || e.touches.length !== 1) return;
      const top = stack[stack.length - 1];
      if (top.modal || top.inst.swipeBack === false) return;
      const t = e.touches[0];
      if (t.clientX > EDGE) return;
      track = { x0: t.clientX, y0: t.clientY, x: t.clientX, t: e.timeStamp, v: 0, committed: false, top, prev: stack[stack.length - 2] };
    },
    { passive: true },
  );

  host.addEventListener(
    'touchmove',
    (e) => {
      if (!track) return;
      const t = e.touches[0];
      const dx = t.clientX - track.x0;
      const dy = t.clientY - track.y0;
      if (!track.committed) {
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
          track = null;
          return;
        }
        if (dx < 8) return;
        track.committed = true;
        busy = true;
        track.top.el.classList.add('tracking'); // edge shadow (css/app.css)
        // The keyboard (if up) goes down only if the swipe completes.
        cover(track.prev, false);
      }
      e.preventDefault();
      const w = host.clientWidth;
      const x = Math.max(0, dx);
      const dt = Math.max(1, e.timeStamp - track.t);
      track.v = (t.clientX - track.x) / dt;
      track.x = t.clientX;
      track.t = e.timeStamp;
      const p = x / w;
      track.top.el.style.transform = `translate3d(${x}px, 0, 0)`;
      track.prev.el.style.transform = `translate3d(${w * PARALLAX * (1 - p)}px, 0, 0)`;
      track.prev.dim.style.opacity = String(DIM * (1 - p));
    },
    { passive: false },
  );

  const end = async () => {
    if (!track) return;
    const { top, prev, committed, v, x0, x } = track;
    track = null;
    if (!committed) return;
    top.el.classList.remove('tracking');
    const w = host.clientWidth;
    const dx = Math.max(0, x - x0);
    const p = dx / w;
    const complete = p > 0.35 || v > 0.45;
    const fromTop = `translate3d(${dx}px, 0, 0)`;
    const fromPrev = `translate3d(${w * PARALLAX * (1 - p)}px, 0, 0)`;
    const ms = Math.max(160, DURATION * (complete ? 1 - p : p));
    top.el.style.transform = '';
    prev.el.style.transform = '';
    prev.dim.style.opacity = '';
    host.classList.add('busy');
    if (complete) {
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      await Promise.all([
        animate(top.el, [{ transform: fromTop }, { transform: `translate3d(${w}px, 0, 0)` }], ms),
        animate(prev.el, [{ transform: fromPrev }, { transform: 'translate3d(0, 0, 0)' }], ms),
        animate(prev.dim, [{ opacity: DIM * (1 - p) }, { opacity: 0 }], ms),
      ]);
      await finishPop(top, prev);
    } else {
      await Promise.all([
        animate(top.el, [{ transform: fromTop }, { transform: 'translate3d(0, 0, 0)' }], ms),
        animate(prev.el, [{ transform: fromPrev }, { transform: `translate3d(${w * PARALLAX}px, 0, 0)` }], ms),
        animate(prev.dim, [{ opacity: DIM * (1 - p) }, { opacity: DIM }], ms),
      ]);
      settle(top);
      settle(prev);
      cover(prev, true);
    }
    busy = false;
    host.classList.remove('busy');
  };
  host.addEventListener('touchend', end);
  host.addEventListener('touchcancel', end);
}

/* ---------- Boot ---------- */

export async function init(container, { defaultTab = 'today' } = {}) {
  host = container;
  host.classList.add('stack');
  host.addEventListener('navback', () => pop());
  host.addEventListener('tabchange', (e) => {
    if (e.detail !== currentTab || stack.length > 1) resetTo(e.detail);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !hasOpenOverlay() && stack.length > 1) pop();
  });
  setupSwipeBack();

  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(NAV_KEY) || 'null');
  } catch {
    saved = null;
  }
  const fresh = !!saved && Date.now() - saved.at < RESTORE_WINDOW && registry.has(saved.tab);
  await resetTo(fresh ? saved.tab : defaultTab);
  if (!fresh) return;
  const entries = Array.isArray(saved.stack) ? saved.stack.slice(1) : [];
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || !registry.has(entry.name)) break;
    try {
      const ok = await push(entry.name, entry.params, { modal: entry.modal, animate: false });
      if (!ok) break;
      // A screen whose content is gone (e.g. its list was deleted): land on
      // the deepest screen that still exists instead.
      if (stack[stack.length - 1].inst.missing) {
        await pop({ force: true, animate: false });
        break;
      }
    } catch (err) {
      console.warn('Could not restore screen', entry.name, err);
      break;
    }
  }
}
