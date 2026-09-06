/* Jiffy's >.< service worker
   Push notifications only. Deliberately caches NOTHING — a stale landing page
   would be worse than no PWA at all, so every request goes straight to the network. */

const API           = 'https://jiffys-api.tail1d1f7b.ts.net:10000';
const KEY_URL       = API + '/push/key';
const SUB_URL       = API + '/push/subscribe';
const FALLBACK_URL   = 'https://kick.com/jiffyvr';
const FALLBACK_TITLE = "Jiffy's is LIVE >.<";
const FALLBACK_BODY  = 'Come hang out in the stream 💕';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/* No-op fetch handler: satisfies the installability heuristic without caching
   anything. It answers nothing, so the browser does its normal network fetch. */
self.addEventListener('fetch', () => {});

function payloadOf(event) {
  var d = null;
  try { d = event.data ? event.data.json() : null; } catch (e) { d = null; }
  if (!d) {
    try {
      var t = event.data ? event.data.text() : '';
      if (t) d = { body: t };
    } catch (e2) { d = null; }
  }
  if (!d || typeof d !== 'object') d = {};
  return d;
}

self.addEventListener('push', (event) => {
  const d = payloadOf(event);

  const title = String(d.title || FALLBACK_TITLE).slice(0, 120);
  const url   = (typeof d.url === 'string' && /^https?:\/\//i.test(d.url)) ? d.url : FALLBACK_URL;

  const options = {
    body: String(d.body || FALLBACK_BODY).slice(0, 300),
    icon: typeof d.icon === 'string' && d.icon ? d.icon : '/icon-512.png',
    badge: typeof d.badge === 'string' && d.badge ? d.badge : '/apple-touch-icon.png',
    tag: typeof d.tag === 'string' && d.tag ? d.tag : 'jiffys-live',
    renotify: true,
    data: { url: url }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const target = (event.notification.data && event.notification.data.url) || FALLBACK_URL;
  const trim = (u) => String(u || '').replace(/\/+$/, '');

  event.waitUntil((async () => {
    /* clients.matchAll only ever returns SAME-ORIGIN windows, so a tab already
       sitting on kick.com (or anywhere else off this site) can never be found
       or focused from here — the spec gives a worker no handle on another
       origin's tabs. Only bother looking when the target is our own site. */
    let sameOrigin = false;
    try { sameOrigin = new URL(target, self.location.origin).origin === self.location.origin; }
    catch (e) { sameOrigin = false; }

    if (sameOrigin) {
      let list = [];
      try {
        list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      } catch (e) { list = []; }
      for (const client of list) {
        if (trim(client.url) === trim(target) && typeof client.focus === 'function') {
          try {
            if (typeof client.navigate === 'function' && client.url !== target) await client.navigate(target);
          } catch (e) {}
          return client.focus();
        }
      }
    }

    /* Cross-origin (the usual case: the stream itself) always opens a window. */
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

/* The push service can retire a subscription on its own — a key rotation, a
   long-idle browser, a quota reset. Without this the endpoint the server
   holds is dead and the fan never hears again, while their bell still reads
   "on". Re-subscribe with the CURRENT server key and re-register it. */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const b64ToBytes = (b64) => {
      const pad = '='.repeat((4 - (b64.length % 4)) % 4);
      const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
      const out = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      return out;
    };

    /* Prefer the freshly published key: this event fires precisely when the
       old one may no longer be the right one. Fall back to the key the dead
       subscription was made with when the backend is unreachable. */
    let key = null;
    try {
      const r = await fetch(KEY_URL, { credentials: 'omit' });
      if (r.ok) {
        const j = await r.json();
        const k = j && (j.public_key || j.key || j.publicKey);
        if (typeof k === 'string' && /^[A-Za-z0-9_-]{40,}$/.test(k)) key = b64ToBytes(k);
      }
    } catch (e) {}
    if (!key) {
      const old = event.oldSubscription || null;
      const opt = old && old.options ? old.options.applicationServerKey : null;
      if (opt) key = opt;
    }
    if (!key) return;

    let sub = event.newSubscription || null;
    if (!sub) {
      try {
        sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true, applicationServerKey: key
        });
      } catch (e) { return; }
    }

    try {
      await fetch(SUB_URL, {
        method: 'POST', credentials: 'omit', mode: 'cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON ? sub.toJSON() : sub)
      });
    } catch (e) {}
  })());
});
