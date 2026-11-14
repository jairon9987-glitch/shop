// VORTX — aplicación web (Fase 1 y núcleo de la Fase 2).
// Cuentas locales, discover, experiencias, marketplace, editor de
// avatar R6, amigos, grupos, perfiles y Creator Hub. Los datos viven
// en este navegador (localStorage); la cuenta en la nube y el
// multijugador llegan con la Fase 4 (Supabase), sin simularlos.
import * as THREE from '../vendor/three.module.js';
import { buildRig, whenTemplateTexReady } from './rig.js';
import { CATALOG, PALETTE, SLOTS, SEED_EXPERIENCES, TEMPLATES, PASS_PERKS, PROMO_CODES, BUNDLES } from './data.js';
import { peekPresence } from './net.js';
import { initI18n, t, currentLang, LANGS, setLang } from './i18n.js';
import { startExperience, stopExperience } from './play.js';

const $ = (s, r) => (r || document).querySelector(s);
const slotName = (sl) => { const k = 'slot.' + sl; const v = t(k); return v === k ? (SLOTS[sl] || sl) : v; };
const perkName = (pk) => { const k = 'perk.' + pk; const v = t(k); return v === k ? ((PASS_PERKS[pk] || {}).name || pk) : v; };
const perkInfo = (pk) => { const k = 'perk.' + pk + 'Info'; const v = t(k); return v === k ? ((PASS_PERKS[pk] || {}).info || '') : v; };
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (n) => '#' + Number(n).toString(16).padStart(6, '0');
const uid = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function hashPw(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return 'h' + h.toString(36); }

// ---------------- Base de datos local ----------------
const DB_KEY = 'vortx_db_v1';
let DB = loadDb();
function loadDb() {
  let d = null;
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) { const p = JSON.parse(raw); if (p && p.users) d = p; }
  } catch (e) {}
  if (!d) {
    d = {
      users: [],
      exps: SEED_EXPERIENCES.map(e => ({ ...e, visits: 0, favs: 0 })),
      groups: [],
      session: null,
      played: [],
      ltd: { cara_eclipse: { sold: 0 } },
      listings: [],
      trades: []
    };
  }
  if (!d.chats) d.chats = {};
  if (!d.msgs) d.msgs = {};
  if (!d.reports) d.reports = [];
  if (!d.votes) d.votes = {};
  if (!d.ltd) d.ltd = { cara_eclipse: { sold: 0 } };
  if (!d.listings) d.listings = [];
  if (!d.trades) d.trades = [];
  // Borradas por orden de Jairon (2026-11-08): Torre VORTX y Arena Doble
  // salen de la plataforma; tambien de las bases ya guardadas.
  // (2026-11-14): las seis experiencias integradas salen igual de las
  // bases guardadas y queda solo la Baseplate nueva (exp_baseplate2,
  // que la migracion de semilla de abajo inserta si falta). Las
  // creaciones de usuario NO se tocan.
  const GONE_EXPS = ['exp_torre', 'exp_arena', 'exp_baseplate', 'exp_obby', 'exp_plaza', 'exp_underground', 'exp_tycoon'];
  if (Array.isArray(d.exps)) d.exps = d.exps.filter(e => !GONE_EXPS.includes(e.id));
  for (const gid of GONE_EXPS) delete d.chats[gid];
  if (Array.isArray(d.played)) d.played = d.played.filter(id => !GONE_EXPS.includes(id));
  for (const g of d.groups || []) { g.admins = g.admins || []; g.wall = g.wall || []; g.banned = g.banned || []; }
  for (const u of d.users || []) {
    if (u.passes) for (const gid of GONE_EXPS) delete u.passes[gid];
    if (u.bestTimes) for (const gid of GONE_EXPS) delete u.bestTimes[gid];
    if (Array.isArray(u.favorites)) u.favorites = u.favorites.filter(id => !GONE_EXPS.includes(id));
  }
  // Migracion: los accesorios salieron del catalogo (orden de Jairon);
  // la Cara Feliz sustituye a la Gorra como regalo de bienvenida.
  for (const u of d.users || []) {
    u.inventory = (u.inventory || []).filter(id => CATALOG.some(i => i.id === id));
    if (!u.inventory.includes('cara_feliz')) u.inventory.push('cara_feliz');
    if (u.avatar && u.avatar.equipped) {
      for (const slot of Object.keys(u.avatar.equipped)) {
        if (!CATALOG.some(i => i.id === u.avatar.equipped[slot])) delete u.avatar.equipped[slot];
      }
      if (!u.avatar.equipped.face) u.avatar.equipped.face = 'cara_feliz';
    }
  }
  // Migracion: una base guardada antes de los pases recibe los de las experiencias originales.
  for (const seed of SEED_EXPERIENCES) {
    const e = d.exps.find(x => x.id === seed.id);
    if (e && seed.passes) {
      e.passes = e.passes || [];
      for (const sp of seed.passes) if (!e.passes.some(p => p.id === sp.id)) e.passes.push(sp);
    }
    if (!e) d.exps.push({ ...seed, visits: 0, favs: 0 });
  }
  return d;
}
function saveDb() { try { localStorage.setItem(DB_KEY, JSON.stringify(DB)); } catch (e) {} }
const TAB_USER_KEY = 'vortx_tab_user';
function tabUserId() { try { return sessionStorage.getItem(TAB_USER_KEY); } catch (e) { return null; } }
function setSession(u, keep) {
  if (!u) return;
  try {
    if (keep) { DB.session = u.id; sessionStorage.removeItem(TAB_USER_KEY); }
    else sessionStorage.setItem(TAB_USER_KEY, u.id);
  } catch (e) { DB.session = u.id; }
}
function clearSession() {
  const u = me();
  if (u) { u.lastSeen = new Date().toISOString(); }
  DB.session = null;
  try { sessionStorage.removeItem(TAB_USER_KEY); } catch (e) {}
  saveDb();
}
function me() { return DB.users.find(u => u.id === (tabUserId() || DB.session)) || null; }
function newSeedUser(name, display, pass) {
  return {
    id: uid('usr'), username: name, display: display || name, pass: hashPw(pass),
    bio: '', coins: 500, createdAt: new Date().toISOString(),
    avatar: defaultAvatar(), inventory: ['cara_feliz'], outfits: [],
    friends: [], requestsIn: [], requestsOut: [], following: [], favorites: [], redeemed: [], consumables: {},
    tx: [{ at: new Date().toISOString(), label: 'Bienvenida a VORTX', amount: 500 }]
  };
}
function userByName(name) { return DB.users.find(u => u.username === String(name || '').toLowerCase()) || null; }
function expById(id) { return DB.exps.find(e => e.id === id) || null; }

function defaultAvatar() {
  return {
    colors: { head: 0xf5f5f5, torso: 0x4c1d95, armL: 0xf5f5f5, armR: 0xf5f5f5, legL: 0x17171c, legR: 0x17171c },
    headShape: 'block', face: false,
    equipped: { face: 'cara_feliz' }
  };
}

export function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3400);
}

// ---------------- Escenario 3D reutilizable (editor / perfil) ----------------
class Stage {
  constructor(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    // Tope 1.5 tambien en vistas previas: a DPR completo (3 en el
    // Galaxy) el lienzo del avatar costaba el doble de GPU sin que se
    // note a estos tamanos.
    this.pr = Math.min(devicePixelRatio || 1, 1.5);
    this.renderer.setPixelRatio(this.pr);
    this.renderer.shadowMap.enabled = true;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    this.dist = opts.dist || 9.5;
    this.camY = opts.camY != null ? opts.camY : 3.1;
    this.lookY = opts.lookY != null ? opts.lookY : 2.2;
    this.rotY = opts.rotY != null ? opts.rotY : 0.5; this.targetRotY = this.rotY;
    this.auto = !!opts.auto;
    const hemi = new THREE.HemisphereLight(0xd8ecff, 0x2a3342, 1.1);
    const sun = new THREE.DirectionalLight(0xffffff, 1.7);
    sun.position.set(4, 8, 5);
    sun.castShadow = true;
    this.scene.add(hemi, sun);
    this.rig = null;
    if (opts.drag !== false) {
      let drag = false, lx = 0;
      canvas.addEventListener('pointerdown', (e) => { drag = true; lx = e.clientX; canvas.setPointerCapture(e.pointerId); });
      canvas.addEventListener('pointermove', (e) => { if (drag) { this.targetRotY += (e.clientX - lx) * 0.012; lx = e.clientX; } });
      canvas.addEventListener('pointerup', () => { drag = false; });
    }
    this.dead = false;
    this.visible = true;
    if ('IntersectionObserver' in window) {
      this.io = new IntersectionObserver(en => { this.visible = en[0].isIntersecting; }, { threshold: 0.02 });
      this.io.observe(canvas);
    }
    const loop = () => {
      if (this.dead) return;
      requestAnimationFrame(loop);
      // Sin render si el lienzo no se ve: fuera de pantalla, pestana
      // oculta o una partida en curso encima. La vista previa no debe
      // competir por la GPU con el juego ni gastar bateria en vano.
      if (!this.visible || document.hidden || document.body.classList.contains('playing') || !this.canvas.clientWidth) return;
      this.resize();
      if (this.auto) this.targetRotY += 0.006;
      this.rotY += (this.targetRotY - this.rotY) * 0.12;
      if (this.rig) {
        this.rig.group.rotation.y = this.rotY;
        this.rig.animate(performance.now() / 1000, 0);
      }
      const d = this.dist;
      this.camera.position.set(0, this.camY, d);
      this.camera.lookAt(0, this.lookY, 0);
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }
  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    if (this.canvas.width !== Math.round(w * this.pr)) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }
  setAvatar(cfg, equippedIds) {
    if (this.rig) { this.scene.remove(this.rig.group); }
    this.rig = buildRig(cfg);
    this.rig.setEquipped(equippedIds || [], CATALOG);
    this.scene.add(this.rig.group);
  }
  dispose() { this.dead = true; if (this.io) this.io.disconnect(); this.renderer.dispose(); }
}
let activeStage = null;
function stageBgPref() { try { return localStorage.getItem('vortx_stagebg') === 'blanco' ? 'blanco' : 'negro'; } catch (e) { return 'negro'; } }
function mountStage(canvas, cfg, equippedIds, opts) {
  if (activeStage) { activeStage.dispose(); activeStage = null; }
  canvas.classList.toggle('stage-white', stageBgPref() === 'blanco');
  activeStage = new Stage(canvas, opts);
  activeStage.setAvatar(cfg, equippedIds);
  return activeStage;
}
function equippedList(u) { return Object.values((u.avatar && u.avatar.equipped) || {}).filter(Boolean); }
function pushRecent(u, itemId) {
  if (!u || !itemId) return;
  u.recents = [itemId, ...(u.recents || []).filter(x => x !== itemId)].slice(0, 24);
}

// Foto fija de un accesorio para las tarjetas del marketplace.
let previewRenderer = null;
function itemPreview(canvas, item) {
  if (!previewRenderer) {
    previewRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    previewRenderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    previewRenderer.setSize(300, 300, false);
  }
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xd8ecff, 0x2a3342, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  const rig = buildRig({ face: item.face || 'clasica' });
  // La tarjeta muestra el artículo puesto: cara, camisa o pantalón.
  rig.setEquipped([item.id], CATALOG);
  rig.group.position.y = -4.35;
  scene.add(rig.group);
  const cam = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
  cam.position.set(0, 0.15, 2.7);
  cam.lookAt(0, 0.05, 0);
  previewRenderer.render(scene, cam);
  const ctx = canvas.getContext('2d');
  canvas.width = 300; canvas.height = 300;
  ctx.clearRect(0, 0, 300, 300);
  ctx.drawImage(previewRenderer.domElement, 0, 0);
  // La textura de la plantilla carga asíncrona: cuando llegue, la
  // vista fija se vuelve a pintar con la prenda puesta.
  if (item.templateTex && !canvas.dataset.texPending) {
    canvas.dataset.texPending = '1';
    whenTemplateTexReady(item.templateTex, () => { delete canvas.dataset.texPending; itemPreview(canvas, item); });
  }
}

// Foto de cabeza 3D de un usuario (fila de amigos de la portada):
// se renderiza su rig real una vez y se guarda la imagen en cache.
let headRenderer = null;
const headshotCache = new Map();
function headshotImg(userObj) {
  const cacheKey = userObj.id + '|' + JSON.stringify(userObj.avatar || {});
  if (headshotCache.has(cacheKey)) return headshotCache.get(cacheKey);
  if (!headRenderer) {
    headRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    headRenderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    headRenderer.setSize(192, 192, false);
  }
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xd8ecff, 0x2a3342, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  const rig = buildRig(userObj.avatar || { face: 'clasica' });
  rig.setEquipped(equippedList(userObj), CATALOG);
  rig.group.position.y = -4.12;
  scene.add(rig.group);
  const cam = new THREE.PerspectiveCamera(36, 1, 0.1, 50);
  cam.position.set(0, 0.15, 2.5);
  cam.lookAt(0, 0.05, 0);
  headRenderer.render(scene, cam);
  const cv = document.createElement('canvas');
  cv.width = 192; cv.height = 192;
  cv.getContext('2d').drawImage(headRenderer.domElement, 0, 0);
  const url = cv.toDataURL();
  headshotCache.set(cacheKey, url);
  return url;
}
// Cabeza 3D segura para cualquier marcador de usuario (amigos, grupos,
// barra superior, lista de jugadores en partida): si el usuario no trae
// datos de avatar accesibles, se usa la cabeza del avatar por defecto
// de la plataforma. Nunca una inicial.
function userHeadImg(userObj) {
  try {
    if (userObj && userObj.avatar) return headshotImg(userObj);
  } catch (e) { /* cae a la cabeza por defecto */ }
  try { return headshotImg({ id: '__default', avatar: defaultAvatar() }); } catch (e) { return ''; }
}
window.__vortxHeadshot = userHeadImg;

// ---------------- Cubiertas de experiencia ----------------
function coverStyle(exp) {
  if (exp.cover) return 'background-image:url("' + exp.cover + '");background-size:cover;background-position:center';
  const h = exp.hue || 0x3d1a5c;
  return 'background:' + hex(h);
}
function shade(color, amt) {
  const r = Math.max(0, Math.min(255, (color >> 16) + amt));
  const g = Math.max(0, Math.min(255, ((color >> 8) & 255) + amt));
  const b = Math.max(0, Math.min(255, (color & 255) + amt));
  return (r << 16) | (g << 8) | b;
}
// Tarjeta desnuda estilo censo (oleada 4): portada cuadrada directa
// sobre el fondo, nombre en blanco debajo y una linea gris con las
// visitas y los favoritos REALES de la experiencia. Nada de jugadores
// inventados: la presencia solo se muestra donde se mide de verdad
// (pestana Servers de la ficha).
const EYE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const HEART_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20.7C6.4 17 3 13.6 3 9.9 3 7.2 5 5 7.7 5c1.7 0 3.3.9 4.3 2.4C13 5.9 14.6 5 16.3 5 19 5 21 7.2 21 9.9c0 3.7-3.4 7.1-9 10.8z"/></svg>';
const PEOPLE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
function expCard(exp) {
  return '<article class="exp-card" data-exp="' + exp.id + '">' +
    '<div class="exp-cover" style="' + coverStyle(exp) + '">' + (exp.cover ? '' : '<span class="cover-letter">' + esc(exp.name[0] || 'V') + '</span>') + '</div>' +
    '<h3>' + esc(exp.name) + '</h3>' +
    '<div class="exp-stats"><span title="' + esc(t('card.visits', { n: exp.visits || 0 })) + '">' + EYE_SVG + (exp.visits || 0) + '</span><span title="' + esc(t('card.favs', { n: exp.favs || 0 })) + '">' + HEART_SVG + (exp.favs || 0) + '</span></div></article>';
}
function sectionHtml(title, note, exps) {
  if (!exps.length) return '';
  return '<div class="sec-head"><h2>' + esc(title) + '</h2>' + (note ? '<span>' + esc(note) + '</span>' : '') + '</div>' +
    '<div class="exp-grid">' + exps.map(expCard).join('') + '</div>';
}
function sectionRow(title, note, exps) {
  if (!exps.length) return '';
  return '<div class="sec-head"><h2>' + esc(title) + '</h2>' + (note ? '<span>' + esc(note) + '</span>' : '') + '</div>' +
    '<div class="exp-row">' + exps.map(expCard).join('') + '</div>';
}
function wireExpCards(root) {
  $$('[data-exp]', root).forEach(c => c.addEventListener('click', () => { location.hash = '#/exp/' + c.dataset.exp; }));
}

// ---------------- Vistas ----------------
const views = ['home', 'exp', 'market', 'avatar', 'friends', 'groups', 'profile', 'hub', 'search', 'codes', 'trades', 'mensajes', 'grupo', 'inventario', 'tienda', 'ajustes', 'descargar', 'legal', 'transacciones', 'login', 'registro'];
const SIDE_OF_VIEW = { home: 'home', exp: 'games', market: 'market', avatar: 'avatar', friends: 'friends', mensajes: 'mensajes', groups: 'groups', grupo: 'groups', profile: 'profile', hub: 'hub', trades: 'trades', inventario: 'inventario', tienda: 'tienda', ajustes: 'seguridad', descargar: 'descargar' };
function show(view) {
  for (const v of views) $('#view-' + v).classList.toggle('hidden', v !== view);
  $$('#mainNav a').forEach(a => a.classList.toggle('active', a.dataset.nav === view || (view === 'exp' && a.dataset.nav === 'home') || (view === 'market' && a.dataset.nav === 'marketplace')));
  $$('#sidebar [data-side]').forEach(a => a.classList.toggle('active', a.dataset.side === SIDE_OF_VIEW[view]));
  if (activeStage && view !== 'avatar' && view !== 'profile') { activeStage.dispose(); activeStage = null; }
  window.scrollTo(0, 0);
}

let greetBucket = null, greetTimer = null;
// Tramos del saludo segun la hora local del dispositivo:
// manana 6-12, tarde 12-20, noche 20-6.
const bucketOf = (h) => (h >= 6 && h < 12) ? 0 : (h >= 12 && h < 20) ? 1 : 2;
function renderHome(query) {
  show('home');
  const u = me();
  const pub = DB.exps.filter(e => e.published);
  let html = '';
  if (query) {
    const q = query.toLowerCase();
    const hits = pub.filter(e => e.name.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q) || e.creator.toLowerCase().includes(q));
    html = '<div class="sec-head"><h2>' + t('home.resultsFor', { q: esc(query) }) + '</h2><span>' + t('home.nExps', { n: hits.length }) + '</span></div>' +
      (hits.length ? '<div class="exp-grid">' + hits.map(expCard).join('') + '</div>' : '<div class="empty-note">' + t('home.nothing') + '</div>');
    $('#view-home').innerHTML = html;
    wireExpCards($('#view-home'));
    return;
  }
  // Oleada 4: fuera la franja de APERTURA y el boton de Discord de la
  // portada (el Discord vive en el pie y el codigo APERTURA sigue en
  // Canjear). Portada del censo: H1 y secciones con datos reales.
  html += '<h1 class="home-h1">' + t('home.discoverTitle') + '</h1>';
  const cont = DB.played.map(id => expById(id)).filter(e => e && e.published);
  if (u) {
    const hr = new Date().getHours();
    greetBucket = bucketOf(hr);
    const gk = ['home.greetM', 'home.greetA', 'home.greetE'][greetBucket];
    if (greetTimer) clearInterval(greetTimer);
    greetTimer = setInterval(() => {
      if (bucketOf(new Date().getHours()) !== greetBucket && !document.getElementById('view-home').classList.contains('hidden')) renderHome();
    }, 30000);
    // El saludo y Seguir jugando forman una sola seccion y solo salen
    // cuando hay historial real de partidas.
    if (cont.length) {
      html += '<div class="home-greet"><img class="greet-body" alt="" src="' + bodyShotImg(u) + '">' +
        '<div class="greet-text"><h1>' + t('home.hello', { name: esc(u.display) }) + '</h1><p class="greet-sub">' + t(gk, { name: esc(u.display) }) + '</p></div></div>' +
        '<div class="sec-head"><h2>' + t('home.continue') + '</h2><span>' + t('home.realHistory') + '</span></div>' +
        '<div class="exp-grid">' + cont.map(expCard).join('') + '</div>';
    }
    const friends = (u.friends || []).map(id => DB.users.find(x => x.id === id)).filter(Boolean);
    html += '<div class="sec-head"><h2>' + t('home.friendsRow') + '</h2><span>' + t('fr.count', { n: friends.length }) + '</span></div>' +
      '<div class="friends-row"><div class="friend-chip add" id="homeAddFriend"><div class="add-circle">+</div><span>' + t('home3.addFriends') + '</span></div>' +
      friends.map(f => '<div class="friend-chip" data-friend="' + esc(f.username) + '"><img alt="" src="' + headshotImg(f) + '"><span>' + esc(f.display) + '</span></div>').join('') + '</div>';
  }
  // Correccion oleada 4 (2026-11-14): fuera la tarjeta hero de
  // invitado («Juega y crea en tu navegador»); la portada va directa
  // del H1 «Descubre VORTX» a las secciones, como el censo.
  const byVisits = [...pub].sort((a, b) => (b.visits || 0) - (a.visits || 0));
  const byNew = [...pub].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  html += sectionHtml(t('home.popularNow'), '', byVisits);
  html += sectionHtml(t('home.addedRecently'), '', byNew);
  html += sectionHtml(t('home.explore'), '', pub);
  if (!pub.length) html += '<div class="empty-note">' + t('home.none') + '</div>';
  $('#view-home').innerHTML = html;
  wireExpCards($('#view-home'));
  $$('#view-home [data-friend]').forEach(c => c.addEventListener('click', () => { location.hash = '#/profile/' + c.dataset.friend; }));
  const haf = $('#homeAddFriend');
  if (haf) haf.addEventListener('click', () => openAddFriend());
}

// ---------------- Pagina de experiencia (oleada 3) ----------------
let expTab = 'about';
let srvState = { expId: null, loading: false, rows: null, failed: false, sort: 'players' };
function voteCounts(expId) {
  const all = (DB.votes || {})[expId] || {};
  let up = 0, down = 0;
  for (const k of Object.keys(all)) { if (all[k] === 1) up++; else if (all[k] === -1) down++; }
  const u = me();
  return { up, down, mine: u ? (all[u.id] || 0) : 0 };
}
function privRoomsKey() { return 'vortx_privrooms_v1'; }
function privRoomsOf(expId) {
  try { const m = JSON.parse(localStorage.getItem(privRoomsKey()) || '{}'); return Array.isArray(m[expId]) ? m[expId] : []; } catch (e) { return []; }
}
function rememberPrivRoom(expId, code) {
  try {
    const m = JSON.parse(localStorage.getItem(privRoomsKey()) || '{}');
    m[expId] = [code, ...(m[expId] || []).filter(c => c !== code)].slice(0, 6);
    localStorage.setItem(privRoomsKey(), JSON.stringify(m));
  } catch (e) {}
}
function genRoomCode() {
  const ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += ABC[Math.floor(Math.random() * ABC.length)];
  return s;
}
// Baneos locales de partida (pieza 44): el cliente del jugador
// baneado guarda su propio nombre en esta lista, por experiencia
// (la escribe play.js al recibir el /ban de un owner). Sin servidor
// de cuentas es un baneo de este navegador, no global.
function myExpBan(expId, username) {
  try {
    const all = JSON.parse(localStorage.getItem('vortx_bans_v1') || '{}');
    return Array.isArray(all[expId]) && all[expId].indexOf(String(username || '').toLowerCase()) >= 0;
  } catch (e) { return false; }
}
function launchExp(exp, code) {
  const u = me();
  if (!u) { openAuth('register'); toast(t('exp.needAccountPlay')); return; }
  if (myExpBan(exp.id, u.username)) { toast(t('pl.banBlocked')); return; }
  exp.visits = (exp.visits || 0) + 1;
  DB.played = [exp.id, ...DB.played.filter(x => x !== exp.id)].slice(0, 12);
  try {
    if (code) {
      sessionStorage.setItem('vortx_join_code', code);
      sessionStorage.setItem('vortx_join_exp', exp.id);
      rememberPrivRoom(exp.id, code);
    } else {
      sessionStorage.removeItem('vortx_join_code');
      sessionStorage.removeItem('vortx_join_exp');
    }
  } catch (e) {}
  saveDb();
  startExperience(exp, u, CATALOG, () => { location.hash = '#/exp/' + exp.id; renderExp(exp.id); }, makeChatApi(exp));
}
async function loadServers(exp) {
  srvState = { expId: exp.id, loading: true, rows: null, failed: false, sort: srvState.sort || 'players' };
  paintServers(exp);
  const topics = [{ kind: 'public', code: null, topic: 'vortx-exp-' + exp.id }];
  for (const code of privRoomsOf(exp.id)) topics.push({ kind: 'private', code, topic: 'vortx-exp-' + exp.id + '-p' + code });
  const rows = [];
  let anyFail = false;
  for (const tp of topics) {
    const r = await peekPresence(tp.topic, 4500);
    if (!r.ok) anyFail = true;
    rows.push({ kind: tp.kind, code: tp.code, ok: r.ok, players: r.players.length, names: r.players.map(p => p.name).filter(Boolean) });
  }
  if (srvState.expId !== exp.id) return;
  srvState = { expId: exp.id, loading: false, rows, failed: anyFail, sort: srvState.sort };
  paintServers(exp);
}
function paintServers(exp) {
  const box = $('#srvList');
  if (!box) return;
  if (srvState.loading) { box.innerHTML = '<div class="empty-note">' + t('exp3.refresh') + '…</div>'; return; }
  if (!srvState.rows) { box.innerHTML = ''; return; }
  let rows = (srvState.rows || []).filter(r => r.kind === 'private' || r.players > 0);
  rows = [...rows].sort((a, b) => srvState.sort === 'name'
    ? String(a.code || '').localeCompare(String(b.code || ''))
    : (b.players - a.players) || String(a.code || '').localeCompare(String(b.code || '')));
  if (!rows.length) {
    box.innerHTML = '<div class="empty-note"><b>' + t('exp3.srvEmpty') + '</b><br><span>' + t('exp3.srvEmptySub') + '</span></div>';
    return;
  }
  box.innerHTML = rows.map((r, ix) =>
    '<div class="srv-card"><div class="grow"><b>' + (r.kind === 'public' ? t('exp3.srvPublic') : t('exp3.srvPrivate') + ' ····' + esc((r.code || '').slice(-2))) + '</b>' +
    '<span>' + (r.ok ? t('exp3.players', { n: r.players }) : t('exp3.playersUnknown')) + '</span>' +
    (r.names.length ? '<span class="srv-avas">' + r.names.slice(0, 6).map(n => '<span class="srv-ava" title="' + esc(n) + '">' + esc((n || '?')[0].toUpperCase()) + '</span>').join('') + '</span>' : '') +
    '</div>' +
    '<button class="btn small" data-srvjoin="' + (r.code || '') + '" type="button">' + t('exp3.join') + '</button></div>').join('');
  $$('#srvList [data-srvjoin]').forEach(b => b.addEventListener('click', () => launchExp(exp, b.dataset.srvjoin || null)));
}
function openCodeModal(exp, mode) {
  const m = $('#codeModal');
  $('#cmTitle').textContent = mode === 'create' ? t('exp3.createPrivate') : t('exp3.joinPrivate');
  const body = $('#cmBody');
  if (mode === 'create') {
    const code = genRoomCode();
    body.innerHTML = '<p class="form-note" style="margin-bottom:10px">' + t('exp3.yourCode') + '</p>' +
      '<div class="room-code">' + code + '</div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px"><button class="btn" id="cmCancel" type="button">' + t('af.cancel') + '</button>' +
      '<button class="btn primary" id="cmGo" type="button">' + t('exp3.enterGame') + '</button></div>';
    m.classList.remove('hidden');
    $('#cmCancel').addEventListener('click', () => m.classList.add('hidden'));
    $('#cmGo').addEventListener('click', () => { m.classList.add('hidden'); launchExp(exp, code); });
  } else {
    body.innerHTML = '<form id="cmForm" class="form-grid"><label><span>' + t('exp3.codeTitle') + '</span> <input id="cmCode" type="text" maxlength="10" autocomplete="off" placeholder="' + t('exp3.codePh') + '"></label>' +
      '<p class="form-err" id="cmErr"></p>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="cmCancel" type="button">' + t('af.cancel') + '</button>' +
      '<button class="btn primary" type="submit">' + t('exp3.codeJoinBtn') + '</button></div></form>';
    m.classList.remove('hidden');
    $('#cmCancel').addEventListener('click', () => m.classList.add('hidden'));
    $('#cmForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const code = $('#cmCode').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length < 4) { $('#cmErr').textContent = t('exp3.codeBad'); return; }
      m.classList.add('hidden');
      launchExp(exp, code);
    });
    setTimeout(() => { const i = $('#cmCode'); if (i) i.focus(); }, 30);
  }
}
function renderExp(id) {
  const exp = expById(id);
  if (!exp) { location.hash = '#/'; return; }
  show('exp');
  const u = me();
  const isFav = !!(u && (u.favorites || []).includes(exp.id));
  const myBest = u && u.bestTimes && u.bestTimes[exp.id];
  const vc = voteCounts(exp.id);
  const fmtD = (iso) => new Date(iso).toLocaleDateString(currentLang());
  const gridCell = (label, val) => '<div class="data-cell"><b>' + esc(val) + '</b><span>' + esc(label) + '</span></div>';
  let grid = gridCell(t('exp3.gVisits'), String(exp.visits || 0));
  grid += gridCell(t('exp3.gCreator'), exp.creator);
  if (exp.createdAt) grid += gridCell(t('exp3.gCreated'), fmtD(exp.createdAt));
  if (exp.updatedAt) grid += gridCell(t('exp3.gUpdated'), fmtD(exp.updatedAt));
  if (exp.genre) grid += gridCell(t('exp3.gGenre'), exp.genre);
  if (exp.age) grid += gridCell(t('exp3.gAge'), exp.age);
  grid += gridCell(t('exp3.gAccess'), t('exp3.public'));
  const passesHtml = (exp.passes || []).length ?
    '<div class="sec-head"><h2>' + t('exp.passes') + '</h2><span>' + t('exp.passNote') + '</span></div>' +
    '<div class="pass-grid">' + exp.passes.map(p => {
      const owned = u && ownedPassIds(u, exp.id).includes(p.id);
      const own = u && exp.creator === u.username;
      const perk = PASS_PERKS[p.perk] || PASS_PERKS.badge;
      const esCons = p.kind === 'consumable';
      const cnt = esCons && u ? (((u.consumables || {})[exp.id] || {})[p.id] || 0) : 0;
      return '<div class="pass-card"><div class="pass-top"><b>' + esc(p.name) + '</b><span class="perk-chip">' + esc(perkName(p.perk)) + (esCons ? ' · ' + (p.seconds || 30) + ' s · ' + t('exp.consumable') : '') + '</span></div>' +
        '<p>' + esc(p.desc || perkInfo(p.perk)) + '</p>' +
        '<div class="pass-foot"><span class="price">' + p.price + ' V-Coins</span>' +
        (own ? '<span class="owned-tag">' + t('exp.yourExp') + '</span>'
          : esCons ? (cnt ? '<span class="owned-tag">' + t('exp.youHave', { n: cnt }) + '</span>' : '') + '<button class="btn primary small" data-pass="' + p.id + '" type="button">' + t('mkt.buy') + '</button>'
          : owned ? '<span class="owned-tag">' + t('exp.owned') + '</span>'
          : '<button class="btn primary small" data-pass="' + p.id + '" type="button">' + t('exp.buyPass') + '</button>') +
        '</div></div>';
    }).join('') + '</div>' : '';
  const others = DB.exps.filter(e => e.published && e.id !== exp.id);
  const creatorU = userByName(exp.creator);
  // «Jugando» solo sale si la presencia real de esta experiencia ya se
  // midio en esta sesion (pestana Servers); nunca se inventa la cifra.
  let playingNow = null;
  if (srvState.expId === exp.id && srvState.rows) {
    const pubRow = srvState.rows.find(r => r.kind === 'public');
    if (pubRow && pubRow.ok) playingNow = pubRow.players;
  }
  const likeBtnHtml = '<button class="btn vote-btn' + (vc.mine === 1 ? ' on' : '') + '" id="likeBtn" type="button" title="' + t('exp3.like') + '"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12H4a1 1 0 0 1-1-1V11a1 1 0 0 1 1-1h3zm0 0l4.2-7.2c1.5 0 2.6 1.2 2.4 2.7L13 9h6.1a2 2 0 0 1 2 2.4l-1.2 7.4a2 2 0 0 1-2 1.6H7"/></svg> ' + vc.up + '</button>';
  const dislikeBtnHtml = '<button class="btn vote-btn' + (vc.mine === -1 ? ' on' : '') + '" id="dislikeBtn" type="button" title="' + t('exp3.dislike') + '"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-3zm0 0l-4.2 7.2c-1.5 0-2.6-1.2-2.4-2.7L11 15H4.9a2 2 0 0 1-2-2.4l1.2-7.4a2 2 0 0 1 2-1.6H17"/></svg> ' + vc.down + '</button>';
  $('#view-exp').innerHTML =
    '<div class="exp-page">' +
    '<div class="exp-cover exp-hero-cover" style="' + coverStyle(exp) + '">' + (exp.cover ? '' : '<span class="cover-letter">' + esc(exp.name[0] || 'V') + '</span>') + '</div>' +
    '<div class="exp-head-row"><div class="exp-head-main">' +
    '<div class="exp-title-row"><h1>' + esc(exp.name) + '</h1>' + (exp.age ? '<span class="age-chip">' + esc(exp.age) + '</span>' : '') + '</div>' +
    '<div class="by-line2">' + '<img class="by-ava" alt="" src="' + userHeadImg(creatorU) + '">' +
    '<span>' + t('c.by') + ' <a href="#/profile/' + esc(exp.creator) + '">' + esc(exp.creator) + '</a></span>' +
    '<span class="by-sep">·</span><span>' + t('exp.template') + ' ' + esc((TEMPLATES[exp.template] || {}).name || exp.template) + '</span></div>' +
    '<div class="exp-stats-row">' +
    '<div class="estat">' + EYE_SVG + '<div><b>' + (exp.visits || 0) + '</b><span>' + t('exp3.gVisits') + '</span></div></div>' +
    '<div class="estat">' + HEART_SVG + '<div><b>' + (exp.favs || 0) + '</b><span>' + t('exp.favs') + '</span></div></div>' +
    (playingNow !== null ? '<div class="estat">' + PEOPLE_SVG + '<div><b>' + playingNow + '</b><span>' + t('exp.playingNow') + '</span></div></div>' : '') +
    '</div></div>' +
    '<button class="btn green big" id="playBtn" type="button"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg> ' + t('c.play') + '</button>' +
    '</div>' +
    '<div class="vtabs"><button class="vtab' + (expTab === 'about' ? ' active' : '') + '" data-etab="about" type="button">' + t('exp3.about') + '</button>' +
    '<button class="vtab' + (expTab === 'servers' ? ' active' : '') + '" data-etab="servers" type="button">' + t('exp3.servers') + '</button></div>' +
    '<div id="expTabBody"></div>' +
    '</div>';
  const paintTab = () => {
    const body = $('#expTabBody');
    if (!body) return;
    if (expTab === 'about') {
      body.innerHTML = '<div class="panel-card about-card">' +
        '<div class="about-actions">' + likeBtnHtml + dislikeBtnHtml +
        '<button class="btn" id="favBtn" type="button">' + (isFav ? t('exp.favIn') : t('exp.favAdd')) + '</button>' +
        '<button class="btn dots-btn" id="expDots" type="button" title="' + t('exp3.more') + '">···</button></div>' +
        '<p class="desc">' + esc(exp.desc || t('exp.noDesc')) + '</p>' +
        (myBest ? '<p class="form-note" style="margin:10px 0">' + t('exp.bestTime') + ' <b>' + Number(myBest).toFixed(1) + ' s</b></p>' : '') +
        '<div class="data-grid">' + grid + '</div></div>' + passesHtml +
        sectionHtml(t('exp3.upNext'), '', others.slice(0, 8));
      $$('#view-exp [data-pass]').forEach(b => b.addEventListener('click', () => buyPass(exp.id, b.dataset.pass)));
      wireExpCards(body);
      wireExpActions();
    } else {
      body.innerHTML = '<div class="srv-tools">' +
        '<button class="btn" id="srvJoinCode" type="button">' + t('exp3.joinPrivate') + '</button>' +
        '<button class="btn" id="srvCreate" type="button">' + t('exp3.createPrivate') + '</button>' +
        '<span class="spacer"></span>' +
        '<button class="btn small' + (srvState.sort === 'players' ? ' primary' : '') + '" id="srvSortP" type="button">' + t('exp3.sortPlayers') + '</button>' +
        '<button class="btn small' + (srvState.sort === 'name' ? ' primary' : '') + '" id="srvSortN" type="button">' + t('exp3.sortName') + '</button>' +
        '<button class="btn small" id="srvRefresh" type="button">' + t('exp3.refresh') + '</button></div>' +
        '<div id="srvList"></div>';
      $('#srvJoinCode').addEventListener('click', () => openCodeModal(exp, 'join'));
      $('#srvCreate').addEventListener('click', () => openCodeModal(exp, 'create'));
      $('#srvRefresh').addEventListener('click', () => loadServers(exp));
      $('#srvSortP').addEventListener('click', () => { srvState.sort = 'players'; paintTab(); paintServers(exp); });
      $('#srvSortN').addEventListener('click', () => { srvState.sort = 'name'; paintTab(); paintServers(exp); });
      if (srvState.expId === exp.id && srvState.rows) paintServers(exp);
      else loadServers(exp);
    }
  };
  paintTab();
  $$('#view-exp [data-etab]').forEach(b => b.addEventListener('click', () => { expTab = b.dataset.etab; renderExp(exp.id); }));
  $('#playBtn').addEventListener('click', () => launchExp(exp, null));
  const castVote = (v) => {
    const usr = me();
    if (!usr) { openAuth('login'); toast(t('exp3.needAccountVote'), true); return; }
    DB.votes = DB.votes || {};
    DB.votes[exp.id] = DB.votes[exp.id] || {};
    if (DB.votes[exp.id][usr.id] === v) delete DB.votes[exp.id][usr.id];
    else DB.votes[exp.id][usr.id] = v;
    saveDb();
    renderExp(exp.id);
  };
  // Los botones de voto/favorito/menu viven dentro de la tarjeta About
  // (oleada 4): se conectan cada vez que paintTab la pinta, y solo si
  // existen (en la pestana Servers no estan en el DOM).
  function wireExpActions() {
    const lb = $('#likeBtn'); if (lb) lb.addEventListener('click', () => castVote(1));
    const db2 = $('#dislikeBtn'); if (db2) db2.addEventListener('click', () => castVote(-1));
    const fv = $('#favBtn');
    if (fv) fv.addEventListener('click', () => {
      const usr = me();
      if (!usr) { openAuth('login'); return; }
      usr.favorites = usr.favorites || [];
      const i = usr.favorites.indexOf(exp.id);
      if (i >= 0) { usr.favorites.splice(i, 1); exp.favs = Math.max(0, (exp.favs || 0) - 1); }
      else { usr.favorites.push(exp.id); exp.favs = (exp.favs || 0) + 1; }
      saveDb();
      renderExp(exp.id);
    });
    const dt = $('#expDots');
    if (dt) dt.addEventListener('click', (e) => {
      openPopMenu(e.currentTarget, [
        { label: t('exp3.copyLink'), fn: () => { copyText(location.origin + location.pathname + '#/exp/' + exp.id); toast(t('exp3.linkCopied')); } },
        { label: t('exp3.report'), fn: () => openReport({ type: 'exp', id: exp.id, label: exp.name, title: t('exp3.repTitle') }) }
      ]);
    });
  }
}

