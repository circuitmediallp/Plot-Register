/* Plot Register web backend: replaces the Claude runtime (db, user, assets, downloads) with Google sign-in + the Apps Script API. */
(function () {
  var C = window.PR_CONFIG || {};
  var store = {}, ver = 0, status = '', me = null, listeners = [], synced = false, writeSeq = 0, inflight = 0, tok = '', tokExp = 0, claims = null;
  var local = {}, waiters = [], firstSync = null, syncing = null;
  var TKEY = 'pr.token';

  /* ---------- sign-in ---------- */
  function b64u(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return decodeURIComponent(escape(atob(s))); }
  function readTok(t) { try { var c = JSON.parse(b64u(t.split('.')[1])); return c && c.exp ? c : null; } catch (e) { return null; } }
  function setTok(t) { var c = readTok(t); if (!c) return false; tok = t; tokExp = c.exp * 1000; claims = c; try { localStorage.setItem(TKEY, t); } catch (e) {} return true; }
  try { var saved = localStorage.getItem(TKEY); if (saved) setTok(saved); } catch (e) {}
  function valid() { return tok && tokExp - Date.now() > 90000; }
  var overlay = null, gisReady = null;
  function ui() {
    if (overlay) return overlay;
    overlay = document.createElement('div'); overlay.id = 'pr-login';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:var(--bg,#EEF1EC);color:var(--ink,#14231D);display:grid;place-content:center;gap:14px;text-align:center;padding:24px;font-family:system-ui,sans-serif';
    overlay.innerHTML = '<h1 style="margin:0;font-size:30px">Plot Register</h1><p id="pr-msg" style="margin:0;color:var(--muted,#566860)">Sign in with your Google account to continue.</p><div id="pr-gbtn" style="justify-self:center;min-height:44px"></div><p id="pr-err" style="margin:0;color:#A3362E"></p>';
    document.body.appendChild(overlay); return overlay;
  }
  function loadGis() {
    if (gisReady) return gisReady;
    gisReady = new Promise(function (res, rej) {
      if (window.google && google.accounts && google.accounts.id) return res();
      var s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.onload = function () { res(); }; s.onerror = function () { gisReady = null; rej(new Error('gis')); };
      document.head.appendChild(s);
    });
    return gisReady;
  }
  var gisInit = false;
  function onCred(resp) {
    if (resp && resp.credential && setTok(resp.credential)) {
      if (overlay) overlay.hidden = true;
      var w = waiters; waiters = []; w.forEach(function (f) { f(); });
    }
  }
  function ensureToken() {
    if (valid()) return Promise.resolve();
    return new Promise(function (res) {
      waiters.push(res);
      var o = ui(); o.hidden = false;
      loadGis().then(function () {
        if (!gisInit) { google.accounts.id.initialize({ client_id: C.CLIENT_ID, callback: onCred, auto_select: true, cancel_on_tap_outside: false }); gisInit = true; }
        var b = document.getElementById('pr-gbtn'); b.textContent = '';
        google.accounts.id.renderButton(b, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill' });
        try { google.accounts.id.prompt(); } catch (e) {}
      }, function () { document.getElementById('pr-err').textContent = 'Could not load Google sign-in. Check your internet connection.'; });
    });
  }

  /* ---------- API ---------- */
  function raw(body) {
    return fetch(C.API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }, function () { var e = new Error('network'); e.code = 'network'; throw e; });
  }
  function api(action, body, retried) {
    return ensureToken().then(function () { return raw(Object.assign({ token: tok, action: action }, body)); }).then(function (r) {
      if (r && r.error === 'auth' && !retried) { tok = ''; tokExp = 0; try { localStorage.removeItem(TKEY); } catch (e) {} return api(action, body, true); }
      if (r && r.error) { var e = new Error(r.message || r.error); e.code = r.error === 'denied' ? 'permission_denied' : r.error; throw e; }
      return r;
    });
  }

  /* ---------- local store + sync ---------- */
  function applyTables(t) {
    store = {};
    Object.keys(t).forEach(function (k) { t[k].forEach(function (r) { store[k + '/' + r.id.split('~').join('/')] = r.data; }); });
  }
  function snapDoc(path) { var ex = path in store; return { id: path.split('/').pop(), exists: ex, data: function () { return ex ? JSON.parse(JSON.stringify(store[path])) : undefined; }, metadata: { fromCache: false, hasPendingWrites: false } }; }
  function snapCol(path) {
    var p = path + '/', docs = Object.keys(store).filter(function (k) { return k.indexOf(p) === 0 && k.slice(p.length).indexOf('/') < 0; }).sort().map(snapDoc);
    return { docs: docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function fire() { listeners.slice().forEach(function (l) { try { l.cb(l.col ? snapCol(l.path) : snapDoc(l.path)); } catch (e) { console.error(e); } }); }
  function sync() {
    if (syncing) return syncing;
    var seq = writeSeq;
    syncing = api('sync', { ver: ver, status: status }).then(function (r) {
      me = r.me; status = r.me.status;
      if (!r.same && seq === writeSeq && !inflight) { applyTables(r.tables); ver = r.ver; synced = true; fire(); }
      else if (!synced && r.same) { synced = true; fire(); }
    }).then(function () { syncing = null; }, function (e) { syncing = null; throw e; });
    return syncing;
  }
  function ready() {
    if (!firstSync) firstSync = sync().then(function () { return null; }, function (e) { firstSync = null; throw e; });
    return firstSync;
  }
  function poll() { if (synced && !document.hidden && !inflight) sync().catch(function () {}); }
  setInterval(poll, 30000);
  document.addEventListener('visibilitychange', poll); window.addEventListener('online', poll); window.addEventListener('focus', poll);

  /* ---------- db ---------- */
  function rid() { var a = new Uint8Array(10); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return (b % 36).toString(36); }).join(''); }
  function write(action, path, data, id) {
    var prev = path in store ? store[path] : undefined, key = path;
    if (action === 'add') key = path + '/' + id;
    var optimistic = action === 'delete' ? undefined : action === 'update' ? Object.assign({}, store[path] || {}, data) : data;
    var had = key in store, before = store[key];
    if (action === 'update' && !(path in store)) { var e0 = new Error('not found'); e0.code = 'not_found'; return Promise.reject(e0); }
    writeSeq++; inflight++;
    if (action === 'delete') delete store[key]; else store[key] = JSON.parse(JSON.stringify(optimistic));
    fire();
    return api(action, { path: path, data: data, id: id }).then(function (r) {
      inflight--; writeSeq++; if (r.data && action !== 'delete') store[key] = r.data; if (r.ver) ver = r.ver; fire(); return r;
    }, function (e) {
      inflight--; writeSeq++; if (had) store[key] = before; else delete store[key]; fire(); throw e;
    });
  }
  function mdoc(path) {
    return { id: path.split('/').pop(), path: path,
      get: function () { return /^plotdocs\//.test(path) ? api('get', { path: path }).then(function (r) { if (r.exists) store[path] = r.data; return { id: path.split('/').pop(), exists: r.exists, data: function () { return r.exists ? r.data : undefined; } }; }) : Promise.resolve(snapDoc(path)); },
      set: function (d) { return write('set', path, d).then(function () {}); },
      update: function (d) { return write('update', path, d).then(function () {}); },
      delete: function () { return write('delete', path).then(function () {}); },
      onSnapshot: function (cb) { var l = { path: path, cb: cb, col: false }; listeners.push(l); setTimeout(function () { cb(snapDoc(path)); }, 0); return function () { listeners = listeners.filter(function (x) { return x !== l; }); }; },
      collection: function (p) { return mcol(path + '/' + p); } };
  }
  function mcol(path) {
    return { path: path, doc: function (id) { return mdoc(path + '/' + (id || rid())); },
      add: function (d) { var id = rid(); return write('add', path, d, id).then(function () { return mdoc(path + '/' + id); }); },
      onSnapshot: function (cb) { var l = { path: path, cb: cb, col: true }; listeners.push(l); setTimeout(function () { cb(snapCol(path)); }, 0); return function () { listeners = listeners.filter(function (x) { return x !== l; }); }; } };
  }
  var db = { doc: mdoc, collection: mcol };
  var user = {
    isOwner: function () { return Promise.resolve(!!(me && me.admin)); }, canEdit: function () { return Promise.resolve(!!(me && me.admin)); }, can: function () { return Promise.resolve(true); },
    id: function () { return Promise.resolve(me.uid); },
    me: function () { return Promise.resolve({ id: me.uid, name: (claims && claims.name) || me.name || '', isOwner: me.admin, canEdit: me.admin }); },
    profiles: function (ids) { var o = {}; [].concat(ids).forEach(function (i) { var p = store['partners/' + i]; o[i] = { id: i, name: (p && p.name) || '', isMe: me && i === me.uid }; }); return Promise.resolve(o); }
  };

  /* ---------- files ---------- */
  function toB64(blob) { return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(String(fr.result).split(',')[1]); }; fr.onerror = rej; fr.readAsDataURL(blob); }); }
  var assets = {
    upload: function (blob, kind) {
      return toB64(blob).then(function (b64) { return api('upload', { kind: kind || 'media', mime: blob.type || 'image/jpeg', b64: b64 }); }).then(function (r) {
        local[r.id] = blob; return { id: r.id, url: '_blob/' + r.id, sizeBytes: blob.size, contentType: blob.type };
      });
    },
    delete: function (id) { delete local[id]; return api('deletefile', { id: id }).then(function () {}); },
    list: function () { return Promise.resolve({ assets: [] }); }
  };
  function fetchBlob(id) {
    if (local[id]) return local[id].arrayBuffer().then(function (b) { return { mime: local[id].type, buf: b }; });
    return api('file', { id: id }).then(function (r) {
      var bin = atob(r.b64), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return { mime: r.mime, buf: u.buffer };
    });
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (ev) {
      var d = ev.data, port = ev.ports && ev.ports[0]; if (!d || d.type !== 'blob?' || !port) return;
      fetchBlob(d.id).then(function (r) { port.postMessage({ mime: r.mime, buf: r.buf }, [r.buf]); }, function () { port.postMessage({ error: true }); });
    });
  }
  var downloads = { save: function (x) {
    var b = new Blob([x.data], { type: 'text/csv;charset=utf-8' }), u = URL.createObjectURL(b), a = document.createElement('a');
    a.href = u; a.download = x.filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 4000); return Promise.resolve();
  } };

  /* ---------- runtime facade ---------- */
  var swReady = ('serviceWorker' in navigator) ? navigator.serviceWorker.register('sw.js').then(function () { return navigator.serviceWorker.ready; }).then(function () {
    if (navigator.serviceWorker.controller) return; return new Promise(function (res) { navigator.serviceWorker.addEventListener('controllerchange', function () { res(); }, { once: true }); setTimeout(res, 3000); });
  }).catch(function () {}) : Promise.resolve();
  window.claude = { use: function (name) {
    return Promise.all([ready(), swReady]).then(function () { return ({ db: db, user: user, assets: assets, downloads: downloads })[name] || null; }, function () { return null; });
  } };
  window.__pr = { sync: sync, signOut: function () { try { localStorage.removeItem(TKEY); } catch (e) {} tok = ''; location.reload(); } };
  document.addEventListener('DOMContentLoaded', function () { ensureToken(); });
})();
