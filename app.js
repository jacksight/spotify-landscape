'use strict';

/* ============================================================
   Landscape Remote for Spotify — PWA, Web API + PKCE, no build.
   ============================================================ */

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  'user-library-modify',
].join(' ');
const KEYS = {
  clientId: 'sl.clientId',
  token: 'sl.token',
  verifier: 'sl.verifier',
  state: 'sl.state',
  wake: 'sl.wake',
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (ms) => {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  const mm = h ? String(m % 60).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s % 60).padStart(2, '0');
};
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

class AuthError extends Error {}

/* ---------- storage ---------- */
function ls(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch (e) { console.warn('localStorage unavailable', e); }
  return value;
}
const getClientId = () => (ls(KEYS.clientId) || '').trim();
function loadToken() { try { return JSON.parse(ls(KEYS.token)); } catch { return null; } }
function saveToken(data) {
  const prev = loadToken() || {};
  const t = {
    access: data.access_token,
    refresh: data.refresh_token || prev.refresh,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000 - 60_000,
  };
  ls(KEYS.token, JSON.stringify(t));
  return t;
}

/* ---------- PKCE auth ---------- */
function redirectUri() {
  let path = location.pathname;
  if (path.endsWith('index.html')) path = path.slice(0, -'index.html'.length);
  if (!path.endsWith('/')) path += '/';
  return location.origin + path;
}
function randomString(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}
async function sha256base64url(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function login() {
  const clientId = getClientId();
  if (!/^[0-9a-f]{32}$/i.test(clientId)) { toast('Client ID should be 32 hex characters'); return; }
  const verifier = randomString(64);
  const state = randomString(16);
  ls(KEYS.verifier, verifier);
  ls(KEYS.state, state);
  const url = new URL(ACCOUNTS + '/authorize');
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: await sha256base64url(verifier),
    state,
  }).toString();
  location.assign(url.toString());
}
async function handleCallback() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return false;
  history.replaceState({}, '', redirectUri());
  if (q.get('error')) throw new Error(q.get('error'));
  if (q.get('state') !== ls(KEYS.state)) throw new Error('state mismatch, please try again');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: q.get('code'),
    redirect_uri: redirectUri(),
    client_id: getClientId(),
    code_verifier: ls(KEYS.verifier) || '',
  });
  const r = await fetch(ACCOUNTS + '/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error_description || data.error || ('HTTP ' + r.status));
  saveToken(data);
  ls(KEYS.verifier, null); ls(KEYS.state, null);
  return true;
}
let refreshing = null;
function refreshToken() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const t = loadToken();
    if (!t?.refresh) throw new AuthError('not logged in');
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: getClientId() });
    const r = await fetch(ACCOUNTS + '/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!r.ok) {
      if (r.status === 400 || r.status === 401) {
        // Another tab may have already rotated the refresh token; use its result instead of logging out.
        const latest = loadToken();
        if (latest?.refresh && latest.refresh !== t.refresh) return latest;
        ls(KEYS.token, null); throw new AuthError('session expired');
      }
      throw new Error('token refresh failed: ' + r.status);
    }
    return saveToken(await r.json());
  })().finally(() => { refreshing = null; });
  return refreshing;
}
async function getAccessToken(force = false) {
  let t = loadToken();
  if (!t?.access) throw new AuthError('not logged in');
  if (force || Date.now() >= t.expiresAt) t = await refreshToken();
  return t.access;
}
function logout() {
  ls(KEYS.token, null);
  stopPolling();
  player = null;
  cache.playlists = null; cache.tracks.clear(); likedCache.clear();
  openContext = null; currentTrackId = null;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  ui.panelTracks.classList.add('hidden'); ui.panelPlaylists.classList.remove('hidden');
  showSetup();
}