function marketCard(item, u) {
  const owned = !!(u && (u.inventory || []).includes(item.id));
  const equipped = !!(u && (u.avatar.equipped || {})[item.slot] === item.id);
  const wished = !!(u && (u.wishlist || []).includes(item.id));
  let foot;
  if (item.limited) {
    const sold = (DB.ltd[item.id] || { sold: 0 }).sold;
    const quedan = item.limited - sold;
    const mias = u ? (u.units || []).filter(un => un.item === item.id).map(un => '#' + un.serial) : [];
    foot = '<p class="form-note"><span class="ltd-badge">' + t('mkt3.limited') + '</span> ' + t('mkt.left', { a: quedan, b: item.limited }) + (mias.length ? ' · ' + t('mkt.yours', { list: mias.join(', ') }) : '') + '</p>' +
      (quedan > 0
        ? '<button class="btn small primary buy-btn" data-buy="' + item.id + '" type="button">' + t('mkt.buy') + ' · <span class="price">' + item.price + ' V-Coins</span></button>'
        : '<button class="btn small" type="button" disabled>' + t('mkt.soldOut') + '</button>') +
      (owned ? ' <button class="btn small" data-equip="' + item.id + '" type="button">' + (equipped ? t('mkt.equipped') : t('mkt.equip')) + '</button>' : '');
  } else {
    foot = owned
      ? '<button class="btn small" data-equip="' + item.id + '" type="button">' + (equipped ? t('mkt.equipEditor') : t('mkt.equipInEditor')) + '</button>'
      : '<button class="btn small primary buy-btn" data-buy="' + item.id + '" type="button">' + t('mkt.buy') + ' · <span class="price">' + item.price + ' V-Coins</span></button>';
  }
  return '<div class="item-card' + (wished ? ' wish-on' : '') + '"><canvas data-preview="' + item.id + '" width="300" height="300"></canvas>' +
    (u ? '<button class="wish-star' + (wished ? ' on' : '') + '" data-wish="' + item.id + '" type="button" title="' + (wished ? t('wish.remove') : t('wish.add')) + '"><svg viewBox="0 0 24 24" width="17" height="17" fill="' + (wished ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l2.7 5.8 6.3.7-4.7 4.3 1.3 6.2L12 17l-5.6 3 1.3-6.2L3 9.5l6.3-.7z"/></svg></button>' : '') +
    '<div class="item-body"><span class="slot">' + esc(slotName(item.slot)) + '</span><h3>' + esc(item.name) + '</h3>' +
    '<p class="by-line">' + t('mkt3.by', { name: esc(item.creator || 'VORTX') }) + '</p>' +
    '<p class="price-line">' + (item.price ? '<span class="brand-bolt price-bolt" aria-hidden="true"></span>' + item.price : t('mkt.free')) + '</p>' + foot +
    '</div></div>';
}

// Filtros del catalogo (pieza 38): columna izquierda con buscar, orden,
// categorias, solo limitados, autor, rango de precio y limpiar; la
// rejilla pagina de 12 en 12 con Anterior/Siguiente reales.
let mktF = { q: '', sort: 'rel', ltd: false, creator: '', min: '', max: '', page: 1 };
const MKT_PAGE = 12;
function renderMarket(cat) {
  if (cat !== undefined && cat !== currentCat) { currentCat = cat || 'Todos'; mktF.page = 1; }
  show('market');
  const u = me();
  const cats = ['Todos', ...new Set(CATALOG.map(i => i.cat))];
  const catLabel = (c) => c === 'Todos' ? t('mkt.all') : c;
  const creators = [...new Set(CATALOG.map(i => i.creator || 'VORTX'))];
  let items = CATALOG.filter(i => (currentCat === 'Todos' || i.cat === currentCat));
  if (mktF.q) { const q = mktF.q.toLowerCase(); items = items.filter(i => i.name.toLowerCase().includes(q) || (i.creator || 'VORTX').toLowerCase().includes(q)); }
  if (mktF.ltd) items = items.filter(i => i.limited);
  if (mktF.creator) items = items.filter(i => (i.creator || 'VORTX') === mktF.creator);
  if (mktF.min !== '') items = items.filter(i => (i.price || 0) >= Number(mktF.min));
  if (mktF.max !== '') items = items.filter(i => (i.price || 0) <= Number(mktF.max));
  if (mktF.sort === 'asc') items = [...items].sort((a, b) => (a.price || 0) - (b.price || 0));
  if (mktF.sort === 'desc') items = [...items].sort((a, b) => (b.price || 0) - (a.price || 0));
  const pages = Math.max(1, Math.ceil(items.length / MKT_PAGE));
  if (mktF.page > pages) mktF.page = pages;
  const pageItems = items.slice((mktF.page - 1) * MKT_PAGE, mktF.page * MKT_PAGE);
  $('#view-market').innerHTML =
    '<div class="sec-head"><h2>Marketplace</h2><span>' + t('mkt.countItems', { n: items.length }) + '</span></div>' +
    '<div class="mkt-layout"><aside class="mkt-filters panel-card">' +
    '<h3>' + t('mkt.filters') + '</h3>' +
    '<input id="mktQ" type="search" placeholder="' + t('mkt.searchPh') + '" value="' + esc(mktF.q) + '">' +
    '<label class="mf-label">' + t('mkt.sort') + '<select id="mktSort">' +
    '<option value="rel"' + (mktF.sort === 'rel' ? ' selected' : '') + '>' + t('mkt.sortRel') + '</option>' +
    '<option value="asc"' + (mktF.sort === 'asc' ? ' selected' : '') + '>' + t('mkt.sortAsc') + '</option>' +
    '<option value="desc"' + (mktF.sort === 'desc' ? ' selected' : '') + '>' + t('mkt.sortDesc') + '</option></select></label>' +
    '<div class="mf-cats">' + cats.map(c => '<button class="chip' + (currentCat === c ? ' active' : '') + '" data-cat="' + esc(c) + '" type="button">' + esc(catLabel(c)) + '</button>').join('') + '</div>' +
    '<label class="mf-check"><input id="mktLtd" type="checkbox"' + (mktF.ltd ? ' checked' : '') + '> ' + t('mkt.onlyLtd') + '</label>' +
    '<label class="mf-label">' + t('mkt.creator') + '<select id="mktCreator"><option value="">' + t('mkt.all') + '</option>' +
    creators.map(c => '<option value="' + esc(c) + '"' + (mktF.creator === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></label>' +
    '<div class="mf-range"><input id="mktMin" type="number" min="0" placeholder="' + t('mkt.min') + '" value="' + esc(mktF.min) + '"><input id="mktMax" type="number" min="0" placeholder="' + t('mkt.max') + '" value="' + esc(mktF.max) + '"></div>' +
    '<button class="btn small" id="mktClear" type="button">' + t('mkt.clear') + '</button>' +
    '</aside><div class="mkt-main">' +
    (pageItems.length ? '<div class="item-grid dense">' + pageItems.map(item => marketCard(item, u)).join('') + '</div>' : '<div class="empty-note">' + t('mkt.none') + '</div>') +
    '<div class="pager"><button class="btn small" data-mpage="prev" type="button"' + (mktF.page <= 1 ? ' disabled' : '') + '>' + t('mkt.prev') + '</button>' +
    '<span>' + t('mkt.pageOf', { a: mktF.page, b: pages }) + '</span>' +
    '<button class="btn small" data-mpage="next" type="button"' + (mktF.page >= pages ? ' disabled' : '') + '>' + t('mkt.next') + '</button></div>' +
    '</div></div>' + marketExtraHtml(u);
  const refocus = (id) => { const el = document.getElementById(id); if (el && (id === 'mktQ' || id === 'mktMin' || id === 'mktMax')) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {} } };
  const qIn = $('#mktQ');
  if (qIn) qIn.addEventListener('input', () => { mktF.q = qIn.value; mktF.page = 1; renderMarket(); refocus('mktQ'); });
  const sSel = $('#mktSort');
  if (sSel) sSel.addEventListener('change', () => { mktF.sort = sSel.value; mktF.page = 1; renderMarket(); });
  const ltdC = $('#mktLtd');
  if (ltdC) ltdC.addEventListener('change', () => { mktF.ltd = ltdC.checked; mktF.page = 1; renderMarket(); });
  const crSel = $('#mktCreator');
  if (crSel) crSel.addEventListener('change', () => { mktF.creator = crSel.value; mktF.page = 1; renderMarket(); });
  const minIn = $('#mktMin');
  if (minIn) minIn.addEventListener('input', () => { mktF.min = minIn.value; mktF.page = 1; renderMarket(); refocus('mktMin'); });
  const maxIn = $('#mktMax');
  if (maxIn) maxIn.addEventListener('input', () => { mktF.max = maxIn.value; mktF.page = 1; renderMarket(); refocus('mktMax'); });
  const clr = $('#mktClear');
  if (clr) clr.addEventListener('click', () => { mktF = { q: '', sort: 'rel', ltd: false, creator: '', min: '', max: '', page: 1 }; currentCat = 'Todos'; renderMarket(); });
  $$('#view-market [data-mpage]').forEach(b => b.addEventListener('click', () => { mktF.page += b.dataset.mpage === 'next' ? 1 : -1; renderMarket(); }));
  $$('#view-market [data-cat]').forEach(b => b.addEventListener('click', () => renderMarket(b.dataset.cat)));
  $$('#view-market [data-preview]').forEach(cv => {
    const item = CATALOG.find(i => i.id === cv.dataset.preview);
    if (item) itemPreview(cv, item);
  });
  $$('#view-market [data-buy]').forEach(b => b.addEventListener('click', () => buyItem(b.dataset.buy)));
  $$('#view-market [data-equip]').forEach(b => b.addEventListener('click', () => { location.hash = '#/avatar'; }));
  $$('#view-market [data-wish]').forEach(b => b.addEventListener('click', () => {
    const usr = me();
    if (!usr) { openAuth('login'); return; }
    usr.wishlist = usr.wishlist || [];
    const i = usr.wishlist.indexOf(b.dataset.wish);
    if (i >= 0) usr.wishlist.splice(i, 1); else usr.wishlist.push(b.dataset.wish);
    saveDb();
    renderMarket();
  }));
  wireMarketExtra(u);
}

function marketExtraHtml(u) {
  const itemName = (id) => (CATALOG.find(i => i.id === id) || {}).name || id;
  const listings = DB.listings || [];
  const resale = '<div class="sec-head"><h2>' + t('mkt.resale') + '</h2><span>' + t('mkt.resaleNote') + '</span></div>' +
    (listings.length ? '<div class="item-grid">' + listings.map(l => {
      const seller = DB.users.find(x => x.id === l.seller);
      return '<div class="item-card"><div class="item-body"><span class="slot">' + t('mkt.unitN', { n: l.serial }) + '</span><h3>' + esc(itemName(l.item)) + '</h3>' +
        '<p>' + t('mkt.seller', { name: esc(seller ? seller.display : '?') }) + '</p>' +
        '<div class="pass-foot"><span class="price">' + l.price + ' V-Coins</span>' +
        (u && l.seller === u.id ? '<button class="btn small" data-unlist="' + l.id + '" type="button">' + t('mkt.unlist') + '</button>'
          : u ? '<button class="btn small primary" data-resale="' + l.id + '" type="button">' + t('mkt.buy') + '</button>' : '') +
        '</div></div></div>';
    }).join('') + '</div>' : '<div class="empty-note">' + t('mkt.noResale') + '</div>');
  let mine = '';
  if (u && (u.units || []).length) {
    mine = '<div class="sec-head"><h2>' + t('mkt.myLimiteds') + '</h2><span>' + t('mkt.myUnits') + '</span></div><div class="panel-card">' +
      u.units.map(un => {
        const l = listings.find(x => x.item === un.item && x.serial === un.serial && x.seller === u.id);
        return '<div class="tx-row"><span>' + esc(itemName(un.item)) + ' #' + un.serial + (l ? ' ' + t('mkt.onSaleFor', { n: l.price }) : '') + '</span>' +
          (l ? '' : '<span><input type="number" min="10" max="100000" step="1" value="500" style="width:90px" data-sellprice="' + un.item + ':' + un.serial + '"> <button class="btn small primary" data-sell="' + un.item + ':' + un.serial + '" type="button">' + t('mkt.sell') + '</button></span>') +
          '</div>';
      }).join('') +
      '<p class="form-note" style="margin-top:8px">' + t('mkt.tradeNote') + ' <a href="#/trades" style="color:var(--accent2)">' + t('mkt.openTrades') + '</a>.</p></div>';
  } else if (u) {
    mine = '<div class="sec-head"><h2>' + t('mkt.myLimiteds') + '</h2></div><div class="empty-note">' + t('mkt.noLimitedsYet') + ' <a href="#/trades" style="color:var(--accent2)">' + t('tr.title') + '</a>.</div>';
  }
  return resale + mine;
}
function wireMarketExtra(u) {
  if (!u) return;
  $$('#view-market [data-sell]').forEach(b => b.addEventListener('click', () => {
    const [itemId, serialTxt] = b.dataset.sell.split(':');
    const serial = Number(serialTxt);
    const inp = document.querySelector('[data-sellprice="' + b.dataset.sell + '"]');
    const price = Math.floor(Number(inp && inp.value));
    if (!(price >= 10 && price <= 100000)) { toast(t('toast.sellPriceRange'), true); return; }
    const un = (u.units || []).find(x => x.item === itemId && x.serial === serial);
    if (!un || un.listed) return;
    const l = { id: uid('lst'), item: itemId, serial, seller: u.id, price, at: new Date().toISOString() };
    un.listed = l.id;
    DB.listings = [...(DB.listings || []), l];
    saveDb();
    toast(t('mkt.sell') + ': #' + serial + ' · ' + price + ' V-Coins');
    renderMarket(currentCat);
  }));
  $$('#view-market [data-unlist]').forEach(b => b.addEventListener('click', () => {
    const l = (DB.listings || []).find(x => x.id === b.dataset.unlist);
    if (!l || l.seller !== u.id) return;
    const un = (u.units || []).find(x => x.item === l.item && x.serial === l.serial);
    if (un) delete un.listed;
    DB.listings = DB.listings.filter(x => x.id !== l.id);
    saveDb();
    renderMarket(currentCat);
  }));
  $$('#view-market [data-resale]').forEach(b => b.addEventListener('click', () => buyResale(b.dataset.resale)));
}
function buyResale(listingId) {
  const u = me();
  if (!u) { openAuth('register'); return; }
  const l = (DB.listings || []).find(x => x.id === listingId);
  if (!l || l.seller === u.id) return;
  const seller = DB.users.find(x => x.id === l.seller);
  const un = seller && (seller.units || []).find(x => x.item === l.item && x.serial === l.serial && x.listed === l.id);
  if (!un) { toast(t('toast.resaleGone'), true); DB.listings = DB.listings.filter(x => x.id !== l.id); saveDb(); renderMarket(currentCat); return; }
  if ((u.coins || 0) < l.price) { toast(t('toast.notEnoughLimited'), true); return; }
  const itemName = (CATALOG.find(i => i.id === l.item) || {}).name || l.item;
  u.coins -= l.price;
  const cut = Math.floor(l.price * 0.9);
  seller.coins = (seller.coins || 0) + cut;
  seller.units = seller.units.filter(x => x !== un);
  delete un.listed;
  u.units = [...(u.units || []), un];
  seller.tx = seller.tx || [];
  seller.tx.unshift({ at: new Date().toISOString(), label: 'Reventa: ' + itemName + ' #' + l.serial, amount: cut });
  u.tx = u.tx || [];
  u.tx.unshift({ at: new Date().toISOString(), label: 'Reventa: ' + itemName + ' #' + l.serial, amount: -l.price });
  fixLimitedInventory(seller);
  fixLimitedInventory(u);
  DB.listings = DB.listings.filter(x => x.id !== l.id);
  saveDb();
  updateTopbar();
  toast(t('toast.unitYours', { n: l.serial, name: itemName }));
  renderMarket(currentCat);
}
function unitKey(un) { return un.item + '#' + un.serial; }
function fixLimitedInventory(usr) {
  // El articulo limited esta en el inventario si la cuenta tiene alguna unidad.
  usr.units = usr.units || [];
  usr.inventory = usr.inventory || [];
  for (const it of CATALOG.filter(i => i.limited)) {
    const has = usr.units.some(un => un.item === it.id);
    const ix = usr.inventory.indexOf(it.id);
    if (has && ix < 0) usr.inventory.push(it.id);
    if (!has && ix >= 0) usr.inventory.splice(ix, 1);
  }
}
function buyItem(id) {
  const u = me();
  if (!u) { openAuth('register'); toast(t('toast.needAccountBuy')); return; }
  const item = CATALOG.find(i => i.id === id);
  if (!item) return;
  if (item.limited) {
    DB.ltd[item.id] = DB.ltd[item.id] || { sold: 0 };
    if (DB.ltd[item.id].sold >= item.limited) { toast(t('toast.limitedOut'), true); return; }
    if ((u.coins || 0) < item.price) { toast(t('toast.notEnoughLimited'), true); return; }
    const serial = DB.ltd[item.id].sold + 1;
    DB.ltd[item.id].sold = serial;
    u.coins -= item.price;
    u.units = [...(u.units || []), { item: item.id, serial }];
    pushRecent(u, item.id);
    u.inventory = u.inventory || [];
    if (!u.inventory.includes(item.id)) u.inventory.push(item.id);
    u.tx = u.tx || [];
    u.tx.unshift({ at: new Date().toISOString(), label: 'Limited: ' + item.name + ' #' + serial, amount: -item.price });
    saveDb();
    updateTopbar();
    toast(t('toast.limitedBought', { name: item.name, n: serial, total: item.limited }));
    renderMarket(currentCat);
    return;
  }
  if ((u.inventory || []).includes(id)) return;
  if ((u.coins || 0) < item.price) { toast(t('toast.notEnoughItem'), true); return; }
  u.coins -= item.price;
  u.inventory.push(id);
  pushRecent(u, id);
  u.tx = u.tx || [];
  u.tx.unshift({ at: new Date().toISOString(), label: 'Compra: ' + item.name, amount: -item.price });
  saveDb();
  updateTopbar();
  toast(t('toast.bought', { name: item.name }));
  renderMarket(currentCat);
}
window.addEventListener('vortx-consumable', (e) => {
  const u = me();
  if (!u) return;
  const d = (e && e.detail) || {};
  if (u.consumables && u.consumables[d.expId] && u.consumables[d.expId][d.passId] > 0) {
    u.consumables[d.expId][d.passId]--;
    saveDb();
  }
});
window.addEventListener('vortx-win', (e) => {
  const u = me();
  if (!u || !e.detail || typeof e.detail.time !== 'number') return;
  u.bestTimes = u.bestTimes || {};
  const prev = u.bestTimes[e.detail.expId];
  const rt = Math.round(e.detail.time * 10) / 10;
  if (prev == null || rt < prev) {
    u.bestTimes[e.detail.expId] = rt;
    saveDb();
    toast(prev == null ? t('toast.firstRecord') : t('toast.newRecord', { t: rt }));
  }
});

// ---------------- Chat y filtro anti bad words ----------------
// Lista de palabras no permitidas (ES/EN). La comparacion normaliza
// acentos, mayusculas, letras repetidas y sustituciones tipo 0/o, 1/i.
const BAD_WORDS = new Set(('mierda puta puto putas putos cono verga vergas pendejo pendeja pendejos cabron cabrona gilipollas joder cojones maricon marica zorra perra idiota imbecil estupido estupida polla follar cagar cagada shit fuck fucking bitch asshole dick pussy nigger nigga faggot whore bastard slut damn crap porno porn').split(' '));
function normWord(w) {
  const leet = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };
  return w.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').split('').map(ch => leet[ch] || ch).join('').replace(/(.)\1+/g, '$1');
}
function isBadToken(tok) {
  const clean = normWord(tok.replace(/[^a-zA-Z0-9@$áéíóúüñÁÉÍÓÚÜÑ]/g, ''));
  if (!clean) return false;
  if (BAD_WORDS.has(clean)) return true;
  // Tambien caza la palabra pegada dentro de otra (p. ej. "putamadre")
  for (const bw of BAD_WORDS) {
    const nb = normWord(bw);
    if (nb.length >= 5 && clean.includes(nb)) return true;
  }
  return false;
}
function filterText(text) {
  let filtered = false;
  const out = text.split(/(\s+)/).map(tok => {
    if (/^\s+$/.test(tok) || !tok) return tok;
    if (isBadToken(tok)) { filtered = true; return '***'; }
    return tok;
  }).join('');
  return { text: out.slice(0, 200), filtered };
}
function makeChatApi(exp) {
  const mu = me();
  return {
    disabled: !!(mu && mu.privacy && mu.privacy.noGameChat),
    history: () => (DB.chats[exp.id] || []).slice(-30),
    post: (raw) => {
      const u = me();
      if (!u) return null;
      const r = filterText(String(raw || ''));
      if (!r.text.trim()) return null;
      const msg = { u: u.username, d: u.display, text: r.text, at: new Date().toISOString() };
      DB.chats[exp.id] = [...(DB.chats[exp.id] || []), msg].slice(-100);
      saveDb();
      return { msg, filtered: r.filtered };
    }
  };
}

function ownedPassIds(u, expId) {
  return ((u && u.passes) || {})[expId] || [];
}
// Codigo estrella (pieza 39): el 5 % del precio sale de la parte de
// la plataforma (el 30 % que no va al creador del pase) y va al
// creador apoyado por el comprador; queda registrado en el libro de
// movimientos de ambos (en el del comprador como apunte sin importe,
// porque ese 5 % no sale de su bolsillo).
function applyStarCut(buyer, price, passName) {
  if (!buyer.star) return;
  const sup = DB.users.find(x => x.username === buyer.star);
  if (!sup || sup.id === buyer.id) return;
  const cut = Math.floor(price * 0.05);
  if (cut <= 0) return;
  sup.coins = (sup.coins || 0) + cut;
  sup.tx = sup.tx || [];
  sup.tx.unshift({ at: new Date().toISOString(), label: 'Apoyo con código estrella: ' + passName, amount: cut });
  buyer.tx = buyer.tx || [];
  buyer.tx.unshift({ at: new Date().toISOString(), label: 'Apoyo con código estrella a @' + sup.username + ': ' + passName, amount: 0 });
}
function buyPass(expId, passId) {
  const u = me();
  if (!u) { openAuth('register'); toast(t('toast.needAccountPass')); return; }
  const exp = expById(expId);
  if (!exp) return;
  const pass = (exp.passes || []).find(p => p.id === passId);
  if (!pass) return;
  if (exp.creator === u.username) { toast(t('toast.ownPass')); return; }
  if (pass.kind === 'consumable') {
    if ((u.coins || 0) < pass.price) { toast(t('toast.notEnoughCons'), true); return; }
    u.coins -= pass.price;
    u.consumables = u.consumables || {};
    u.consumables[exp.id] = u.consumables[exp.id] || {};
    u.consumables[exp.id][pass.id] = (u.consumables[exp.id][pass.id] || 0) + 1;
    u.tx = u.tx || [];
    u.tx.unshift({ at: new Date().toISOString(), label: 'Consumible: ' + pass.name + ' (' + exp.name + ')', amount: -pass.price });
    const creatorC = DB.users.find(x => x.username === exp.creator);
    if (creatorC && creatorC.id !== u.id) {
      const cutC = Math.floor(pass.price * 0.7);
      creatorC.coins = (creatorC.coins || 0) + cutC;
      creatorC.tx = creatorC.tx || [];
      creatorC.tx.unshift({ at: new Date().toISOString(), label: 'Venta de consumible: ' + pass.name + ' (' + exp.name + ')', amount: cutC });
    }
    applyStarCut(u, pass.price, pass.name);
    saveDb();
    updateTopbar();
    toast(t('toast.consBought', { name: pass.name, n: u.consumables[exp.id][pass.id] }));
    renderExp(exp.id);
    return;
  }
  u.passes = u.passes || {};
  u.passes[exp.id] = u.passes[exp.id] || [];
  if (u.passes[exp.id].includes(pass.id)) return;
  if ((u.coins || 0) < pass.price) { toast(t('toast.notEnoughPass'), true); return; }
  u.coins -= pass.price;
  u.passes[exp.id].push(pass.id);
  u.tx = u.tx || [];
  u.tx.unshift({ at: new Date().toISOString(), label: 'Pase: ' + pass.name + ' (' + exp.name + ')', amount: -pass.price });
  // El creador recibe el 70 % de la venta; el resto es la comision de la plataforma.
  const creator = DB.users.find(x => x.username === exp.creator);
  if (creator && creator.id !== u.id) {
    const cut = Math.floor(pass.price * 0.7);
    creator.coins = (creator.coins || 0) + cut;
    creator.tx = creator.tx || [];
    creator.tx.unshift({ at: new Date().toISOString(), label: 'Venta de pase: ' + pass.name + ' (' + exp.name + ')', amount: cut });
  }
  applyStarCut(u, pass.price, pass.name);
  saveDb();
  updateTopbar();
  toast(t('toast.passBought', { name: pass.name }));
  renderExp(exp.id);
}

let currentCat = 'Todos';

// ---------------- Editor de avatar (pieza 13) ----------------
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: mx ? d / mx : 0, v: mx };
}
function hsvToRgbVal(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
function hexToRgbStr(hx) {
  const n = parseInt(String(hx).replace('#', ''), 16);
  if (isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
let avTab = 'recientes', avQuery = '', avPart = 'all', avPicker = { h: 270, s: 0.6, v: 0.55 };
let avSnapshot = null; // foto del avatar al entrar al editor (pieza 38)
function snapshotAvatar() { const u = me(); if (u) avSnapshot = JSON.parse(JSON.stringify(u.avatar)); }
const SKIN_TONES = ['#f8dcc0', '#f0c9a6', '#e0ac7e', '#c68742', '#8c5a2b', '#5d3a1a'];
const AV_PARTS2 = [
  { key: 'head', label: 'part.head', x: 50, y: 8, w: 30, h: 22 },
  { key: 'torso', label: 'part.torso', x: 38, y: 34, w: 24, h: 26 },
  { key: 'armL', label: 'part.armL', x: 16, y: 34, w: 16, h: 26 },
  { key: 'armR', label: 'part.armR', x: 68, y: 34, w: 16, h: 26 },
  { key: 'legL', label: 'part.legL', x: 38, y: 64, w: 11, h: 28 },
  { key: 'legR', label: 'part.legR', x: 51, y: 64, w: 11, h: 28 }
];
function renderAvatar() {
  show('avatar');
  const u = me();
  if (!u) {
    $('#view-avatar').innerHTML = '<div class="empty-note">' + t('av.login') + '<br><br><button class="btn primary" id="avLogin" type="button">' + t('c.enter') + '</button></div>';
    $('#avLogin').addEventListener('click', () => openAuth('register'));
    return;
  }
  const avatar = u.avatar;
  const owned = (avatar.equipped ? [] : []);
  const ownedItems = (u.inventory || []).map(id => CATALOG.find(i => i.id === id)).filter(Boolean);
  const q = avQuery.toLowerCase();
  const matchQ = (it) => !q || it.name.toLowerCase().includes(q);
  const tabs = [
    ['recientes', t('av3.recents')], ['cuerpo', t('av3.body')], ['paquetes', t('av3.bundles')],
    ['caras', t('av3.faces')], ['ropa', t('av3.clothing')], ['accesorios', t('av3.accessories')], ['conjuntos', t('av3.outfits')]
  ];
  const itemCards = (items, emptyMsg) => items.length
    ? '<div class="item-grid dense av-items">' + items.map(item => {
        const equipped = (avatar.equipped || {})[item.slot] === item.id;
        return '<div class="item-card"><canvas data-avprev="' + item.id + '" width="300" height="300"></canvas>' +
          (equipped ? '<span class="eq-check"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M4 12l5 5L20 6"/></svg></span>' : '') +
          '<div class="item-body"><span class="slot">' + esc(slotName(item.slot)) + '</span><h3>' + esc(item.name) + '</h3>' +
          '<button class="btn small ' + (equipped ? '' : 'primary') + '" data-avitem="' + item.id + '" type="button">' + (equipped ? t('mkt.equipped') : t('mkt.equip')) + '</button></div></div>';
      }).join('') + '</div>'
    : '<div class="empty-note">' + emptyMsg + '</div>';
  let panel = '';
  if (avTab === 'recientes') {
    const recentIds = [...new Set([...(u.recents || []), ...Object.values(avatar.equipped || {})])];
    const items = recentIds.map(id => CATALOG.find(i => i.id === id)).filter(Boolean).filter(matchQ);
    panel = itemCards(items, t('av3.noRecents'));
  } else if (avTab === 'cuerpo') {
    const selPart = AV_PARTS2.find(p => p.key === avPart);
    panel = '<div class="body-picker"><div class="body-diagram">' +
      AV_PARTS2.map(p => '<button class="body-part' + (avPart === p.key ? ' sel' : '') + '" data-part="' + p.key + '" type="button" style="left:' + p.x + '%;top:' + p.y + '%;width:' + p.w + '%;height:' + p.h + '%;background:' + hex(avatar.colors[p.key]) + '" aria-label="' + t(p.label) + '"></button>').join('') +
      '<div class="body-part-name">' + (selPart ? t(selPart.label) : '') + '</div></div>' +
      '<div class="color-lab"><div class="sv-box" id="svBox"><span class="sv-dot" id="svDot"></span></div>' +
      '<input type="range" id="hueRange" min="0" max="360" step="1">' +
      '<div class="skin-row">' + SKIN_TONES.map(c => '<button class="bg-swatch" data-skin="' + c + '" style="background:' + c + '" type="button" aria-label="skin"></button>').join('') + '</div>' +
      '<div class="hsv-fields"><label>' + t('av3.saturation') + ' <input type="number" id="satNum" min="0" max="100"></label>' +
      '<label>' + t('av3.brightness') + ' <input type="number" id="briNum" min="0" max="100"></label>' +
      '<label>Hex <input type="text" id="hexIn" maxlength="7" spellcheck="false"></label></div>' +
      '<div class="swatch-grid quick">' + PALETTE.map(c => '<button class="swatch" data-avcolor="' + c + '" type="button" style="background:' + hex(c) + '" aria-label="color"></button>').join('') + '</div>' +
      '<div style="margin-top:12px"><button class="chip' + (avatar.face ? ' active' : '') + '" id="faceToggle" type="button">' + t('av.faceToggle') + '</button></div>' +
      '</div></div>';
  } else if (avTab === 'paquetes') {
    const partChips = [['all', t('inv.all')], ['head', t('part.head')], ['torso', t('part.torso')], ['armL', t('part.armL')], ['armR', t('part.armR')], ['legL', t('part.legL')], ['legR', t('part.legR')]];
    const packs = BUNDLES.filter(p => (avPart === 'all' || p.parts[avPart] !== undefined) && (!q || p.name.toLowerCase().includes(q)));
    panel = '<div class="chip-row">' + partChips.map(([k, l]) => '<button class="chip' + (avPart === k ? ' active' : '') + '" data-packchip="' + k + '" type="button">' + l + '</button>').join('') + '</div>' +
      '<div class="item-grid dense">' + packs.map(p => {
        const applied = Object.entries(p.parts).every(([k, v]) => avatar.colors[k] === v);
        return '<div class="item-card"><img class="outfit-img" alt="" src="' + bodyShotImg({ avatar: Object.assign(defaultAvatar(), { colors: Object.assign({}, defaultAvatar().colors, p.parts) }) }) + '">' +
          (applied ? '<span class="eq-check"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M4 12l5 5L20 6"/></svg></span>' : '') +
          '<div class="item-body"><h3>' + esc(p.name) + '</h3>' +
          '<button class="btn small ' + (applied ? '' : 'primary') + '" data-pack="' + p.id + '" type="button">' + (applied ? t('mkt.equipped') : t('av3.applyBundle')) + '</button></div></div>';
      }).join('') + '</div>';
  } else if (avTab === 'caras') {
    panel = itemCards(ownedItems.filter(it => it.slot === 'face' && matchQ(it)), t('av3.noItems'));
  } else if (avTab === 'ropa') {
    panel = itemCards(ownedItems.filter(it => (it.cat === 'Camisetas' || it.cat === 'Pantalones') && matchQ(it)), t('av3.noItems'));
  } else if (avTab === 'accesorios') {
    panel = itemCards(ownedItems.filter(it => it.cat === 'Accesorios' && matchQ(it)), t('av3.noItems'));
  } else if (avTab === 'conjuntos') {
    const outfits = (u.outfits || []).filter(o => !q || o.name.toLowerCase().includes(q));
    panel = '<div class="item-grid dense"><button class="item-card add-card" id="outfitNew" type="button"><span class="add-plus">+</span><b>' + t('av3.newOutfit') + '</b></button>' +
      outfits.map((o, i) => '<div class="item-card"><img class="outfit-img" alt="" src="' + bodyShotImg({ avatar: o.avatar }) + '"><div class="item-body"><h3>' + esc(o.name) + '</h3>' +
        '<div style="display:flex;gap:6px"><button class="btn small primary" data-outfit="' + i + '" type="button">' + t('av3.applyOutfit') + '</button>' +
        '<button class="btn small danger" data-outfitdel="' + i + '" type="button">' + t('av.delete') + '</button></div></div></div>').join('') + '</div>';
  }
  $('#view-avatar').innerHTML =
    '<div class="sec-head"><h2>' + t('av.title') + '</h2><span>' + esc(u.display) + '</span><span class="spacer"></span>' +
    '<span class="form-note">' + t('av.bg') + '</span><button class="btn small' + (stageBgPref() === 'negro' ? ' primary' : '') + '" data-stagebg="negro" type="button">' + t('av.bgBlack') + '</button><button class="btn small' + (stageBgPref() === 'blanco' ? ' primary' : '') + '" data-stagebg="blanco" type="button">' + t('av.bgWhite') + '</button></div>' +
    '<div class="avatar-layout"><div class="avatar-stage"><canvas id="avatarCanvas" width="520" height="560"></canvas>' +
    '<button class="btn reset-view" id="avReset" type="button" title="' + t('av3.resetView') + '"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg></button>' +
    '<div class="av-stage-actions"><button class="btn primary" id="avSave" type="button">' + t('av3.saveChanges') + '</button><button class="btn" id="avRevert" type="button">' + t('av3.revertChanges') + '</button></div></div>' +
    '<div class="avatar-panel">' +
    '<div class="vtabs wrap">' + tabs.map(([k, l]) => '<button class="vtab' + (avTab === k ? ' active' : '') + '" data-avtab="' + k + '" type="button">' + l + '</button>').join('') + '</div>' +
    '<div class="dock-search"><input id="avSearch" type="text" placeholder="' + t('av3.searchIn', { tab: tabs.find(x => x[0] === avTab)[1] }) + '" value="' + esc(avQuery) + '" autocomplete="off"></div>' +
    panel + '</div></div>';
  mountStage($('#avatarCanvas'), avatar, equippedList(u), { dist: 10.5, auto: true });
  const rerender = () => renderAvatar();
  $$('#view-avatar [data-avtab]').forEach(b => b.addEventListener('click', () => { avTab = b.dataset.avtab; avQuery = ''; if (avTab !== 'paquetes') avPart = avTab === 'cuerpo' ? (avPart === 'all' ? 'head' : avPart) : avPart; if (avTab === 'cuerpo' && avPart === 'all') avPart = 'head'; renderAvatar(); }));
  const as = $('#avSearch');
  if (as) as.addEventListener('input', () => { avQuery = as.value; renderAvatar(); const n = $('#avSearch'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } });
  $$('#view-avatar [data-stagebg]').forEach(b => b.addEventListener('click', () => { try { localStorage.setItem('vortx_stagebg', b.dataset.stagebg); } catch (e) {} renderAvatar(); }));
  const rst = $('#avReset');
  if (rst) rst.addEventListener('click', () => { if (activeStage) { activeStage.yaw = 0; activeStage.pitch = 0; } });
  // Guardar / Reiniciar cambios (pieza 38): la foto de entrada al editor
  // se toma en route() al entrar; Guardar la renueva, Reiniciar vuelve a ella.
  const avs = $('#avSave');
  if (avs) avs.addEventListener('click', () => { saveDb(); snapshotAvatar(); toast(t('av3.saved')); });
  const avr = $('#avRevert');
  if (avr) avr.addEventListener('click', () => {
    if (avSnapshot) { u.avatar = JSON.parse(JSON.stringify(avSnapshot)); saveDb(); }
    renderAvatar();
  });
  $$('#view-avatar [data-avprev]').forEach(cv => { const it = CATALOG.find(i => i.id === cv.dataset.avprev); if (it) itemPreview(cv, it); });
  $$('#view-avatar [data-avitem]').forEach(b => b.addEventListener('click', () => {
    const it = CATALOG.find(i => i.id === b.dataset.avitem);
    if (!it) return;
    if ((avatar.equipped || {})[it.slot] === it.id) delete avatar.equipped[it.slot];
    else { avatar.equipped[it.slot] = it.id; pushRecent(u, it.id); }
    saveDb();
    if (activeStage) activeStage.setEquipped(equippedList(u));
    rerender();
  }));
  if (avTab === 'cuerpo') {
    const applyColor = (rgbArr) => {
      const n = (rgbArr[0] << 16) | (rgbArr[1] << 8) | rgbArr[2];
      avatar.colors[avPart] = n;
      saveDb();
      if (activeStage && activeStage.rig) activeStage.rig.setColors(avatar.colors);
      const d = document.querySelector('#view-avatar .body-part.sel');
      if (d) d.style.background = hex(n);
    };
    const paintPicker = () => {
      const cur = hexToRgbStr(hex(avatar.colors[avPart]));
      const hsv = rgbToHsv(cur[0], cur[1], cur[2]);
      avPicker = hsv;
      const box = $('#svBox'); if (!box) return;
      box.style.background = 'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), hsl(' + hsv.h + ', 100%, 50%)';
      const dot = $('#svDot');
      dot.style.left = (hsv.s * 100) + '%';
      dot.style.top = ((1 - hsv.v) * 100) + '%';
      $('#hueRange').value = Math.round(hsv.h);
      $('#satNum').value = Math.round(hsv.s * 100);
      $('#briNum').value = Math.round(hsv.v * 100);
      $('#hexIn').value = hex(avatar.colors[avPart]);
    };
    $$('#view-avatar [data-part]').forEach(b => b.addEventListener('click', () => { avPart = b.dataset.part; renderAvatar(); }));
    $$('#view-avatar [data-avcolor]').forEach(b => b.addEventListener('click', () => { avatar.colors[avPart] = Number(b.dataset.avcolor); saveDb(); if (activeStage && activeStage.rig) activeStage.rig.setColors(avatar.colors); renderAvatar(); }));
    $$('#view-avatar [data-skin]').forEach(b => b.addEventListener('click', () => { const rgb = hexToRgbStr(b.dataset.skin); applyColor(rgb); renderAvatar(); }));
    const box = $('#svBox');
    if (box) {
      const fromEvent = (ev) => {
        const r = box.getBoundingClientRect();
        const s = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
        const v = 1 - Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
        avPicker.s = s; avPicker.v = v;
        applyColor(hsvToRgbVal(avPicker.h, s, v));
        paintPickerSoft();
      };
      const paintPickerSoft = () => {
        const dot = $('#svDot'); if (!dot) return;
        dot.style.left = (avPicker.s * 100) + '%';
        dot.style.top = ((1 - avPicker.v) * 100) + '%';
        $('#satNum').value = Math.round(avPicker.s * 100);
        $('#briNum').value = Math.round(avPicker.v * 100);
        $('#hexIn').value = hex(avatar.colors[avPart]);
      };
      box.addEventListener('pointerdown', (ev) => { box.setPointerCapture(ev.pointerId); fromEvent(ev); const mv = (e2) => fromEvent(e2); box.addEventListener('pointermove', mv); box.addEventListener('pointerup', () => box.removeEventListener('pointermove', mv), { once: true }); });
      $('#hueRange').addEventListener('input', (ev) => { avPicker.h = Number(ev.target.value); applyColor(hsvToRgbVal(avPicker.h, avPicker.s, avPicker.v)); paintPicker(); });
      $('#satNum').addEventListener('change', (ev) => { avPicker.s = Math.min(1, Math.max(0, Number(ev.target.value) / 100)); applyColor(hsvToRgbVal(avPicker.h, avPicker.s, avPicker.v)); paintPicker(); });
      $('#briNum').addEventListener('change', (ev) => { avPicker.v = Math.min(1, Math.max(0, Number(ev.target.value) / 100)); applyColor(hsvToRgbVal(avPicker.h, avPicker.s, avPicker.v)); paintPicker(); });
      $('#hexIn').addEventListener('change', (ev) => { const rgb = hexToRgbStr(ev.target.value.trim()); if (rgb) { applyColor(rgb); renderAvatar(); } });
    }
    const ft = $('#faceToggle');
    if (ft) ft.addEventListener('click', () => { avatar.face = !avatar.face; saveDb(); renderAvatar(); });
    paintPicker();
  }
  if (avTab === 'paquetes') {
    $$('#view-avatar [data-packchip]').forEach(b => b.addEventListener('click', () => { avPart = b.dataset.packchip; renderAvatar(); }));
    $$('#view-avatar [data-pack]').forEach(b => b.addEventListener('click', () => {
      const p = BUNDLES.find(x => x.id === b.dataset.pack);
      if (!p) return;
      Object.assign(avatar.colors, p.parts);
      saveDb();
      if (activeStage && activeStage.rig) activeStage.rig.setColors(avatar.colors);
      renderAvatar();
    }));
  }
  if (avTab === 'conjuntos') {
    const on2 = $('#outfitNew');
    if (on2) on2.addEventListener('click', () => {
      const name = (prompt(t('av3.newOutfitName'), t('av3.outfits') + ' ' + ((u.outfits || []).length + 1)) || '').trim();
      if (!name) return;
      u.outfits = [...(u.outfits || []), { name: name.slice(0, 30), avatar: JSON.parse(JSON.stringify(avatar)) }];
      saveDb();
      renderAvatar();
    });
    $$('#view-avatar [data-outfit]').forEach(b => b.addEventListener('click', () => {
      const o = (u.outfits || [])[Number(b.dataset.outfit)];
      if (!o) return;
      u.avatar = JSON.parse(JSON.stringify(o.avatar));
      saveDb();
      renderAvatar();
    }));
    $$('#view-avatar [data-outfitdel]').forEach(b => b.addEventListener('click', () => { u.outfits.splice(Number(b.dataset.outfitdel), 1); saveDb(); renderAvatar(); }));
  }
}

// ---------------- Amigos ----------------
function relation(u, other) {
  if (!u || !other) return 'none';
  if ((u.friends || []).includes(other.id)) return 'friends';
  if ((u.requestsOut || []).includes(other.id)) return 'out';
  if ((u.requestsIn || []).includes(other.id)) return 'in';
  return 'none';
}
function personRow(other, actionsHtml) {
  return '<div class="person-row"><img class="pavatar" alt="" style="background:' + hex(other.avatar.colors.torso) + '" src="' + userHeadImg(other) + '">' +
    '<div class="grow"><b>' + esc(other.display) + '</b><span>@' + esc(other.username) + '</span></div>' + (actionsHtml || '') + '</div>';
}
// ---------------- Amigos (oleada 3) ----------------
let frTab = 'friends', frQuery = '';
function renderFriends() {
  show('friends');
  paintReqBadge();
  const u = me();
  if (!u) {
    $('#view-friends').innerHTML = '<div class="empty-note">' + t('fr.login') + '<br><br><button class="btn primary" id="frLogin" type="button">' + t('c.enter') + '</button></div>';
    $('#frLogin').addEventListener('click', () => openAuth('register'));
    return;
  }
  const others = DB.users.filter(x => x.id !== u.id);
  const friends = others.filter(o => relation(u, o) === 'friends');
  const incoming = others.filter(o => relation(u, o) === 'in');
  const outgoing = others.filter(o => relation(u, o) === 'out');
  const discover = others.filter(o => relation(u, o) === 'none' || relation(u, o) === 'out');
  const q = frQuery.toLowerCase();
  const shownFriends = friends.filter(o => !q || o.display.toLowerCase().includes(q) || o.username.toLowerCase().includes(q));
  let main = '';
  if (frTab === 'friends') {
    main = '<div class="dock-search"><input id="frSearch" type="text" placeholder="' + t('fr3.searchPh') + '" value="' + esc(frQuery) + '" autocomplete="off"></div>' +
      (friends.length === 0
        ? '<div class="empty-note big"><b>' + t('fr3.emptyTitle') + '</b><br><span>' + t('fr3.emptySub') + '</span><br><br><button class="btn primary" id="frAddBtn2" type="button">+ ' + t('fr3.addBtn') + '</button></div>'
        : shownFriends.length
          ? shownFriends.map(o => personRow(o, '<button class="btn small" data-msg="' + o.id + '" type="button">' + t('fr3.message') + '</button><button class="btn small" data-goprofile="' + o.username + '" type="button">' + t('fr.profile') + '</button><button class="btn small danger" data-unfriend="' + o.id + '" type="button">' + t('fr.remove') + '</button>')).join('')
          : '<div class="empty-note">' + t('fr3.noMatch') + '</div>') +
      '<div class="panel-card" style="margin-top:16px"><h3>' + t('fr.people') + '</h3>' + (discover.length ? discover.map(o => personRow(o, relation(u, o) === 'out' ? '<span class="form-note">' + t('fr.sent') + '</span>' : '<button class="btn small primary" data-add="' + o.id + '" type="button">' + t('fr.add') + '</button>')).join('') : '<p class="form-note">' + t('fr.noPeople') + '</p>') + '</div>';
  } else if (frTab === 'followers' || frTab === 'following') {
    const list = frTab === 'followers' ? others.filter(o => (o.following || []).includes(u.id)) : others.filter(o => (u.following || []).includes(o.id));
    main = list.length ? list.map(o => personRow(o, frTab === 'following'
      ? '<button class="btn small" data-goprofile="' + o.username + '" type="button">' + t('fr.profile') + '</button><button class="btn small danger" data-unfollow38="' + o.id + '" type="button">' + t('prof.unfollow') + '</button>'
      : ((u.following || []).includes(o.id) ? '<span class="form-note">' + t('prof.following') + '</span>' : '<button class="btn small primary" data-follow38="' + o.id + '" type="button">' + t('prof.follow') + '</button>'))).join('')
      : '<div class="empty-note">' + t(frTab === 'followers' ? 'fr3.noFollowers' : 'fr3.noFollowing') + '</div>';
  } else {
    main = '<div class="panel-card"><h3>' + t('fr.received') + '</h3>' + (incoming.length ? incoming.map(o => personRow(o, '<button class="btn small primary" data-accept="' + o.id + '" type="button">' + t('fr.accept') + '</button><button class="btn small danger" data-reject="' + o.id + '" type="button">' + t('fr.reject') + '</button>')).join('') : '<p class="form-note">' + t('fr.noRequests') + '</p>') + '</div>' +
      '<div class="panel-card"><h3>' + t('fr3.sentList') + '</h3>' + (outgoing.length ? outgoing.map(o => personRow(o, '<span class="form-note">' + t('fr.sent') + '</span>')).join('') : '<p class="form-note">' + t('fr.noRequests') + '</p>') + '</div>';
  }
  $('#view-friends').innerHTML =
    '<div class="sec-head"><h2>Friends</h2><span>' + t('fr.count', { n: friends.length }) + '</span><span class="spacer"></span>' +
    '<button class="btn primary" id="frAddBtn" type="button">+ ' + t('fr3.addBtn') + '</button></div>' +
    '<div class="vtabs"><button class="vtab' + (frTab === 'friends' ? ' active' : '') + '" data-frtab="friends" type="button">' + t('fr3.friendsTab') + ' (' + friends.length + ')</button>' +
    '<button class="vtab' + (frTab === 'requests' ? ' active' : '') + '" data-frtab="requests" type="button">' + t('fr3.requestsTab') + ' (' + incoming.length + ')</button>' +
    '<button class="vtab' + (frTab === 'followers' ? ' active' : '') + '" data-frtab="followers" type="button">' + t('prof.followers') + ' (' + others.filter(o => (o.following || []).includes(u.id)).length + ')</button>' +
    '<button class="vtab' + (frTab === 'following' ? ' active' : '') + '" data-frtab="following" type="button">' + t('prof.following') + ' (' + (u.following || []).length + ')</button></div>' +
    main;
  $$('#view-friends [data-frtab]').forEach(b => b.addEventListener('click', () => { frTab = b.dataset.frtab; renderFriends(); }));
  const open = () => openAddFriend();
  const ab = $('#frAddBtn'); if (ab) ab.addEventListener('click', open);
  const ab2 = $('#frAddBtn2'); if (ab2) ab2.addEventListener('click', open);
  const fs = $('#frSearch');
  if (fs) fs.addEventListener('input', () => { frQuery = fs.value; renderFriends(); const n = $('#frSearch'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } });
  const wire = (sel, fn) => $$('#view-friends [' + sel + ']').forEach(b => b.addEventListener('click', () => fn(b)));
  wire('data-add', b => {
    const o = DB.users.find(x => x.id === b.dataset.add); if (!o) return;
    if (isBlockedEither(u, o)) { toast(t('af.errBlocked'), true); return; }
    u.requestsOut = [...(u.requestsOut || []), o.id];
    o.requestsIn = [...(o.requestsIn || []), u.id];
    saveDb(); paintReqBadge(); toast(t('toast.requestSent', { name: o.display })); renderFriends();
  });
  wire('data-accept', b => {
    const o = DB.users.find(x => x.id === b.dataset.accept); if (!o) return;
    u.requestsIn = (u.requestsIn || []).filter(id => id !== o.id);
    o.requestsOut = (o.requestsOut || []).filter(id => id !== u.id);
    u.friends = [...(u.friends || []), o.id];
    o.friends = [...(o.friends || []), u.id];
    saveDb(); paintReqBadge(); toast(t('toast.nowFriends')); renderFriends();
  });
  wire('data-reject', b => {
    const o = DB.users.find(x => x.id === b.dataset.reject); if (!o) return;
    u.requestsIn = (u.requestsIn || []).filter(id => id !== o.id);
    o.requestsOut = (o.requestsOut || []).filter(id => id !== u.id);
    saveDb(); paintReqBadge(); renderFriends();
  });
  wire('data-unfriend', b => {
    const o = DB.users.find(x => x.id === b.dataset.unfriend); if (!o) return;
    u.friends = (u.friends || []).filter(id => id !== o.id);
    o.friends = (o.friends || []).filter(id => id !== u.id);
    saveDb(); renderFriends();
  });
  wire('data-follow38', b => {
    const o = DB.users.find(x => x.id === b.dataset.follow38); if (!o) return;
    u.following = u.following || [];
    if (!u.following.includes(o.id)) u.following.push(o.id);
    saveDb(); renderFriends();
  });
  wire('data-unfollow38', b => {
    u.following = (u.following || []).filter(id => id !== b.dataset.unfollow38);
    saveDb(); renderFriends();
  });
  wire('data-msg', b => openConversationWith(b.dataset.msg));
  wire('data-goprofile', b => { location.hash = '#/profile/' + b.dataset.goprofile; });
}

// ---------------- Grupos: descubrir (pieza 9) ----------------
const GROUP_HUES = [0x3d1a5c, 0x5b2a86, 0x232329, 0x2b5a86, 0x862a2a, 0x2a8657, 0x8a5a2b, 0x39424f];
function groupHue(g) {
  if (g.hue) return g.hue;
  let h = 0;
  for (const ch of String(g.id || g.name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GROUP_HUES[h % GROUP_HUES.length];
}
function groupCardHtml(g, u) {
  const mine = !!(u && g.members.includes(u.id));
  const banned = !!(u && (g.banned || []).includes(u.id));
  const owner = DB.users.find(x => x.id === g.ownerId);
  return '<div class="group-card" data-gopen="' + g.id + '">' +
    '<div class="group-icon" style="background:' + hex(groupHue(g)) + '">' + esc((g.name || 'G')[0].toUpperCase()) + '</div>' +
    '<div class="grow"><h3>' + esc(g.name) + '</h3><p class="gdesc">' + esc(g.desc || '') + '</p>' +
    '<div class="gmeta"><span>' + t('grp3.membersN', { n: g.members.length }) + '</span><span>' + t('c.by') + ' ' + esc(owner ? owner.display : 'VORTX') + '</span></div></div>' +
    (u ? '<button class="btn small' + (mine ? '' : ' primary') + '" data-gjoin="' + g.id + '" type="button">' + (mine ? t('grp.leave') : banned ? t('grp.bannedYou') : t('grp.join')) + '</button>' : '') +
    '</div>';
}
function wireGroupCards(root, rerender) {
  $$('[data-gopen]', root).forEach(c => c.addEventListener('click', (e) => {
    if (e.target.closest('[data-gjoin]')) return;
    location.hash = '#/grupo/' + c.dataset.gopen;
  }));
  $$('[data-gjoin]', root).forEach(b => b.addEventListener('click', () => { toggleGroupMembership(b.dataset.gjoin); rerender(); }));
}
function toggleGroupMembership(gid) {
  const u = me();
  const g = DB.groups.find(x => x.id === gid);
  if (!g || !u) return;
  if (g.members.includes(u.id)) {
    if (g.ownerId === u.id) { toast(t('toast.ownerCantLeave'), true); return; }
    g.members = g.members.filter(id => id !== u.id);
    g.admins = (g.admins || []).filter(id => id !== u.id);
  } else {
    if ((g.banned || []).includes(u.id)) { toast(t('toast.bannedFrom'), true); return; }
    g.members.push(u.id);
  }
  saveDb();
}
let grpQuery = '', grpSort = 'trending';
function renderGroups() {
  show('groups');
  const u = me();
  const mine = u ? DB.groups.filter(g => g.members.includes(u.id)) : [];
  const q = grpQuery.toLowerCase();
  let all = DB.groups.filter(g => !q || g.name.toLowerCase().includes(q) || (g.desc || '').toLowerCase().includes(q));
  all = [...all].sort((a, b) => grpSort === 'newest'
    ? String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    : (b.members.length - a.members.length) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  $('#view-groups').innerHTML =
    '<div class="groups-layout"><div class="groups-side">' +
    '<div class="panel-card"><h3>' + t('grp3.yourGroups') + '</h3>' +
    (u ? (mine.length ? mine.map(g => '<button class="conv-row" data-gopen="' + g.id + '" type="button"><span class="group-icon small" style="background:' + hex(groupHue(g)) + '">' + esc((g.name || 'G')[0].toUpperCase()) + '</span><span class="grow"><b>' + esc(g.name) + '</b><span>' + t('grp3.membersN', { n: g.members.length }) + '</span></span></button>').join('')
      : '<p class="form-note">' + t('grp3.noYours') + '</p>')
      : '<p class="form-note">' + t('grp.loginCreate') + '</p>') +
    '</div>' +
    '<div class="panel-card"><h3>' + t('grp.create') + '</h3>' + (u ?
      '<form id="groupForm" class="form-grid"><label>' + t('grp.name') + ' <input id="gName" type="text" maxlength="30" required></label><label>' + t('grp.desc') + ' <textarea id="gDesc" rows="3" maxlength="140"></textarea></label><button class="btn primary" type="submit">' + t('grp.createBtn') + '</button></form>' :
      '<button class="btn primary" id="grLogin" type="button">' + t('c.enter') + '</button>') +
    '</div></div>' +
    '<div class="groups-main"><div class="sec-head" style="margin-top:0"><h2>' + t('grp3.discover') + ' (' + all.length + ')</h2><span>' + t('grp.note') + '</span></div>' +
    '<div class="dock-search"><input id="grpSearch" type="text" placeholder="' + t('grp3.searchPh') + '" value="' + esc(grpQuery) + '" autocomplete="off">' +
    '<select id="grpSortSel" aria-label="' + t('mkt.sort') + '"><option value="trending"' + (grpSort === 'trending' ? ' selected' : '') + '>' + t('grp3.sortMembers') + '</option><option value="newest"' + (grpSort === 'newest' ? ' selected' : '') + '>' + t('grp3.newest') + '</option></select></div>' +
    (all.length ? '<div class="group-grid">' + all.map(g => groupCardHtml(g, u)).join('') + '</div>' : '<div class="empty-note">' + t('grp.none') + '</div>') +
    '</div></div>';
  wireGroupCards($('#view-groups'), renderGroups);
  const gs = $('#grpSearch');
  if (gs) gs.addEventListener('input', () => { grpQuery = gs.value; renderGroups(); const n = $('#grpSearch'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } });
  const ssel = $('#grpSortSel'); if (ssel) ssel.addEventListener('change', () => { grpSort = ssel.value; renderGroups(); });
  const gf = $('#groupForm');
  if (gf) gf.addEventListener('submit', (e) => {
    e.preventDefault();
    DB.groups.unshift({ id: uid('grp'), name: $('#gName').value.trim(), desc: $('#gDesc').value.trim(), ownerId: u.id, members: [u.id], admins: [], wall: [], banned: [], createdAt: new Date().toISOString(), hue: GROUP_HUES[Math.floor(Math.random() * GROUP_HUES.length)] });
    saveDb(); toast(t('toast.groupCreated')); renderGroups();
  });
  const gl = $('#grLogin');
  if (gl) gl.addEventListener('click', () => openAuth('register'));
}
// ---------------- Pagina de grupo (pieza 10) ----------------
let grpPageTab = 'home', grpPageId = null, memQuery = '', memRole = 'all', wallQuote = null;
function normalizeWall(g) {
  (g.wall || []).forEach((w, i) => { if (!w.id) w.id = 'wp_' + g.id + '_' + i; if (!Array.isArray(w.likes)) w.likes = []; });
}
function wallPostHtml(g, w, u, opts) {
  opts = opts || {};
  const author = DB.users.find(x => x.username === w.u);
  const mine = !!(u && author && author.id === u.id);
  const canModHere = !!(u && (g.ownerId === u.id || (g.admins || []).includes(u.id)));
  const liked = !!(u && (w.likes || []).includes(u.id));
  return '<article class="wall-card" data-post="' + w.id + '">' +
    '<div class="wall-head"><img class="pavatar" alt="" style="background:' + hex(author ? author.avatar.colors.torso : 0x3d1a5c) + '" src="' + (author ? userHeadImg(author) : '') + '">' +
    '<div class="grow"><b>' + esc(w.d) + '</b><span>' + timeAgo(w.at) + '</span></div>' +
    (u ? '<button class="btn small dots-btn" data-postdots="' + w.id + '" type="button">···</button>' : '') + '</div>' +
    (w.quote ? '<blockquote class="wall-quote"><b>' + esc(w.quote.d) + '</b> ' + esc(w.quote.text) + '</blockquote>' : '') +
    '<p class="wall-text">' + esc(w.text) + '</p>' +
    '<div class="wall-actions">' +
    '<button class="btn small vote-btn' + (liked ? ' on' : '') + '" data-postlike="' + w.id + '" type="button"><svg viewBox="0 0 24 24" width="14" height="14" fill="' + (liked ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.7C6.4 17 3 13.6 3 9.9 3 7.2 5 5 7.7 5c1.7 0 3.3.9 4.3 2.4C13 5.9 14.6 5 16.3 5 19 5 21 7.2 21 9.9c0 3.7-3.4 7.1-9 10.8z"/></svg> ' + (w.likes || []).length + '</button>' +
    (opts.announce && u && g.members.includes(u.id) ? '<button class="btn small" data-postreply="' + w.id + '" type="button">' + t('grp3.reply') + '</button>' : '') +
    '</div></article>';
}
function wireWall(root, g, rerender) {
  const u = me();
  $$('[data-postlike]', root).forEach(b => b.addEventListener('click', () => {
    if (!u) { openAuth('login'); return; }
    const w = (g.wall || []).find(x => x.id === b.dataset.postlike);
    if (!w) return;
    w.likes = w.likes || [];
    const i = w.likes.indexOf(u.id);
    if (i >= 0) w.likes.splice(i, 1); else w.likes.push(u.id);
    saveDb(); rerender();
  }));
  $$('[data-postreply]', root).forEach(b => b.addEventListener('click', () => {
    const w = (g.wall || []).find(x => x.id === b.dataset.postreply);
    if (!w) return;
    wallQuote = { d: w.d, text: w.text.slice(0, 140) };
    grpPageTab = 'wall';
    rerender();
    setTimeout(() => { const i = $('#wallInput'); if (i) i.focus(); }, 30);
  }));
  $$('[data-postdots]', root).forEach(b => b.addEventListener('click', () => {
    const w = (g.wall || []).find(x => x.id === b.dataset.postdots);
    if (!w || !u) return;
    const author = DB.users.find(x => x.username === w.u);
    const mine = author && author.id === u.id;
    const canModHere = g.ownerId === u.id || (g.admins || []).includes(u.id);
    const items = [];
    if (mine || canModHere) items.push({ label: t('grp3.deletePost'), danger: true, fn: () => { g.wall = g.wall.filter(x => x.id !== w.id); saveDb(); rerender(); } });
    if (!mine) items.push({ label: t('grp3.repPost'), fn: () => openReport({ type: 'post', id: w.id, label: (g.name + ': ' + w.text.slice(0, 40)), title: t('grp3.repPost') }) });
    if (items.length) openPopMenu(b, items);
  }));
}
function renderGroupPage(id) {
  const g = DB.groups.find(x => x.id === id);
  if (!g) { location.hash = '#/groups'; return; }
  if (grpPageId !== id) { grpPageId = id; grpPageTab = 'home'; wallQuote = null; memQuery = ''; memRole = 'all'; }
  show('grupo');
  normalizeWall(g);
  const u = me();
  const owner = DB.users.find(x => x.id === g.ownerId);
  const isOwner = !!(u && g.ownerId === u.id);
  const isAdmin = !!(u && (g.admins || []).includes(u.id));
  const isMember = !!(u && g.members.includes(u.id));
  const isBanned = !!(u && (g.banned || []).includes(u.id));
  const roleOf = (m) => g.ownerId === m.id ? t('grp.roleOwner') : (g.admins || []).includes(m.id) ? t('grp.roleAdmin') : t('grp.roleMember');
  let body = '';
  if (grpPageTab === 'home') {
    const anns = [...(g.wall || [])].filter(w => w.announce).reverse();
    body = '<div class="panel-card"><h3>' + t('grp3.announcements') + '</h3>' +
      (anns.length ? anns.map(w => wallPostHtml(g, w, u, { announce: true })).join('') : '<p class="form-note">' + t('grp3.noAnnouncements') + '</p>') + '</div>';
  } else if (grpPageTab === 'members') {
    const q = memQuery.toLowerCase();
    let members = g.members.map(mid => DB.users.find(x => x.id === mid)).filter(Boolean);
    if (memRole === 'owner') members = members.filter(m => g.ownerId === m.id);
    if (memRole === 'admins') members = members.filter(m => (g.admins || []).includes(m.id));
    if (memRole === 'members') members = members.filter(m => g.ownerId !== m.id && !(g.admins || []).includes(m.id));
    members = members.filter(m => !q || m.display.toLowerCase().includes(q) || m.username.toLowerCase().includes(q));
    body = '<div class="dock-search"><input id="memSearch" type="text" placeholder="' + t('grp3.searchMembersPh') + '" value="' + esc(memQuery) + '" autocomplete="off">' +
      [['all', t('grp3.allRoles')], ['owner', t('grp.roleOwner')], ['admins', t('grp.roleAdmin')], ['members', t('grp.roleMember')]].map(([k, l]) => '<button class="btn small' + (memRole === k ? ' primary' : '') + '" data-memrole="' + k + '" type="button">' + l + '</button>').join('') + '</div>' +
      (members.length ? '<div class="member-grid">' + members.map(m => {
        const canMod = (isOwner && m.id !== g.ownerId) || (isAdmin && !isOwner && m.id !== g.ownerId && !(g.admins || []).includes(m.id));
        return '<div class="member-card"><img alt="" src="' + bodyShotImg(m) + '"><div class="grow"><b>' + esc(m.display) + '</b><span>@' + esc(m.username) + '</span><span class="role-chip">' + roleOf(m) + '</span></div>' +
          '<div class="member-actions"><a class="btn small" href="#/profile/' + esc(m.username) + '">' + t('fr.profile') + '</a>' +
          (u && m.id !== u.id && canMod ? '<button class="btn small" data-gkick="' + m.id + '" type="button">' + t('grp.kick') + '</button><button class="btn small danger" data-gban="' + m.id + '" type="button">' + t('grp.ban') + '</button>' : '') +
          (isOwner && m.id !== g.ownerId ? '<button class="btn small" data-gadmin="' + m.id + '" type="button">' + ((g.admins || []).includes(m.id) ? t('grp.removeAdmin') : t('grp.makeAdmin')) + '</button><button class="btn small" data-gown="' + m.id + '" type="button">' + t('grp.makeOwner') + '</button>' : '') +
          '</div></div>';
      }).join('') + '</div>' : '<div class="empty-note">' + t('grp3.noMembersMatch') + '</div>') +
      ((g.banned || []).length && (isOwner || isAdmin) ? '<p class="form-note" style="margin-top:10px">' + t('grp.bannedList', { list: (g.banned || []).map(bid => esc((DB.users.find(x => x.id === bid) || {}).display || '?')).join(', ') }) + '</p>' : '') +
      (isOwner ? '<div style="margin-top:12px"><button class="btn danger" id="gDelete" type="button">' + t('grp.delete') + '</button></div>' : '');
  } else {
    const posts = [...(g.wall || [])].reverse();
    body = (isMember && !isBanned
      ? (wallQuote ? '<div class="quote-chip">' + t('grp3.replyingTo', { name: esc(wallQuote.d) }) + ' <button class="btn small" id="wallQuoteX" type="button">' + t('grp3.cancelReply') + '</button></div>' : '') +
        '<form id="wallForm" class="code-form" style="max-width:none;margin-bottom:14px"><input id="wallInput" type="text" maxlength="300" placeholder="' + t('grp.wallPh') + '" autocomplete="off">' +
        (isOwner || isAdmin ? '<label class="announce-check"><input type="checkbox" id="wallAnnounce"> ' + t('grp3.announce') + '</label>' : '') +
        '<button class="btn primary" type="submit">' + t('grp.publish') + '</button></form>'
      : '<div class="empty-note" style="margin-bottom:14px">' + (isBanned ? t('grp.bannedWall') : t('grp3.joinToPost')) + '</div>') +
      (posts.length ? posts.map(w => wallPostHtml(g, w, u, {})).join('') : '<div class="empty-note">' + t('grp.wallEmpty') + '</div>');
  }
  $('#view-grupo').innerHTML =
    '<div class="group-head"><div class="group-icon big" style="background:' + hex(groupHue(g)) + '">' + esc((g.name || 'G')[0].toUpperCase()) + '</div>' +
    '<div class="grow"><h1>' + esc(g.name) + '</h1><div class="by">' + t('grp3.byOwner', { name: esc(owner ? owner.display : 'VORTX') }) + '</div></div>' +
    (u ? '<button class="btn' + (isMember ? '' : ' primary') + '" id="gJoinBtn" type="button">' + (isMember ? t('grp3.leave') : t('grp3.joinGroup')) + '</button>' : '') +
    '<button class="btn dots-btn" id="gDots" type="button">···</button></div>' +
    '<p class="desc" style="color:var(--ink2);line-height:1.6;max-width:760px">' + esc(g.desc || '') + '</p>' +
    '<div class="gmeta-row"><span>' + t('grp3.membersN', { n: g.members.length }) + '</span>' +
    '<span>' + t('grp3.byOwner', { name: esc(owner ? owner.display : 'VORTX') }) + '</span>' +
    (g.createdAt ? '<span>' + t('grp3.created', { d: new Date(g.createdAt).toLocaleDateString(currentLang()) }) + '</span>' : '') +
    '<span>' + t('grp3.public') + '</span></div>' +
    '<div class="vtabs"><button class="vtab' + (grpPageTab === 'home' ? ' active' : '') + '" data-gtab="home" type="button">' + t('grp3.tabHome') + '</button>' +
    '<button class="vtab' + (grpPageTab === 'members' ? ' active' : '') + '" data-gtab="members" type="button">' + t('grp3.tabMembers') + '</button>' +
    '<button class="vtab' + (grpPageTab === 'wall' ? ' active' : '') + '" data-gtab="wall" type="button">' + t('grp3.tabWall') + '</button></div>' +
    body;
  $$('#view-grupo [data-gtab]').forEach(b => b.addEventListener('click', () => { grpPageTab = b.dataset.gtab; renderGroupPage(id); }));
  const jb = $('#gJoinBtn');
  if (jb) jb.addEventListener('click', () => { toggleGroupMembership(g.id); renderGroupPage(id); });
  const gd = $('#gDots');
  if (gd) gd.addEventListener('click', () => openPopMenu(gd, [
    { label: t('exp3.copyLink'), fn: () => { copyText(location.origin + location.pathname + '#/grupo/' + g.id); toast(t('exp3.linkCopied')); } },
    { label: t('grp3.repGroup'), fn: () => openReport({ type: 'group', id: g.id, label: g.name, title: t('grp3.repGroup') }) }
  ]));
  wireWall($('#view-grupo'), g, () => renderGroupPage(id));
  const ms = $('#memSearch');
  if (ms) ms.addEventListener('input', () => { memQuery = ms.value; renderGroupPage(id); const n = $('#memSearch'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } });
  $$('#view-grupo [data-memrole]').forEach(b => b.addEventListener('click', () => { memRole = b.dataset.memrole; renderGroupPage(id); }));
  $$('#view-grupo [data-gkick]').forEach(b => b.addEventListener('click', () => { g.members = g.members.filter(x => x !== b.dataset.gkick); g.admins = (g.admins || []).filter(x => x !== b.dataset.gkick); saveDb(); toast(t('toast.kicked')); renderGroupPage(id); }));
  $$('#view-grupo [data-gban]').forEach(b => b.addEventListener('click', () => { const mid = b.dataset.gban; g.members = g.members.filter(x => x !== mid); g.admins = (g.admins || []).filter(x => x !== mid); g.banned = [...(g.banned || []), mid]; saveDb(); toast(t('toast.bannedToast')); renderGroupPage(id); }));
  $$('#view-grupo [data-gadmin]').forEach(b => b.addEventListener('click', () => { const mid = b.dataset.gadmin; g.admins = g.admins || []; g.admins = g.admins.includes(mid) ? g.admins.filter(x => x !== mid) : [...g.admins, mid]; saveDb(); renderGroupPage(id); }));
  $$('#view-grupo [data-gown]').forEach(b => b.addEventListener('click', () => { if (!confirm(t('confirm.transferOwner'))) return; g.ownerId = b.dataset.gown; saveDb(); toast(t('toast.ownerTransferred')); renderGroupPage(id); }));
  const gdel = $('#gDelete');
  if (gdel) gdel.addEventListener('click', () => { if (!confirm(t('confirm.deleteGroup'))) return; DB.groups = DB.groups.filter(x => x.id !== g.id); saveDb(); toast(t('toast.groupDeleted')); location.hash = '#/groups'; });
  const wf = $('#wallForm');
  if (wf) wf.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = $('#wallInput').value.trim();
    if (!raw) return;
    const r = filterText(raw.slice(0, 300));
    const post = { id: uid('wp'), u: u.username, d: u.display, text: r.text, at: new Date().toISOString(), likes: [], announce: !!(($('#wallAnnounce') || {}).checked) };
    if (wallQuote) post.quote = wallQuote;
    g.wall = [...(g.wall || []), post].slice(-100);
    wallQuote = null;
    saveDb();
    if (r.filtered) toast(t('toast.wallFiltered'));
    renderGroupPage(id);
  });
  const wq = $('#wallQuoteX');
  if (wq) wq.addEventListener('click', () => { wallQuote = null; renderGroupPage(id); });
}

// ---------------- Perfil ----------------
// ---------------- Perfil (piezas 11 y 12) ----------------
let profTab = 'about', profUser = null, profStageMode = 'body';
const PROFILE_COLORS = ['#3d1a5c', '#5b2a86', '#17171c', '#232329', '#2b5a86', '#862a2a', '#2a8657', '#8a5a2b', '#f5f5f5'];
function canSee(u, target, key) {
  if (!target || !target.privacy) return true;
  const v = target.privacy[key] || 'all';
  if (v === 'all') return true;
  if (!u) return false;
  if (u.id === target.id) return true;
  if (v === 'none') return false;
  if (v === 'friends') return (target.friends || []).includes(u.id);
  return true;
}
function renderProfile(username) {
  show('profile');
  const u = me();
  const target = username ? userByName(username) : u;
  if (!target) {
    $('#view-profile').innerHTML = '<div class="empty-note">' + (username ? t('prof.notExist') : t('prof.loginView')) + '</div>';
    return;
  }
  if (profUser !== target.id) { profUser = target.id; profTab = 'about'; profStageMode = 'body'; invState = { cat: 'Todos', q: '' }; }
  const own = !!(u && u.id === target.id);
  const creations = DB.exps.filter(e => e.creator === target.username || (target.username === 'vortx' && e.creator === 'VORTX'));
  const followers = DB.users.filter(x => (x.following || []).includes(target.id));
  const isFollowing = !!(u && (u.following || []).includes(target.id));
  const areFriends = !!(u && (u.friends || []).includes(target.id));
  const passList = [];
  for (const [expId, ids] of Object.entries(target.passes || {})) {
    const e2 = expById(expId);
    if (!e2) continue;
    for (const pid of ids) {
      const p2 = (e2.passes || []).find(x => x.id === pid);
      if (p2) passList.push({ pass: p2, exp: e2 });
    }
  }
  const banner = target.profileBanner || '#3d1a5c';
  const accent = target.profileAccent || '';
  const friendsVisible = canSee(u, target, 'friends');
  const onlineVisible = canSee(u, target, 'online');
  const statusHtml = own
    ? '<span class="status-line"><span class="dot on"></span>' + t('prof3.onlineNow') + '</span>'
    : (onlineVisible && target.lastSeen ? '<span class="status-line">' + t('prof3.lastSeen', { d: new Date(target.lastSeen).toLocaleString(currentLang()) }) + '</span>' : '');
  const friendCards = friendsVisible ? (target.friends || []).map(id => DB.users.find(x => x.id === id)).filter(Boolean) : [];
  const equippedChips = Object.entries(target.avatar.equipped || {}).map(([slot, iid]) => {
    const it = CATALOG.find(i => i.id === iid);
    return it ? '<span class="chip">' + esc(slotName(slot)) + ': ' + esc(it.name) + '</span>' : '';
  }).join('');
  let tabBody = '';
  if (profTab === 'about') {
    if (!canSee(u, target, 'profile')) {
      tabBody = '<div class="empty-note">' + t('prof3.privateSection') + '</div>';
    } else {
      tabBody = '<div class="panel-card profile-about-card"><div class="profile-about"><div class="stage-card" style="background:' + esc(target.profileBg || 'var(--panel)') + '">' +
        '<canvas id="profileCanvas" width="420" height="500"></canvas>' +
        '<div class="stage-tools"><button class="btn small' + (profStageMode === 'body' ? ' primary' : '') + '" data-pview="body" type="button">' + t('prof3.viewBody') + '</button>' +
        '<button class="btn small' + (profStageMode === 'head' ? ' primary' : '') + '" data-pview="head" type="button">' + t('prof3.viewHead') + '</button>' +
        '<span class="spacer"></span><span class="form-note">' + t('av.bg') + '</span><button class="btn small' + (stageBgPref() === 'negro' ? ' primary' : '') + '" data-stagebg="negro" type="button">' + t('av.bgBlack') + '</button><button class="btn small' + (stageBgPref() === 'blanco' ? ' primary' : '') + '" data-stagebg="blanco" type="button">' + t('av.bgWhite') + '</button></div></div>' +
        '<div class="about-side"><h3>' + t('prof3.showcase') + '</h3>' +
        (creations.length ? creations.map(e => '<div class="tx-row"><span>' + esc(e.name) + '</span><a class="btn small" href="#/exp/' + e.id + '">' + t('c.play') + '</a></div>').join('')
          : '<p class="form-note">' + t('prof3.noShowcase', { name: esc(target.display) }) + '</p>') +
        (passList.length ? '<h3 style="margin:16px 0 8px">' + t('exp.passes') + '</h3><div class="chip-row">' + passList.map(x => '<span class="chip">' + esc(x.pass.name) + ' · ' + esc(x.exp.name) + '</span>').join('') + '</div>' : '') +
        (equippedChips ? '<h3 style="margin:16px 0 8px">' + t('mkt.equipped') + '</h3><div class="chip-row">' + equippedChips + '</div>' : '') +
        '</div></div></div>' +
        (friendsVisible ? '<div class="sec-head"><h2>' + t('nav.friends') + ' <span class="count-badge">' + friendCards.length + '</span></h2></div>' +
          (friendCards.length ? '<div class="pf-friends">' + friendCards.map(f => '<div class="friend-vcard" data-friend="' + esc(f.username) + '"><img alt="" src="' + bodyShotImg(f) + '"><span>' + esc(f.display) + '</span></div>').join('') + '</div>'
            : '<div class="empty-note">' + t('fr3.emptyTitle') + '</div>') : '') +
        (own ? '<div class="sec-head"><h2>' + t('prof.a11y') + '</h2></div>' + a11yPanelHtml() : '') +
        (own ? '<div class="sec-head"><h2>' + t('prof.txHistory') + '</h2></div><div class="panel-card">' + ((target.tx || []).length ? (target.tx || []).slice(0, 12).map(tx => '<div class="tx-row"><span>' + esc(tx.label) + '</span><b>' + (tx.amount > 0 ? '+' : '') + tx.amount + ' VC</b></div>').join('') : '<p class="form-note">' + t('prof.noTx') + '</p>') + '</div>' : '');
    }
  } else if (profTab === 'creations') {
    tabBody = creations.length ? '<div class="exp-grid">' + creations.map(expCard).join('') + '</div>' : '<div class="empty-note">' + t('prof.noCreations') + '</div>';
  } else if (profTab === 'groups') {
    const tgroups = DB.groups.filter(g => g.members.includes(target.id));
    tabBody = tgroups.length ? '<div class="group-grid">' + tgroups.map(g => groupCardHtml(g, u)).join('') + '</div>' : '<div class="empty-note">' + t('grp3.noYours') + '</div>';
  } else if (profTab === 'inventory') {
    tabBody = canSee(u, target, 'inventory') ? inventoryHtml(target, own) : '<div class="empty-note">' + t('prof3.privateSection') + '</div>';
  } else if (profTab === 'wishlist') {
    if (!canSee(u, target, 'wishlist')) {
      tabBody = '<div class="empty-note">' + t('prof3.privateSection') + '</div>';
    } else {
      const items = (target.wishlist || []).map(id => CATALOG.find(i => i.id === id)).filter(Boolean);
      tabBody = items.length ? '<div class="item-grid dense">' + items.map(it => marketCard(it, u)).join('') + '</div>' : '<div class="empty-note">' + t('wish.empty') + '</div>';
    }
  }
  const bannerMedia = profileBannerMediaHtml(target);
  const gameVisits = creations.reduce((s, e) => s + (e.visits || 0), 0);
  const statBlock = (val, label) => '<div class="pf-stat"><b>' + val + '</b><span>' + esc(label) + '</span></div>';
  $('#view-profile').innerHTML =
    '<div class="profile-page"' + (accent ? ' style="--paccent:' + esc(accent) + '"' : '') + '>' +
    // El banner (pieza 41) solo ocupa sitio cuando hay foto o video
    // puesto; el color elegido se conserva como fondo de esa franja.
    (bannerMedia ? '<div class="profile-banner" style="background:' + esc(banner) + '">' + bannerMedia + '</div>' : '') +
    '<div class="profile-head2"><div class="pf-ava-wrap"><img class="pf-body" alt="" src="' + bodyShotImg(target) + '">' +
    (own ? '<span class="pf-dot" title="' + t('prof3.onlineNow') + '"></span>' : '') + '</div>' +
    '<div class="grow"><h1>' + esc(target.display) + '</h1><div class="uname">@' + esc(target.username) + '</div>' + statusHtml + '</div>' +
    '<div class="pf-actions">' +
    (own ? '<button class="btn primary" id="pfEdit" type="button">' + t('prof3.edit') + '</button><a class="btn" href="#/avatar">' + t('prof3.customizeAvatar') + '</a><a class="btn" href="#/ajustes/cuenta">' + t('chip.settings') + '</a>' : '') +
    (!own && u ? '<button class="btn primary" id="followBtn" type="button">' + (isFollowing ? t('prof.unfollow') : t('prof.follow')) + '</button>' : '') +
    '<button class="btn dots-btn" id="pfDots" type="button">···</button></div></div>' +
    (target.bio ? '<p class="bio">' + esc(target.bio) + '</p>' : (own ? '<button class="bio-add" id="pfBioAdd" type="button">' + t('prof3.addBio') + '</button>' : '')) +
    '<div class="pf-stats">' +
    statBlock(friendsVisible ? (target.friends || []).length : '—', t('nav.friends')) +
    statBlock(followers.length, t('prof.followers')) +
    statBlock((target.following || []).length, t('prof.following')) +
    statBlock(gameVisits, t('prof3.gameVisits')) +
    '</div>' +
    '<div class="pf-meta">' +
    '<span>' + t('prof3.joined', { d: new Date(target.createdAt).toLocaleDateString(currentLang()) }) + '</span>' +
    (own ? '<span>' + (target.coins || 0) + ' V-Coins</span>' : '') +
    '<span>' + ((target.pastNames || []).length ? t('prof3.pastNames') + ': ' + esc(target.pastNames.join(', ')) : t('prof3.noPastNames')) + '</span>' +
    '</div>' +
    '<div class="vtabs">' +
    [['about', t('prof3.tabAbout')], ['creations', t('prof3.tabCreations')], ['groups', t('prof3.tabGroups')], ['inventory', t('prof3.tabInventory')], ['wishlist', t('prof3.tabWishlist')]]
      .map(([k, l]) => '<button class="vtab' + (profTab === k ? ' active' : '') + '" data-ptab="' + k + '" type="button">' + l + '</button>').join('') +
    '</div>' + tabBody + '</div>';
  $$('#view-profile [data-ptab]').forEach(b => b.addEventListener('click', () => { profTab = b.dataset.ptab; renderProfile(username); }));
  const applyStageMode = () => {
    if (!activeStage) return;
    if (profStageMode === 'head') { activeStage.dist = 4.6; activeStage.camY = 4.05; activeStage.lookY = 3.8; }
    else { activeStage.dist = 10.5; activeStage.camY = 3.1; activeStage.lookY = 2.2; }
  };
  if (profTab === 'about' && canSee(u, target, 'profile')) {
    mountStage($('#profileCanvas'), target.avatar, equippedList(target), { dist: 10.5, auto: true });
    applyStageMode();
    $$('#view-profile [data-pview]').forEach(b => b.addEventListener('click', () => { profStageMode = b.dataset.pview; renderProfile(username); }));
    $$('#view-profile [data-stagebg]').forEach(b => b.addEventListener('click', () => { try { localStorage.setItem('vortx_stagebg', b.dataset.stagebg); } catch (e) {} renderProfile(username); }));
    wireA11y($('#view-profile'), () => renderProfile(username));
  }
  if (profTab === 'inventory' && canSee(u, target, 'inventory')) wireInventory($('#view-profile'), target, () => renderProfile(username));
  if (profTab === 'wishlist' && canSee(u, target, 'wishlist')) {
    $$('#view-profile [data-preview]').forEach(cv => { const it = CATALOG.find(i => i.id === cv.dataset.preview); if (it) itemPreview(cv, it); });
    $$('#view-profile [data-buy]').forEach(b => b.addEventListener('click', () => { buyItem(b.dataset.buy); renderProfile(username); }));
    $$('#view-profile [data-wish]').forEach(b => b.addEventListener('click', () => {
      const usr = me(); if (!usr) return;
      usr.wishlist = (usr.wishlist || []).filter(x => x !== b.dataset.wish);
      saveDb(); renderProfile(username);
    }));
    $$('#view-profile [data-equip]').forEach(b => b.addEventListener('click', () => { location.hash = '#/avatar'; }));
  }
  if (profTab === 'groups') wireGroupCards($('#view-profile'), () => renderProfile(username));
  wireExpCards($('#view-profile'));
  $$('#view-profile [data-friend]').forEach(c => c.addEventListener('click', () => { location.hash = '#/profile/' + c.dataset.friend; }));
  const pe = $('#pfEdit');
  if (pe) pe.addEventListener('click', () => openEditProfile());
  const ba = $('#pfBioAdd');
  if (ba) ba.addEventListener('click', () => openEditProfile());
  const fb = $('#followBtn');
  if (fb) fb.addEventListener('click', () => {
    u.following = u.following || [];
    const i = u.following.indexOf(target.id);
    if (i >= 0) u.following.splice(i, 1); else u.following.push(target.id);
    saveDb(); renderProfile(username);
  });
  const pd = $('#pfDots');
  if (pd) pd.addEventListener('click', () => {
    const items = [{ label: t('exp3.copyLink'), fn: () => { copyText(location.origin + location.pathname + '#/profile/' + target.username); toast(t('exp3.linkCopied')); } }];
    if (!own && u) {
      if (areFriends) items.push({ label: t('prof3.sendMessage'), fn: () => openConversationWith(target.id) });
      items.push({ label: t('prof3.report'), fn: () => openReport({ type: 'user', id: target.id, label: '@' + target.username, title: t('prof3.repTitle') }) });
      items.push({ label: t('prof3.block'), danger: true, fn: () => { blockUser(u, target); renderProfile(username); } });
    }
    openPopMenu(pd, items);
  });
}
function blockUser(u, target) {
  u.blocked = u.blocked || [];
  if (!u.blocked.includes(target.id)) u.blocked.push(target.id);
  u.friends = (u.friends || []).filter(id => id !== target.id);
  target.friends = (target.friends || []).filter(id => id !== u.id);
  u.requestsIn = (u.requestsIn || []).filter(id => id !== target.id);
  u.requestsOut = (u.requestsOut || []).filter(id => id !== target.id);
  target.requestsIn = (target.requestsIn || []).filter(id => id !== u.id);
  target.requestsOut = (target.requestsOut || []).filter(id => id !== u.id);
  saveDb();
  paintReqBadge();
  toast(t('priv.blockedOk'));
}
// Banner del perfil con foto o video subidos (pieza 41): el mismo
// render en todas las vistas que enseñen el banner.
function profileBannerMediaHtml(target) {
  const m = target && target.bannerMedia;
  if (!m || !m.src) return '';
  if (m.kind === 'video') return '<video class="profile-banner-media" src="' + m.src + '" muted autoplay loop playsinline></video>';
  return '<img class="profile-banner-media" alt="" src="' + m.src + '">';
}
// ---------------- Editor de perfil (pieza 12, gratis) ----------------
let edpSel = { banner: '', accent: '', bg: '' };
let edpMedia = null; // banner con foto/video en edicion (pieza 41)
function swatchRowHtml(id, colors, sel) {
  return colors.map(c => '<button class="bg-swatch' + (sel === c ? ' sel' : '') + '" data-edp="' + id + ':' + c + '" style="background:' + c + '" type="button" aria-label="color"></button>').join('');
}
function openEditProfile() {
  const u = me();
  if (!u) return;
  edpSel = { banner: u.profileBanner || '#3d1a5c', accent: u.profileAccent || '#5b2a86', bg: u.profileBg || '#17171c' };
  edpMedia = u.bannerMedia || null;
  $('#edpBio').value = u.bio || '';
  const merr = $('#edpMediaErr');
  if (merr) merr.textContent = '';
  const paintMedia = () => {
    const prev = $('#edpMediaPrev');
    if (!prev) return;
    prev.innerHTML = !edpMedia ? '' : edpMedia.kind === 'video'
      ? '<video src="' + edpMedia.src + '" muted autoplay loop playsinline></video>'
      : '<img alt="" src="' + edpMedia.src + '">';
  };
  paintMedia();
  const imgIn = $('#edpImgFile');
  if (imgIn) imgIn.onchange = () => {
    const f = imgIn.files && imgIn.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const im = new Image();
      im.onload = () => {
        // La foto se reduce a 1280 px de ancho como maximo (JPEG 0.85)
        // antes de guardarse en la DB local.
        const scale = Math.min(1, 1280 / (im.naturalWidth || 1280));
        const cv = document.createElement('canvas');
        cv.width = Math.round((im.naturalWidth || 1280) * scale);
        cv.height = Math.round((im.naturalHeight || 720) * scale);
        cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
        edpMedia = { kind: 'img', src: cv.toDataURL('image/jpeg', 0.85) };
        if (merr) merr.textContent = t('edp.mediaPhoto');
        paintMedia();
      };
      im.onerror = () => { if (merr) merr.textContent = t('edp.imgBad'); };
      im.src = rd.result;
    };
    rd.readAsDataURL(f);
    imgIn.value = '';
  };
  const vidIn = $('#edpVidFile');
  if (vidIn) vidIn.onchange = () => {
    const f = vidIn.files && vidIn.files[0];
    if (!f) return;
    if (f.size > 6 * 1024 * 1024) { if (merr) merr.textContent = t('edp.videoTooBig'); vidIn.value = ''; return; }
    const rd = new FileReader();
    rd.onload = () => {
      edpMedia = { kind: 'video', src: rd.result };
      if (merr) merr.textContent = t('edp.mediaVideo');
      paintMedia();
    };
    rd.readAsDataURL(f);
    vidIn.value = '';
  };
  const rm = $('#edpMediaRemove');
  if (rm) rm.onclick = () => { edpMedia = null; if (merr) merr.textContent = ''; paintMedia(); };
  const paint = () => {
    $('#edpBannerRow').innerHTML = swatchRowHtml('banner', PROFILE_COLORS, edpSel.banner);
    $('#edpAccentRow').innerHTML = swatchRowHtml('accent', PROFILE_COLORS, edpSel.accent);
    $('#edpBgRow').innerHTML = swatchRowHtml('bg', PROFILE_COLORS, edpSel.bg);
    $$('#editProfileModal [data-edp]').forEach(b => b.addEventListener('click', () => {
      const [k, c] = b.dataset.edp.split(':');
      edpSel[k] = c;
      paint();
    }));
  };
  paint();
  $('#editProfileModal').classList.remove('hidden');
}

// ---------------- Creator Hub ----------------
const LUA_EXAMPLE = [
  '-- Plataforma creada por un script Lua',
  'local p = Instance.new("Part")',
  'p.Name = "PlataformaLua"',
  'p.Size = Vector3.new(6, 1, 6)',
  'p.Position = Vector3.new(0, 0.5, 8)',
  'p.Color = Color3.fromRGB(91, 42, 134)',
  'p.Anchored = true',
  'p.Parent = workspace',
  '',
  'p.Touched:Connect(function()',
  '  print("Has pisado la plataforma de Lua")',
  'end)',
  '',
  'while true do',
  '  p.Color = Color3.fromRGB(91, 42, 134)',
  '  wait(1)',
  '  p.Color = Color3.fromRGB(245, 245, 245)',
  '  wait(1)',
  'end'
].join('\n');
let hubEditId = null;
let hubCover = '';
function renderHub() {
  show('hub');
  const u = me();
  if (!u) {
    $('#view-hub').innerHTML = '<div class="empty-note">' + t('hub.login') + '<br><br><button class="btn primary" id="hubLogin" type="button">' + t('c.enter') + '</button></div>';
    $('#hubLogin').addEventListener('click', () => openAuth('register'));
    return;
  }
  const mine = DB.exps.filter(e => e.creator === u.username);
  const totalVisits = mine.reduce((s, e) => s + (e.visits || 0), 0);
  const editing = hubEditId ? mine.find(e => e.id === hubEditId) : null;
  hubCover = editing ? (editing.cover || '') : '';
  $('#view-hub').innerHTML =
    '<div class="sec-head"><h2>Creator Hub</h2><span>' + t('hub.note') + '</span></div>' +
    '<div class="hub-stats">' +
    '<div class="hub-stat"><b>' + mine.length + '</b><span>' + t('hub.myExps') + '</span></div>' +
    '<div class="hub-stat"><b>' + totalVisits + '</b><span>' + t('hub.totalVisits') + '</span></div>' +
    '<div class="hub-stat"><b>' + (u.coins || 0) + '</b><span>V-Coins</span></div>' +
    '</div>' +
    '<div class="cols"><div class="panel-card"><h3>' + (editing ? t('hub.editExp') : t('hub.createExp')) + '</h3>' +
    '<form id="expForm" class="form-grid">' +
    '<label>' + t('hub.name') + ' <input id="eName" type="text" maxlength="40" required value="' + esc(editing ? editing.name : '') + '"></label>' +
    '<label>' + t('hub.desc') + ' <textarea id="eDesc" rows="3" maxlength="240">' + esc(editing ? editing.desc : '') + '</textarea></label>' +
    '<label>' + t('hub.template') + ' <select id="eTpl">' + Object.entries(TEMPLATES).map(([k, tpl]) => '<option value="' + k + '"' + (editing && editing.template === k ? ' selected' : '') + '>' + tpl.name + '</option>').join('') + '</select></label>' +
    '<label>' + t('hub.baseColor') + ' <input id="eHue" type="color" value="' + hex(editing ? editing.hue : 0x39424f) + '"></label>' +
    '<label>' + t('hub.coverLabel') + ' <input id="eCover" type="file" accept="image/*"></label>' +
    '<div id="coverPrev">' + (hubCover ? '<img src="' + hubCover + '" alt="cover" style="max-width:240px;border-radius:10px;border:1px solid var(--line)"><br><button class="btn small" id="eCoverDel" type="button">' + t('hub.coverRemove') + '</button>' : '<p class="form-note">' + t('hub.coverNote') + '</p>') + '</div>' +
    '<label>' + t('hub2.genre') + ' <input id="eGenre" type="text" maxlength="30" value="' + esc(editing ? (editing.genre || '') : '') + '"></label>' +
    '<label>' + t('hub2.age') + ' <select id="eAge">' + ['Todas las edades', '9+', '13+'].map(a => '<option value="' + a + '"' + (editing && editing.age === a ? ' selected' : '') + '>' + a + '</option>').join('') + '</select></label>' +
    '<label style="display:flex;gap:8px;align-items:center"><input id="ePub" type="checkbox"' + (!editing || editing.published ? ' checked' : '') + '> ' + t('hub.published') + '</label>' +
    '<button class="btn primary" type="submit">' + (editing ? t('hub.saveChanges') : t('hub.createBtn')) + '</button>' +
    (editing ? '<button class="btn" id="cancelEdit" type="button">' + t('hub.cancelEdit') + '</button>' : '') +
    '</form></div>' +
    '<div class="panel-card"><h3>' + t('hub.myList') + '</h3>' +
    (mine.length ? '<table class="simple"><tr><th>' + t('hub.name') + '</th><th>' + t('hub.colVisits') + '</th><th>' + t('hub.colState') + '</th><th></th></tr>' + mine.map(e =>
      '<tr><td>' + esc(e.name) + '</td><td>' + (e.visits || 0) + '</td><td>' + (e.published ? t('hub.statePub') : t('hub.stateDraft')) + '</td>' +
      '<td style="white-space:nowrap"><button class="btn small" data-play="' + e.id + '" type="button">' + t('hub.test') + '</button> <button class="btn small" data-edit="' + e.id + '" type="button">' + t('hub.edit') + '</button> <button class="btn small danger" data-del="' + e.id + '" type="button">' + t('hub.delete') + '</button></td></tr>').join('') + '</table>'
      : '<p class="form-note">' + t('hub.noneYet') + '</p>') +
    '<p class="form-note" style="margin-top:14px">' + t('hub.analyticsNote') + '</p>' +
    '</div></div>' +
    (editing ?
      '<div class="panel-card" style="margin-top:16px"><h3>' + t('hub.passesOf', { name: esc(editing.name) }) + '</h3>' +
      '<p class="form-note">' + t('hub.passesNote') + '</p>' +
      ((editing.passes || []).length ?
        '<table class="simple"><tr><th>' + t('hub.name') + '</th><th>' + t('hub.colPerk') + '</th><th>' + t('hub.colPrice') + '</th><th></th></tr>' +
        editing.passes.map(p => '<tr><td>' + esc(p.name) + '</td><td>' + esc(perkName(p.perk)) + (p.kind === 'consumable' ? ' · ' + t('exp.consumable') + ' ' + (p.seconds || 30) + ' s' : '') + '</td><td>' + p.price + ' VC</td>' +
          '<td><button class="btn small danger" data-delpass="' + p.id + '" type="button">' + t('hub.delete') + '</button></td></tr>').join('') + '</table>'
        : '<p class="form-note">' + t('hub.noPasses') + '</p>') +
      '<form id="passForm" class="form-grid" style="margin-top:12px">' +
      '<label>' + t('hub.passName') + ' <input id="pName" type="text" maxlength="40" required></label>' +
      '<label>' + t('hub.passDesc') + ' <input id="pDesc" type="text" maxlength="120"></label>' +
      '<label>' + t('hub.passPrice') + ' <input id="pPrice" type="number" min="10" max="10000" step="1" value="100" required></label>' +
      '<label>' + t('hub.passPerk') + ' <select id="pPerk">' + Object.entries(PASS_PERKS).map(([k]) => '<option value="' + k + '">' + perkName(k) + '</option>').join('') + '</select></label>' +
      '<label>' + t('hub.passKind') + ' <select id="pKind"><option value="pass">' + t('hub.kindPass') + '</option><option value="consumable">' + t('hub.kindCons') + '</option></select></label>' +
      '<label>' + t('hub.consSecs') + ' <input id="pSecs" type="number" min="5" max="600" step="1" value="30"></label>' +
      '<button class="btn primary" type="submit">' + t('hub.addPass') + '</button>' +
      '</form></div>' : '') +
    (editing ?
      '<div class="panel-card" style="margin-top:16px"><h3>' + t('hub.scripts') + ' · «' + esc(editing.name) + '»</h3>' +
      '<p class="form-note">' + t('hub.scriptsNote') + '</p>' +
      ((editing.scripts || []).length ? (editing.scripts || []).map((sc, i) =>
        '<div class="script-row"><div class="pass-top"><input type="text" maxlength="40" value="' + esc(sc.name || 'Script') + '" data-sc-name="' + i + '" placeholder="' + t('hub.scriptNamePh') + '" style="max-width:240px">' +
        '<button class="btn small danger" data-delscript="' + i + '" type="button">' + t('hub.delete') + '</button></div>' +
        '<textarea class="script-code" rows="9" spellcheck="false" data-sc-code="' + i + '">' + esc(sc.code || '') + '</textarea></div>').join('')
        : '<p class="form-note">' + t('hub.noScripts') + '</p>') +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button class="btn primary" id="saveScripts" type="button">' + t('hub.saveScripts') + '</button>' +
      '<button class="btn" id="addScript" type="button">' + t('hub.addScript') + '</button>' +
      '<button class="btn" id="exampleScript" type="button">' + t('hub.exampleScript') + '</button></div></div>' : '');
  $('#expForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const data = {
      name: $('#eName').value.trim(),
      desc: $('#eDesc').value.trim(),
      template: $('#eTpl').value,
      hue: parseInt($('#eHue').value.slice(1), 16),
      published: $('#ePub').checked,
      genre: ($('#eGenre').value || '').trim(),
      age: $('#eAge').value,
      cover: hubCover || '',
      updatedAt: new Date().toISOString()
    };
    if (!data.name) return;
    if (editing) Object.assign(editing, data);
    else DB.exps.unshift({ id: uid('exp'), creator: u.username, visits: 0, favs: 0, createdAt: new Date().toISOString(), ...data });
    hubEditId = null;
    saveDb();
    toast(editing ? t('toast.expUpdated') : t('toast.expCreated'));
    renderHub();
  });
  const ec = $('#eCover');
  if (ec) ec.addEventListener('change', () => {
    const f = ec.files && ec.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement('canvas');
        cv.width = 480; cv.height = 270;
        const cx = cv.getContext('2d');
        const sc = Math.max(480 / img.width, 270 / img.height);
        const w = img.width * sc, h = img.height * sc;
        cx.drawImage(img, (480 - w) / 2, (270 - h) / 2, w, h);
        hubCover = cv.toDataURL('image/jpeg', 0.85);
        const prev = $('#coverPrev');
        if (prev) {
          prev.innerHTML = '<img src="' + hubCover + '" alt="cover" style="max-width:240px;border-radius:10px;border:1px solid var(--line)"><br><button class="btn small" id="eCoverDel" type="button">' + t('hub.coverRemove') + '</button>';
          const del = $('#eCoverDel');
          if (del) del.addEventListener('click', () => { hubCover = ''; renderHub(); });
        }
        toast(t('toast.coverReady'));
      };
      img.src = rd.result;
    };
    rd.readAsDataURL(f);
  });
  const ecd = $('#eCoverDel');
  if (ecd) ecd.addEventListener('click', () => { hubCover = ''; renderHub(); });
  const pf = $('#passForm');
  if (pf && editing) pf.addEventListener('submit', (e) => {
    e.preventDefault();
    editing.passes = editing.passes || [];
    if (editing.passes.length >= 6) { toast(t('toast.maxPasses'), true); return; }
    const name = $('#pName').value.trim();
    const price = Math.floor(Number($('#pPrice').value));
    if (!name) return;
    if (!(price >= 10 && price <= 10000)) { toast(t('toast.priceRange'), true); return; }
    const kind = $('#pKind').value;
    const perk = $('#pPerk').value;
    if (kind === 'consumable' && perk === 'badge') { toast(t('toast.badgeNotCons'), true); return; }
    const nuevo = { id: uid('pass'), name, desc: $('#pDesc').value.trim(), price, perk };
    if (kind === 'consumable') { nuevo.kind = 'consumable'; nuevo.seconds = Math.max(5, Math.min(600, Math.floor(Number($('#pSecs').value)) || 30)); }
    editing.passes.push(nuevo);
    hubEditId = editing.id;
    saveDb();
    toast(t('toast.passAdded', { name }));
    renderHub();
  });
  const harvestScripts = () => {
    if (!editing) return;
    editing.scripts = editing.scripts || [];
    $$('#view-hub [data-sc-name]').forEach(inp => { const sc = editing.scripts[Number(inp.dataset.scName)]; if (sc) sc.name = inp.value.trim() || 'Script'; });
    $$('#view-hub [data-sc-code]').forEach(ta => { const sc = editing.scripts[Number(ta.dataset.scCode)]; if (sc) sc.code = ta.value; });
  };
  const scSave = $('#saveScripts');
  if (scSave && editing) scSave.addEventListener('click', () => { harvestScripts(); saveDb(); toast(t('toast.scriptsSaved')); });
  const scAdd = $('#addScript');
  if (scAdd && editing) scAdd.addEventListener('click', () => {
    harvestScripts();
    editing.scripts.push({ name: 'Script' + (editing.scripts.length + 1), code: '' });
    hubEditId = editing.id; saveDb(); renderHub();
  });
  const scEx = $('#exampleScript');
  if (scEx && editing) scEx.addEventListener('click', () => {
    harvestScripts();
    editing.scripts.push({ name: 'Ejemplo', code: LUA_EXAMPLE });
    hubEditId = editing.id; saveDb(); renderHub();
  });
  $$('#view-hub [data-delscript]').forEach(b => b.addEventListener('click', () => {
    if (!editing) return;
    harvestScripts();
    editing.scripts.splice(Number(b.dataset.delscript), 1);
    hubEditId = editing.id; saveDb(); renderHub();
  }));
  $$('#view-hub [data-delpass]').forEach(b => b.addEventListener('click', () => {
    if (!editing) return;
    editing.passes = (editing.passes || []).filter(p => p.id !== b.dataset.delpass);
    hubEditId = editing.id;
    saveDb();
    renderHub();
  }));
  const ce = $('#cancelEdit');
  if (ce) ce.addEventListener('click', () => { hubEditId = null; renderHub(); });
  $$('#view-hub [data-edit]').forEach(b => b.addEventListener('click', () => { hubEditId = b.dataset.edit; renderHub(); }));
  $$('#view-hub [data-del]').forEach(b => b.addEventListener('click', () => {
    if (!confirm(t('confirm.deleteExp'))) return;
    DB.exps = DB.exps.filter(e => e.id !== b.dataset.del);
    if (hubEditId === b.dataset.del) hubEditId = null;
    saveDb(); renderHub();
  }));
  $$('#view-hub [data-play]').forEach(b => b.addEventListener('click', () => { location.hash = '#/exp/' + b.dataset.play; }));
}

