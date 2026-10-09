// Small pure helpers shared by core logic and UI.

export function uid() {
  const rand = typeof crypto !== 'undefined' && crypto.getRandomValues
    ? Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(36).padStart(2, '0')).join('')
    : Math.random().toString(36).slice(2, 14);
  return Date.now().toString(36) + rand.slice(0, 8);
}

// Fisher–Yates; returns a new array and leaves the input untouched.
export function shuffle(array, rng = Math.random) {
  const out = array.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function pick(array, rng = Math.random) {
  return array.length ? array[Math.floor(rng() * array.length)] : undefined;
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export const DAY = 24 * 60 * 60 * 1000;

export function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(ms, days) {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function plural(n, one, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}

export function formatDate(ms, locale = 'en-GB') {
  return new Date(ms).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}
