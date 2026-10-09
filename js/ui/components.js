// Shared iOS-style components. Screens compose these; styling is in css/app.css.
import { h, append, nextFrame, reducedMotion } from './dom.js';
import { icon } from './icons.js';
import { posLabel } from '../core/text.js';

const asNode = (x) => (typeof x === 'string' ? document.createTextNode(x) : x);

/* ---------- Buttons ---------- */

export function button({ label, icon: iconName, variant = 'primary', size = 'regular', onTap, disabled = false, block = false, className = '', ariaLabel, type = 'button' } = {}) {
  return h(
    'button',
    {
      type,
      class: ['btn', variant, size !== 'regular' && size, block && 'block', className],
      disabled,
      'aria-label': ariaLabel,
      onClick: (e) => {
        if (!e.currentTarget.disabled && onTap) onTap(e);
      },
    },
    iconName ? icon(iconName) : null,
    label ? h('span', null, label) : null,
  );
}

export function iconButton({ icon: iconName, label, onTap, variant = '', className = '', disabled = false }) {
  return h(
    'button',
    {
      type: 'button',
      class: ['icon-btn', variant, className],
      'aria-label': label,
      title: label,
      disabled,
      onClick: (e) => onTap && onTap(e),
    },
    icon(iconName),
  );
}

/* ---------- Screen scaffold ---------- */

function navButton(action) {
  if (action instanceof Node) return action;
  return h(
    'button',
    {
      type: 'button',
      class: ['nav-action', action.strong && 'strong'],
      disabled: action.disabled,
      'aria-label': action.ariaLabel || action.label,
      onClick: (e) => action.onTap && action.onTap(e),
      ref: action.ref,
    },
    action.icon ? icon(action.icon, { size: 24 }) : null,
    action.label && !action.icon ? action.label : null,
  );
}

export function navBar({ title = '', back = null, actions = [], left = [] } = {}) {
  const titleEl = h('div', { class: 'nav-title', role: 'heading', 'aria-level': '2' }, title);
  const leftSide = h('div', { class: 'nav-side left' });
  if (back) {
    const label = back.label ?? 'Back';
    // Like UIKit: a back title too long for the bar becomes "Back".
    const shown = label.length > 12 ? 'Back' : label;
    leftSide.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: 'nav-back',
          'aria-label': `Back to ${label}`,
          onClick: (e) => {
            if (back.onTap) back.onTap(e);
            else e.currentTarget.dispatchEvent(new CustomEvent('navback', { bubbles: true }));
          },
        },
        icon('chevronLeft'),
        h('span', null, shown),
      ),
    );
  }
  left.forEach((a) => leftSide.appendChild(navButton(a)));
  const rightSide = h('div', { class: 'nav-side right' }, actions.map(navButton));
  const el = h('header', { class: 'nav' }, h('div', { class: 'nav-bar' }, leftSide, titleEl, rightSide));
  return { el, titleEl, leftSide, rightSide };
}

// Standard screen: nav bar, scrolling content (with an iOS large title that
// collapses into the nav bar), optional footer and tab bar.
export function screen({ title = '', subtitle = '', largeTitle = true, back = null, actions = [], left = [], body = [], footer = null, className = '', tab = null, solidNav = false } = {}) {
  const nav = navBar({ title, back, actions, left });
  if (solidNav) nav.el.classList.add('solid');
  const largeEl = largeTitle ? h('h1', { class: 'large-title' }, title) : null;
  const subEl = subtitle ? h('p', { class: 'large-subtitle' }, subtitle) : null;
  const content = h('div', { class: 'scroll-inner' }, largeEl, subEl, body);
  const scroll = h('div', { class: 'scroll' }, content);
  const footerEl = footer ? h('div', { class: 'footer' }, h('div', { class: 'footer-row' }, footer)) : null;
  const el = h(
    'section',
    { class: ['screen', largeTitle && 'has-large-title', tab && 'has-tabbar', className] },
    nav.el,
    scroll,
    footerEl,
    tab ? tabBar(tab) : null,
  );

  let ticking = false;
  const threshold = largeTitle ? 34 : 2;
  scroll.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        el.classList.toggle('scrolled', scroll.scrollTop > threshold);
      });
    },
    { passive: true },
  );

  return {
    el,
    nav,
    scroll,
    content,
    footer: footerEl,
    setTitle(t) {
      nav.titleEl.textContent = t;
      if (largeEl) largeEl.textContent = t;
    },
    setSubtitle(t) {
      if (subEl) subEl.textContent = t;
    },
    setFooter(...children) {
      if (!footerEl) return;
      const row = footerEl.firstChild;
      row.replaceChildren();
      append(row, children);
    },
  };
}