/* ---------- API ---------- */
async function api(method, path, { query, body, retry = true } = {}) {
  const token = await getAccessToken();
  const url = new URL(API + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  const headers = { Authorization: 'Bearer ' + token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (r.status === 401 && retry) {
    await getAccessToken(true);
    return api(method, path, { query, body, retry: false });
  }
  if (r.status === 429 && retry) {
    await sleep((parseInt(r.headers.get('Retry-After'), 10) || 2) * 1000);
    return api(method, path, { query, body, retry: false });
  }
  if (r.status === 204) return null;
  const text = await r.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (!r.ok) {
    const err = new Error(data?.error?.message || ('HTTP ' + r.status));
    err.status = r.status;
    err.reason = data?.error?.reason;
    if (r.status === 401) throw new AuthError(err.message);
    throw err;
  }
  return data;
}

/* ---------- UI refs ---------- */
const ui = {};
function cacheUi() {
  [
    'setup', 'app', 'settings', 'toast', 'redirect-uri', 'btn-copy', 'client-id', 'btn-connect', 'install-tip',
    'art', 'art-placeholder', 'title', 'artist', 'elapsed', 'seek', 'duration',
    'btn-shuffle', 'btn-prev', 'btn-play', 'play-icon', 'btn-next', 'btn-repeat', 'repeat-icon',
    'btn-like', 'like-icon', 'btn-device', 'device-name', 'volume', 'btn-settings',
    'panel-playlists', 'playlists-list', 'panel-tracks', 'btn-back', 'tracks-title', 'btn-play-ctx', 'btn-shuffle-ctx', 'tracks-list',
    'panel-search', 'search-input', 'search-results', 'panel-queue', 'queue-list', 'panel-devices', 'devices-list',
    'settings-redirect', 'settings-client', 'wake-toggle', 'btn-reload', 'btn-change-id', 'btn-logout', 'btn-close-settings',
  ].forEach((id) => { ui[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id); });
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  ui.toast.textContent = msg;
  ui.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.add('hidden'), ms);
}

/* ---------- player state ---------- */
let player = null;        // last /me/player response
let fetchedAt = 0;        // when it was fetched (for progress interpolation)
let cmdAt = 0;            // ignore poll responses started before the last command
let pollHandle = null;
let pollGen = 0;
let tickHandle = null;
let seeking = false;
let volumeDragging = false;
let currentTrackId = null;
const likedCache = new Map();

function handleError(e, { quiet = false } = {}) {
  console.warn(e);
  if (e instanceof AuthError) { toast('Please log in again'); logout(); return; }
  if (quiet) return;
  if (e.status === 404 && (e.reason === 'NO_ACTIVE_DEVICE' || /no active device/i.test(e.message))) {
    toast('No active device. Open Spotify somewhere or pick a device.');
    showTab('devices');
  } else if (e.status === 403 && e.reason === 'PREMIUM_REQUIRED') {
    toast('Spotify Premium is required for playback control');
  } else if (e.status === 403) {
    toast(e.message || 'Not allowed');
  } else if (e instanceof TypeError) {
    toast('Network error');
  } else {
    toast(e.message || 'Something went wrong');
  }
}

async function refreshPlayer() {
  const started = Date.now();
  try {
    const p = await api('GET', '/me/player', { query: { additional_types: 'track,episode' } });
    if (started < cmdAt) return;
    player = p;
    fetchedAt = Date.now();
    renderPlayer();
  } catch (e) {
    handleError(e, { quiet: true });
  }
}
function pollLoop() {
  clearTimeout(pollHandle);
  if (!loadToken()) return;
  const gen = ++pollGen;
  const run = async () => {
    if (document.visibilityState === 'visible') await refreshPlayer();
    if (gen !== pollGen) return;   // a newer loop replaced this one
    const delay = player?.is_playing ? 1000 : 3000;
    pollHandle = setTimeout(run, delay);
  };
  run();
}
function startPolling() {
  pollLoop();
  clearInterval(tickHandle);
  tickHandle = setInterval(tick, 250);
}
function stopPolling() {
  pollGen++;
  clearTimeout(pollHandle); pollHandle = null;
  clearInterval(tickHandle); tickHandle = null;
}
function currentPosition() {
  if (!player?.item) return 0;
  let pos = player.progress_ms || 0;
  if (player.is_playing) pos += Date.now() - fetchedAt;
  return Math.min(pos, player.item.duration_ms || 0);
}
function tick() {
  if (!player?.item || seeking) return;
  const pos = currentPosition();
  const dur = player.item.duration_ms || 1;
  ui.seek.value = Math.round((pos / dur) * 1000) || 0;
  ui.elapsed.textContent = fmt(pos);
}

function renderPlayer() {
  const item = player?.item;
  const device = player?.device;
  ui.deviceName.textContent = device?.name || 'No device';
  ui.btnDevice.classList.toggle('active', !!device);
  if (device && !volumeDragging) {
    ui.volume.value = device.volume_percent ?? 50;
    ui.volume.disabled = device.supports_volume === false;
  } else if (!device) {
    ui.volume.disabled = true;
  }

  if (!item) {
    ui.art.classList.add('hidden');
    ui.art.removeAttribute('src');
    ui.artPlaceholder.classList.remove('hidden');
    ui.title.textContent = 'Nothing playing';
    ui.artist.textContent = device ? `Press play on ${device.name}` : 'Start playback in Spotify on any device';
    ui.seek.value = 0; ui.elapsed.textContent = '0:00'; ui.duration.textContent = '0:00';
    ui.playIcon.setAttribute('href', '#i-play');
    ui.btnShuffle.classList.remove('active');
    ui.btnRepeat.classList.remove('active');
    ui.btnLike.classList.add('hidden');
    document.title = 'Landscape Remote';
    highlightCurrent(null);
    return;
  }
  const images = item.type === 'episode' ? item.images : item.album?.images;
  const img = images?.[0]?.url;
  if (img) {
    if (ui.art.getAttribute('src') !== img) ui.art.src = img;
    ui.art.classList.remove('hidden');
    ui.artPlaceholder.classList.add('hidden');
  } else {
    ui.art.classList.add('hidden');
    ui.artPlaceholder.classList.remove('hidden');
  }
  ui.title.textContent = item.name;
  ui.artist.textContent = item.type === 'episode' ? (item.show?.name || 'Podcast') : (item.artists || []).map((a) => a.name).join(', ');
  ui.duration.textContent = fmt(item.duration_ms);
  ui.playIcon.setAttribute('href', player.is_playing ? '#i-pause' : '#i-play');
  ui.btnShuffle.classList.toggle('active', !!player.shuffle_state);
  ui.btnRepeat.classList.toggle('active', player.repeat_state && player.repeat_state !== 'off');
  ui.repeatIcon.setAttribute('href', player.repeat_state === 'track' ? '#i-repeat-one' : '#i-repeat');
  document.title = `${item.name} · ${ui.artist.textContent}`;

  if (item.type === 'track' && item.id) {
    ui.btnLike.classList.remove('hidden');
    if (item.id !== currentTrackId) { currentTrackId = item.id; checkLiked(item.id); }
    else renderLiked();
  } else {
    ui.btnLike.classList.add('hidden');
    currentTrackId = null;
  }
  highlightCurrent(item.uri);
  tick();
}
function highlightCurrent(uri) {
  $$('.row[data-uri]').forEach((r) => r.classList.toggle('current', !!uri && r.dataset.uri === uri));
}
function renderLiked() {
  const liked = currentTrackId ? likedCache.get(currentTrackId) : false;
  ui.likeIcon.setAttribute('href', liked ? '#i-heart' : '#i-heart-o');
  ui.btnLike.classList.toggle('active', !!liked);
}
async function checkLiked(id) {
  if (!likedCache.has(id)) {
    try {
      const [v] = await api('GET', '/me/tracks/contains', { query: { ids: id } }) || [false];
      likedCache.set(id, !!v);
    } catch (e) { handleError(e, { quiet: true }); }
  }
  if (currentTrackId === id) renderLiked();
}
async function toggleLiked() {
  const id = currentTrackId;
  if (!id) return;
  const liked = likedCache.get(id);
  likedCache.set(id, !liked); renderLiked();
  try {
    await api(liked ? 'DELETE' : 'PUT', '/me/tracks', { query: { ids: id } });
    toast(liked ? 'Removed from Liked Songs' : 'Added to Liked Songs', 1400);
  } catch (e) { likedCache.set(id, liked); renderLiked(); handleError(e); }
}

/* ---------- commands ---------- */
async function command(fn, { refreshDelay = 400 } = {}) {
  cmdAt = Date.now();
  try { await fn(); } catch (e) { handleError(e); }
  await sleep(refreshDelay);
  cmdAt = Date.now();
  await refreshPlayer();
}
function togglePlay() {
  const playing = !!player?.is_playing;
  if (player) { const pos = currentPosition(); player.is_playing = !playing; player.progress_ms = pos; fetchedAt = Date.now(); renderPlayer(); }
  return command(() => api('PUT', playing ? '/me/player/pause' : '/me/player/play'));
}
const next = () => command(() => api('POST', '/me/player/next'));
const prev = () => command(() => {
  if (currentPosition() > 3000) {
    if (player) { player.progress_ms = 0; fetchedAt = Date.now(); tick(); }
    return api('PUT', '/me/player/seek', { query: { position_ms: 0 } });
  }
  return api('POST', '/me/player/previous');
});
function toggleShuffle() {
  const state = !player?.shuffle_state;
  if (player) { player.shuffle_state = state; renderPlayer(); }
  return command(() => api('PUT', '/me/player/shuffle', { query: { state } }));
}
function cycleRepeat() {
  const order = ['off', 'context', 'track'];
  const cur = player?.repeat_state || 'off';
  const state = order[(order.indexOf(cur) + 1) % order.length];
  if (player) { player.repeat_state = state; renderPlayer(); }
  return command(() => api('PUT', '/me/player/repeat', { query: { state } }));
}
function seekTo(ms) {
  if (player) { player.progress_ms = ms; fetchedAt = Date.now(); }
  return command(() => api('PUT', '/me/player/seek', { query: { position_ms: Math.round(ms) } }));
}
let volumeTimer = null;
function setVolume(pct) {
  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(() => {
    if (player?.device) player.device.volume_percent = pct;
    command(() => api('PUT', '/me/player/volume', { query: { volume_percent: pct } }), { refreshDelay: 800 });
  }, 150);
}
async function transferTo(deviceId) {
  await command(() => api('PUT', '/me/player', { body: { device_ids: [deviceId], play: !!player?.is_playing } }), { refreshDelay: 900 });
  loadDevices();
}
/** Start playback. body = {context_uri, offset} or {uris}. Falls back to the first known device if none is active. */
async function play(body) {
  cmdAt = Date.now();
  try {
    await api('PUT', '/me/player/play', { body });
  } catch (e) {
    if (e.status === 404) {
      try {
        const d = await api('GET', '/me/player/devices');
        const devices = d?.devices || [];
        const target = devices.find((x) => x.is_active) || devices[0];
        if (target) {
          await api('PUT', '/me/player/play', { query: { device_id: target.id }, body });
          toast(`Playing on ${target.name}`, 1600);
        } else {
          toast('No Spotify device found. Open the Spotify app first.');
          showTab('devices');
        }
      } catch (e2) { handleError(e2); }
    } else {
      handleError(e);
    }
  }
  await sleep(600);
  cmdAt = Date.now();
  await refreshPlayer();
}

/* ---------- side panel ---------- */
let activeTab = 'playlists';
let openContext = null;  // { uri, name, id }
const cache = { playlists: null, tracks: new Map() };

function showTab(name) {
  activeTab = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  ['playlists', 'tracks', 'search', 'queue', 'devices'].forEach((p) => ui[`panel${p[0].toUpperCase()}${p.slice(1)}`].classList.add('hidden'));
  if (name === 'playlists') {
    (openContext ? ui.panelTracks : ui.panelPlaylists).classList.remove('hidden');
    if (!cache.playlists) loadPlaylists();
  } else {
    ui[`panel${name[0].toUpperCase()}${name.slice(1)}`].classList.remove('hidden');
    if (name === 'queue') loadQueue();
    if (name === 'devices') loadDevices();
    if (name === 'search') setTimeout(() => ui.searchInput.focus(), 50);
  }
}

function rowHtml({ uri, img, name, sub, right = '', round = false, disabled = false, iconFallback = '#i-note', extra = '' }) {
  const thumb = img ? `<img src="${esc(img)}" alt="" loading="lazy" draggable="false">` : `<div class="thumb"><svg><use href="${iconFallback}"/></svg></div>`;
  return `<button class="row${round ? ' round' : ''}${disabled ? ' disabled' : ''}${extra}" ${uri ? `data-uri="${esc(uri)}"` : ''}>
    ${thumb}<div class="text"><div class="name">${esc(name)}</div><div class="sub">${esc(sub)}</div></div><div class="right">${esc(right)}</div>
  </button>`;
}
const smallImg = (images) => images?.[images.length - 1]?.url;
const artistNames = (t) => (t?.artists || []).map((a) => a.name).join(', ');

async function loadPlaylists(force = false) {
  if (cache.playlists && !force) { renderPlaylists(); return; }
  ui.playlistsList.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const items = [];
    let path = '/me/playlists', query = { limit: 50 };
    while (path) {
      const d = await api('GET', path, { query });
      items.push(...(d?.items || []).filter(Boolean));
      path = d?.next ? d.next.replace(API, '') : null;
      query = undefined;
      if (items.length >= 500) break;
    }
    cache.playlists = items;
    renderPlaylists();
  } catch (e) {
    ui.playlistsList.innerHTML = '<div class="empty">Could not load playlists</div>';
    handleError(e);
  }
}
function renderPlaylists() {
  const items = cache.playlists || [];
  if (!items.length) { ui.playlistsList.innerHTML = '<div class="empty">No playlists yet</div>'; return; }
  ui.playlistsList.innerHTML = items.map((p) => rowHtml({
    uri: '', img: smallImg(p.images), name: p.name,
    sub: [p.owner?.display_name, p.tracks?.total != null ? `${p.tracks.total} tracks` : null].filter(Boolean).join(' · '),
    extra: ` playlist`,
  }).replace('<button class="row', `<button data-id="${esc(p.id)}" class="row`)).join('');
  $$('.row.playlist', ui.playlistsList).forEach((el) => {
    el.addEventListener('click', () => {
      const p = items.find((x) => x.id === el.dataset.id);
      if (p) openPlaylist(p);
    });
  });
}
async function openPlaylist(p) {
  openContext = { uri: p.uri, name: p.name, id: p.id };
  ui.tracksTitle.textContent = p.name;
  ui.panelPlaylists.classList.add('hidden');
  ui.panelTracks.classList.remove('hidden');
  ui.panelTracks.scrollTop = 0;
  const cached = cache.tracks.get(p.id);
  if (cached) { renderTracks(cached); return; }
  ui.tracksList.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const tracks = await fetchPlaylistTracks(p.id, 200);
    cache.tracks.set(p.id, tracks);
    if (openContext?.id === p.id) renderTracks(tracks);
  } catch (e) {
    ui.tracksList.innerHTML = '<div class="empty">Could not load tracks</div>';
    handleError(e);
  }
}
async function fetchPlaylistTracks(id, max) {
  const out = [];
  // Spotify renamed /playlists/{id}/tracks to /playlists/{id}/items in 2026; try new, fall back to old.
  let path = `/playlists/${id}/items`, query = { limit: 100 };
  let d;
  try { d = await api('GET', path, { query }); }
  catch (e) { if (e.status === 404) { path = `/playlists/${id}/tracks`; d = await api('GET', path, { query }); } else throw e; }
  for (;;) {
    for (const it of d?.items || []) { const t = it?.item || it?.track; if (t) out.push(t); }
    if (!d?.next || out.length >= max) break;
    d = await api('GET', d.next.replace(API, ''));
  }
  out.more = !!d?.next;
  return out;
}
function renderTracks(tracks) {
  if (!tracks.length) { ui.tracksList.innerHTML = '<div class="empty">This playlist is empty</div>'; return; }
  ui.tracksList.innerHTML = tracks.map((t, i) => rowHtml({
    uri: t.uri, img: smallImg(t.album?.images || t.images), name: t.name,
    sub: t.type === 'episode' ? (t.show?.name || 'Podcast') : artistNames(t),
    right: fmt(t.duration_ms), disabled: !!t.is_local || !t.uri,
  }).replace('<button class="row', `<button data-pos="${i}" class="row`)).join('') + (tracks.more ? '<div class="empty">Showing the first 200 tracks</div>' : '');
  $$('.row[data-uri]', ui.tracksList).forEach((el) => {
    el.addEventListener('click', () => play({ context_uri: openContext.uri, offset: { position: parseInt(el.dataset.pos, 10) } }));
  });
  highlightCurrent(player?.item?.uri);
}
function closePlaylist() {
  openContext = null;
  ui.panelTracks.classList.add('hidden');
  ui.panelPlaylists.classList.remove('hidden');
}

