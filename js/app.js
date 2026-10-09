// Boot: storage + settings → theme → screens → router → service worker.
import * as router from './ui/router.js';
import { initViewport } from './ui/viewport.js';
import { openDatabase, loadSettings, settings, onChange } from './data/store.js';
import { englishVoices, unlock as unlockSpeech } from './ui/speech.js';
import { toast } from './ui/components.js';
import { registerScreens } from './screens/index.js';
import { recoverSnapshot } from './screens/practice/session.js';

const THEME_COLORS = { light: '#f2f2f7', dark: '#000000' };

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const scheme = meta.getAttribute('media')?.includes('dark') ? 'dark' : 'light';
    meta.setAttribute('content', THEME_COLORS[theme === 'light' || theme === 'dark' ? theme : scheme]);
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  // The first install also takes control of this page (clients.claim), which
  // fires controllerchange: that must not reload the page and wipe what the
  // user is doing. Reload only when a running version is being replaced.
  const hadController = !!navigator.serviceWorker.controller;
  let updateAccepted = false;
  navigator.serviceWorker
    .register('sw.js')
    .then((reg) => {
      if (!reg) return;
      const offerUpdate = (worker) => {
        toast('A new version is ready', {
          icon: 'sparkles',
          tone: 'accent',
          duration: 12000,
          className: 'update',
          action: {
            label: 'Update',
            onTap: () => {
              updateAccepted = true;
              worker.postMessage({ type: 'SKIP_WAITING' });
            },
          },
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
        });
      });
      // Check for updates whenever the app comes back to the foreground, and
      // offer a waiting one again if its toast was missed or replaced.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        reg
          .update()
          .catch(() => {})
          .finally(() => {
            if (reg.waiting && navigator.serviceWorker.controller && !document.querySelector('.toast.update')) offerUpdate(reg.waiting);
          });
      });
    })
    .catch((err) => console.warn('Service worker registration failed', err));

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || (!hadController && !updateAccepted)) return;
    reloading = true;
    location.reload();
  });
}

async function boot() {
  initViewport();
  // An empty touchstart listener makes :active styles work on iOS.
  document.addEventListener('touchstart', () => {}, { passive: true });
  window.addEventListener('pointerup', () => unlockSpeech(), { once: true, capture: true });

  await openDatabase();
  await loadSettings();
  applyTheme(settings().theme);
  onChange(({ store, key, value }) => {
    if (store === 'settings' && key === 'theme') applyTheme(value);
    if (store === 'all') applyTheme(settings().theme);
  });
  englishVoices();

  registerScreens(router.register);
  const app = document.getElementById('app');
  const splash = app.querySelector('.boot');
  await router.init(app, { defaultTab: 'today' });
  if (splash) {
    splash.classList.add('gone');
    setTimeout(() => splash.remove(), 300);
  }
  // A session whose answers were never saved (the app closed on the last
  // card, or saving failed): save it now.
  recoverSnapshot().catch((err) => console.error('Could not save the paused session', err));
  registerServiceWorker();
}

boot().catch((err) => {
  console.error(err);
  const app = document.getElementById('app');
  app.textContent = '';
  const box = document.createElement('div');
  box.style.cssText = 'padding:48px 24px;font:17px -apple-system,sans-serif;color:var(--label);text-align:center';
  box.textContent = 'Something went wrong while starting the app. Please close it and open it again.';
  app.appendChild(box);
});