export const TABS = [
  { name: 'today', label: 'Today', icon: 'sun' },
  { name: 'lists', label: 'Lists', icon: 'books' },
  { name: 'settings', label: 'Settings', icon: 'gear' },
];

export function tabBar(active) {
  return h(
    'nav',
    { class: 'tabbar', 'aria-label': 'Tabs' },
    TABS.map((t) =>
      h(
        'button',
        {
          type: 'button',
          class: ['tab', t.name === active && 'active'],
          'aria-current': t.name === active ? 'page' : undefined,
          dataset: { tab: t.name },
          onClick: (e) => e.currentTarget.dispatchEvent(new CustomEvent('tabchange', { bubbles: true, detail: t.name })),
        },
        icon(t.icon),
        h('span', null, t.label),
      ),
    ),
  );
}

/* ---------- Lists ---------- */

export function section({ header, footer, children = [], prominent = false, plain = false, className = '' } = {}) {
  return h(
    'div',
    { class: ['section', className] },
    header ? h('div', { class: ['section-header', prominent && 'prominent'] }, header) : null,
    plain ? children : h('div', { class: 'group' }, children),
    footer ? h('div', { class: 'section-footer' }, footer) : null,
  );
}

export function row({ icon: iconName, iconBg, title, subtitle, detail, accessory = 'chevron', onTap, destructive = false, accent = false, className = '', ariaLabel } = {}) {
  const tappable = typeof onTap === 'function';
  const acc =
    accessory === 'chevron'
      ? tappable
        ? h('span', { class: 'row-chevron' }, icon('chevronRight'))
        : null
      : accessory === 'none' || !accessory
        ? null
        : accessory;
  return h(
    tappable ? 'button' : 'div',
    {
      type: tappable ? 'button' : undefined,
      class: ['row', tappable && 'tappable', iconName && 'with-icon', destructive && 'destructive', accent && 'accent', className],
      'aria-label': ariaLabel,
      onClick: tappable ? onTap : undefined,
    },
    iconName ? h('span', { class: 'row-icon', style: { background: iconBg || 'var(--accent)' } }, icon(iconName)) : null,
    h(
      'span',
      { class: 'row-main' },
      h('span', { class: 'row-title', style: { display: 'block' } }, asNode(title)),
      subtitle ? h('span', { class: 'row-subtitle', style: { display: 'block' } }, asNode(subtitle)) : null,
    ),
    detail !== undefined && detail !== null && detail !== '' ? h('span', { class: 'row-detail' }, detail instanceof Node ? detail : String(detail)) : null,
    acc,
  );
}

/* ---------- Controls ---------- */

export function segmented({ options, value, onChange, ariaLabel }) {
  const count = options.length;
  const thumb = h('span', { class: 'segmented-thumb', style: { width: `calc((100% - 4px) / ${count})` } });
  const buttons = options.map((opt, i) =>
    h(
      'button',
      {
        type: 'button',
        'aria-pressed': String(opt.value === value),
        onClick: () => {
          if (opt.value === current) return;
          set(opt.value);
          onChange && onChange(opt.value);
        },
        dataset: { index: i },
      },
      h('span', { class: 'segmented-label' }, opt.label),
    ),
  );
  const el = h('div', { class: 'segmented', role: 'group', 'aria-label': ariaLabel }, thumb, buttons);
  let current = value;
  function set(v) {
    current = v;
    const idx = Math.max(0, options.findIndex((o) => o.value === v));
    thumb.style.transform = `translateX(${idx * 100}%)`;
    buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(i === idx)));
  }
  set(value);
  el.setValue = set;
  return el;
}