let searchTimer = null, searchSeq = 0;
function onSearchInput() {
  clearTimeout(searchTimer);
  const q = ui.searchInput.value.trim();
  if (!q) { ui.searchResults.innerHTML = ''; return; }
  searchTimer = setTimeout(() => runSearch(q), 350);
}
async function runSearch(q) {
  const seq = ++searchSeq;
  try {
    const d = await api('GET', '/search', { query: { q, type: 'track,album,artist,playlist', limit: 10 } });
    if (seq !== searchSeq) return;
    renderSearch(d || {});
  } catch (e) { handleError(e); }
}
function renderSearch(d) {
  const sections = [];
  const tracks = (d.tracks?.items || []).filter(Boolean);
  const albums = (d.albums?.items || []).filter(Boolean);
  const artists = (d.artists?.items || []).filter(Boolean);
  const playlists = (d.playlists?.items || []).filter(Boolean);
  if (tracks.length) sections.push('<div class="section-title">Songs</div>' + tracks.map((t) => rowHtml({
    uri: t.uri, img: smallImg(t.album?.images), name: t.name, sub: artistNames(t), right: fmt(t.duration_ms), extra: ' s-track',
  })).join(''));
  if (albums.length) sections.push('<div class="section-title">Albums</div>' + albums.map((a) => rowHtml({
    uri: a.uri, img: smallImg(a.images), name: a.name, sub: [artistNames(a), a.release_date?.slice(0, 4)].filter(Boolean).join(' · '), extra: ' s-context',
  })).join(''));
  if (artists.length) sections.push('<div class="section-title">Artists</div>' + artists.map((a) => rowHtml({
    uri: a.uri, img: smallImg(a.images), name: a.name, sub: 'Artist', round: true, extra: ' s-context',
  })).join(''));
  if (playlists.length) sections.push('<div class="section-title">Playlists</div>' + playlists.map((p) => rowHtml({
    uri: p.uri, img: smallImg(p.images), name: p.name, sub: p.owner?.display_name || 'Playlist', extra: ' s-context',
  })).join(''));
  ui.searchResults.innerHTML = sections.join('') || '<div class="empty">No results</div>';
  $$('.row.s-track', ui.searchResults).forEach((el) => el.addEventListener('click', () => play({ uris: [el.dataset.uri] })));
  $$('.row.s-context', ui.searchResults).forEach((el) => el.addEventListener('click', () => play({ context_uri: el.dataset.uri })));
  highlightCurrent(player?.item?.uri);
}