// ---------------- Cuenta / barra superior ----------------
// ---------------- Barra superior y lateral ----------------
function paintReqBadge() {
  const u = me();
  const n = u ? (u.requestsIn || []).length : 0;
  for (const id of ['#reqBadge', '#reqBadgeSide']) {
    const b = $(id);
    if (!b) continue;
    b.textContent = n;
    b.classList.toggle('hidden', n === 0);
  }
}
function paintSidebar() {
  const u = me();
  const chip = $('#sideUser');
  if (!chip) return;
  if (u) {
    chip.innerHTML = '<img alt="" style="background:' + hex(u.avatar.colors.torso) + '" src="' + userHeadImg(u) + '"><span class="grow"><b>' + esc(u.display) + '</b><span>@' + esc(u.username) + '</span></span><span class="dots">···</span>';
    chip.classList.add('clickable');
  } else {
    chip.innerHTML = '<span class="grow"><b>VORTX</b><span>' + t('chip.guest') + '</span></span>';
    chip.classList.remove('clickable');
  }
  const sc = $('#sideCoin');
  if (sc) { sc.textContent = u ? (u.coins || 0) : 0; sc.classList.toggle('hidden', !u); }
  paintMsgBadges();
}
function openUserMenu(anchor) {
  const u = me();
  const chip = anchor || $('#sideUser');
  if (!u) { openAuth('login'); return; }
  // Oleada 4: sin barra lateral, el menu del chip lleva TODAS las
  // secciones de la plataforma (las de la fila de enlaces y el resto).
  openPopMenu(chip, [
    { label: t('side.home'), fn: () => { location.hash = '#/'; } },
    { label: t('side.games'), fn: () => { location.hash = '#/'; } },
    { label: t('nav.friends'), fn: () => { location.hash = '#/friends'; } },
    { label: t('side.messages'), fn: () => { location.hash = '#/mensajes'; } },
    { label: t('nav.groups'), fn: () => { location.hash = '#/groups'; } },
    { label: t('nav.marketplace'), fn: () => { location.hash = '#/marketplace'; } },
    { label: t('nav.hub'), fn: () => { location.hash = '#/hub'; } },
    { label: t('chip.profile'), fn: () => { location.hash = '#/profile/' + u.username; } },
    { label: t('nav.avatar'), fn: () => { location.hash = '#/avatar'; } },
    { label: t('side.inventory'), fn: () => { location.hash = '#/inventario'; } },
    { label: t('side.store'), fn: () => { location.hash = '#/tienda'; } },
    { label: t('tr.title'), fn: () => { location.hash = '#/trades'; } },
    { label: t('chip.settings'), fn: () => { location.hash = '#/ajustes'; } },
    { label: t('chip.redeem'), fn: () => { location.hash = '#/canjear'; } },
    { label: t('chip.transactions'), fn: () => { location.hash = '#/transacciones'; } },
    { label: t('side.download'), fn: () => { location.hash = '#/descargar'; } },
    { label: t('chip.switch'), fn: () => switchAccount() },
    { label: t('chip.logout'), danger: true, fn: () => openLogoutConfirm() }
  ], 'up-left');
}
function updateTopbar() {
  const u = me();
  const skip = $('#skipBtn');
  if (skip) skip.style.display = '';
  const pill = $('#coinPill');
  pill.classList.toggle('hidden', !u);
  pill.style.display = u ? '' : 'none';
  if (u) pill.textContent = (u.coins || 0) + ' V-Coins';
  const area = $('#userArea');
  if (u) {
    area.innerHTML =
      '<button class="btn small user-chip" id="profileBtn" type="button"><img class="btn-avatar" alt="" id="topAvatarImg" src="' + userHeadImg(u) + '"><span>' + esc(u.display) + '</span><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>';
    $('#profileBtn').addEventListener('click', (e) => openUserMenu(e.currentTarget));
  } else {
    area.innerHTML =
      '<button class="btn small" id="loginBtn" type="button">' + t('c.login') + '</button>' +
      '<button class="btn small primary" id="registerBtn" type="button">' + t('c.register') + '</button>';
    $('#loginBtn').addEventListener('click', () => openAuth('login'));
    $('#registerBtn').addEventListener('click', () => openAuth('register'));
  }
  paintReqBadge();
  paintSidebar();
  renderDock();
}