export function toggle({ checked = false, onChange, label = '' }) {
  const el = h('button', {
    type: 'button',
    role: 'switch',
    class: 'switch',
    'aria-checked': String(!!checked),
    'aria-label': label,
    onClick: () => {
      const next = el.getAttribute('aria-checked') !== 'true';
      el.setAttribute('aria-checked', String(next));
      onChange && onChange(next);
    },
  });
  el.setChecked = (v) => el.setAttribute('aria-checked', String(!!v));
  return el;
}

export function slider({ min = 0, max = 100, step = 1, value = 0, format = (v) => String(v), onChange, onInput, ariaLabel }) {
  const out = h('span', { class: 'slider-value' }, format(value));
  const input = h('input', {
    type: 'range',
    min,
    max,
    step,
    value: String(value),
    'aria-label': ariaLabel,
    onInput: (e) => {
      const v = Number(e.target.value);
      out.textContent = format(v);
      onInput && onInput(v);
    },
    onChange: (e) => onChange && onChange(Number(e.target.value)),
  });
  return h('div', { class: 'slider-wrap' }, input, out);
}

const ANSWER_ATTRS = {
  autocomplete: 'off',
  autocorrect: 'off',
  autocapitalize: 'off',
  spellcheck: 'false',
};

export function textField({ value = '', placeholder = '', onInput, onEnter, answer = false, type = 'text', enterkeyhint, inputmode, className = '', ariaLabel, maxlength } = {}) {
  const el = h('input', {
    type,
    class: ['field', answer && 'answer', className],
    value,
    placeholder,
    enterkeyhint,
    inputmode,
    maxlength,
    'aria-label': ariaLabel || placeholder,
    ...(answer ? ANSWER_ATTRS : {}),
    onInput: (e) => onInput && onInput(e.target.value, e),
    onKeydown: (e) => {
      if (e.key === 'Enter' && !e.isComposing && onEnter) {
        e.preventDefault();
        onEnter(e.target.value, e);
      }
    },
  });
  return el;
}

export function textArea({ value = '', placeholder = '', rows = 6, onInput, answer = false, className = '', ariaLabel } = {}) {
  const el = h('textarea', {
    class: ['textarea', className],
    placeholder,
    rows,
    'aria-label': ariaLabel || placeholder,
    ...(answer ? ANSWER_ATTRS : {}),
    onInput: (e) => onInput && onInput(e.target.value, e),
  });
  el.value = value;
  return el;
}

export function chip({ label, tone = '', onTap, selected = false, disabled = false, className = '' }) {
  return h(
    'button',
    {
      type: 'button',
      class: ['chip', tone, selected && 'selected', className],
      disabled,
      onClick: (e) => onTap && onTap(e),
    },
    label,
  );
}

export function badge(text, tone = '') {
  return h('span', { class: ['badge', tone] }, text);
}

// Parts of speech are neutral gray: coloured badges are kept for status
// ('3 due', 'New'), so colour keeps one meaning.
export function posBadge(pos) {
  if (!pos) return null;
  return badge(posLabel(pos));
}

/* ---------- Progress ---------- */

export function progressBar(fraction = 0) {
  const fill = h('div', { class: 'progress-fill' });
  const el = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
  const set = (f) => {
    const v = Math.max(0, Math.min(1, f || 0));
    fill.style.transform = `scaleX(${v})`;
    el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
  };
  set(fraction);
  return { el, set };
}

export function ring({ fraction = 0, size = 44, stroke = 5, label = '', color = '', labelSize } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = document.createElementNS(NS, 'svg');
  svgEl.setAttribute('width', size);
  svgEl.setAttribute('height', size);
  svgEl.setAttribute('viewBox', `0 0 ${size} ${size}`);
  const mk = (cls) => {
    const el = document.createElementNS(NS, 'circle');
    el.setAttribute('class', cls);
    el.setAttribute('cx', size / 2);
    el.setAttribute('cy', size / 2);
    el.setAttribute('r', r);
    el.setAttribute('stroke-width', stroke);
    return el;
  };
  const track = mk('ring-track');
  const value = mk('ring-value');
  value.setAttribute('stroke-dasharray', String(c));
  value.setAttribute('stroke-dashoffset', String(c));
  if (color) value.style.stroke = color;
  svgEl.append(track, value);
  const labelEl = h('span', { class: 'ring-label', style: { fontSize: `${labelSize || Math.round(size * 0.28)}px` } }, label);
  const el = h('span', { class: 'ring', style: { width: `${size}px`, height: `${size}px` } }, svgEl, labelEl);
  const set = (f, text) => {
    const v = Math.max(0, Math.min(1, f || 0));
    value.setAttribute('stroke-dashoffset', String(c * (1 - v)));
    if (text !== undefined) labelEl.textContent = text;
  };
  requestAnimationFrame(() => set(fraction));
  return { el, set };
}

