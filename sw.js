/* Service worker minimo: gestisce push + click delle notifiche.
 * Niente cache offline (per ora) — manteniamo la portata stretta.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  if (!event.data) return;
  let data;
  try { data = event.data.json(); }
  catch { data = { title: 'PEE Field', body: event.data.text() }; }
  const title = data.title || 'PEE Field';
  const options = {
    body: data.body || '',
    icon: '/favicon-192.png',
    badge: '/favicon-192.png',
    tag: data.data && data.data.pv ? 'pv-' + data.data.pv : undefined,
    data: data.data || {},
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const pv = event.notification.data && event.notification.data.pv;
  const targetUrl = pv ? '/?pv=' + pv : '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      // Se c'è già una finestra aperta: focus + messaggio per selezionare PV.
      if ('focus' in c) {
        await c.focus();
        if (pv) c.postMessage({ type: 'select-pv', pv });
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});