// ---------------- Acceso y salida (pieza 24) ----------------
function openAuth(tab) {
  location.hash = tab === 'register' ? '#/registro' : '#/login';
}
function doLogout() {
  const u = me();
  if (u) { u.lastSeen = new Date().toISOString(); saveDb(); }
  clearSession();
  updateTopbar();
  location.hash = '#/';
}
function switchAccount() {
  const u = me();
  if (u) { u.lastSeen = new Date().toISOString(); saveDb(); }
  clearSession();
  updateTopbar();
  location.hash = '#/login';
}
function openLogoutConfirm() {
  const m = $('#logoutModal');
  if (m) m.classList.remove('hidden');
}
// (La pantalla partida del acceso de la oleada 3, con su panel de
// arte, salio en la oleada 4: el censo manda columna estrecha.)
function pwStrength(pw) {
  let s = 0;
  if (pw.length >= 4) s++;
  if (pw.length >= 8) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^a-zA-Z0-9]/.test(pw)) s++;
  return Math.min(4, s);
}
function wirePwEye(inputId, btnId) {
  const b = document.getElementById(btnId);
  if (!b) return;
  b.addEventListener('click', () => {
    const i = document.getElementById(inputId);
    i.type = i.type === 'password' ? 'text' : 'password';
  });
}
function renderLogin() {
  show('login');
  $('#view-login').innerHTML =
    '<div class="auth-col"><a class="auth-logo" href="#/"><span class="brand-bolt auth-bolt" aria-hidden="true"></span><span>VORTX</span></a><div class="panel-card auth-card"><h1>' + t('auth2.loginTitle') + '</h1>' +
    '<form id="loginForm2" class="form-grid"><label>' + t('auth.userOrEmail') + ' <input id="liUser" type="text" autocomplete="username" required></label>' +
    '<label>' + t('auth.pass') + ' <span class="pw-wrap"><input id="liPass" type="password" autocomplete="current-password" required><button class="pw-eye" id="liEye" type="button" aria-label="show"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg></button></span></label>' +
    '<label class="check-line"><input type="checkbox" id="liKeep" checked> ' + t('auth2.keep') + '</label>' +
    '<p class="form-err" id="liErr"></p>' +
    '<button class="btn primary big" type="submit">' + t('auth.enter') + '</button>' +
    '<button class="btn big hidden" id="liReact" type="button">' + t('auth.reactivate') + '</button></form>' +
    '<p class="form-note" style="margin-top:12px">' + t('auth2.noAccount') + ' <button class="linklike" id="liGoReg" type="button">' + t('auth.register') + '</button></p>' +
    '</div></div>';
  wirePwEye('liPass', 'liEye');
  $('#liGoReg').addEventListener('click', () => openAuth('register'));
  let pendingReact = null;
  $('#loginForm2').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#liErr');
    const name = $('#liUser').value.trim().toLowerCase();
    // Entrar con el nombre de usuario O con el correo de la cuenta.
    const target = userByName(name) || DB.users.find(x => (x.email || '').toLowerCase() === name);
    if (!target) { err.textContent = t('auth.errBad'); return; }
    if (target.pass !== hashPw($('#liPass').value)) { err.textContent = t('auth.errBad'); return; }
    // Cuenta desactivada (pieza 39): con la contrasena correcta se
    // ofrece reactivarla; sin ella, error generico como cualquier
    // credencial mala (no se filtra que la cuenta existe).
    if (target.disabled) {
      pendingReact = target;
      err.textContent = t('auth.errDeactivated');
      $('#liReact').classList.remove('hidden');
      return;
    }
    setSession(target, $('#liKeep').checked);
    saveDb();
    updateTopbar();
    toast(t('toast.welcome', { name: target.display }));
    location.hash = '#/';
  });
  $('#liReact').addEventListener('click', () => {
    if (!pendingReact) return;
    pendingReact.disabled = false;
    const target = pendingReact;
    pendingReact = null;
    setSession(target, $('#liKeep').checked);
    saveDb();
    updateTopbar();
    toast(t('auth.reactivated'));
    location.hash = '#/';
  });
}
function renderRegister() {
  show('registro');
  $('#view-registro').innerHTML =
    '<div class="auth-col"><a class="auth-logo" href="#/"><span class="brand-bolt auth-bolt" aria-hidden="true"></span><span>VORTX</span></a><div class="panel-card auth-card"><h1>' + t('auth2.registerTitle') + '</h1>' +
    '<form id="regForm2" class="form-grid"><label>' + t('auth.user') + ' <input id="rgUser" type="text" autocomplete="username" maxlength="16" required></label>' +
    '<label>' + t('auth.display') + ' <input id="rgDisplay" type="text" maxlength="24"></label>' +
    '<label>' + t('auth.email') + ' <input id="rgEmail" type="email" autocomplete="email" maxlength="64" required></label>' +
    '<label>' + t('auth.pass') + ' <span class="pw-wrap"><input id="rgPass" type="password" autocomplete="new-password" required><button class="pw-eye" id="rgEye" type="button" aria-label="show"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg></button></span></label>' +
    '<div class="pw-meter"><span id="pwBar"></span></div><p class="form-note" id="pwHint"></p>' +
    '<label class="check-line"><input type="checkbox" id="rgTerms"> <span>' + t('auth2.acceptPre') + ' <a href="#/legal/terminos" target="_blank" rel="noopener">' + t('foot.terms') + '</a>, <a href="#/legal/privacidad" target="_blank" rel="noopener">' + t('foot.privacy') + '</a>, <a href="#/legal/reglas" target="_blank" rel="noopener">' + t('foot.rules') + '</a> ' + t('auth2.and') + ' <a href="#/legal/creadores" target="_blank" rel="noopener">' + t('foot.creators') + '</a></span></label>' +
    '<label class="check-line"><input type="checkbox" id="rgKeep" checked> ' + t('auth2.keep') + '</label>' +
    '<p class="form-err" id="rgErr"></p>' +
    '<button class="btn primary big" type="submit">' + t('auth.create') + '</button></form>' +
    '<p class="form-note" style="margin-top:12px">' + t('auth2.haveAccount') + ' <button class="linklike" id="rgGoLogin" type="button">' + t('auth.login') + '</button></p>' +
    '</div></div>';
  wirePwEye('rgPass', 'rgEye');
  $('#rgGoLogin').addEventListener('click', () => openAuth('login'));
  const paintPw = () => {
    const pw = $('#rgPass').value;
    const s = pwStrength(pw);
    const bar = $('#pwBar');
    bar.style.width = (pw ? (s + 1) * 20 : 0) + '%';
    bar.style.background = s <= 1 ? 'var(--red)' : s === 2 ? '#c98a2b' : 'var(--accent)';
    $('#pwHint').textContent = pw ? t('auth2.strength') + ': ' + t(s <= 1 ? 'auth2.weak' : s === 2 ? 'auth2.medium' : 'auth2.strong') : '';
  };
  $('#rgPass').addEventListener('input', paintPw);
  $('#regForm2').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#rgErr');
    const name = $('#rgUser').value.trim().toLowerCase();
    const pass = $('#rgPass').value;
    if (!/^[a-z0-9_]{3,16}$/.test(name)) { err.textContent = t('auth.errUserFmt'); return; }
    if (name === 'vortx') { err.textContent = t('toast.reserved'); return; }
    if (userByName(name)) { err.textContent = t('auth.errUserTaken'); return; }
    const email = $('#rgEmail').value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err.textContent = t('st.errEmailFmt'); return; }
    if (DB.users.some(x => (x.email || '').toLowerCase() === email)) { err.textContent = t('st.errEmailTaken'); return; }
    if (pass.length < 4) { err.textContent = t('auth.errPassShort'); return; }
    if (!$('#rgTerms').checked) { err.textContent = t('auth2.acceptErr'); return; }
    const display = $('#rgDisplay').value.trim().slice(0, 24) || name;
    const nu = newSeedUser(name, display, pass);
    nu.email = email;
    DB.users.push(nu);
    setSession(nu, $('#rgKeep').checked);
    saveDb();
    updateTopbar();
    toast(t('toast.accountReady', { name: display }));
    location.hash = '#/';
  });
}
function wireAuth() {
  wireModals();
}
function wireModals() {
  const closeModal = (id) => { const m = $(id); if (m) m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.classList.add('hidden'); }); };
  ['#friendModal', '#reportModal', '#codeModal', '#editProfileModal', '#logoutModal'].forEach(closeModal);
  const af = $('#afForm');
  if (af) af.addEventListener('submit', (e) => { e.preventDefault(); submitAddFriend(); });
  const afc = $('#afCancel');
  if (afc) afc.addEventListener('click', () => $('#friendModal').classList.add('hidden'));
  const rpc = $('#repCancel');
  if (rpc) rpc.addEventListener('click', () => $('#reportModal').classList.add('hidden'));
  const rf = $('#repForm');
  if (rf) rf.addEventListener('submit', (e) => { e.preventDefault(); saveReport(); });
  const lc = $('#loCancel');
  if (lc) lc.addEventListener('click', () => $('#logoutModal').classList.add('hidden'));
  const lf = $('#loConfirm');
  if (lf) lf.addEventListener('click', () => { $('#logoutModal').classList.add('hidden'); doLogout(); });
  const ep = $('#edpForm');
  if (ep) ep.addEventListener('submit', (e) => {
    e.preventDefault();
    const u = me();
    if (!u) return;
    u.bio = $('#edpBio').value.trim().slice(0, 200);
    if (edpMedia) u.bannerMedia = edpMedia; else delete u.bannerMedia;
    u.profileBanner = edpSel.banner;
    u.profileAccent = edpSel.accent;
    u.profileBg = edpSel.bg;
    saveDb();
    $('#editProfileModal').classList.add('hidden');
    toast(t('edp.saved'));
    if (profUser === u.id) renderProfile(u.username);
  });
  const ss = $('#sideSearchBtn');
  if (ss) ss.addEventListener('click', () => openQuickNav());
  // La pildora de V-Coins abre su menu (pieza 38): Transacciones y la
  // pagina de V-Coins. Sin sesion no hay menu (la pildora ni se ve).
  const coinMenu = (anchor) => {
    if (!me()) return;
    openPopMenu(anchor, [
      { label: t('chip.transactions'), fn: () => { location.hash = '#/transacciones'; } },
      { label: 'V-Coins', fn: () => { location.hash = '#/tienda'; } }
    ]);
  };
  const cp = $('#coinPill');
  if (cp) cp.addEventListener('click', () => coinMenu(cp));
  const sc = $('#sideCoin');
  if (sc) sc.addEventListener('click', () => coinMenu(sc));
  const su = $('#sideUser');
  if (su) su.addEventListener('click', () => openUserMenu());
}