/* ---------- Content blocks ---------- */

export function emptyState({ icon: iconName = 'books', title, message, action } = {}) {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon(iconName)),
    h('div', { class: 'empty-title' }, title),
    message ? h('div', { class: 'empty-message' }, message) : null,
    action ? button({ label: action.label, icon: action.icon, onTap: action.onTap, size: 'large' }) : null,
  );
}

export function card({ children = [], onTap, className = '', ariaLabel } = {}) {
  const tappable = typeof onTap === 'function';
  return h(
    tappable ? 'button' : 'div',
    {
      type: tappable ? 'button' : undefined,
      class: ['card', tappable && 'tappable', className],
      onClick: tappable ? onTap : undefined,
      'aria-label': ariaLabel,
    },
    children,
  );
}

/* ---------- Overlays ---------- */

const openOverlays = [];

function mountOverlay(content, { onScrim } = {}) {
  const scrim = h('div', { class: 'overlay-scrim', onClick: () => onScrim && onScrim() });
  const el = h('div', { class: 'overlay', role: 'presentation' }, scrim, content);
  document.body.appendChild(el);
  openOverlays.push(el);
  // Keep the keyboard from staying up under an overlay.
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  nextFrame().then(() => el.classList.add('open'));
  let closed = false;
  const close = () =>
    new Promise((resolve) => {
      if (closed) return resolve();
      closed = true;
      el.classList.remove('open');
      // While fading out, absorb the second tap of a double tap, then let
      // taps reach the screen underneath.
      setTimeout(() => (el.style.pointerEvents = 'none'), 150);
      const idx = openOverlays.indexOf(el);
      if (idx >= 0) openOverlays.splice(idx, 1);
      setTimeout(() => {
        el.remove();
        resolve();
      }, reducedMotion() ? 10 : 420);
    });
  return { el, close };
}

export function hasOpenOverlay() {
  return openOverlays.length > 0;
}

export function alert({ title, message = '', actions = [{ label: 'OK', value: true, style: 'default' }] } = {}) {
  return new Promise((resolve) => {
    const vertical = actions.length > 2;
    const ordered = vertical ? actions : [...actions].sort((a, b) => (a.style === 'cancel' ? -1 : b.style === 'cancel' ? 1 : 0));
    let overlay;
    const box = h(
      'div',
      { class: 'alert-wrap' },
      h(
        'div',
        { class: 'alert', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { class: 'alert-text' }, h('div', { class: 'alert-title' }, title), message ? h('div', { class: 'alert-message' }, message) : null),
        h(
          'div',
          { class: ['alert-actions', vertical && 'vertical'] },
          ordered.map((a) =>
            h(
              'button',
              {
                type: 'button',
                class: a.style || 'default',
                onClick: () => {
                  overlay.close();
                  resolve(a.value);
                },
              },
              a.label,
            ),
          ),
        ),
      ),
    );
    overlay = mountOverlay(box);
  });
}

export async function confirm({ title, message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', destructive = false } = {}) {
  const value = await alert({
    title,
    message,
    actions: [
      { label: cancelLabel, value: false, style: 'cancel' },
      { label: confirmLabel, value: true, style: destructive ? 'destructive' : 'default' },
    ],
  });
  return value === true;
}

export function actionSheet({ title = '', message = '', actions = [], cancelLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    let overlay;
    const done = (value) => {
      overlay.close();
      resolve(value);
    };
    const head = title || message ? h('div', { class: 'action-head' }, title ? h('strong', null, title) : null, message || null) : null;
    const sheetEl = h(
      'div',
      { class: 'action-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Actions' },
      h(
        'div',
        { class: 'action-group' },
        head,
        actions.map((a) => h('button', { type: 'button', class: a.style || '', onClick: () => done(a.value) }, a.label)),
      ),
      h('div', { class: 'action-group' }, h('button', { type: 'button', class: 'cancel', onClick: () => done(null) }, cancelLabel)),
    );
    overlay = mountOverlay(sheetEl, { onScrim: () => done(null) });
  });
}