async function loadQueue() {
  if (!ui.queueList.children.length) ui.queueList.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const d = await api('GET', '/me/player/queue');
    const now = d?.currently_playing;
    const queue = (d?.queue || []).filter(Boolean);
    const row = (t) => rowHtml({
      uri: t.uri, img: smallImg(t.album?.images || t.images), name: t.name,
      sub: t.type === 'episode' ? (t.show?.name || 'Podcast') : artistNames(t), right: fmt(t.duration_ms),
    });
    ui.queueList.innerHTML = (now ? '<div class="section-title">Now playing</div>' + row(now) : '')
      + (queue.length ? '<div class="section-title">Next up</div>' + queue.map(row).join('') : '')
      || '<div class="empty">Queue is empty</div>';
    highlightCurrent(player?.item?.uri);
  } catch (e) {
    ui.queueList.innerHTML = '<div class="empty">Could not load queue</div>';
    handleError(e, { quiet: true });
  }
}
const deviceIcon = (type) => {
  const t = (type || '').toLowerCase();
  if (t === 'smartphone' || t === 'tablet') return '#i-phone';
  if (t === 'computer') return '#i-computer';
  return '#i-speaker';
};
async function loadDevices() {
  if (!ui.devicesList.children.length) ui.devicesList.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const d = await api('GET', '/me/player/devices');
    const devices = (d?.devices || []).filter(Boolean);
    ui.devicesList.innerHTML = devices.length
      ? devices.map((dev) => rowHtml({
          uri: '', name: dev.name, sub: (dev.type || 'Device') + (dev.is_active ? ' · Active' : ''),
          right: dev.volume_percent != null ? `${dev.volume_percent}%` : '', iconFallback: deviceIcon(dev.type),
          extra: dev.is_active ? ' active-device' : '', disabled: !dev.id || !!dev.is_restricted,
        }).replace('<button class="row', `<button data-id="${esc(dev.id || '')}" class="row device`)).join('')
        + '<div class="empty">Devices appear here once the Spotify app is open on them.</div>'
      : '<div class="empty">No devices found.<br>Open Spotify on your phone, computer or speaker, then come back.</div>';
    $$('.row.device', ui.devicesList).forEach((el) => el.addEventListener('click', () => { if (el.dataset.id) transferTo(el.dataset.id); }));
  } catch (e) {
    ui.devicesList.innerHTML = '<div class="empty">Could not load devices</div>';
    handleError(e, { quiet: true });
  }
}