// ---------------- Router ----------------
function route() {
  paintReqBadge();
  paintMsgBadges();
  const hash = location.hash.replace(/^#\/?/, '');
  const [page, param] = hash.split('/');
  if (page !== 'avatar') avSnapshot = null;
  stopExperience();
  document.getElementById('playOverlay').classList.add('hidden');
  if (!page) renderHome();
  else if (page === 'exp') renderExp(param);
  else if (page === 'marketplace') renderMarket(currentCat);
  else if (page === 'avatar') { if (!avSnapshot) snapshotAvatar(); renderAvatar(); }
  else if (page === 'friends') renderFriends();
  else if (page === 'groups') renderGroups();
  else if (page === 'grupo') renderGroupPage(param);
  else if (page === 'mensajes') renderMensajes();
  else if (page === 'inventario') renderInventario();
  else if (page === 'tienda') renderTienda(param || null);
  else if (page === 'canjear') renderCodes();
  else if (page === 'transacciones') renderTransacciones();
  else if (page === 'ajustes') renderAjustes(param || null);
  else if (page === 'descargar') renderDescargar();
  else if (page === 'legal') renderLegal(param || 'terminos');
  else if (page === 'login') renderLogin();
  else if (page === 'registro') renderRegister();
  else if (page === 'profile') renderProfile(param ? decodeURIComponent(param) : null);
  else if (page === 'hub') renderHub();
  else if (page === 'search') renderSearch(param ? decodeURIComponent(param) : '');
  else if (page === 'codes') renderCodes();
  else if (page === 'trades') renderTrades();
  else renderHome();
}
window.addEventListener('hashchange', route);
$('#globalSearch').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  if (location.hash !== '#/' && location.hash !== '') location.hash = '#/';
  renderHome(q || null);
});
$('#globalSearch').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  if (q) location.hash = '#/search/' + encodeURIComponent(q);
});

