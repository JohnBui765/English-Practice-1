// Keeps the app frame inside the *visual* viewport so the iOS keyboard never
// covers the footer buttons, and the page never drifts after the keyboard
// closes. Sets --app-h / --app-top on <html> and toggles html.kb-open.

export function initViewport() {
  const root = document.documentElement;
  const vv = window.visualViewport;
  let frame = 0;
  let lastHeight = 0;

  const update = () => {
    frame = 0;
    if (!vv || vv.scale > 1.01) {
      // Pinch-zoomed (or no visualViewport): let the frame fill the layout viewport.
      root.style.removeProperty('--app-h');
      root.style.removeProperty('--app-top');
      root.classList.remove('kb-open');
      return;
    }
    const height = Math.round(vv.height);
    const top = Math.round(vv.offsetTop);
    const keyboard = window.innerHeight - height;
    root.style.setProperty('--app-h', `${height}px`);
    root.style.setProperty('--app-top', `${top}px`);
    root.classList.toggle('kb-open', keyboard > 120);
    // The frame got shorter (keyboard opened or grew): keep the focused field
    // in view instead of under the footer.
    if (lastHeight && height < lastHeight) {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) requestAnimationFrame(() => revealField(el));
    }
    lastHeight = height;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };

  if (vv) {
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
  }
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', () => setTimeout(update, 300));

  // iOS sometimes leaves the window scrolled after the keyboard closes.
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      const el = document.activeElement;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (!typing && (window.scrollY || document.documentElement.scrollTop)) window.scrollTo(0, 0);
      schedule();
    }, 60);
  });

  update();
}

// Scrolls a focused field into the middle of its scroll container once the
// keyboard animation has finished.
export function keepVisible(el) {
  setTimeout(() => {
    if (document.activeElement === el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 320);
}

// Top of `el` inside the positioned `scroller`, from layout offsets; null
// when the scroller is not its offset parent chain's end.
function offsetIn(el, scroller) {
  let top = 0;
  let node = el;
  while (node && node !== scroller && scroller.contains(node)) {
    top += node.offsetTop;
    node = node.offsetParent;
  }
  return node === scroller ? top : null;
}

// Scrolls the nearest .scroll container just enough that `el` is clear of
// its edges (e.g. a focused answer field after a hint or a taller footer).
// `above`: an element higher up (the sentence a field answers) that should
// stay in view too when both fit. Uses layout positions (offsetTop), so a
// FLIP transform still running on `el` does not throw the measurement off
// the way scrollIntoView() is.
export function revealField(el, { margin = 12, above = null } = {}) {
  const scroller = el?.closest?.('.scroll');
  if (!scroller || !el.isConnected) return;
  const top = offsetIn(el, scroller);
  if (top === null) {
    // The container is not positioned, so offsets are not relative to it.
    el.scrollIntoView({ block: 'nearest' });
    return;
  }
  const bottom = top + el.offsetHeight;
  const view = scroller.clientHeight;
  let target = scroller.scrollTop;
  if (bottom + margin > target + view) target = bottom + margin - view;
  if (top - margin < target) target = Math.max(0, top - margin);
  const from = above?.isConnected && scroller.contains(above) ? offsetIn(above, scroller) : null;
  if (from !== null && from - margin < target && bottom - from + 2 * margin <= view) target = Math.max(0, from - margin);
  if (Math.abs(target - scroller.scrollTop) < 1) return;
  const smooth = !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  scroller.scrollTo({ top: target, behavior: smooth ? 'smooth' : 'auto' });
}