/* ---------- wake lock ---------- */
let wakeLock = null;
async function applyWakeLock() {
  const want = ls(KEYS.wake) === '1';
  if (want && 'wakeLock' in navigator && document.visibilityState === 'visible' && !ui.app.classList.contains('hidden')) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { console.warn('wakeLock', e); }
  } else if (!want && wakeLock) {
    try { await wakeLock.release(); } catch {}
    wakeLock = null;
  }
}

/* ---------- screens ---------- */
function showSetup() {
  ui.app.classList.add('hidden');
  ui.setup.classList.remove('hidden');
  ui.clientId.value = getClientId();
  ui.installTip.classList.toggle('hidden', !(isIOS() && !isStandalone()));
}
function showApp() {
  ui.setup.classList.add('hidden');
  ui.app.classList.remove('hidden');
  renderPlayer();
  startPolling();
  showTab('playlists');
  applyWakeLock();
}
function openSettings() {
  ui.settingsRedirect.textContent = redirectUri();
  ui.settingsClient.textContent = getClientId() || '—';
  ui.wakeToggle.checked = ls(KEYS.wake) === '1';
  ui.wakeToggle.disabled = !('wakeLock' in navigator);
  ui.settings.classList.remove('hidden');
}

function bindEvents() {
  ui.btnCopy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(redirectUri()); toast('Copied'); } catch { toast('Long-press the text to copy'); }
  });
  ui.btnConnect.addEventListener('click', () => {
    ls(KEYS.clientId, ui.clientId.value.trim());
    login().catch((e) => toast('Login failed: ' + e.message));
  });
  ui.clientId.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.btnConnect.click(); });

  ui.btnPlay.addEventListener('click', togglePlay);
  ui.btnNext.addEventListener('click', next);
  ui.btnPrev.addEventListener('click', prev);
  ui.btnShuffle.addEventListener('click', toggleShuffle);
  ui.btnRepeat.addEventListener('click', cycleRepeat);
  ui.btnLike.addEventListener('click', toggleLiked);
  ui.btnDevice.addEventListener('click', () => showTab('devices'));
  ui.btnSettings.addEventListener('click', openSettings);

  const seekPreview = () => {
    seeking = true;
    const dur = player?.item?.duration_ms || 0;
    ui.elapsed.textContent = fmt((ui.seek.value / 1000) * dur);
  };
  ui.seek.addEventListener('input', seekPreview);
  ui.seek.addEventListener('change', () => {
    const dur = player?.item?.duration_ms || 0;
    seeking = false;
    if (dur) seekTo((ui.seek.value / 1000) * dur);
  });
  ui.volume.addEventListener('pointerdown', () => { volumeDragging = true; });
  ui.volume.addEventListener('input', () => { volumeDragging = true; });
  ui.volume.addEventListener('change', () => { volumeDragging = false; setVolume(parseInt(ui.volume.value, 10)); });
  ['pointerup', 'pointercancel', 'blur'].forEach((ev) => ui.volume.addEventListener(ev, () => { volumeDragging = false; }));

  $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  ui.btnBack.addEventListener('click', closePlaylist);
  ui.btnPlayCtx.addEventListener('click', () => openContext && play({ context_uri: openContext.uri }));
  ui.btnShuffleCtx.addEventListener('click', async () => {
    if (!openContext) return;
    const tracks = cache.tracks.get(openContext.id) || [];
    const playable = tracks.filter((t) => t.uri && !t.is_local);
    const pos = playable.length ? tracks.indexOf(playable[Math.floor(Math.random() * playable.length)]) : -1;
    try { await api('PUT', '/me/player/shuffle', { query: { state: true } }); } catch { /* applied after play below */ }
    await play(pos >= 0 ? { context_uri: openContext.uri, offset: { position: pos } } : { context_uri: openContext.uri });
    api('PUT', '/me/player/shuffle', { query: { state: true } }).catch(() => {});
  });
  ui.searchInput.addEventListener('input', onSearchInput);
  ui.searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimer); const q = ui.searchInput.value.trim(); if (q) runSearch(q); ui.searchInput.blur(); } });

  ui.btnCloseSettings.addEventListener('click', () => ui.settings.classList.add('hidden'));
  ui.settings.addEventListener('click', (e) => { if (e.target === ui.settings) ui.settings.classList.add('hidden'); });
  ui.wakeToggle.addEventListener('change', () => { ls(KEYS.wake, ui.wakeToggle.checked ? '1' : '0'); applyWakeLock(); });
  ui.btnLogout.addEventListener('click', () => { ui.settings.classList.add('hidden'); logout(); });
  ui.btnChangeId.addEventListener('click', () => { ui.settings.classList.add('hidden'); ls(KEYS.clientId, null); logout(); });
  ui.btnReload.addEventListener('click', async () => {
    try {
      const regs = await navigator.serviceWorker?.getRegistrations() || [];
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = await caches?.keys() || [];
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {}
    location.reload();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (loadToken() && !ui.app.classList.contains('hidden')) { pollLoop(); applyWakeLock(); }
    } else {
      pollGen++;
      clearTimeout(pollHandle);
    }
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted && loadToken()) refreshPlayer(); });
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('sw', e)));
}

async function boot() {
  cacheUi();
  bindEvents();
  registerSW();
  ui.redirectUri.textContent = redirectUri();
  try {
    if (await handleCallback()) toast('Connected to Spotify', 1800);
  } catch (e) {
    toast('Login failed: ' + e.message, 5000);
  }
  if (loadToken() && getClientId()) showApp(); else showSetup();
}
boot();