// ---------------- Intercambios de limiteds ----------------
let tradeTo = null;
function tradeSummary(side) {
  const parts = [];
  for (const k of side.units || []) parts.push(k.replace('#', ' #'));
  if (side.coins > 0) parts.push(side.coins + ' V-Coins');
  return parts.length ? parts.join(' + ') : t('tr.nothing');
}
// ---------------- Intercambios (pieza 16) ----------------
let trTab = 'pendientes', trSel = null, trQuery = '', trCompose = false;
function renderTrades() {
  show('trades');
  const u = me();
  if (!u) {
    $('#view-trades').innerHTML = '<div class="empty-note">' + t('tr.login') + '<br><br><button class="btn primary" id="trLogin" type="button">' + t('c.enter') + '</button></div>';
    $('#trLogin').addEventListener('click', () => openAuth('register'));
    return;
  }
  const others = DB.users.filter(x => x.id !== u.id && !isBlockedEither(u, x));
  if (!tradeTo || !others.some(o => o.id === tradeTo)) tradeTo = others.length ? others[0].id : null;
  const target = others.find(o => o.id === tradeTo);
  const itemName = (id) => (CATALOG.find(i => i.id === id) || {}).name || id;
  const unitLabel = (un) => itemName(un.item) + ' #' + un.serial;
  const myFree = (u.units || []).filter(un => !un.listed);
  const theirFree = target ? (target.units || []).filter(un => !un.listed) : [];
  const trades = DB.trades || [];
  const nameOf = (id) => { const x = DB.users.find(y => y.id === id); return x ? x.display : '?'; };
  const lists = {
    pendientes: trades.filter(x => x.to === u.id && x.status === 'pending'),
    enviados: trades.filter(x => x.from === u.id && x.status === 'pending'),
    historial: trades.filter(x => (x.to === u.id || x.from === u.id) && x.status !== 'pending').slice().reverse()
  };
  const q = trQuery.toLowerCase();
  const inTab = lists[trTab].filter(x => {
    if (!q) return true;
    const hay = (nameOf(x.from) + ' ' + nameOf(x.to) + ' ' + tradeSummary(x.give) + ' ' + tradeSummary(x.want)).toLowerCase();
    return hay.includes(q);
  });
  if (trSel && !trades.some(x => x.id === trSel)) trSel = null;
  const sel = trSel ? trades.find(x => x.id === trSel) : null;
  let detail = '';
  if (trCompose) {
    detail = '<div class="panel-card"><h3>' + t('tr.propose') + '</h3>' +
      (others.length ? '<form id="tradeForm" class="form-grid">' +
        '<label>' + t('tr.player') + ' <select id="trTo">' + others.map(o => '<option value="' + o.id + '"' + (o.id === tradeTo ? ' selected' : '') + '>' + esc(o.display) + ' (@' + esc(o.username) + ')</option>').join('') + '</select></label>' +
        '<fieldset class="trade-set"><legend>' + t('tr.iGive') + '</legend>' +
        (myFree.length ? myFree.map(un => '<label class="trade-opt"><input type="checkbox" name="giveUnit" value="' + unitKey(un) + '"> ' + esc(unitLabel(un)) + '</label>').join('') : '<p class="form-note">' + t('tr.noFreeMine') + '</p>') +
        '<label>V-Coins <input type="number" id="trGiveCoins" min="0" max="100000" step="1" value="0"></label></fieldset>' +
        '<fieldset class="trade-set"><legend>' + t('tr.theyGive', { name: esc(target ? target.display : '') }) + '</legend>' +
        (theirFree.length ? theirFree.map(un => '<label class="trade-opt"><input type="checkbox" name="wantUnit" value="' + unitKey(un) + '"> ' + esc(unitLabel(un)) + '</label>').join('') : '<p class="form-note">' + t('tr.noFreeTheirs') + '</p>') +
        '<label>V-Coins <input type="number" id="trWantCoins" min="0" max="100000" step="1" value="0"></label></fieldset>' +
        '<button class="btn primary" type="submit">' + t('tr.send') + '</button></form>'
        : '<p class="form-note">' + t('tr.noAccounts') + '</p>') + '</div>';
  } else if (sel) {
    const mine = sel.from === u.id;
    detail = '<div class="panel-card"><h3>' + esc(nameOf(sel.from)) + ' → ' + esc(nameOf(sel.to)) + '</h3>' +
      '<div class="tx-row"><span>' + t('tr3.offers') + '</span><b>' + esc(tradeSummary(sel.give)) + '</b></div>' +
      '<div class="tx-row"><span>' + t('tr3.asks') + '</span><b>' + esc(tradeSummary(sel.want)) + '</b></div>' +
      '<div class="tx-row"><span>' + new Date(sel.at).toLocaleString(currentLang()) + '</span><b>' + (sel.status === 'pending' ? t('tr3.pending') : sel.status === 'done' ? t('tr.done') : sel.status === 'rejected' ? t('tr.rejected') : t('tr.cancelled')) + '</b></div>' +
      (sel.status === 'pending' && !mine ? '<div style="margin-top:12px"><button class="btn primary" data-taccept="' + sel.id + '" type="button">' + t('fr.accept') + '</button> <button class="btn danger" data-treject="' + sel.id + '" type="button">' + t('fr.reject') + '</button></div>' : '') +
      (sel.status === 'pending' && mine ? '<div style="margin-top:12px"><button class="btn" data-tcancel="' + sel.id + '" type="button">' + t('tr.cancel') + '</button></div>' : '') +
      '</div>';
  } else {
    detail = '<div class="empty-note big"><b>' + t('tr3.noneSel') + '</b><br><br><button class="btn primary" id="trNewBtn" type="button">' + t('tr3.sendTrade') + '</button></div>';
  }
  $('#view-trades').innerHTML =
    '<div class="sec-head"><h2>' + t('tr.title') + '</h2><span>' + t('tr.note') + '</span></div>' +
    '<div class="vtabs">' +
    '<button class="vtab' + (trTab === 'pendientes' ? ' active' : '') + '" data-trtab="pendientes" type="button">' + t('tr3.pendingTab') + ' (' + lists.pendientes.length + ')</button>' +
    '<button class="vtab' + (trTab === 'enviados' ? ' active' : '') + '" data-trtab="enviados" type="button">' + t('tr3.sentTab') + ' (' + lists.enviados.length + ')</button>' +
    '<button class="vtab' + (trTab === 'historial' ? ' active' : '') + '" data-trtab="historial" type="button">' + t('tr.history') + ' (' + lists.historial.length + ')</button></div>' +
    '<div class="trades-layout"><div class="trades-side">' +
    '<div class="dock-search"><input id="trSearch" type="text" placeholder="' + t('fr3.searchPh') + '" value="' + esc(trQuery) + '" autocomplete="off"></div>' +
    (inTab.length ? inTab.map(x => '<button class="conv-row' + (trSel === x.id ? ' active' : '') + '" data-trsel="' + x.id + '" type="button"><span class="grow"><b>' + esc(nameOf(x.from)) + ' → ' + esc(nameOf(x.to)) + '</b><span>' + esc(tradeSummary(x.give)) + ' ⇄ ' + esc(tradeSummary(x.want)) + '</span></span></button>').join('')
      : '<div class="empty-note">' + t('tr3.none') + '</div>') +
    '</div><div class="trades-main">' + detail + '</div></div>';
  $$('#view-trades [data-trtab]').forEach(b => b.addEventListener('click', () => { trTab = b.dataset.trtab; trSel = null; trCompose = false; renderTrades(); }));
  $$('#view-trades [data-trsel]').forEach(b => b.addEventListener('click', () => { trSel = b.dataset.trsel; trCompose = false; renderTrades(); }));
  const ts = $('#trSearch');
  if (ts) ts.addEventListener('input', () => { trQuery = ts.value; renderTrades(); const n = $('#trSearch'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } });
  const nb = $('#trNewBtn');
  if (nb) nb.addEventListener('click', () => { trCompose = true; renderTrades(); });
  const selEl = $('#trTo');
  if (selEl) selEl.addEventListener('change', () => { tradeTo = selEl.value; renderTrades(); });
  const tf = $('#tradeForm');
  if (tf) tf.addEventListener('submit', (e) => {
    e.preventDefault();
    const giveUnits = $$('#tradeForm [name="giveUnit"]:checked').map(x => x.value);
    const wantUnits = $$('#tradeForm [name="wantUnit"]:checked').map(x => x.value);
    const giveCoins = Math.max(0, Math.floor(Number($('#trGiveCoins').value)) || 0);
    const wantCoins = Math.max(0, Math.floor(Number($('#trWantCoins').value)) || 0);
    if (!giveUnits.length && !giveCoins && !wantUnits.length && !wantCoins) { toast(t('toast.tradeEmpty'), true); return; }
    if (giveCoins > (u.coins || 0)) { toast(t('toast.tradeCoins'), true); return; }
    DB.trades = [...(DB.trades || []), { id: uid('trd'), from: u.id, to: tradeTo, give: { units: giveUnits, coins: giveCoins }, want: { units: wantUnits, coins: wantCoins }, status: 'pending', at: new Date().toISOString() }];
    saveDb();
    toast(t('toast.tradeSent'));
    trCompose = false; trTab = 'enviados';
    renderTrades();
  });
  $$('#view-trades [data-taccept]').forEach(b => b.addEventListener('click', () => acceptTrade(b.dataset.taccept)));
  $$('#view-trades [data-treject]').forEach(b => b.addEventListener('click', () => {
    const t2 = (DB.trades || []).find(x => x.id === b.dataset.treject);
    if (t2 && t2.to === u.id && t2.status === 'pending') { t2.status = 'rejected'; saveDb(); renderTrades(); }
  }));
  $$('#view-trades [data-tcancel]').forEach(b => b.addEventListener('click', () => {
    const t2 = (DB.trades || []).find(x => x.id === b.dataset.tcancel);
    if (t2 && t2.from === u.id && t2.status === 'pending') { t2.status = 'cancelled'; saveDb(); renderTrades(); }
  }));
}

function acceptTrade(tradeId) {
  const u = me();
  const tr = (DB.trades || []).find(x => x.id === tradeId);
  if (!u || !tr || tr.to !== u.id || tr.status !== 'pending') return;
  const from = DB.users.find(x => x.id === tr.from);
  if (!from) { toast(t('toast.tradeGone'), true); return; }
  if (isBlockedEither(u, from)) { toast(t('af.errBlocked'), true); tr.status = 'cancelled'; saveDb(); renderTrades(); return; }
  const findUnit = (usr, key) => (usr.units || []).find(un => unitKey(un) === key && !un.listed);
  const giveUns = (tr.give.units || []).map(k => findUnit(from, k));
  const wantUns = (tr.want.units || []).map(k => findUnit(u, k));
  if (giveUns.some(x => !x) || wantUns.some(x => !x)) { toast(t('toast.tradeUnitGone'), true); tr.status = 'cancelled'; saveDb(); renderTrades(); return; }
  if ((from.coins || 0) < (tr.give.coins || 0) || (u.coins || 0) < (tr.want.coins || 0)) { toast(t('toast.tradeNoCoins'), true); return; }
  from.units = from.units.filter(un => !giveUns.includes(un));
  u.units = (u.units || []).filter(un => !wantUns.includes(un));
  from.units = [...from.units, ...wantUns];
  u.units = [...u.units, ...giveUns];
  from.coins = (from.coins || 0) - (tr.give.coins || 0) + (tr.want.coins || 0);
  u.coins = (u.coins || 0) - (tr.want.coins || 0) + (tr.give.coins || 0);
  if (tr.give.coins > 0) { u.tx = u.tx || []; u.tx.unshift({ at: new Date().toISOString(), label: 'Intercambio con ' + from.display, amount: tr.give.coins }); }
  if (tr.want.coins > 0) { from.tx = from.tx || []; from.tx.unshift({ at: new Date().toISOString(), label: 'Intercambio con ' + u.display, amount: tr.want.coins }); }
  fixLimitedInventory(from);
  fixLimitedInventory(u);
  tr.status = 'done';
  saveDb();
  updateTopbar();
  toast(t('toast.tradeDone'));
  renderTrades();
}


// ---------------- Busqueda global ----------------
function normText(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function renderSearch(q) {
  show('search');
  const nq = normText(q).trim();
  const match = (t) => nq && normText(t).includes(nq);
  const exps = DB.exps.filter(e => e.published !== false && (match(e.name) || match(e.desc) || match(e.creator)));
  const users = DB.users.filter(x => match(x.display) || match(x.username));
  const groups = (DB.groups || []).filter(g => match(g.name) || match(g.desc));
  const items = CATALOG.filter(i => match(i.name) || match(i.cat));
  const total = exps.length + users.length + groups.length + items.length;
  $('#view-search').innerHTML =
    '<div class="sec-head"><h2>' + t('home.resultsFor', { q: esc(q) }) + '</h2><span>' + t('srch.total', { n: total }) + '</span></div>' +
    (exps.length ? '<div class="sec-head"><h2>' + t('srch.exps') + '</h2><span>' + exps.length + '</span></div><div class="exp-grid">' + exps.map(expCard).join('') + '</div>' : '') +
    (users.length ? '<div class="sec-head"><h2>' + t('srch.people') + '</h2><span>' + users.length + '</span></div><div class="user-grid">' + users.map(x => '<a class="user-card" href="#/profile/' + encodeURIComponent(x.username) + '"><img alt="" style="background:' + hex(x.avatar.colors.torso) + '" src="' + userHeadImg(x) + '"><span class="grow"><b>' + esc(x.display) + '</b><span>@' + esc(x.username) + '</span></span></a>').join('') + '</div>' : '') +
    (groups.length ? '<div class="sec-head"><h2>' + t('srch.groups') + '</h2><span>' + groups.length + '</span></div><div class="item-grid">' + groups.map(g => '<div class="item-card"><div class="item-body"><span class="slot">' + t('grp.tag') + '</span><h3>' + esc(g.name) + '</h3><p>' + esc(g.desc || '') + '</p><a class="btn small" href="#/grupo/' + g.id + '">' + t('srch.viewGroups') + '</a></div></div>').join('') + '</div>' : '') +
    (items.length ? '<div class="sec-head"><h2>' + t('srch.items') + '</h2><span>' + items.length + '</span></div><div class="item-grid">' + items.map(i => '<div class="item-card"><div class="item-body"><span class="slot">' + esc(i.cat) + '</span><h3>' + esc(i.name) + '</h3><p>' + esc(i.desc || '') + '</p><a class="btn small" href="#/marketplace">' + t('srch.goMarket') + '</a></div></div>').join('') + '</div>' : '') +
    (total === 0 ? '<div class="empty-note">' + t('srch.none', { q: esc(q) }) + '</div>' : '');
  wireExpCards($('#view-search'));
}



// ---------------- Utilidades oleada 3 ----------------
function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return t('time.now');
  if (s < 3600) return t('time.min', { n: Math.floor(s / 60) });
  if (s < 86400) return t('time.hour', { n: Math.floor(s / 3600) });
  return t('time.day', { n: Math.floor(s / 86400) });
}
function copyText(txt) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).catch(() => {}); return; }
  } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  } catch (e) {}
}
let popAnchor = null;
function closePopMenu() { const p = $('#popMenu'); if (p) { p.classList.add('hidden'); p.innerHTML = ''; } popAnchor = null; }
function openPopMenu(anchor, items) {
  const p = $('#popMenu');
  if (!p) return;
  popAnchor = anchor;
  if (!p.classList.contains('hidden')) { closePopMenu(); return; }
  p.innerHTML = items.map((it, i) => '<button class="pop-item' + (it.danger ? ' danger' : '') + '" data-pop="' + i + '" type="button">' + esc(it.label) + '</button>').join('');
  p.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  p.style.top = (r.bottom + 6 + window.scrollY) + 'px';
  p.style.left = Math.max(8, Math.min(r.left + window.scrollX, window.innerWidth - 230)) + 'px';
  $$('#popMenu [data-pop]').forEach(b => b.addEventListener('click', () => { const it = items[Number(b.dataset.pop)]; closePopMenu(); if (it) it.fn(); }));
}
document.addEventListener('click', (e) => {
  const p = $('#popMenu');
  if (p && !p.classList.contains('hidden') && !p.contains(e.target) && !(popAnchor && popAnchor.contains(e.target))) closePopMenu();
});
let reportCtx = null;
function openReport(ctx) {
  const u = me();
  if (!u) { openAuth('login'); toast(t('exp3.repSent'), true); return; }
  reportCtx = ctx;
  $('#repTitle').textContent = ctx.title || t('exp3.report');
  $('#repText').value = '';
  $('#repReason').value = 'spam';
  $('#reportModal').classList.remove('hidden');
}
function saveReport() {
  const u = me();
  if (!u || !reportCtx) return;
  DB.reports = DB.reports || [];
  DB.reports.unshift({
    id: uid('rep'), by: u.id, type: reportCtx.type, targetId: reportCtx.id, label: reportCtx.label || '',
    reason: $('#repReason').value, text: $('#repText').value.trim(), at: new Date().toISOString()
  });
  saveDb();
  $('#reportModal').classList.add('hidden');
  toast(t('exp3.repSent'));
}
// Foto de cuerpo completo de un avatar (tarjetas de miembros de grupo,
// conjuntos del editor): mismo rig real, encuadre de cuerpo entero.
let bodyRenderer = null;
const bodyShotCache = new Map();
function bodyShotImg(userObj) {
  const cacheKey = (userObj.id || '?') + '|' + JSON.stringify(userObj.avatar || {});
  if (bodyShotCache.has(cacheKey)) return bodyShotCache.get(cacheKey);
  if (!bodyRenderer) {
    bodyRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    bodyRenderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    bodyRenderer.setSize(216, 288, false);
  }
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xd8ecff, 0x2a3342, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  const rig = buildRig(userObj.avatar || { face: 'clasica' });
  rig.setEquipped(equippedList(userObj), CATALOG);
  rig.group.position.y = -2.75;
  scene.add(rig.group);
  const cam = new THREE.PerspectiveCamera(38, 216 / 288, 0.1, 50);
  cam.position.set(0, 0.1, 8.8);
  cam.lookAt(0, 0, 0);
  bodyRenderer.render(scene, cam);
  const cv = document.createElement('canvas');
  cv.width = 216; cv.height = 288;
  cv.getContext('2d').drawImage(bodyRenderer.domElement, 0, 0);
  const url = cv.toDataURL();
  bodyShotCache.set(cacheKey, url);
  return url;
}
function isBlockedEither(a, b) {
  if (!a || !b) return false;
  return (a.blocked || []).includes(b.id) || (b.blocked || []).includes(a.id);
}

