// Tiny DOM builder. Children that are strings become text nodes, so user text
// is never parsed as HTML.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Keys set as DOM properties rather than attributes.
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'readOnly', 'indeterminate', 'muted']);

function applyClass(el, value) {
  if (!value) return;
  if (typeof value === 'string') {
    el.setAttribute('class', value);
  } else if (Array.isArray(value)) {
    el.setAttribute('class', value.filter(Boolean).join(' '));
  } else {
    el.setAttribute('class', Object.keys(value).filter((k) => value[k]).join(' '));
  }
}

function applyProps(el, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key === 'class' || key === 'className') {
      applyClass(el, value);
    } else if (key === 'style') {
      if (typeof value === 'string') el.setAttribute('style', value);
      else if (value) {
        for (const [prop, v] of Object.entries(value)) {
          if (v === null || v === undefined || v === false) continue;
          if (prop.startsWith('--')) el.style.setProperty(prop, String(v));
          else el.style[prop] = v;
        }
      }
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value || {})) {
        if (v !== undefined && v !== null) el.dataset[k] = String(v);
      }
    } else if (key === 'ref') {
      if (typeof value === 'function') value(el);
    } else if (key.length > 2 && key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (PROPS.has(key)) {
      el[key] = value;
    } else if (value === true) {
      el.setAttribute(key, '');
    } else if (value !== false && value !== null) {
      el.setAttribute(key, String(value));
    }
  }
}

export function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
  return parent;
}

function isProps(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Node);
}

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (isProps(props)) applyProps(el, props);
  else if (props !== undefined) children.unshift(props);
  return append(el, children);
}

export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.setAttribute('class', value);
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) if (child) el.appendChild(child);
  return el;
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replaceChildren(el, ...children) {
  clear(el);
  return append(el, children);
}

export function onTap(el, fn) {
  el.addEventListener('click', fn);
  return el;
}

// Resolves after the next paint — use before starting a CSS transition on a
// freshly inserted element.
export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

export const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
