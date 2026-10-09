// Clipboard helpers. Call copyText() directly inside a tap handler (before any
// await) — iOS only grants clipboard access during a user gesture.

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  Object.assign(ta.style, { position: 'fixed', top: '0', left: '0', opacity: '0', fontSize: '16px' });
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

// Returns the clipboard text, or null when reading is not allowed/supported
// (iOS shows a small "Paste" bubble the user must tap).
export async function readText() {
  try {
    if (!navigator.clipboard || !navigator.clipboard.readText) return null;
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}