// ---------------- Mensajes privados (piezas 2 y 8) ----------------
const OFFICIAL_POSTS = () => [{ title: t('ofc.title'), body: t('ofc.body'), more: t('ofc.more'), at: '2026-11-08T10:00:00.000Z' }];
function convKeyFor(a, b) { return 'dm_' + [a, b].sort().join('_'); }
function getConv(a, b, create) {
  DB.msgs = DB.msgs || {};
  const k = convKeyFor(a, b);
  if (!DB.msgs[k] && create) DB.msgs[k] = { id: k, users: [a, b], messages: [], reads: {} };
  return DB.msgs[k] || null;
}
function convUnread(conv, u) {
  const since = (conv.reads || {})[u.id] || '';
  return conv.messages.filter(m => m.from !== u.id && m.at > since).length;
}
function officialUnread(u) { return u && !u.officialSeen ? 1 : 0; }
function totalUnread(u) {
  if (!u) return 0;
  let n = officialUnread(u);
  for (const k of Object.keys(DB.msgs || {})) {
    const c = DB.msgs[k];
    if (c.users.includes(u.id)) n += convUnread(c, u);
  }
  return n;
}
function paintMsgBadges() {
  const u = me();
  const n = totalUnread(u);
  for (const id of ['msgBadgeSide', 'msgBadgeNav']) {
    const b = document.getElementById(id);
    if (b) { b.textContent = n; b.classList.toggle('hidden', n === 0); }
  }
  const pillBadge = $('#dockBadge');
  if (pillBadge) { pillBadge.textContent = n; pillBadge.classList.toggle('hidden', n === 0); }
}
function canDm(u, other) {
  if (!u || !other) return { ok: false, why: 'friends' };
  if (isBlockedEither(u, other)) return { ok: false, why: 'blocked' };
  if (!(u.friends || []).includes(other.id)) return { ok: false, why: 'friends' };
  if (other.privacy && other.privacy.dm === 'none') return { ok: false, why: 'closed' };
  return { ok: true };
}
function markConvRead(conv, u) {
  conv.reads = conv.reads || {};
  conv.reads[u.id] = new Date().toISOString();
  saveDb();
  paintMsgBadges();
}
function convRowsHtml(u, query) {
  const q = (query || '').toLowerCase();
  const rows = [];
  rows.push({ official: true, name: 'VORTX', sub: t('msg.officialSub'), last: OFFICIAL_POSTS()[0].title, at: OFFICIAL_POSTS()[0].at, unread: officialUnread(u) });
  const list = [];
  for (const k of Object.keys(DB.msgs || {})) {
    const c = DB.msgs[k];
    if (!c.users.includes(u.id)) continue;
    const other = DB.users.find(x => x.id === (c.users[0] === u.id ? c.users[1] : c.users[0]));
    if (!other) continue;
    const last = c.messages[c.messages.length - 1];
    list.push({ official: false, other, name: other.display, sub: '@' + other.username, last: last ? last.text : '', at: last ? last.at : '', unread: convUnread(c, u), conv: c });
  }
  list.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  rows.push(...list);
  return rows.filter(r => !q || r.name.toLowerCase().includes(q) || r.last.toLowerCase().includes(q));
}
function convRowHtml(r, active) {
  if (r.official) {
    return '<button class="conv-row' + (active ? ' active' : '') + '" data-conv="oficial" type="button">' +
      '<span class="pavatar official-av"><span class="brand-bolt conv-bolt"></span></span>' +
      '<span class="grow"><b>VORTX ' + VERIFIED_SVG + '</b><span>' + esc(r.last) + '</span></span>' +
      (r.unread ? '<span class="nav-badge">' + r.unread + '</span>' : '') + '</button>';
  }
  return '<button class="conv-row' + (active ? ' active' : '') + '" data-conv="' + r.other.id + '" type="button">' +
    '<img class="pavatar" alt="" style="background:' + hex(r.other.avatar.colors.torso) + '" src="' + userHeadImg(r.other) + '">' +
    '<span class="grow"><b>' + esc(r.name) + '</b><span>' + esc(r.last || r.sub) + '</span></span>' +
    (r.unread ? '<span class="nav-badge">' + r.unread + '</span>' : '') + '</button>';
}
const VERIFIED_SVG = '<svg class="verified" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="#a583d6" d="M12 1.7l2.5 2 3.2-.3 1.1 3 3 1.1-.3 3.2 2 2.5-2 2.5.3 3.2-3 1.1-1.1 3-3.2-.3-2.5 2-2.5-2-3.2.3-1.1-3-3-1.1.3-3.2-2-2.5 2-2.5-.3-3.2 3-1.1 1.1-3 3.2.3z"/><path fill="#131316" d="M10.9 15.9l-3-3 1.3-1.3 1.7 1.7 4-4.4 1.4 1.2z"/></svg>';
function threadHtml(u, targetId, expanded) {
  if (targetId === 'oficial') {
    const p = OFFICIAL_POSTS()[0];
    return '<div class="anti-scam">' + t('msg.antiScam') + '</div>' +
      '<div class="ofc-card"><h4>' + esc(p.title) + '</h4><p>' + esc(p.body) + '</p>' +
      (expanded ? '<p>' + esc(p.more) + '</p>' : '') +
      '<button class="btn small" data-readmore type="button">' + (expanded ? t('msg.readLess') : t('msg.readMore')) + '</button>' +
      '<div class="msg-time">' + new Date(p.at).toLocaleString(currentLang()) + '</div></div>' +
      '<div class="cant-reply">' + t('msg.cantReply') + '</div>';
  }
  const other = DB.users.find(x => x.id === targetId);
  if (!other) return '';
  const conv = getConv(u.id, other.id, false);
  const msgs = conv ? conv.messages : [];
  const gate = canDm(u, other);
  return '<div class="msg-list">' + (msgs.length ? msgs.map(m =>
    '<div class="msg-bubble' + (m.from === u.id ? ' mine' : '') + '"><p>' + esc(m.text) + '</p><span>' + new Date(m.at).toLocaleTimeString(currentLang(), { hour: '2-digit', minute: '2-digit' }) + '</span></div>').join('')
    : '<div class="empty-note">' + t('msg.empty') + '</div>') + '</div>' +
    (gate.ok
      ? '<form class="msg-form" data-msgform><input type="text" maxlength="500" placeholder="' + t('msg.sendPh') + '" autocomplete="off"><button class="btn primary" type="submit">' + t('msg.send') + '</button></form>'
      : '<div class="cant-reply">' + (gate.why === 'blocked' ? t('msg.blockedConv') : gate.why === 'closed' ? t('msg.dmClosed') : t('msg.notFriends')) + '</div>');
}
function sendDm(u, otherId, rawText) {
  const other = DB.users.find(x => x.id === otherId);
  if (!other) return false;
  const gate = canDm(u, other);
  if (!gate.ok) { toast(gate.why === 'blocked' ? t('msg.blockedConv') : gate.why === 'closed' ? t('msg.dmClosed') : t('msg.notFriends'), true); return false; }
  const r = filterText(String(rawText || '').slice(0, 500));
  if (!r.text.trim()) return false;
  const conv = getConv(u.id, other.id, true);
  conv.messages = [...conv.messages, { from: u.id, text: r.text, at: new Date().toISOString() }].slice(-300);
  conv.reads = conv.reads || {};
  conv.reads[u.id] = new Date().toISOString();
  saveDb();
  return true;
}
// --- Panel flotante de mensajes ---
let dockOpen = false, dockConv = null, dockQuery = '', dockPick = false, dockExpanded = false, dockUserId = null;
function renderDock() {
  const dock = $('#msgDock');
  if (!dock) return;
  const u = me();
  if (!u) { dock.classList.add('hidden'); dock.innerHTML = ''; dockOpen = false; dockConv = null; dockPick = false; dockUserId = null; return; }
  if (dockUserId !== u.id) { dockOpen = false; dockConv = null; dockPick = false; dockUserId = u.id; }
  dock.classList.remove('hidden');
  if (!dockOpen) {
    const n = totalUnread(u);
    dock.innerHTML = '<button class="dock-pill" id="dockPill" type="button"><span>' + t('msg.title') + '</span>' +
      '<span id="dockBadge" class="nav-badge' + (n ? '' : ' hidden') + '">' + n + '</span>' +
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 15l6-6 6 6"/></svg></button>';
    $('#dockPill').addEventListener('click', () => { dockOpen = true; renderDock(); });
    return;
  }
  let inner = '';
  if (dockPick) {
    const friends = (u.friends || []).map(id => DB.users.find(x => x.id === id)).filter(Boolean).filter(o => !isBlockedEither(u, o));
    inner = '<div class="dock-head"><button class="btn small" data-dockback type="button">‹</button><b>' + t('msg.pickFriend') + '</b><span class="spacer"></span><button class="btn small" data-dockclose type="button">×</button></div>' +
      '<div class="dock-body">' + (friends.length ? friends.map(f => '<button class="conv-row" data-pick="' + f.id + '" type="button"><img class="pavatar" alt="" style="background:' + hex(f.avatar.colors.torso) + '" src="' + userHeadImg(f) + '"><span class="grow"><b>' + esc(f.display) + '</b><span>@' + esc(f.username) + '</span></span></button>').join('')
        : '<div class="empty-note">' + t('msg.noFriendsYet') + '</div>') + '</div>';
  } else if (dockConv) {
    const isOf = dockConv === 'oficial';
    const other = isOf ? null : DB.users.find(x => x.id === dockConv);
    inner = '<div class="dock-head"><button class="btn small" data-dockback type="button">‹</button><b>' + (isOf ? 'VORTX' : esc(other ? other.display : '')) + '</b><span class="spacer"></span><button class="btn small" data-dockclose type="button">×</button></div>' +
      '<div class="dock-thread">' + threadHtml(u, dockConv, dockExpanded) + '</div>';
  } else {
    const rows = convRowsHtml(u, dockQuery);
    const n = totalUnread(u);
    inner = '<div class="dock-head"><b>' + t('msg.title') + '</b>' + (n ? '<span class="nav-badge">' + n + '</span>' : '') +
      '<span class="spacer"></span><button class="btn small primary" data-docknew type="button">' + t('msg.new') + '</button><button class="btn small" data-dockclose type="button">×</button></div>' +
      '<div class="dock-search"><input id="dockSearch" type="text" placeholder="' + t('msg.searchPh') + '" value="' + esc(dockQuery) + '" autocomplete="off"></div>' +
      '<div class="dock-body">' + (rows.length ? rows.map(r => convRowHtml(r, false)).join('') : '<div class="empty-note">' + t('msg.empty') + '</div>') +
      '<button class="btn primary" data-docknew type="button" style="width:100%;margin-top:10px">' + t('msg.start') + '</button></div>';
  }
  dock.innerHTML = '<div class="dock-panel">' + inner + '</div>';
  const close = () => { dockOpen = false; dockConv = null; dockPick = false; renderDock(); };
  $$('#msgDock [data-dockclose]').forEach(b => b.addEventListener('click', close));
  $$('#msgDock [data-dockback]').forEach(b => b.addEventListener('click', () => { dockConv = null; dockPick = false; renderDock(); }));
  $$('#msgDock [data-docknew]').forEach(b => b.addEventListener('click', () => { dockPick = true; renderDock(); }));
  $$('#msgDock [data-pick]').forEach(b => b.addEventListener('click', () => { openDockConv(b.dataset.pick); }));
  $$('#msgDock [data-conv]').forEach(b => b.addEventListener('click', () => { openDockConv(b.dataset.conv); }));
  const ds = $('#dockSearch');
  if (ds) ds.addEventListener('input', () => { dockQuery = ds.value; renderDock(); const nds = $('#dockSearch'); if (nds) { nds.focus(); nds.setSelectionRange(nds.value.length, nds.value.length); } });
  wireThread($('#msgDock'), u, dockConv, () => renderDock());
}
function openDockConv(targetId) {
  const u = me();
  if (!u) return;
  dockConv = targetId; dockPick = false; dockExpanded = false;
  if (targetId === 'oficial') { if (!u.officialSeen) { u.officialSeen = true; saveDb(); } }
  else { const c = getConv(u.id, targetId, false); if (c) markConvRead(c, u); }
  paintMsgBadges();
  renderDock();
}
function wireThread(root, u, targetId, rerender) {
  if (!targetId || !root) return;
  const rm = root.querySelector('[data-readmore]');
  if (rm) rm.addEventListener('click', () => { dockExpanded = !dockExpanded; pageExpanded = dockExpanded; rerender(); });
  const form = root.querySelector('[data-msgform]');
  if (form) form.addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = form.querySelector('input');
    if (sendDm(u, targetId, inp.value)) rerender();
  });
  const list = root.querySelector('.msg-list, .dock-thread');
  if (list) list.scrollTop = list.scrollHeight;
}
// --- Pagina completa de mensajes ---
let pageConv = null, pageQuery = '', pageExpanded = false;
function renderMensajes() {
  show('mensajes');
  const u = me();
  if (!u) {
    $('#view-mensajes').innerHTML = '<div class="empty-note">' + t('fr.login') + '<br><br><button class="btn primary" id="msgLogin" type="button">' + t('c.enter') + '</button></div>';
    $('#msgLogin').addEventListener('click', () => openAuth('register'));
    return;
  }
  if (pageConv && pageConv !== 'oficial') {
    const c = getConv(u.id, pageConv, false);
    if (c) { c.reads = c.reads || {}; c.reads[u.id] = new Date().toISOString(); saveDb(); }
  }
  if (pageConv === 'oficial' && !u.officialSeen) { u.officialSeen = true; saveDb(); }
  paintMsgBadges();
  const rows = convRowsHtml(u, pageQuery);
  const other = pageConv && pageConv !== 'oficial' ? DB.users.find(x => x.id === pageConv) : null;
  $('#view-mensajes').innerHTML =
    '<div class="sec-head"><h2>' + t('msg.title') + '</h2></div>' +
    '<div class="msg-layout"><div class="msg-side">' +
    '<div class="dock-search"><input id="pageMsgSearch" type="text" placeholder="' + t('msg.searchPh') + '" value="' + esc(pageQuery) + '" autocomplete="off">' +
    '<button class="btn primary" id="pageMsgNew" type="button">' + t('msg.new') + '</button></div>' +
    (rows.length ? rows.map(r => convRowHtml(r, pageConv === (r.official ? 'oficial' : r.other.id))).join('') : '<div class="empty-note">' + t('msg.empty') + '</div>') +
    '</div><div class="msg-main">' +
    (pageConv
      ? '<div class="dock-head"><b>' + (pageConv === 'oficial' ? 'VORTX ' + VERIFIED_SVG : esc(other ? other.display : '')) + '</b></div><div class="page-thread">' + threadHtml(u, pageConv, pageExpanded) + '</div>'
      : '<div class="empty-note big"><b>' + t('msg.empty') + '</b><br><span>' + t('msg.emptySub') + '</span><br><br><button class="btn primary" id="pageMsgStart" type="button">' + t('msg.start') + '</button></div>') +
    '</div></div>';
  $$('#view-mensajes [data-conv]').forEach(b => b.addEventListener('click', () => { pageConv = b.dataset.conv; pageExpanded = false; renderMensajes(); }));
  const pick = () => {
    const friends = (u.friends || []).map(id => DB.users.find(x => x.id === id)).filter(Boolean).filter(o => !isBlockedEither(u, o));
    if (!friends.length) { toast(t('msg.noFriendsYet'), true); return; }
    pageConv = friends[0].id;
    if (friends.length > 1) { dockOpen = true; dockPick = true; renderDock(); return; }
    renderMensajes();
  };
  const nw = $('#pageMsgNew'); if (nw) nw.addEventListener('click', pick);
  const st = $('#pageMsgStart'); if (st) st.addEventListener('click', pick);
  const ps = $('#pageMsgSearch');
  if (ps) ps.addEventListener('input', () => { pageQuery = ps.value; renderMensajes(); const n = $('#pageMsgSearch'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } });
  wireThread($('#view-mensajes'), u, pageConv, () => renderMensajes());
}
function openConversationWith(otherId) {
  pageConv = otherId;
  location.hash = '#/mensajes';
  if ((location.hash || '') === '#/mensajes') renderMensajes();
}
// ---------------- Modal anadir amigo (pieza 3) ----------------
function openAddFriend() {
  const u = me();
  if (!u) { openAuth('register'); return; }
  $('#afErr').textContent = '';
  $('#afUser').value = '';
  $('#friendModal').classList.remove('hidden');
  setTimeout(() => { const i = $('#afUser'); if (i) i.focus(); }, 30);
}
function submitAddFriend() {
  const u = me();
  if (!u) return;
  const name = $('#afUser').value.trim().toLowerCase();
  const err = (k) => { $('#afErr').textContent = t(k); };
  const o = userByName(name);
  if (!o) return err('af.errNotFound');
  if (o.id === u.id) return err('af.errSelf');
  if (isBlockedEither(u, o)) return err('af.errBlocked');
  const rel = relation(u, o);
  if (rel === 'friends') return err('af.errFriends');
  if (rel === 'out') return err('af.errSent');
  if (rel === 'in') return err('af.errReceived');
  u.requestsOut = [...(u.requestsOut || []), o.id];
  o.requestsIn = [...(o.requestsIn || []), u.id];
  saveDb();
  paintReqBadge();
  $('#friendModal').classList.add('hidden');
  toast(t('toast.requestSent', { name: o.display }));
  if (!$('#view-friends').classList.contains('hidden')) renderFriends();
}

// ---------------- Inventario compartido (piezas 11 y 14) ----------------
const INV_CATS = ['Todos', 'Favoritos', 'Accesorios', 'Camisetas', 'Pantalones', 'Caras', 'Paquetes'];
let invState = { cat: 'Todos', q: '' };
function invFilteredItems(target) {
  const items = (target.inventory || []).map(id => CATALOG.find(i => i.id === id)).filter(Boolean);
  const q = invState.q.toLowerCase();
  return items.filter(it => {
    if (invState.cat === 'Favoritos' && !(target.favItems || []).includes(it.id)) return false;
    if (invState.cat !== 'Todos' && invState.cat !== 'Favoritos' && it.cat !== invState.cat) return false;
    if (q && !(it.name.toLowerCase().includes(q) || (it.creator || 'VORTX').toLowerCase().includes(q))) return false;
    return true;
  });
}
function inventoryHtml(target, own) {
  const items = invFilteredItems(target);
  return '<div class="chip-row">' + INV_CATS.map(c => '<button class="chip' + (invState.cat === c ? ' active' : '') + '" data-invcat="' + c + '" type="button">' + (c === 'Todos' ? t('inv.all') : c === 'Favoritos' ? t('inv.favorites') : c) + '</button>').join('') + '</div>' +
    '<div class="dock-search"><input id="invSearch" type="text" placeholder="' + t('inv.searchPh') + '" value="' + esc(invState.q) + '" autocomplete="off"></div>' +
    (items.length ? '<div class="item-grid dense">' + items.map(it => {
      const equipped = (target.avatar && target.avatar.equipped && Object.values(target.avatar.equipped).includes(it.id));
      const fav = (target.favItems || []).includes(it.id);
      return '<div class="item-card"><canvas data-invprev="' + it.id + '" width="300" height="300"></canvas>' +
        (own ? '<button class="wish-star' + (fav ? ' on' : '') + '" data-favitem="' + it.id + '" type="button" title="' + t('inv.fav') + '"><svg viewBox="0 0 24 24" width="17" height="17" fill="' + (fav ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l2.7 5.8 6.3.7-4.7 4.3 1.3 6.2L12 17l-5.6 3 1.3-6.2L3 9.5l6.3-.7z"/></svg></button>' : '') +
        '<div class="item-body"><span class="slot">' + esc(it.cat) + '</span><h3>' + esc(it.name) + '</h3>' +
        '<p class="by-line">' + t('inv.by', { name: esc(it.creator || 'VORTX') }) + '</p>' +
        '<div class="pass-foot"><span class="price">' + (it.price > 0 ? it.price + ' V-Coins' : t('inv.free')) + '</span><span class="owned-tag"><span class="brand-bolt owned-bolt" aria-hidden="true"></span>' + t('inv.owned') + '</span>' +
        (equipped ? '<span class="owned-tag">' + t('inv.equippedTag') + '</span>' : own ? '<a class="btn small" href="#/avatar">' + t('inv.goEquip') + '</a>' : '') +
        '</div></div></div>';
    }).join('') + '</div>' : '<div class="empty-note">' + t('inv.empty') + '</div>');
}
function wireInventory(root, target, rerender) {
  $$('[data-invcat]', root).forEach(b => b.addEventListener('click', () => { invState.cat = b.dataset.invcat; rerender(); }));
  const s = $('#invSearch', root);
  if (s) s.addEventListener('input', () => { invState.q = s.value; rerender(); const n = $('#invSearch', root); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } });
  $$('[data-invprev]', root).forEach(cv => { const it = CATALOG.find(i => i.id === cv.dataset.invprev); if (it) itemPreview(cv, it); });
  $$('[data-favitem]', root).forEach(b => b.addEventListener('click', () => {
    target.favItems = target.favItems || [];
    const i = target.favItems.indexOf(b.dataset.favitem);
    if (i >= 0) target.favItems.splice(i, 1); else target.favItems.push(b.dataset.favitem);
    saveDb(); rerender();
  }));
}
function renderInventario() {
  show('inventario');
  const u = me();
  if (!u) {
    $('#view-inventario').innerHTML = '<div class="empty-note">' + t('fr.login') + '<br><br><button class="btn primary" id="invLogin" type="button">' + t('c.enter') + '</button></div>';
    $('#invLogin').addEventListener('click', () => openAuth('register'));
    return;
  }
  $('#view-inventario').innerHTML = '<div class="sec-head"><h2>' + t('inv.title') + '</h2><span>' + esc(u.display) + '</span></div>' + inventoryHtml(u, true);
  wireInventory($('#view-inventario'), u, renderInventario);
}
// ---------------- Tienda de V-Coins (pieza 18) ----------------
// ---------------- Tienda de V-Coins (piezas 18 + 39) -------------
// Paquetes con precios reales en USD (decision del usuario, foto 76).
// El cobro aun NO esta conectado: la vista de pago lo declara y ningun
// paquete acredita monedas al pulsarlo. Cuando exista una cuenta de
// cobro, el proveedor llamara tras un pago verificado a la UNICA
// funcion de credito, acreditarCompraVerificada(), hoy sin llamadores.
const COIN_PACKS = [
  { id: 'pack_500', name: 'Pila de V-Coins', base: 500, bonus: 0, price: 4.99, tier: 1 },
  { id: 'pack_1050', name: 'Carga de V-Coins', base: 1000, bonus: 50, price: 9.99, tier: 2 },
  { id: 'pack_2200', name: 'Oleada de V-Coins', base: 2000, bonus: 200, price: 19.99, tier: 3 },
  { id: 'pack_5750', name: 'Condensador de V-Coins', base: 5000, bonus: 750, price: 49.99, tier: 4 },
  { id: 'pack_12000', name: 'Generador de V-Coins', base: 10000, bonus: 2000, price: 99.99, tier: 5 },
  { id: 'pack_25000', name: 'Reactor de V-Coins', base: 20000, bonus: 5000, price: 199.99, tier: 6 }
];
function coinPileSvg(tier) {
  // Monton de monedas del rayo dibujado por codigo (arte propio):
  // pilas de monedas moradas con el rayo en blanco; crece con el tier.
  const stacks = [[2], [2, 3], [3, 4, 2], [3, 5, 4, 2], [4, 6, 5, 3, 2], [5, 7, 6, 4, 3, 2]][Math.min(6, Math.max(1, tier)) - 1];
  const W = 150, coinW = 30, coinH = 11;
  const totalW = stacks.length * (coinW + 3);
  const x0 = (W - totalW) / 2;
  const maxH = Math.max(...stacks);
  const H = maxH * coinH + 16;
  let s = '<svg class="coin-pile" width="150" height="86" viewBox="0 0 ' + W + ' ' + Math.max(H, 40) + '" aria-hidden="true">';
  stacks.forEach((n, ci) => {
    for (let i = 0; i < n; i++) {
      const cx = x0 + ci * (coinW + 3) + coinW / 2;
      const cy = Math.max(H, 40) - 8 - i * coinH;
      s += '<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + (coinW / 2) + '" ry="' + (coinH / 2 + 2) + '" fill="#5b2a86" stroke="#a583d6" stroke-width="1.4"/>';
      if (i === n - 1) s += '<path d="M ' + (cx + 1.5) + ' ' + (cy - 5) + ' L ' + (cx - 3.4) + ' ' + (cy + 0.5) + ' L ' + (cx - 0.6) + ' ' + (cy + 0.5) + ' L ' + (cx - 1.5) + ' ' + (cy + 5) + ' L ' + (cx + 3.4) + ' ' + (cy - 0.5) + ' L ' + (cx + 0.6) + ' ' + (cy - 0.5) + ' Z" fill="#fff"/>';
    }
  });
  return s + '</svg>';
}
function starLineHtml(u) {
  return '<div class="star-line"><span>' + (u && u.star ? t('st.starYou', { name: '@' + esc(u.star) }) : t('st.starNone')) + '.</span>' +
    '<a href="#/ajustes/cuenta">' + t('st.starAdd') + '</a></div>';
}
function acreditarCompraVerificada(packId) {
  // UNICO punto de credito de compras con dinero real: lo llamara el
  // proveedor de pago SOLO tras verificar un cobro. Sin llamadores hoy.
  const u = me();
  const pack = COIN_PACKS.find(p => p.id === packId);
  if (!u || !pack) return false;
  const total = pack.base + pack.bonus;
  u.coins = (u.coins || 0) + total;
  u.tx = u.tx || [];
  u.tx.unshift({ at: new Date().toISOString(), label: 'Compra de V-Coins: ' + pack.name, amount: total });
  saveDb();
  updateTopbar();
  return true;
}
function renderTienda(packId) {
  show('tienda');
  const u = me();
  const pack = packId ? COIN_PACKS.find(p => p.id === packId) : null;
  if (pack) {
    const total = pack.base + pack.bonus;
    const bal = u ? (u.coins || 0) : 0;
    $('#view-tienda').innerHTML =
      '<div class="sec-head"><h2>' + t('shop.payTitle', { name: esc(pack.name) }) + '</h2></div>' +
      '<div class="panel-card" style="max-width:560px">' + coinPileSvg(pack.tier) +
      '<div class="tx-row"><span>' + esc(pack.name) + '</span><b>' + total.toLocaleString() + ' V-Coins</b></div>' +
      (pack.bonus ? '<div class="tx-row"><span>' + t('shop.bonus', { n: pack.bonus.toLocaleString() }) + '</span><b>' + pack.base.toLocaleString() + ' + ' + pack.bonus.toLocaleString() + '</b></div>' : '') +
      '<div class="tx-row"><span>' + t('shop.total') + '</span><b>US$' + pack.price.toFixed(2) + '</b></div>' +
      '<div class="tx-row"><span>' + t('shop.youHave') + '</span><b>' + bal + ' V-Coins</b></div>' +
      '<div class="tx-row"><span>' + t('shop.after') + '</span><b>' + (bal + total).toLocaleString() + ' V-Coins</b></div>' +
      '<p class="form-note" style="margin-top:12px">' + t('shop.payNote') + '</p>' +
      '<div style="display:flex;gap:8px;margin-top:12px"><a class="btn primary" href="#/tienda">' + t('shop.understood') + '</a></div></div>';
    return;
  }
  $('#view-tienda').innerHTML =
    '<div class="sec-head"><h2>' + t('shop.title') + '</h2></div>' +
    starLineHtml(u) +
    '<div class="panel-card store-balance"><span>' + t('store.balance') + '</span><b>' + (u ? (u.coins || 0) : 0) + ' V-Coins</b>' +
    '<p class="form-note">' + t('store.note') + '</p>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><a class="btn primary" href="#/canjear">' + t('store.goRedeem') + '</a>' +
    (u ? '<a class="btn" href="#/transacciones">' + t('store.goTx') + '</a>' : '<button class="btn" id="storeLogin" type="button">' + t('c.enter') + '</button>') + '</div></div>' +
    '<div class="sec-head"><h2>' + t('shop.title') + '</h2></div>' +
    '<div class="pack-grid">' + COIN_PACKS.map(p =>
      '<div class="panel-card pack-card">' + (p.bonus ? '<span class="pack-bonus">' + t('shop.bonus', { n: p.bonus.toLocaleString() }) + '</span>' : '') +
      coinPileSvg(p.tier) +
      '<span class="pack-name">' + esc(p.name) + '</span>' +
      '<span class="pack-coins"><span class="brand-bolt"></span>' + (p.base + p.bonus).toLocaleString() + '</span>' +
      '<a class="btn primary pack-price" href="#/tienda/' + p.id + '">US$' + p.price.toFixed(2) + '</a></div>').join('') + '</div>' +
    '<p class="shop-foot">' + t('shop.pricesUsd') + '</p>' +
    '<div class="panel-card"><h3>' + t('store.ways') + '</h3>' +
    ['store.wayWelcome', 'store.wayCodes', 'store.wayPasses', 'store.wayResale'].map(k => '<div class="tx-row"><span>' + t(k) + '</span></div>').join('') + '</div>';
  const sl = $('#storeLogin');
  if (sl) sl.addEventListener('click', () => openAuth('register'));
}
// ---------------- Transacciones (pieza 21) ----------------
function renderTransacciones() {
  show('transacciones');
  const u = me();
  if (!u) {
    $('#view-transacciones').innerHTML = '<div class="empty-note">' + t('fr.login') + '<br><br><button class="btn primary" id="trxLogin" type="button">' + t('c.enter') + '</button></div>';
    $('#trxLogin').addEventListener('click', () => openAuth('register'));
    return;
  }
  const txs = u.tx || [];
  $('#view-transacciones').innerHTML =
    '<div class="sec-head"><h2>' + t('trx.title') + '</h2><span>' + t('trx.note') + '</span></div>' +
    '<div class="panel-card">' + (txs.length ? txs.map(tx =>
      '<div class="tx-row"><span>' + esc(tx.label) + '<br><span class="form-note">' + new Date(tx.at).toLocaleString(currentLang()) + '</span></span>' +
      '<b class="' + (tx.amount > 0 ? 'tx-pos' : 'tx-neg') + '">' + (tx.amount > 0 ? '+' : '') + tx.amount + ' VC</b></div>').join('')
      : '<p class="form-note">' + t('trx.empty') + '</p>') + '</div>';
}
// ---------------- Descargar (pieza 17) ----------------
function renderDescargar() {
  show('descargar');
  const row = (name, desc, action) => '<div class="dl-row"><div class="grow"><b>' + name + '</b><span>' + desc + '</span></div>' + action + '</div>';
  $('#view-descargar').innerHTML =
    '<div class="dl-hero"><h1>' + t('dl.title') + '</h1><p>' + t('dl.sub') + '</p>' +
    '<a class="btn primary big" style="width:auto" href="#/">' + t('dl.playBrowser') + '</a></div>' +
    '<div class="sec-head"><h2>' + t('dl.allPlatforms') + '</h2></div>' +
    '<div class="panel-card">' +
    row(t('dl.web'), t('dl.webDesc'), '<a class="btn primary" href="https://vyxos-remote-1.onrender.com" target="_blank" rel="noopener">' + t('dl.open') + '</a>') +
    row(t('dl.windows'), t('dl.windowsDesc') + ' ' + t('dl.driveNote'), '<span style="display:flex;gap:8px"><a class="btn" href="https://vyxos-remote-1.onrender.com" target="_blank" rel="noopener">' + t('dl.liveSite') + '</a><a class="btn" href="https://github.com/jairon9987-glitch/VyxOS-Remote" target="_blank" rel="noopener">' + t('dl.repo') + '</a></span>') +
    row(t('dl.android'), t('dl.androidDesc') + ' ' + t('dl.driveNote'), '<span style="display:flex;gap:8px"><a class="btn" href="https://vyxos-remote-1.onrender.com" target="_blank" rel="noopener">' + t('dl.liveSite') + '</a><a class="btn" href="https://github.com/jairon9987-glitch/VyxOS-Remote" target="_blank" rel="noopener">' + t('dl.repo') + '</a></span>') +
    '</div>';
}
// ---------------- Paginas legales (pieza 7) ----------------
const LEGAL_PAGES = {
  terminos: { title: 'legal.termsT', paras: ['legal.terms1', 'legal.terms2', 'legal.terms3'] },
  privacidad: { title: 'legal.privacyT', paras: ['legal.priv1', 'legal.priv2', 'legal.priv3'] },
  reglas: { title: 'legal.rulesT', paras: ['legal.rules1', 'legal.rules2', 'legal.rules3'] },
  creadores: { title: 'legal.creatorsT', paras: ['legal.crea1', 'legal.crea2', 'legal.crea3'] }
};
function renderLegal(slug) {
  const page = LEGAL_PAGES[slug] || LEGAL_PAGES.terminos;
  show('legal');
  $('#view-legal').innerHTML =
    '<div class="sec-head"><h2>' + t(page.title) + '</h2></div>' +
    '<div class="panel-card legal-body">' + page.paras.map(k => '<p>' + t(k) + '</p>').join('') +
    '<p style="margin-top:16px"><a class="btn" href="#/">' + t('legal.back') + '</a></p></div>';
}
// ---------------- Canjear codigo a pantalla completa (pieza 20) ----------------
function redeemCode(u, code) {
  const promo = PROMO_CODES.find(p => p.code === code);
  if (!promo) return { ok: false, key: 'toast.codeBad' };
  u.redeemed = u.redeemed || [];
  if (u.redeemed.some(r => r.code === code)) return { ok: false, key: 'toast.codeUsed' };
  u.redeemed.push({ code, coins: promo.coins, at: new Date().toISOString() });
  u.coins = (u.coins || 0) + promo.coins;
  u.tx = u.tx || [];
  u.tx.unshift({ at: new Date().toISOString(), label: promo.label, amount: promo.coins });
  saveDb();
  updateTopbar();
  return { ok: true, key: 'toast.codeOk', n: promo.coins };
}
function renderCodes() {
  show('codes');
  const u = me();
  if (!u) {
    $('#view-codes').innerHTML = '<div class="empty-note">' + t('codes.login') + '<br><br><button class="btn primary" id="codeLogin" type="button">' + t('c.enter') + '</button></div>';
    $('#codeLogin').addEventListener('click', () => openAuth('register'));
    return;
  }
  const redeemed = u.redeemed || [];
  $('#view-codes').innerHTML =
    '<div class="redeem-hero"><h1>' + t('redeem.title') + '</h1><p>' + t('redeem.sub') + '</p>' +
    '<form id="codeForm" class="code-form big"><input id="codeInput" type="text" maxlength="24" placeholder="' + t('codes.ph') + '" autocomplete="off"><button class="btn primary" type="submit">' + t('redeem.btn') + '</button></form>' +
    '<p class="form-note" style="margin-top:18px">' + t('redeem.noCodeQ') + ' <a href="https://discord.gg/8nYDeZSmnT" target="_blank" rel="noopener" style="color:var(--accent2)">' + t('redeem.discord') + '</a></p></div>' +
    (redeemed.length ? '<div class="panel-card"><h3>' + t('codes.done') + '</h3>' + redeemed.map(r => '<div class="tx-row"><span>' + esc(r.code) + '</span><b>+' + r.coins + ' VC</b></div>').join('') + '</div>' : '');
  $('#codeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#codeInput').value.trim().toUpperCase();
    const r = redeemCode(u, code);
    if (!r.ok) { toast(t(r.key), true); return; }
    toast(t('toast.codeOk', { n: r.n }));
    renderCodes();
  });
}