// Bottom sheet. `left` / `right` are optional nav-style buttons; by default a
// "Close" button sits on the left. Drag the header down to dismiss.
export function sheet({ title = '', content = [], onClose, left, right, className = '' } = {}) {
  let overlay;
  let closedResolve;
  const closed = new Promise((r) => (closedResolve = r));
  const close = async (reason) => {
    await overlay.close();
    onClose && onClose(reason);
    closedResolve(reason);
  };
  const leftBtn = left === null ? null : navButton(left || { label: 'Close', onTap: () => close('close') });
  const rightBtn = right ? navButton(right) : null;
  const head = h(
    'div',
    { class: 'sheet-head' },
    h('div', { class: 'sheet-grabber' }),
    h('div', { class: 'sheet-bar' }, h('div', { class: 'nav-side left' }, leftBtn), h('div', { class: 'sheet-title' }, title), h('div', { class: 'nav-side right' }, rightBtn)),
  );
  const body = h('div', { class: 'sheet-body' }, content);
  const panel = h('div', { class: ['sheet', className], role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, head, body);
  overlay = mountOverlay(panel, { onScrim: () => close('scrim') });

  // Drag-to-dismiss on the header.
  let startY = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  let dragging = false;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    dragging = true;
    startY = lastY = e.clientY;
    lastT = e.timeStamp;
    velocity = 0;
    panel.classList.add('dragging');
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = Math.max(0, e.clientY - startY);
    const dt = Math.max(1, e.timeStamp - lastT);
    velocity = (e.clientY - lastY) / dt;
    lastY = e.clientY;
    lastT = e.timeStamp;
    panel.style.transform = `translate3d(0, ${dy}px, 0)`;
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('dragging');
    const dy = Math.max(0, e.clientY - startY);
    if (dy > 120 || velocity > 0.6) {
      panel.style.transform = '';
      close('swipe');
    } else {
      panel.style.transform = '';
    }
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);

  return { el: panel, body, close, closed, setRight(btn) { head.querySelector('.nav-side.right').replaceChildren(btn ? navButton(btn) : ''); } };
}

let toastTimer = null;
let toastEl = null;

export function toast(message, { icon: iconName = 'checkCircle', tone = 'green', duration = 2200, action, className = '' } = {}) {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = h('div', { class: 'toast-host', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  if (toastEl) toastEl.remove();
  clearTimeout(toastTimer);
  // Over a sheet, sit below its header so Close / Save stay visible.
  const sheetHead = openOverlays.length ? openOverlays[openOverlays.length - 1].querySelector('.sheet-head') : null;
  if (sheetHead) host.style.top = `${Math.round(sheetHead.getBoundingClientRect().bottom + 6)}px`;
  else host.style.removeProperty('top');
  const el = h(
    'div',
    { class: ['toast', tone, className], role: 'status' },
    iconName ? icon(iconName) : null,
    h('span', null, message),
    action ? h('button', { type: 'button', onClick: () => { hide(); action.onTap(); } }, action.label) : null,
  );
  toastEl = el;
  host.appendChild(el);
  nextFrame().then(() => el.classList.add('show'));
  function hide() {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
    if (toastEl === el) toastEl = null;
  }
  toastTimer = setTimeout(hide, duration);
  return { hide };
}

// Close the top-most overlay with Escape (keyboard users on iPad / desktop).
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !openOverlays.length) return;
    // Handled here: the router must not also pop the screen underneath.
    e.preventDefault();
    e.stopImmediatePropagation();
    const top = openOverlays[openOverlays.length - 1];
    top.querySelector('.overlay-scrim')?.click();
  });
}
