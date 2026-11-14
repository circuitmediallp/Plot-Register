/* Plot Register service worker: caches the app shell for offline start, and serves _blob/<id> (photos, maps, documents) from a local cache,
   asking the open page to fetch them from the backend the first time. */
var SHELL = 'pr-shell-v2', BLOBS = 'pr-blobs-v1';
var FILES = ['./', 'index.html', 'config.js', 'shim.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== SHELL && k !== BLOBS; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
function askPage(id) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cl) {
    var c = cl.filter(function (x) { return x.visibilityState === 'visible'; })[0] || cl[0];
    if (!c) throw new Error('no page');
    return new Promise(function (res, rej) {
      var ch = new MessageChannel(), t = setTimeout(function () { rej(new Error('timeout')); }, 60000);
      ch.port1.onmessage = function (m) { clearTimeout(t); m.data && !m.data.error ? res(m.data) : rej(new Error('fail')); };
      c.postMessage({ type: 'blob?', id: id }, [ch.port2]);
    });
  });
}
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  var m = u.pathname.match(/\/_blob\/([^/]+)$/);
  if (m) {
    var id = decodeURIComponent(m[1]);
    e.respondWith(caches.open(BLOBS).then(function (c) {
      return c.match(e.request.url).then(function (hit) {
        if (hit) return hit;
        return askPage(id).then(function (r) {
          var res = new Response(r.buf, { headers: { 'Content-Type': r.mime, 'Cache-Control': 'private, max-age=31536000' } });
          return c.put(e.request.url, res.clone()).then(function () { return res; });
        }).catch(function () { return new Response('', { status: 504 }); });
      });
    }));
    return;
  }
  // App files: network first (so updates arrive on the next open), cached copy when offline.
  e.respondWith(fetch(e.request).then(function (r) { if (r && r.ok) { var cp = r.clone(); caches.open(SHELL).then(function (c) { c.put(e.request, cp); }); } return r; })
    .catch(function () { return caches.match(e.request, { ignoreSearch: true }); }));
});