// ---------------- Temas (pieza 22, Apariencia) ----------------
// Oleada 4: el tema por defecto (sin preferencia guardada) es el
// oscuro del censo; «Sistema» sigue disponible en Ajustes.
const THEME_KEY = 'vortx_theme_v1';
function themePref() { try { return localStorage.getItem(THEME_KEY) || 'oscuro'; } catch (e) { return 'oscuro'; } }
function applyTheme() {
  let pref = themePref();
  // Migracion: el modo claro de la oleada 2 vivia en el ajuste de accesibilidad.
  try {
    if (!localStorage.getItem(THEME_KEY) && loadA11y().light) { pref = 'claro'; localStorage.setItem(THEME_KEY, 'claro'); }
  } catch (e) {}
  const sysLight = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.body.classList.toggle('theme-light', pref === 'claro' || (pref === 'sistema' && sysLight));
  document.body.classList.toggle('theme-darker', pref === 'masoscuro');
}
if (window.matchMedia) {
  try { window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (themePref() === 'sistema') applyTheme(); }); } catch (e) {}
}
// ---------------- Accesibilidad (web) ----------------
const A11Y_KEY = 'vortx_a11y_v1';
function loadA11y() {
  try { return Object.assign({ night: false, gray: false, big: false, light: false }, JSON.parse(localStorage.getItem(A11Y_KEY) || '{}')); }
  catch (e) { return { night: false, gray: false, big: false, light: false }; }
}
function applyA11y() {
  const a = loadA11y();
  document.body.classList.toggle('a11y-night', !!a.night);
  document.body.classList.toggle('a11y-gray', !!a.gray);
  document.body.classList.toggle('a11y-big', !!a.big);
}
function a11yPanelHtml() {
  const a = loadA11y();
  const row = (key, label) => '<div class="tx-row"><span>' + label + '</span><button class="btn small' + (a[key] ? ' primary' : '') + '" data-a11y="' + key + '" type="button">' + (a[key] ? t('a11y.on') : t('a11y.off')) + '</button></div>';
  return '<div class="panel-card">' + row('night', t('a11y.night')) + row('gray', t('a11y.gray')) + row('big', t('a11y.big')) + '</div>';
}
function wireA11y(root, rerender) {
  $$('[data-a11y]', root).forEach(b => b.addEventListener('click', () => {
    const a = loadA11y();
    a[b.dataset.a11y] = !a[b.dataset.a11y];
    try { localStorage.setItem(A11Y_KEY, JSON.stringify(a)); } catch (e) {}
    applyA11y();
    rerender();
  }));
}
// ---------------- Notificaciones (pieza 22) ----------------
let audioCtx = null;
function playNotifSound(kind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioCtx;
    const now = ctx.currentTime;
    const tone = (freq, t0, dur, type, gain) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(gain || 0.12, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    };
    if (kind === 'chime') { tone(880, now, 0.18); tone(1174, now + 0.12, 0.28); }
    else if (kind === 'bell') { tone(1568, now, 0.5, 'triangle', 0.1); tone(2093, now, 0.35, 'sine', 0.05); }
    else { tone(660, now, 0.1, 'sine', 0.14); tone(990, now + 0.07, 0.14, 'sine', 0.1); }
  } catch (e) {}
}
let notifBaseline = null;
function notifWatcherTick() {
  const u = me();
  if (!u) { notifBaseline = null; return; }
  const total = totalUnread(u) + (u.requestsIn || []).length;
  if (notifBaseline === null) { notifBaseline = total; return; }
  if (total > notifBaseline && !(u.notif && u.notif.dnd)) playNotifSound((u.notif && u.notif.sound) || 'pop');
  notifBaseline = total;
}
// ---------------- Ajustes (pieza 22) ----------------
let setTab = 'cuenta', blockQuery = '';
function pwFormHtml() {
  return '<form id="setPwForm" class="form-grid"><h3>' + t('set.changePw') + '</h3>' +
    '<label>' + t('set.currentPw') + ' <input id="pwCur" type="password" autocomplete="current-password" required></label>' +
    '<label>' + t('set.newPw') + ' <input id="pwNew" type="password" autocomplete="new-password" required></label>' +
    '<p class="form-err" id="pwErr"></p>' +
    '<button class="btn primary" type="submit">' + t('set.changePw') + '</button></form>';
}
function wirePwForm(root, rerender) {
  const f = $('#setPwForm', root);
  if (!f) return;
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const u = me();
    const err = $('#pwErr', root);
    if (!u) return;
    if (u.pass !== hashPw($('#pwCur', root).value)) { err.textContent = t('set.errWrongPw'); return; }
    const nw = $('#pwNew', root).value;
    if (nw.length < 4) { err.textContent = t('auth.errPassShort'); return; }
    u.pass = hashPw(nw);
    saveDb();
    toast(t('set.pwChanged'));
    rerender();
  });
}
function myReportsHtml(u) {
  const mine = (DB.reports || []).filter(r => r.by === u.id);
  return '<div class="panel-card"><h3>' + t('set.myReports') + '</h3>' +
    (mine.length ? mine.map(r => '<div class="tx-row"><span>' + esc(r.label) + '<br><span class="form-note">' + esc(r.reason) + ' · ' + new Date(r.at).toLocaleString(currentLang()) + '</span></span></div>').join('')
      : '<p class="form-note">' + t('set.noReports') + '</p>') + '</div>';
}
function renderAjustes(tab) {
  if (tab) setTab = tab;
  show('ajustes');
  const u = me();
  if (!u) {
    $('#view-ajustes').innerHTML = '<div class="empty-note">' + t('fr.login') + '<br><br><button class="btn primary" id="setLogin" type="button">' + t('c.enter') + '</button></div>';
    $('#setLogin').addEventListener('click', () => openAuth('register'));
    return;
  }
  u.privacy = Object.assign({ profile: 'all', inventory: 'all', online: 'all', friends: 'all', wishlist: 'all', dm: 'friends', noGameChat: false }, u.privacy || {});
  u.notif = Object.assign({ dnd: false, sound: 'pop' }, u.notif || {});
  // Composicion de la foto 75 (pieza 39): sub-menu lateral con cuatro
  // entradas; las pestanas antiguas de la pieza 22 se pliegan dentro:
  // Privacidad vive en Seguridad y Privacidad, y Notificaciones,
  // Apariencia y Accesibilidad en Personalizacion.
  if (setTab === 'privacidad') setTab = 'seguridad';
  if (setTab === 'notificaciones' || setTab === 'apariencia' || setTab === 'accesibilidad') setTab = 'personalizacion';
  if (!['cuenta', 'seguridad', 'sesiones', 'personalizacion'].includes(setTab)) setTab = 'cuenta';
  const tabs = [['cuenta', t('set.tabAccount')], ['seguridad', t('st.secPriv')], ['sesiones', t('st.sessions')], ['personalizacion', t('st.personal')]];
  // Cuerpos plegados (pieza 39): Privacidad se pinta dentro de
  // Seguridad y Privacidad; Notificaciones + Apariencia + Accesibilidad
  // dentro de Personalizacion. Se calculan una vez y se reutilizan.
  let privBody = '';
  {
    const sel = (key, label, opts) => '<div class="tx-row"><span>' + label + '</span><select data-priv="' + key + '">' +
      opts.map(([v, l]) => '<option value="' + v + '"' + (u.privacy[key] === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></div>';
    const vis = [['all', t('priv.all')], ['friends', t('priv.friends')], ['none', t('priv.nobody')]];
    const blocked = (u.blocked || []).map(id => DB.users.find(x => x.id === id)).filter(Boolean);
    const bq = blockQuery.toLowerCase();
    const shownBlocked = blocked.filter(x => !bq || x.display.toLowerCase().includes(bq) || x.username.toLowerCase().includes(bq));
    privBody = '<div class="panel-card"><h3>' + t('set.tabPrivacy') + '</h3>' +
      sel('profile', t('priv.profile'), vis) + sel('inventory', t('priv.inventory'), vis) + sel('online', t('priv.online'), vis) +
      sel('friends', t('priv.friendsL'), vis) + sel('wishlist', t('priv.wishlist'), vis) +
      sel('dm', t('priv.dmWho'), [['friends', t('priv.friends')], ['none', t('priv.nobody')]]) +
      '<div class="tx-row"><span>' + t('priv.noGameChat') + '</span><button class="btn small' + (u.privacy.noGameChat ? ' primary' : '') + '" id="privChatTgl" type="button">' + (u.privacy.noGameChat ? t('a11y.on') : t('a11y.off')) + '</button></div></div>' +
      '<div class="panel-card"><h3>' + t('priv.blocked') + '</h3>' +
      '<form id="blockForm" class="code-form" style="max-width:none"><input id="blockInput" type="text" placeholder="' + t('priv.blockPh') + '" autocomplete="off"><button class="btn" type="submit">' + t('priv.block') + '</button></form>' +
      '<p class="form-err" id="blockErr"></p>' +
      '<div class="dock-search" style="margin-top:10px"><input id="blockSearch" type="text" placeholder="' + t('fr3.searchPh') + '" value="' + esc(blockQuery) + '" autocomplete="off"></div>' +
      (shownBlocked.length ? shownBlocked.map(x => '<div class="tx-row"><span>' + esc(x.display) + ' (@' + esc(x.username) + ')</span><button class="btn small" data-unblock="' + x.id + '" type="button">' + t('priv.unblock') + '</button></div>').join('')
        : '<p class="form-note">' + t('priv.noBlocked') + '</p>') + '</div>';
  }
  const notifBody = '<div class="panel-card"><h3>' + t('set.tabNotif') + '</h3>' +
    '<div class="tx-row"><span>' + t('ntf.dnd') + '</span><button class="btn small' + (u.notif.dnd ? ' primary' : '') + '" id="ntfDnd" type="button">' + (u.notif.dnd ? t('a11y.on') : t('a11y.off')) + '</button></div>' +
    '<div class="tx-row"><span>' + t('ntf.sound') + '</span><span><select id="ntfSound">' +
    [['pop', t('ntf.pop')], ['chime', t('ntf.chime')], ['bell', t('ntf.bell')]].map(([v, l]) => '<option value="' + v + '"' + (u.notif.sound === v ? ' selected' : '') + '>' + l + '</option>').join('') +
    '</select> <button class="btn small" id="ntfTest" type="button">' + t('ntf.listen') + '</button></span></div></div>';
  const aparBody = '<div class="panel-card"><h3>' + t('set.tabAppearance') + '</h3><div class="theme-grid">' +
    [['sistema', t('theme.system')], ['claro', t('theme.light')], ['oscuro', t('theme.dark')], ['masoscuro', t('theme.darker')]].map(([v, l]) =>
      '<button class="theme-card' + (themePref() === v ? ' sel' : '') + ' th-' + v + '" data-theme="' + v + '" type="button"><span class="theme-prev"></span>' + l + '</button>').join('') +
    '</div></div>';
  // Correccion oleada 4 (2026-11-14): el selector de idioma sale de
  // la barra superior y vive aqui, en Personalizacion, con el mismo
  // comportamiento de siempre (setLang: cambio al momento y
  // persistencia en vortx_lang).
  const langBody = '<div class="panel-card"><h3>' + t('lang.title') + '</h3>' +
    '<div class="tx-row"><span>' + t('lang.title') + '</span><select id="setLangSel">' +
    LANGS.map(l => '<option value="' + l.code + '"' + (currentLang() === l.code ? ' selected' : '') + '>' + l.name + '</option>').join('') +
    '</select></div></div>';
  const persBody = notifBody + aparBody + langBody + '<div class="panel-card"><h3>' + t('prof.a11y') + '</h3>' + a11yPanelHtml() + '</div>';
  let body = '';
  if (setTab === 'cuenta') {
    const maskEmail = (e) => { if (!e) return t('st.noEmail'); const [lo, dom] = e.split('@'); return esc(lo.slice(0, 3)) + '•••@' + esc(dom || ''); };
    const infoRow = (label, value, zoneId) =>
      '<div class="info-row"><div class="grow"><span class="info-label">' + label + '</span><b>' + value + '</b></div>' +
      '<button class="btn small" type="button" data-edit="' + zoneId + '">' + t('st.edit') + '</button></div>' +
      '<div class="edit-zone hidden" id="' + zoneId + '">';
    body = '<div class="panel-card"><h3>' + t('st.infoTitle') + '</h3>' +
      infoRow(t('set.username'), '@' + esc(u.username), 'ezUser') +
      '<form id="setUserForm" class="form-grid"><label>' + t('set.username') + ' <input id="setUsername" type="text" maxlength="16" value="' + esc(u.username) + '"></label>' +
      '<p class="form-note">' + ((u.pastNames || []).length ? t('prof3.pastNames') + ': ' + esc(u.pastNames.join(', ')) : t('prof3.noPastNames')) + '</p>' +
      '<p class="form-err" id="setUserErr"></p>' +
      '<button class="btn primary" type="submit">' + t('set.save') + '</button></form></div>' +
      infoRow(t('set.displayName'), esc(u.display), 'ezDisplay') +
      '<form id="setDisplayForm" class="form-grid"><label>' + t('set.displayName') + ' <input id="setDisplay" type="text" maxlength="24" value="' + esc(u.display) + '"></label>' +
      '<button class="btn primary" type="submit">' + t('set.save') + '</button></form></div>' +
      infoRow(t('st.email'), maskEmail(u.email), 'ezEmail') +
      '<form id="setEmailForm" class="form-grid"><label>' + t('st.emailNewPh') + ' <input id="setEmailNew" type="email" maxlength="64" value="' + esc(u.email || '') + '"></label>' +
      '<label>' + t('st.emailPassPh') + ' <input id="setEmailPass" type="password" autocomplete="current-password"></label>' +
      '<p class="form-note">' + t('st.emailNote') + '</p>' +
      '<p class="form-err" id="setEmailErr"></p>' +
      '<button class="btn primary" type="submit">' + t('set.save') + '</button></form></div>' +
      infoRow(t('auth.pass'), '••••••••', 'ezPass') + pwFormHtml() + '</div>' +
      '</div>' +
      '<div class="panel-card"><h3>' + t('st.starTitle') + '</h3>' +
      '<p>' + (u.star ? t('st.starYou', { name: '@' + esc(u.star) }) : t('st.starNone')) + '</p>' +
      '<form id="starForm" class="code-form" style="max-width:none"><input id="starInput" type="text" placeholder="' + t('st.starPh') + '" autocomplete="off" value="' + esc(u.star || '') + '">' +
      '<button class="btn primary" type="submit">' + (u.star ? t('st.starChange') : t('st.starAdd')) + '</button>' +
      (u.star ? '<button class="btn" id="starRemove" type="button">' + t('st.starRemove') + '</button>' : '') + '</form>' +
      '<p class="form-err" id="starErr"></p>' +
      '<p class="form-note">' + t('st.starNote') + '</p></div>' +
      '<div class="panel-card danger-zone"><h3>' + t('st.danger') + '</h3>' +
      '<div class="tx-row"><span><b>' + t('st.deact') + '</b><br><span class="form-note">' + t('st.deactDesc') + '</span></span>' +
      '<button class="btn danger-o" id="deactBtn" type="button">' + t('st.deactBtn') + '</button></div>' +
      '<div class="edit-zone hidden" id="deactZone"><form id="deactForm" class="form-grid">' +
      '<label>' + t('st.emailPassPh') + ' <input id="deactPass" type="password" autocomplete="current-password"></label>' +
      '<p class="form-err" id="deactErr"></p>' +
      '<button class="btn danger-o" type="submit">' + t('st.deactConfirm') + '</button></form></div>' +
      '<div class="tx-row"><span><b>' + t('set.deleteTitle') + '</b><br><span class="form-note">' + t('set.deleteWarn') + '</span></span></div>' +
      '<form id="setDeleteForm" class="form-grid"><label>' + t('set.deletePh') + ' <input id="setDeleteInput" type="text" autocomplete="off"></label>' +
      '<button class="btn danger" type="submit">' + t('set.deleteBtn') + '</button></form></div>';
  } else if (setTab === 'seguridad') {
    body = '<div class="panel-card">' + pwFormHtml() + '</div>' +
      '<div class="panel-card"><h3>' + t('set.sessionT') + '</h3><button class="btn" id="setLogout" type="button">' + t('c.logout') + '</button></div>' +
      myReportsHtml(u) + privBody;
  } else if (setTab === 'sesiones') {
    let keepOn = false;
    try { keepOn = !sessionStorage.getItem('vortx_tab_user') && !!JSON.parse(localStorage.getItem('vortx_db_v1') || '{}').session; } catch (e) {}
    body = '<div class="panel-card"><h3>' + t('st.curSession') + '</h3>' +
      '<div class="tx-row"><span>' + t('st.thisDevice') + '</span><b>' + (keepOn ? t('st.keepOn') : t('st.keepOff')) + '</b></div>' +
      '<div style="margin-top:12px"><button class="btn" id="setLogout" type="button">' + t('c.logout') + '</button></div></div>';
  } else if (setTab === 'personalizacion') {
    body = persBody;
  }
  $('#view-ajustes').innerHTML =
    '<div class="sec-head"><h2>' + t('set.title') + '</h2></div>' +
    '<div class="set-layout"><aside class="set-menu panel-card">' +
    '<div class="set-user"><img class="set-head" alt="" src="' + userHeadImg(u) + '"><div class="grow"><b>' + esc(u.display) + '</b><span>@' + esc(u.username) + '</span></div>' +
    '<button class="btn small" id="setMenuLogout" type="button">' + t('c.logout') + '</button></div>' +
    tabs.map(([k, l]) => '<button class="set-item' + (setTab === k ? ' active' : '') + '" data-settab="' + k + '" type="button">' + l + '</button>').join('') +
    '</aside><div class="set-content">' + body + '</div></div>';
  const root = $('#view-ajustes');
  $$('[data-settab]', root).forEach(b => b.addEventListener('click', () => { setTab = b.dataset.settab; renderAjustes(); }));
  wirePwForm(root, () => renderAjustes());
  const df = $('#setDisplayForm', root);
  if (df) df.addEventListener('submit', (e) => { e.preventDefault(); const v = $('#setDisplay', root).value.trim().slice(0, 24); if (v) { u.display = v; saveDb(); updateTopbar(); toast(t('set.nameSaved')); } renderAjustes(); });
  const uf = $('#setUserForm', root);
  if (uf) uf.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#setUserErr', root);
    const nv = $('#setUsername', root).value.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,16}$/.test(nv)) { err.textContent = t('auth.errUserFmt'); return; }
    if (nv === 'vortx') { err.textContent = t('toast.reserved'); return; }
    const taken = userByName(nv);
    if (taken && taken.id !== u.id) { err.textContent = t('auth.errUserTaken'); return; }
    if (nv !== u.username) {
      const old = u.username;
      u.pastNames = [...(u.pastNames || []), old];
      u.username = nv;
      DB.exps.forEach(x => { if (x.creator === old) x.creator = nv; });
      Object.values(DB.chats || {}).forEach(list => list.forEach(m => { if (m.u === old) m.u = nv; }));
      (DB.groups || []).forEach(g => (g.wall || []).forEach(w => { if (w.u === old) w.u = nv; }));
      saveDb();
      updateTopbar();
      toast(t('set.nameSaved'));
    }
    renderAjustes();
  });
  const dlf = $('#setDeleteForm', root);
  if (dlf) dlf.addEventListener('submit', (e) => {
    e.preventDefault();
    if ($('#setDeleteInput', root).value.trim() !== u.username) { toast(t('set.errDeleteName'), true); return; }
    const myId = u.id;
    DB.users = DB.users.filter(x => x.id !== myId);
    DB.users.forEach(x => {
      x.friends = (x.friends || []).filter(id => id !== myId);
      x.following = (x.following || []).filter(id => id !== myId);
      x.requestsIn = (x.requestsIn || []).filter(id => id !== myId);
      x.requestsOut = (x.requestsOut || []).filter(id => id !== myId);
      x.blocked = (x.blocked || []).filter(id => id !== myId);
    });
    (DB.groups || []).forEach(g => { g.members = g.members.filter(id => id !== myId); g.admins = (g.admins || []).filter(id => id !== myId); });
    clearSession();
    saveDb();
    updateTopbar();
    toast(t('set.deleted'));
    location.hash = '#/';
  });
  const lo2 = $('#setLogout', root);
  if (lo2) lo2.addEventListener('click', () => openLogoutConfirm());
  $$('[data-priv]', root).forEach(s => s.addEventListener('change', () => { u.privacy[s.dataset.priv] = s.value; saveDb(); toast(t('set.nameSaved')); }));
  const pct = $('#privChatTgl', root);
  if (pct) pct.addEventListener('click', () => { u.privacy.noGameChat = !u.privacy.noGameChat; saveDb(); renderAjustes(); });
  const bf = $('#blockForm', root);
  if (bf) bf.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#blockErr', root);
    const target = userByName($('#blockInput', root).value.trim());
    if (!target) { err.textContent = t('af.errNotFound'); return; }
    if (target.id === u.id) { err.textContent = t('af.errSelf'); return; }
    blockUser(u, target);
    renderAjustes();
  });
  $$('[data-unblock]', root).forEach(b => b.addEventListener('click', () => { u.blocked = (u.blocked || []).filter(id => id !== b.dataset.unblock); saveDb(); renderAjustes(); }));
  const bs = $('#blockSearch', root);
  if (bs) bs.addEventListener('input', () => { blockQuery = bs.value; renderAjustes(); const n = $('#blockSearch', root); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } });
  const nd = $('#ntfDnd', root);
  if (nd) nd.addEventListener('click', () => { u.notif.dnd = !u.notif.dnd; saveDb(); renderAjustes(); });
  const nsel = $('#ntfSound', root);
  if (nsel) nsel.addEventListener('change', () => { u.notif.sound = nsel.value; saveDb(); });
  const nt = $('#ntfTest', root);
  if (nt) nt.addEventListener('click', () => playNotifSound(u.notif.sound || 'pop'));
  $$('[data-theme]', root).forEach(b => b.addEventListener('click', () => {
    try { localStorage.setItem(THEME_KEY, b.dataset.theme); } catch (e) {}
    applyTheme();
    renderAjustes();
  }));
  const lsel = $('#setLangSel', root);
  if (lsel) lsel.addEventListener('change', () => setLang(lsel.value));
  if (setTab === 'personalizacion') wireA11y(root, () => renderAjustes());
  const ml = $('#setMenuLogout', root);
  if (ml) ml.addEventListener('click', () => openLogoutConfirm());
  $$('[data-edit]', root).forEach(b => b.addEventListener('click', () => {
    const z = document.getElementById(b.dataset.edit);
    if (z) z.classList.toggle('hidden');
  }));
  const db2 = $('#deactBtn', root);
  if (db2) db2.addEventListener('click', () => { const z = $('#deactZone', root); if (z) z.classList.toggle('hidden'); });
  const dcf = $('#deactForm', root);
  if (dcf) dcf.addEventListener('submit', (e) => {
    e.preventDefault();
    if (u.pass !== hashPw($('#deactPass', root).value)) { $('#deactErr', root).textContent = t('st.errPass'); return; }
    u.disabled = true;
    saveDb();
    toast(t('st.deacted'));
    doLogout();
  });
  const ef = $('#setEmailForm', root);
  if (ef) ef.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#setEmailErr', root);
    if (u.pass !== hashPw($('#setEmailPass', root).value)) { err.textContent = t('st.errPass'); return; }
    const email = $('#setEmailNew', root).value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err.textContent = t('st.errEmailFmt'); return; }
    if (DB.users.some(x => x.id !== u.id && (x.email || '').toLowerCase() === email)) { err.textContent = t('st.errEmailTaken'); return; }
    u.email = email;
    saveDb();
    toast(t('st.emailSaved'));
    renderAjustes();
  });
  const sf = $('#starForm', root);
  if (sf) sf.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#starErr', root);
    const name = $('#starInput', root).value.trim().toLowerCase();
    const target = userByName(name);
    if (!target) { err.textContent = t('st.errStarNotFound'); return; }
    if (target.id === u.id) { err.textContent = t('st.errStarSelf'); return; }
    u.star = target.username;
    saveDb();
    toast(t('st.starSaved'));
    renderAjustes();
  });
  const sr = $('#starRemove', root);
  if (sr) sr.addEventListener('click', () => { delete u.star; saveDb(); renderAjustes(); });
}
// ---------------- Barra de titulo del caparazon (pieza 37) -------
// Solo dentro de la app de PC: el caparazon Rust marca la ventana con
// window.__vortxShell antes de cargar y la deja sin marco; esta barra
// fina pone los tres circulos estilo macOS a la izquierda y una zona
// de arrastre. Sin el marcador no se crea nada (navegador y APK sin
// cambios). Los botones hablan con el caparazon por window.ipc.
function initShellBar() {
  if (!window.__vortxShell || document.getElementById('shellBar')) return;
  const post = (m) => { try { if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(m); } catch (e) {} };
  const bar = document.createElement('div');
  bar.id = 'shellBar';
  bar.innerHTML = '<div class="shell-btns">' +
    '<button class="shell-btn close" type="button" data-win="close" aria-label="Cerrar"><span>×</span></button>' +
    '<button class="shell-btn min" type="button" data-win="minimize" aria-label="Minimizar"><span>−</span></button>' +
    '<button class="shell-btn max" type="button" data-win="maximize" aria-label="Maximizar"><span>+</span></button>' +
    '</div><div class="shell-drag"></div>';
  document.body.prepend(bar);
  document.body.classList.add('has-shellbar');
  bar.querySelectorAll('[data-win]').forEach(b => b.addEventListener('click', () => post('vortx-win:' + b.dataset.win)));
  const drag = bar.querySelector('.shell-drag');
  drag.addEventListener('mousedown', () => post('vortx-win:drag'));
  drag.addEventListener('dblclick', () => post('vortx-win:maximize'));
  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('shell-fs', !!document.fullscreenElement);
  });
}
// ---------------- Pantalla de arranque ----------------
// Baldosas flotantes de la pantalla de carga del sitio: reusan las
// portadas que ya generan las tarjetas de Descubrir (coverStyle +
// letra, o la imagen de portada si la experiencia trae una).
function buildBootTiles() {
  const box = document.getElementById('bootTiles');
  const scr = document.getElementById('bootScreen');
  if (!box || !scr) return;
  try {
    const s = JSON.parse(localStorage.getItem('vortx_settings_v1') || '{}');
    if (s && s.reduceMotion) scr.classList.add('still');
  } catch (e) { /* sin ajustes guardados: flotación normal */ }
  const spots = [
    { l: '3%', t: '7%', r: -11, w: 168 }, { l: '21%', t: '2%', r: 7, w: 132 },
    { l: '64%', t: '3%', r: 10, w: 148 }, { l: '83%', t: '11%', r: -7, w: 172 },
    { l: '1%', t: '57%', r: 8, w: 148 }, { l: '14%', t: '76%', r: -6, w: 124 },
    { l: '72%', t: '74%', r: 9, w: 140 }, { l: '85%', t: '55%', r: -10, w: 156 }
  ];
  const pub = DB.exps.filter(e => e.published !== false);
  if (!pub.length) return;
  box.innerHTML = spots.map((sp, i) => {
    const e = pub[i % pub.length];
    return '<div class="boot-tile" style="left:' + sp.l + ';top:' + sp.t + ';width:' + sp.w + 'px;--rot:' + sp.r + 'deg;--d:' + (7 + (i % 4)) + 's;--dl:' + (-i * 1.3) + 's">' +
      '<div class="bt-cover" style="' + coverStyle(e) + '">' + (e.cover ? '' : '<span class="cover-letter">' + esc((e.name || 'V')[0]) + '</span>') + '</div>' +
      '<div class="bt-name">' + esc(e.name) + '</div></div>';
  }).join('');
}

// ---------------- QuickNav ----------------
function qnItems() {
  const base = [
    { label: t('nav.discover'), hint: t('qn.discoverHint'), go: '#/' },
    { label: t('nav.marketplace'), hint: t('qn.marketHint'), go: '#/marketplace' },
    { label: t('av.title'), hint: t('nav.avatar'), go: '#/avatar' },
    { label: t('qn.invLabel'), hint: t('qn.invHint'), go: '#/inventario' },
    { label: t('qn.friendsLabel'), hint: t('nav.friends'), go: '#/friends' },
    { label: t('qn.groupsLabel'), hint: t('nav.groups'), go: '#/groups' },
    { label: t('nav.hub'), hint: t('hub.createBtn'), go: '#/hub' },
    { label: t('qn.profileLabel'), hint: t('qn.profileHint'), go: '#/profile' },
    { label: t('menu.settings'), hint: t('qn.setHint'), go: '#/ajustes' },
    { label: t('codes.title'), hint: t('qn.codesHint'), go: '#/codes' },
    { label: t('tr.title'), hint: t('qn.tradesHint'), go: '#/trades' },
    { label: t('side.messages'), hint: '', go: '#/mensajes' },
    { label: t('side.store'), hint: '', go: '#/tienda' },
    { label: t('chip.transactions'), hint: '', go: '#/transacciones' },
    { label: t('side.download'), hint: '', go: '#/descargar' }
  ];
  for (const e of DB.exps.filter(x => x.published !== false)) base.push({ label: e.name, hint: t('qn.expHint', { name: e.creator }), go: '#/exp/' + e.id });
  for (const g of DB.groups || []) base.push({ label: g.name, hint: t('qn.groupHint'), go: '#/grupo/' + g.id });
  return base;
}
let qnCurrent = [];
let qnSel = 0;
function paintQnSel() {
  $$('#qnList [data-qn]').forEach(b => {
    const on = Number(b.dataset.qn) === qnSel;
    b.classList.toggle('sel', on);
    if (on) b.scrollIntoView({ block: 'nearest' });
  });
}
function renderQnList(q) {
  const nq = normText(q).trim();
  const items = qnItems().filter(i => !nq || normText(i.label).includes(nq) || normText(i.hint).includes(nq));
  $('#qnList').innerHTML = items.length
    ? items.map((i, ix) => '<button class="qn-item" data-qn="' + ix + '" type="button"><b>' + esc(i.label) + '</b><span>' + esc(i.hint) + '</span></button>').join('')
    : '<div class="empty-note">' + t('qn.none') + '</div>';
  qnSel = 0;
  $$('#qnList [data-qn]').forEach(b => {
    b.addEventListener('click', () => {
      const it = items[Number(b.dataset.qn)];
      closeQuickNav();
      if (it) location.hash = it.go;
    });
    b.addEventListener('mouseenter', () => { qnSel = Number(b.dataset.qn); paintQnSel(); });
  });
  paintQnSel();
  return items;
}
function openQuickNav() {
  $('#quickNav').classList.remove('hidden');
  $('#qnInput').value = '';
  qnCurrent = renderQnList('');
  setTimeout(() => $('#qnInput').focus(), 30);
}
function closeQuickNav() { $('#quickNav').classList.add('hidden'); }
// Correccion oleada 4 (2026-11-14): el boton «Ir a…» (#quickNavBtn)
// salio de la barra superior; el modal de navegacion rapida queda en
// el codigo sin ningun elemento visible que lo abra (solo Ctrl+K).
const qnBtn = $('#quickNavBtn');
if (qnBtn) qnBtn.addEventListener('click', openQuickNav);
// Boton de tema de la barra superior (oleada 4): alterna entre el
// oscuro del censo y el claro usando la misma preferencia guardada
// que la pestana de Apariencia de Ajustes (vortx_theme_v1).
$('#themeBtn').addEventListener('click', () => {
  const next = document.body.classList.contains('theme-light') ? 'oscuro' : 'claro';
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  applyTheme();
});
$('#qnClose').addEventListener('click', closeQuickNav);
$('#quickNav').addEventListener('click', (e) => { if (e.target.id === 'quickNav') closeQuickNav(); });
$('#qnInput').addEventListener('input', (e) => { qnCurrent = renderQnList(e.target.value); });
$('#qnInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!qnCurrent.length) return;
    qnSel = (qnSel + (e.key === 'ArrowDown' ? 1 : -1) + qnCurrent.length) % qnCurrent.length;
    paintQnSel();
  } else if (e.key === 'Enter' && qnCurrent.length) {
    const it = qnCurrent[Math.min(qnSel, qnCurrent.length - 1)];
    closeQuickNav();
    if (it) location.hash = it.go;
  } else if (e.key === 'Escape') closeQuickNav();
});
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') { e.preventDefault(); openQuickNav(); }
});

window.addEventListener('vortx-lang', () => { updateTopbar(); route(); });
// Hitos reales de la pantalla de arranque: datos locales ya cargados
// (la DB se lee al evaluar este módulo), textos e interfaz, y primera
// vista pintada; la pantalla se retira tras dos frames completos.
if (window.__bootSet) window.__bootSet(35);
initShellBar();
buildBootTiles();
applyA11y();
applyTheme();
initI18n();
if (window.__bootSet) window.__bootSet(60);
wireAuth();
updateTopbar();
renderDock();
paintMsgBadges();
setInterval(notifWatcherTick, 5000);
route();
if (window.__bootSet) window.__bootSet(85);
requestAnimationFrame(() => requestAnimationFrame(() => { if (window.__bootDone) window.__bootDone(); }));
