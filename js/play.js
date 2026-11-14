// VORTX — motor de juego en el navegador (Three.js).
// Mundo de piezas con colisiones reales, personaje R6 del jugador con
// su avatar guardado, cámara en tercera persona, controles de teclado,
// ratón, táctil y mando. Sin jugadores falsos: la lista muestra solo
// a quien está jugando de verdad. El multijugador en línea (Fase 4)
// usa Supabase Realtime: presencia y posiciones reales por broadcast.
import * as THREE from '../vendor/three.module.js';
import { buildRig } from './rig.js';
import { createAnimator } from './anim.js';
import { TEMPLATES, PALETTE } from './data.js';
import { STUDS_B64, STUD_CELL } from './studs-data.js';
import { VORTX_WASM_B64 } from './wasm-data.js';
import { connectRoom } from './net.js';
import { t } from './i18n.js';
import { createLuaRuntime } from './lua.js';

// Nucleo de optimizacion en Rust (WebAssembly): fisica y particulas.
// Si el WASM no carga en algun navegador, el motor usa el JS de siempre.
let CORE = null;
try {
  const wasmBytes = Uint8Array.from(atob(VORTX_WASM_B64), (c) => c.charCodeAt(0));
  WebAssembly.instantiate(wasmBytes, {}).then((r) => {
    CORE = r.instance.exports;
    window.__vortxCore = 'rust-wasm';
  }).catch(() => {});
} catch (e) { /* sin WASM: respaldo en JS */ }

let session = null;

export function stopExperience() {
  document.body.classList.remove('playing');
  window.__vortxLangHook = null;
  if (!session) return;
  if (document.pointerLockElement) document.exitPointerLock();
  session.dead = true;
  cancelAnimationFrame(session.raf);
  window.removeEventListener('keydown', session.onKeyDown);
  if (session.onBlur) { window.removeEventListener('blur', session.onBlur); window.removeEventListener('focus', session.onFocus); document.removeEventListener('visibilitychange', session.onVis); }
  window.removeEventListener('keyup', session.onKeyUp);
  if (session.netClose) { try { session.netClose(); } catch (e) {} }
  if (session.luaRuntime) { try { session.luaRuntime.destroy(); } catch (e) {} session.luaRuntime = null; }
  window.__vortxLua = null;
  if (session.audio) session.audio.dispose();
  session.renderer.dispose();
  session = null;
}

const PERK_LABELS = { speed: 'Velocidad +50%', jump: 'Super salto', badge: 'Insignia de apoyo' };

// Owners de la plataforma (corrección del usuario, 2026-11-14): SOLO
// estas cuentas (username, sin distinguir mayúsculas) pueden usar los
// comandos de admin en partida (/fly, /speed, /freeze, /unfreeze,
// /ban). Ni el creador de la experiencia ni la cuenta oficial VORTX
// tienen poderes. /close es para todos los jugadores.
const OWNER_USERS = ['ethera', 'noobz'];
function isOwnerUser(name) {
  return !!name && OWNER_USERS.indexOf(String(name).toLowerCase()) >= 0;
}

const SETTINGS_DEFAULTS = {
  camMode: 'libre', camInv: false, moveMode: 'fijo',
  showNames: true, showEmblems: true, multi: true,
  gfxMode: 'manual', gfxQ: 6, gfxProfile: 'equilibrio', haptics: true, reduceMotion: false,
  volume: 8, menuAlpha: 90, textSize: 2, sens: 1,
  fpsCap: 0, fov: 62, sfxVol: 10, musicVol: 10, muteBlur: true, shiftLock: true,
  showBoard: true
};
function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem('vortx_settings_v1') || 'null');
    if (!raw) {
      // Primera vez en este navegador: en pantallas tactiles el modo de
      // graficos arranca en Automatico (resolucion dinamica). Si ya hay
      // ajustes guardados, la eleccion del usuario manda y no se toca.
      const first = Object.assign({}, SETTINGS_DEFAULTS);
      if (('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0) first.gfxMode = 'auto';
      return first;
    }
    return Object.assign({}, SETTINGS_DEFAULTS, raw);
  } catch (e) { return Object.assign({}, SETTINGS_DEFAULTS); }
}
function saveSettings(st) {
  try { localStorage.setItem('vortx_settings_v1', JSON.stringify(st)); } catch (e) {}
}

function fmtTime(t) {
  const m = Math.floor(t / 60), ss = t - m * 60;
  const sec = Math.floor(ss);
  return (m > 0 ? m + ':' + String(sec).padStart(2, '0') : String(sec)) + '.' + Math.floor((ss % 1) * 10);
}
function fmtClock(t) {
  const m = Math.floor(t / 60);
  return m + ':' + String(Math.floor(t % 60)).padStart(2, '0');
}

// Audio 100 % sintetizado con WebAudio: efectos (salto, muerte, victoria)
// y una almohadilla musical ambiental original (4 acordes en codigo).
// Sin archivos de audio de terceros.
function makeAudio() {
  let ctx = null, master = null, musicTimer = null, chordIdx = 0;
  let sfxBus = null, musicBus = null;
  const busLevels = { sfx: 1, music: 1 };
  const CHORDS = [[220.0, 261.63, 329.63], [174.61, 220.0, 261.63], [196.0, 246.94, 293.66], [164.81, 196.0, 261.63]];
  function ensure() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return true; }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination);
      sfxBus = ctx.createGain(); sfxBus.gain.value = busLevels.sfx; sfxBus.connect(master);
      musicBus = ctx.createGain(); musicBus.gain.value = busLevels.music; musicBus.connect(master);
      const playChord = () => {
        if (!ctx) return;
        const t0 = ctx.currentTime;
        for (const f of CHORDS[chordIdx % CHORDS.length]) {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'triangle'; o.frequency.value = f;
          g.gain.setValueAtTime(0, t0);
          g.gain.linearRampToValueAtTime(0.028, t0 + 1.2);
          g.gain.linearRampToValueAtTime(0, t0 + 4.2);
          o.connect(g); g.connect(musicBus || master); o.start(t0); o.stop(t0 + 4.3);
        }
        chordIdx++;
      };
      playChord();
      musicTimer = setInterval(playChord, 4000);
      return true;
    } catch (e) { return false; }
  }
  function tone(f0, f1, dur, vol, type, delay) {
    if (!ensure()) return;
    const t0 = ctx.currentTime + (delay || 0);
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(sfxBus || master); o.start(t0); o.stop(t0 + dur + 0.05);
  }
  let volLevel = 0.8, muted = false;
  function applyGain() { if (master) master.gain.value = muted ? 0 : volLevel * 0.6; }
  return {
    setVolume(v) { volLevel = v; applyGain(); },
    setBus(name, v) { busLevels[name] = v; if (name === 'sfx' && sfxBus) sfxBus.gain.value = v; if (name === 'music' && musicBus) musicBus.gain.value = v; },
    jump() { tone(320, 560, 0.14, 0.09, 'sine'); },
    death() { tone(300, 70, 0.35, 0.13, 'square'); },
    win() { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, f, 0.22, 0.09, 'sine', i * 0.11)); },
    shot() { tone(920, 240, 0.09, 0.06, 'square'); },
    swing() { tone(680, 170, 0.13, 0.05, 'triangle'); },
    hit() { tone(210, 80, 0.1, 0.1, 'square'); },
    ko() { [392, 523.25, 659.25].forEach((f, i) => tone(f, f, 0.16, 0.08, 'sine', i * 0.08)); },
    beep() { tone(1250, 1250, 0.05, 0.05, 'square'); },
    boom() { tone(160, 40, 0.5, 0.16, 'sawtooth'); tone(90, 30, 0.7, 0.12, 'square', 0.02); },
    unlock() { ensure(); },
    setMuted(m) { muted = m; applyGain(); },
    dispose() { if (musicTimer) clearInterval(musicTimer); if (ctx) { try { ctx.close(); } catch (e) {} } ctx = null; }
  };
}

export function startExperience(exp, user, catalog, onExit, chatApi) {
  stopExperience();
  const ownedHere = ((user && user.passes) || {})[exp.id] || [];
  const perkSet = new Set((exp.passes || []).filter(p => ownedHere.includes(p.id)).map(p => p.perk));
  const perkSpeed = perkSet.has('speed');
  const perkJump = perkSet.has('jump');
  const perkText = [...perkSet].map(p => PERK_LABELS[p] || p).join(' · ');
  // Consumibles de esta experiencia: unidades del jugador y efecto temporal.
  const consHere = ((user && user.consumables) || {})[exp.id] || {};
  const consCounts = {};
  for (const p of (exp.passes || []).filter(p => p.kind === 'consumable')) consCounts[p.id] = consHere[p.id] || 0;
  let fxSpeedUntil = -1, fxJumpUntil = -1;
  window.__vortxFx = () => ({ speed: S.t < fxSpeedUntil, jump: S.t < fxJumpUntil, counts: { ...consCounts } });
  window.__vortxPerks = [...perkSet];
  document.body.classList.add('playing');
  const overlay = document.getElementById('playOverlay');
  const loading = document.getElementById('playLoading');
  const hud = document.getElementById('hud');
  const pauseMenu = document.getElementById('pauseMenu');
  const fill = document.getElementById('loadFill');
  const loadText = document.getElementById('loadText');
  overlay.classList.remove('hidden');
  loading.classList.remove('hidden');
  hud.classList.add('hidden');
  pauseMenu.classList.add('hidden');
  fill.style.width = '12%';
  loadText.textContent = t('load.text');
  // Pantalla de carga (oleada 3, pieza 30): fondo = portada de ESTA
  // experiencia desenfocada y tarjeta con su portada, nombre y creador.
  const coverCss = exp.cover
    ? 'background-image:url("' + exp.cover + '");background-size:cover;background-position:center'
    : 'background:#' + (exp.hue || 0x3d1a5c).toString(16).padStart(6, '0');
  const plBg = document.getElementById('plBg');
  if (plBg) plBg.style.cssText = coverCss;
  const plCover = document.getElementById('plCover');
  if (plCover) plCover.style.cssText = coverCss;
  const plName = document.getElementById('plName');
  if (plName) plName.textContent = exp.name || '';
  const plBy = document.getElementById('plBy');
  if (plBy) plBy.textContent = t('c.by') + ' ' + (exp.creator || 'VORTX');

  const canvas = document.getElementById('gameCanvas');
  // Tope de resolucion: 1.5 en tactil (un Galaxy A14 tiene DPR ~3 y
  // renderizar a DPR completo es el mayor gasto de GPU en movil), 2 en
  // escritorio como hasta ahora.
  const IS_TOUCH = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
  const PR_CAP = IS_TOUCH ? 1.5 : 2;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, PR_CAP));
  // Render directo, sin pase de post-proceso: la escena se dibuja tal
  // cual con la resolucion dinamica (dynScale). El pase de «Escalado
  // nitido» (CAS, pieza 34) se retiro por orden del usuario el
  // 2026-11-14; los reflejos por entorno (PMREM) de la misma pieza
  // se quedan.
  renderer.info.autoReset = false;
  const gfxStats = { sceneCalls: 0, totalCalls: 0, tris: 0 };
  function renderFrame() {
    renderer.info.reset();
    renderer.render(scene, camera);
    gfxStats.sceneCalls = renderer.info.render.calls;
    gfxStats.totalCalls = gfxStats.sceneCalls;
    gfxStats.tris = renderer.info.render.triangles;
  }
  window.__vortxGfxInfo = () => ({
    sceneCalls: gfxStats.sceneCalls, totalCalls: gfxStats.totalCalls, tris: gfxStats.tris,
    geos: renderer.info.memory.geometries, texs: renderer.info.memory.textures,
    children: scene.children.length,
    heap: (performance.memory && performance.memory.usedJSHeapSize) || 0,
    pr: +renderer.getPixelRatio().toFixed(2)
  });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xdce6ee, 55, 185);

  // Cielo con shader propio: luz del cielo, disco solar y halo.
  const SUN_DIR = new THREE.Vector3(34, 38, 20).normalize();
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x9db8cc) },
      uBottom: { value: new THREE.Color(0xeef0f2) },
      uSunDir: { value: SUN_DIR },
      uSunColor: { value: new THREE.Color(0xfff3da) }
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'varying vec3 vDir; uniform vec3 uTop; uniform vec3 uBottom; uniform vec3 uSunDir; uniform vec3 uSunColor;',
      'void main(){',
      '  vec3 d = normalize(vDir);',
      '  float h = pow(max(d.y, 0.0), 0.55);',
      '  vec3 col = mix(uBottom, uTop, h);',
      '  float s = max(dot(d, uSunDir), 0.0);',
      '  col += uSunColor * (pow(s, 350.0) * 1.4 + pow(s, 24.0) * 0.16);',
      '  col += uSunColor * smoothstep(0.9995, 0.99985, s) * 2.2;',
      '  gl_FragColor = vec4(col, 1.0);',
      '}'
    ].join('\n')
  });
  // La cupula sigue a la camara (ver el bloque de cielo en frame()):
  // centrada en el origen, en mapas grandes la camara se alejaba de
  // ella y el plano lejano la recortaba: cielo negro (pieza 35).
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(320, 24, 16), skyMat);
  skyMesh.frustumCulled = false;
  scene.add(skyMesh);
  // Iluminacion de entorno generada del propio cielo (reflejos).
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 16, 12), skyMat));
    const gnd = new THREE.Mesh(new THREE.CircleGeometry(40, 16), new THREE.MeshBasicMaterial({ color: 0x8a8f96 }));
    gnd.rotation.x = -Math.PI / 2; gnd.position.y = -4;
    envScene.add(gnd);
    scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    pmrem.dispose();
  } catch (e) { /* sin entorno, la luz directa basta */ }

  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 400);

  const hemi = new THREE.HemisphereLight(0xdfe9f2, 0x3a3f45, 0.95);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffe3b3, 1.75);
  sun.position.copy(SUN_DIR).multiplyScalar(60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -44; sun.shadow.camera.right = 44;
  sun.shadow.camera.top = 44; sun.shadow.camera.bottom = -44;
  scene.add(sun);
  scene.add(sun.target);

  // Resplandor del sol SIN postprocesado (foto de referencia 2: sol
  // brillante de dia con halo): sprites aditivos con texturas generadas
  // por canvas. El halo es tan grande que su borde inferior se cuela al
  // mirar al horizonte; el nucleo con rayos corona el disco que ya
  // dibuja el shader del cielo. depthTest activo: las paredes tapan el
  // sol, como en la foto. Sustituye al bloom, que en movil no cabe.
  function radialGlowTex(size, stops) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [o, col] of stops) g.addColorStop(o, col);
    x.fillStyle = g; x.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(c);
  }
  const glowTex = radialGlowTex(256, [[0, 'rgba(255,250,235,1)'], [0.25, 'rgba(255,236,190,0.55)'], [0.6, 'rgba(255,214,140,0.16)'], [1, 'rgba(255,214,140,0)']]);
  const sunSpr = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffe9c4, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  sunSpr.position.copy(SUN_DIR).multiplyScalar(285);
  sunSpr.scale.set(200, 200, 1);
  sunSpr.frustumCulled = false;
  scene.add(sunSpr);
  const starTex = (() => {
    const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
    const x = c.getContext('2d'); const cx = s / 2;
    const spike = (ang, len, wid) => {
      const dx = Math.cos(ang), dy = Math.sin(ang), px = -dy, py = dx;
      const g = x.createLinearGradient(cx, cx, cx + dx * len, cx + dy * len);
      g.addColorStop(0, 'rgba(255,252,240,0.95)'); g.addColorStop(1, 'rgba(255,244,214,0)');
      x.fillStyle = g;
      x.beginPath();
      x.moveTo(cx + px * wid, cx + py * wid);
      x.lineTo(cx + dx * len, cx + dy * len);
      x.lineTo(cx - px * wid, cx - py * wid);
      x.closePath(); x.fill();
    };
    for (let i = 0; i < 4; i++) spike(i * Math.PI / 2, 124, 7);
    for (let i = 0; i < 4; i++) spike(i * Math.PI / 2 + Math.PI / 4, 74, 5);
    const g = x.createRadialGradient(cx, cx, 0, cx, cx, 34);
    g.addColorStop(0, 'rgba(255,255,250,1)'); g.addColorStop(1, 'rgba(255,250,230,0)');
    x.fillStyle = g; x.beginPath(); x.arc(cx, cx, 34, 0, 7); x.fill();
    return new THREE.CanvasTexture(c);
  })();
  const sunCore = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTex, color: 0xfff6dd, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  sunCore.position.copy(SUN_DIR).multiplyScalar(283);
  sunCore.scale.set(72, 72, 1);
  sunCore.frustumCulled = false;
  scene.add(sunCore);
  // Haces de sol falsos: planos aditivos inclinados siguiendo la
  // direccion de los rayos. Se rellenan tras conocer el spawn y solo
  // se ven en calidad alta (applyGfx): es lo primero que se apaga.
  const beamTex = (() => {
    const w = 128, h = 256, c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); const img = x.createImageData(w, h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const u = i / (w - 1), v = j / (h - 1);
      const a = Math.pow(Math.sin(u * Math.PI), 1.6) * Math.pow(1 - v, 1.7) * (0.35 + 0.65 * Math.min(1, v * 6));
      const o = (j * w + i) * 4;
      img.data[o] = 255; img.data[o + 1] = 238; img.data[o + 2] = 200; img.data[o + 3] = Math.round(a * 255);
    }
    x.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(c);
  })();
  const beamMat = new THREE.MeshBasicMaterial({ map: beamTex, transparent: true, opacity: 0.085, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const beamGeo = new THREE.PlaneGeometry(1, 1);
  const beamQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), SUN_DIR.clone());
  const sunBeams = new THREE.Group();
  sunBeams.visible = false;
  scene.add(sunBeams);

  fill.style.width = '38%';
  loadText.textContent = t('load.world');
  const tpl = TEMPLATES[exp.template] || TEMPLATES.baseplate;
  const COMBAT = !!tpl.combat;
  const BUILD = !!tpl.build;
  const parts = tpl.make(exp.hue);
  // Textura de studs de Jairon: la celda guardada en studs-data.js
  // se repite 4x4 en un lienzo, igual que su imagen original.
  const studTex = (() => {
    const raw = atob(STUDS_B64);
    const cell = document.createElement('canvas');
    cell.width = cell.height = STUD_CELL;
    const cx = cell.getContext('2d');
    const img = cx.createImageData(STUD_CELL, STUD_CELL);
    for (let i = 0; i < STUD_CELL * STUD_CELL; i++) {
      const v = raw.charCodeAt(i);
      img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
    const big = document.createElement('canvas');
    big.width = big.height = STUD_CELL * 4;
    const bx = big.getContext('2d');
    for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 4; tx++) bx.drawImage(cell, tx * STUD_CELL, ty * STUD_CELL);
    const tex = new THREE.CanvasTexture(big);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  })();
  const colliders = [];
  let plateMeshRef = null; // la placa del mundo (mundos build: una sola pieza)
  let luaPartCount = 0; // piezas creadas por scripts Lua (con colision)
  let dynPartCount = 0; // piezas dinamicas de otros sistemas (Lua y similares)
  const lampPts = []; // cabezas de farola: halo falso en vez de bloom
  const worldGroup = new THREE.Group();
  const cullList = [];
  for (const p of parts) {
    const geo = new THREE.BoxGeometry(p.sx, p.sy, p.sz);
    // Studs arriba: las UV de la cara +Y se escalan para repetir la
    // textura una vez por cada 4 unidades de mundo.
    const uv = geo.attributes.uv;
    for (let i = 8; i < 12; i++) uv.setXY(i, uv.getX(i) * p.sx / 4, uv.getY(i) * p.sz / 4);
      let sideMat, topMat;
      if (p.neon) {
        // Material neon: la pieza emite su propio color (idea de los devlogs).
        sideMat = new THREE.MeshStandardMaterial({ color: p.color, emissive: p.color, emissiveIntensity: 1.15, roughness: 0.4, metalness: 0 });
        topMat = sideMat;
      } else if (p.lamp) {
        // Farola encendida: emite calido y lleva halo (ver lampHalos).
        sideMat = new THREE.MeshStandardMaterial({ color: p.color, emissive: 0xffdf9e, emissiveIntensity: 0.95, roughness: 0.4, metalness: 0 });
        topMat = sideMat;
      } else {
        sideMat = new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.8, metalness: 0.02, envMapIntensity: 0.45 });
        topMat = new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.75, metalness: 0.02, envMapIntensity: 0.45, bumpMap: studTex, bumpScale: 0.9 });
      }
      const m = new THREE.Mesh(geo, [sideMat, sideMat, topMat, sideMat, sideMat, sideMat]);
      m.position.set(p.x, p.y, p.z);
      m.castShadow = true;
      m.receiveShadow = true;
      worldGroup.add(m);
      if (BUILD && !plateMeshRef) plateMeshRef = m;
      cullList.push({ m, x: p.x, y: p.y, z: p.z, r: 0.5 * Math.hypot(p.sx, p.sy, p.sz) });
    if (p.lamp) lampPts.push([p.x, p.y, p.z]);
    colliders.push({
      minX: p.x - p.sx / 2, maxX: p.x + p.sx / 2,
      minZ: p.z - p.sz / 2, maxZ: p.z + p.sz / 2,
      top: p.y + p.sy / 2, bottom: p.y - p.sy / 2,
      kill: !!p.kill, win: !!p.win,
      climb: !!p.climb, seat: !!p.seat, seatYaw: p.seatYaw || 0
    });
  }
  const hazards = colliders.filter(c => c.kill || c.win);
  scene.add(worldGroup);
  // Halos de farola (foto de referencia 1: las linternas brillan con
  // halo): un sprite aditivo por cabeza, sin bloom de postprocesado.
  const lampHalos = new THREE.Group();
  for (const lp of lampPts) {
    const hs = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffdf9e, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    hs.position.set(lp[0], lp[1], lp[2]);
    hs.scale.set(3.4, 3.4, 1);
    lampHalos.add(hs);
  }
  scene.add(lampHalos);

  // ---------- Nucleo Rust/WASM (preparacion perezosa) ----------
  let coreDone = false;
  let colPtr = 0, posPtr = 0, posView = null;
  let motePosPtr = 0, moteBasePtr = 0, motePhasePtr = 0;
  let sprayPosPtr = 0, sprayVelPtr = 0;
  function coreReady() { return !!(CORE && coreDone) && luaPartCount === 0 && dynPartCount === 0 && !BUILD; }
  function coreSetup() {
    colPtr = CORE.vc_alloc(colliders.length * 6);
    posPtr = CORE.vc_alloc(3);
    motePosPtr = CORE.vc_alloc(MOTES * 3);
    moteBasePtr = CORE.vc_alloc(MOTES * 3);
    motePhasePtr = CORE.vc_alloc(MOTES);
    if (spray) {
      sprayPosPtr = CORE.vc_alloc(spray.userData.N * 3);
      sprayVelPtr = CORE.vc_alloc(spray.userData.N * 3);
    }
    const mem = new Float32Array(CORE.memory.buffer);
    colliders.forEach((c, i) => {
      const o = colPtr / 4 + i * 6;
      mem[o] = c.minX; mem[o + 1] = c.maxX; mem[o + 2] = c.minZ;
      mem[o + 3] = c.maxZ; mem[o + 4] = c.top; mem[o + 5] = c.bottom;
    });
    mem.set(mBase, moteBasePtr / 4);
    mem.set(mPhase, motePhasePtr / 4);
    posView = new Float32Array(CORE.memory.buffer, posPtr, 3);
    moteGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CORE.memory.buffer, motePosPtr, MOTES * 3), 3));
    if (spray) {
      CORE.vc_init_spray(sprayPosPtr, sprayVelPtr, spray.userData.N, tpl.water[0].x, 2.55, tpl.water[0].z, 1234567);
      spray.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CORE.memory.buffer, sprayPosPtr, spray.userData.N * 3), 3));
    }
    coreDone = true;
    window.__vortxCoreActive = true;
  }

  // ---------- Ambiente vivo ----------
  const dotTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 2, 32, 32, 30);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const puffTex = (() => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const x = c.getContext('2d');
    const blob = (cx, cy, r, a) => {
      const g = x.createRadialGradient(cx, cy, 1, cx, cy, r);
      g.addColorStop(0, 'rgba(255,255,255,' + a + ')'); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(cx - r, cy - r, r * 2, r * 2);
    };
    blob(128, 74, 62, 0.85); blob(84, 80, 42, 0.7); blob(172, 80, 44, 0.7);
    blob(108, 62, 40, 0.6); blob(150, 60, 38, 0.6);
    return new THREE.CanvasTexture(c);
  })();
  // Nubes a la deriva.
  const clouds = new THREE.Group();
  for (let i = 0; i < 24; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, transparent: true, opacity: 0.65 + Math.random() * 0.3, depthWrite: false, color: 0xe6ebf0 }));
    sp.position.set(Math.random() * 460 - 230, 46 + Math.random() * 28, Math.random() * 460 - 230);
    sp.scale.set(62 + Math.random() * 48, 19 + Math.random() * 11, 1);
    clouds.add(sp);
  }
  scene.add(clouds);
  // Polvo ambiental flotante.
  const MOTES = 240;
  const moteGeo = new THREE.BufferGeometry();
  const mPos = new Float32Array(MOTES * 3);
  const mBase = new Float32Array(MOTES * 3);
  const mPhase = new Float32Array(MOTES);
  for (let i = 0; i < MOTES; i++) {
    mBase[i * 3] = Math.random() * 150 - 75;
    mBase[i * 3 + 1] = Math.random() * 26 + 1;
    mBase[i * 3 + 2] = Math.random() * 170 - 110;
    mPhase[i] = Math.random() * Math.PI * 2;
  }
  moteGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3));
  scene.add(new THREE.Points(moteGeo, new THREE.PointsMaterial({ size: 0.17, map: dotTex, transparent: true, opacity: 0.5, depthWrite: false, color: 0xffffff })));
  // Agua con shader: olas, fresnel, brillo del sol y causticas
  // animadas (la red de luz ondulante de las fotos del usuario,
  // generada por codigo, sin assets). Azul turquesa translucido.
  const waterUniforms = {
    uTime: { value: 0 }, uSunDir: { value: SUN_DIR },
    uDeep: { value: new THREE.Color(0x0a5d7d) },
    uSky: { value: new THREE.Color(0xbfe6f2) },
    uSunColor: { value: new THREE.Color(0xfff3da) },
    uCaust: { value: 1 }
  };
  let waterAnim = true, underNow = false;
  const airFog = { near: 55, far: 185 };
  const waterMat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: waterUniforms,
    vertexShader: [
      'uniform float uTime; varying vec3 vWorld;',
      'void main(){ vec4 wp = modelMatrix * vec4(position, 1.0);',
      ' wp.y += sin(wp.x * 0.7 + uTime * 1.4) * 0.035 + cos(wp.z * 0.9 + uTime * 1.1) * 0.03;',
      ' vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }'
    ].join('\n'),
    fragmentShader: [
      'uniform float uTime; uniform vec3 uSunDir; uniform vec3 uDeep; uniform vec3 uSky; uniform vec3 uSunColor; uniform float uCaust; varying vec3 vWorld;',
      'float wheight(vec2 p){ return sin(p.x * 1.4 + uTime * 1.6) * 0.5 + sin(p.y * 1.9 - uTime * 1.3) * 0.35 + sin((p.x + p.y) * 0.6 + uTime * 0.7) * 0.4; }',
      'float caust(vec2 uv, float t){',
      ' vec2 p = uv * 1.35; vec2 i = p; float c = 1.0;',
      ' for (int n = 0; n < 3; n++){',
      '  float tt = t * (0.55 + 0.22 * float(n));',
      '  i = p + vec2(cos(tt - i.x * 1.3) + sin(tt + i.y * 1.1), sin(tt - i.y * 1.2) + cos(tt + i.x * 1.4));',
      '  c += 1.0 / max(length(vec2(p.x / (sin(i.x + tt) * 2.4 + 0.001), p.y / (cos(i.y + tt) * 2.4 + 0.001))), 0.001);',
      ' }',
      ' c /= 3.0; c = 1.12 - pow(c, 1.35);',
      ' return pow(max(c, 0.0), 5.0); }',
      'void main(){',
      ' float e = 0.35; float h = wheight(vWorld.xz);',
      ' vec3 n = normalize(vec3((h - wheight(vWorld.xz + vec2(e, 0.0))) * 0.55, 1.0, (h - wheight(vWorld.xz + vec2(0.0, e))) * 0.55));',
      ' vec3 v = normalize(cameraPosition - vWorld);',
      ' float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);',
      ' vec3 col = mix(uDeep, uSky, 0.18 + fres * 0.6);',
      ' float ca = caust(vWorld.xz * 0.55, uTime * 0.7) * uCaust;',
      ' col += vec3(0.72, 0.94, 1.0) * ca * (0.85 - fres * 0.45);',
      ' vec3 r = reflect(-uSunDir, n);',
      ' col += uSunColor * pow(max(dot(r, v), 0.0), 120.0) * 1.5;',
      ' float sparkle = sin(vWorld.x * 7.0 + uTime * 2.2) * sin(vWorld.z * 6.0 - uTime * 1.7);',
      ' col += vec3(1.0) * smoothstep(0.92, 1.0, sparkle) * 0.08;',
      ' gl_FragColor = vec4(col, 0.86); }'
    ].join('\n')
  });
  for (const w of tpl.water || []) {
    const wm = new THREE.Mesh(new THREE.PlaneGeometry(w.sx, w.sz, 20, 20), waterMat);
    wm.rotation.x = -Math.PI / 2;
    wm.position.set(w.x, w.y, w.z);
    scene.add(wm);
  }
  // Chorro de particulas de la fuente (solo donde hay agua).
  let spray = null, sprayVel = null;
  if ((tpl.water || []).length) {
    const w0 = tpl.water[0];
    const N = 220;
    const sPos = new Float32Array(N * 3);
    sprayVel = new Float32Array(N * 3);
    const resetP = (i, randomY) => {
      sPos[i * 3] = w0.x + (Math.random() - 0.5) * 0.5;
      sPos[i * 3 + 1] = 2.55 + (randomY ? Math.random() * 1.4 : 0);
      sPos[i * 3 + 2] = w0.z + (Math.random() - 0.5) * 0.5;
      sprayVel[i * 3] = (Math.random() - 0.5) * 1.7;
      sprayVel[i * 3 + 1] = 4.4 + Math.random() * 1.9;
      sprayVel[i * 3 + 2] = (Math.random() - 0.5) * 1.7;
    };
    for (let i = 0; i < N; i++) resetP(i, true);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
    spray = new THREE.Points(sg, new THREE.PointsMaterial({ size: 0.15, map: dotTex, transparent: true, opacity: 0.85, depthWrite: false, color: 0xeaf2ff }));
    spray.userData = { reset: resetP, floor: w0.y + 0.05, N };
    scene.add(spray);
  }

  // Vigas de luz decorativas de la plantilla (sin colision).
  for (const b of tpl.beams || []) {
    const bh = b.y1 - b.y0;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(b.r, b.r, bh, 20, 1, true),
      new THREE.MeshBasicMaterial({ color: b.color, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    );
    beam.position.set(b.x, b.y0 + bh / 2, b.z);
    scene.add(beam);
  }
  // Chispas ascendentes de la plantilla (p. ej. sobre la meta).
  let sparks = null, sparkVel = null;
  if ((tpl.sparks || []).length) {
    const sp0 = tpl.sparks[0];
    const sPos = new Float32Array(sp0.n * 3);
    sparkVel = new Float32Array(sp0.n);
    for (let i = 0; i < sp0.n; i++) {
      const a = Math.random() * Math.PI * 2, r = 0.6 + Math.random() * 2.6;
      sPos[i * 3] = sp0.x + Math.cos(a) * r;
      sPos[i * 3 + 1] = sp0.y + Math.random() * 5;
      sPos[i * 3 + 2] = sp0.z + Math.sin(a) * r;
      sparkVel[i] = 0.8 + Math.random() * 1.4;
    }
    const sGeo = new THREE.BufferGeometry();
    sGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
    sparks = new THREE.Points(sGeo, new THREE.PointsMaterial({ size: 0.2, map: dotTex, transparent: true, opacity: 0.9, depthWrite: false, color: sp0.color }));
    sparks.userData = { base: sp0, pos: sPos };
    sparks.frustumCulled = false;
    scene.add(sparks);
  }
  // Estela del jugador: puntos que quedan atras al moverse y se apagan.
  const TRAIL_N = 90;
  const trailPos = new Float32Array(TRAIL_N * 3).fill(-999);
  const trailCol = new Float32Array(TRAIL_N * 3);
  const trailAge = new Float32Array(TRAIL_N).fill(9);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
  trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
  const trailPts = new THREE.Points(trailGeo, new THREE.PointsMaterial({ size: 0.32, map: dotTex, transparent: true, depthWrite: false, vertexColors: true, blending: THREE.AdditiveBlending }));
  trailPts.frustumCulled = false;
  scene.add(trailPts);
  let trailIdx = 0, trailClock = 0;

  fill.style.width = '62%';
  loadText.textContent = t('load.avatar');
  const rig = buildRig(user.avatar);
  rig.setEquipped(equippedIds(user), catalog);
  scene.add(rig.group);
  rig.group.rotation.order = 'YXZ';
  rig.group.traverse(o => { if (o.material) o.material.envMapIntensity = 0.35; });

  // Destellos (sparkles) alrededor del avatar, el elemento comun de las
  // dos fotos de referencia: estrellas de 4 puntas con textura de
  // canvas y brillo por particula en un shader minimo (sin
  // postprocesado). Flotan con el rig. El numero activo lo manda la
  // calidad (applyGfx): en baja desaparecen, son lo primero que se va.
  const SPARK_MAX = 26;
  const sparkTex = (() => {
    const s = 128, c = document.createElement('canvas'); c.width = c.height = s;
    const x = c.getContext('2d'); const cx = s / 2;
    const g = x.createRadialGradient(cx, cx, 0, cx, cx, 62);
    g.addColorStop(0, 'rgba(255,255,252,1)'); g.addColorStop(0.35, 'rgba(255,252,240,0.85)'); g.addColorStop(1, 'rgba(255,248,225,0)');
    x.fillStyle = g;
    x.beginPath();
    for (let i = 0; i < 8; i++) {
      const ang = i * Math.PI / 4, rad = i % 2 === 0 ? 60 : 8;
      const px = cx + Math.cos(ang) * rad, py = cx + Math.sin(ang) * rad;
      if (i === 0) x.moveTo(px, py); else x.quadraticCurveTo(cx, cx, px, py);
    }
    x.closePath(); x.fill();
    x.beginPath(); x.arc(cx, cx, 9, 0, 7); x.fillStyle = 'rgba(255,255,255,0.95)'; x.fill();
    return new THREE.CanvasTexture(c);
  })();
  const sparkGeo = new THREE.BufferGeometry();
  {
    const pos = new Float32Array(SPARK_MAX * 3), ph = new Float32Array(SPARK_MAX), sz = new Float32Array(SPARK_MAX);
    for (let i = 0; i < SPARK_MAX; i++) {
      const a = Math.random() * Math.PI * 2, rad = 0.7 + Math.random() * 0.9;
      pos[i * 3] = Math.cos(a) * rad;
      pos[i * 3 + 1] = 0.7 + Math.random() * 2.9;
      pos[i * 3 + 2] = Math.sin(a) * rad;
      ph[i] = Math.random(); sz[i] = 0.55 + Math.random() * 0.65;
    }
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sparkGeo.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    sparkGeo.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
  }
  const sparkMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uTex: { value: sparkTex } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: [
      'attribute float aPhase; attribute float aSize;',
      'uniform float uTime; varying float vTw;',
      'void main(){',
      '  float tw = 0.5 + 0.5 * sin(uTime * 2.3 + aPhase * 39.0);',
      '  vTw = smoothstep(0.25, 0.95, tw);',
      '  vec3 p = position;',
      '  p.y += sin(uTime * 0.6 + aPhase * 47.0) * 0.16;',
      '  p.x += cos(uTime * 0.45 + aPhase * 29.0) * 0.09;',
      '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
      '  gl_PointSize = aSize * (10.0 + 18.0 * vTw) * (30.0 / -mv.z);',
      '  gl_Position = projectionMatrix * mv;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D uTex; varying float vTw;',
      'void main(){',
      '  vec4 tx = texture2D(uTex, gl_PointCoord);',
      '  gl_FragColor = vec4(vec3(1.0, 0.99, 0.94), tx.a * (0.12 + 0.75 * vTw));',
      '}'
    ].join('\n')
  });
  const sparkPts = new THREE.Points(sparkGeo, sparkMat);
  sparkPts.frustumCulled = false;
  sparkPts.userData.n = SPARK_MAX;
  rig.group.add(sparkPts);

  const spawn = tpl.spawn || [0, 1.2, 6];
  // Relleno de los haces de sol: abanico de planos alrededor del spawn,
  // inclinados como los rayos (su eje largo apunta al sol).
  for (const [ox, oz, w, roll] of [[-11, -7, 7, 0.3], [12, 5, 9, 1.9], [1, 13, 6, 3.6], [-5, -17, 11, 5.1]]) {
    const bm = new THREE.Mesh(beamGeo, beamMat);
    bm.position.set(spawn[0] + ox + SUN_DIR.x * 30, spawn[1] + SUN_DIR.y * 30, spawn[2] + oz + SUN_DIR.z * 30);
    bm.quaternion.copy(beamQuat);
    bm.rotateY(roll);
    bm.scale.set(w, 95, 1);
    sunBeams.add(bm);
  }
  const S = {
    dead: false, raf: 0, renderer,
    pos: new THREE.Vector3(spawn[0], spawn[1], spawn[2]),
    vel: new THREE.Vector3(),
    yaw: (tpl.yaw != null ? tpl.yaw : Math.PI), pitch: 0.32, dist: 11,
    keys: {}, grounded: false,
    sens: 1, paused: false,
    joy: { x: 0, y: 0 }, jumpQueued: false,
    onKeyDown: null, onKeyUp: null, t: 0,
    runT: 0, won: false, winTime: 0, falls: 0, wins: 0, jumps: 0, sessionT: 0, kos: 0, earned: 0, hp: 100, tool: 1, firing: false, aimLock: false, swingT: 0, nextShot: 0, nextSwing: 0, protUntil: 0, lastDmgT: -99999, audio: makeAudio(),
    crouchToggle: false, crouchOn: false, shiftLock: false,
    climbing: null, climbDir: 0, climbStrafe: 0,
    flying: false, adminSpeed: 0, frozenMe: false,
    sitting: null, seatTimer: 0,
    inWater: false, swimSurf: 0,
    landT: 0, landDepth: 0.3, airTime: 0, wasGrounded: true, velYBefore: 0,
    charState: 'idle', moveBlend: 0, emote: null
  };
  const SETT = loadSettings();
  S.sens = SETT.sens;
  const audio = S.audio;
  window.__vortxState = () => ({ pos: [S.pos.x, S.pos.y, S.pos.z], won: S.won, runT: S.runT, stats: { t: Math.floor(S.sessionT), f: S.falls, w: S.wins, j: S.jumps, ko: S.kos }, combat: { hp: Math.round(S.hp), tool: S.tool }, state: S.charState, emote: S.emote || '', shift: S.shiftLock, crouch: S.crouchOn, yaw: +S.yaw.toFixed(2), pitch: +S.pitch.toFixed(2), keys: Object.keys(S.keys).filter(k => S.keys[k]), camY: +camera.position.y.toFixed(2), under: underNow, gfx: { pr: +renderer.getPixelRatio().toFixed(2), mode: SETT.gfxMode, q: SETT.gfxQ, dyn: +dynScale.toFixed(2), shadows: renderer.shadowMap.enabled, spark: sparkPts.userData.n, beams: sunBeams.visible, fps: S.fpsNow || 0, fpsCap: SETT.fpsCap, drawDist: isFinite(drawDist) ? Math.round(drawDist) : 0, culled: culledCount, partsVis: cullList.length - culledCount, partsTotal: cullList.length, lampHalos: lampHalos.visible, sunSpr: sunSpr.visible } });
  session = S;

  function groundAt(x, z, feetY) {
    if (coreReady()) return CORE.vc_ground_at(colPtr, colliders.length, x, z, feetY);
    let g = -Infinity;
    for (const c of colliders) {
      if (x >= c.minX - 0.28 && x <= c.maxX + 0.28 && z >= c.minZ - 0.28 && z <= c.maxZ + 0.28) {
        if (c.top <= feetY + 0.55 && c.top > g) g = c.top;
      }
    }
    return g;
  }
  function pushOut() {
    if (coreReady()) {
      posView[0] = S.pos.x; posView[1] = S.pos.y; posView[2] = S.pos.z;
      CORE.vc_push_out(colPtr, colliders.length, posPtr);
      S.pos.x = posView[0]; S.pos.z = posView[2];
      return;
    }
    for (const c of colliders) {
      if (c.top <= S.pos.y + 0.55) continue;          // se puede subir
      if (c.bottom > S.pos.y + 2.4) continue;          // está por encima
      const r = 0.45;
      if (S.pos.x > c.minX - r && S.pos.x < c.maxX + r && S.pos.z > c.minZ - r && S.pos.z < c.maxZ + r) {
        const dxl = S.pos.x - (c.minX - r), dxr = (c.maxX + r) - S.pos.x;
        const dzl = S.pos.z - (c.minZ - r), dzr = (c.maxZ + r) - S.pos.z;
        const m = Math.min(dxl, dxr, dzl, dzr);
        if (m === dxl) S.pos.x = c.minX - r;
        else if (m === dxr) S.pos.x = c.maxX + r;
        else if (m === dzl) S.pos.z = c.minZ - r;
        else S.pos.z = c.maxZ + r;
      }
    }
  }

  const climbBoxes = colliders.filter(c => c.climb);
  const seatBoxes = colliders.filter(c => c.seat);
  const waterBoxes = tpl.water || [];
  function groundInfo(x, z, feetY) {
    let g = -Infinity, col = null;
    for (const c of colliders) {
      if (x >= c.minX - 0.28 && x <= c.maxX + 0.28 && z >= c.minZ - 0.28 && z <= c.maxZ + 0.28) {
        if (c.top <= feetY + 0.55 && c.top > g) { g = c.top; col = c; }
      }
    }
    return { g, col };
  }
  function vibrate(p) { if (SETT.haptics && navigator.vibrate) { try { navigator.vibrate(p); } catch (e) {} } }
  const anim = createAnimator(rig);
  // Nombre sobre el avatar (y emblemas de pases insignia de esta experiencia).
  let plate = null, plateCtx = null, plateTex = null;
  // Etiqueta OWNER en la placa, junto al nombre (pieza 44): sale por
  // la misma ruta de canvas que el nombre, sin coste extra.
  function plateOwnerBadge(g, name, y) {
    g.font = '700 46px system-ui, sans-serif';
    const w = g.measureText(name).width;
    g.font = '800 27px system-ui, sans-serif';
    g.textAlign = 'left';
    const bx = 256 + w / 2 + 14;
    g.strokeText('OWNER', bx, y);
    g.fillStyle = '#c084fc'; g.fillText('OWNER', bx, y);
    g.textAlign = 'center';
    g.font = '700 46px system-ui, sans-serif';
  }
  function drawPlate() {
    if (!plateCtx) return;
    const g = plateCtx;
    g.clearRect(0, 0, 512, 128);
    g.textAlign = 'center';
    g.font = '700 46px system-ui, sans-serif';
    g.lineWidth = 8; g.strokeStyle = 'rgba(8,8,12,0.85)';
    const name = user.display || user.username || 'VORTX';
    g.strokeText(name, 256, 52); g.fillStyle = '#ffffff'; g.fillText(name, 256, 52);
    if (isOwnerUser(user.username)) plateOwnerBadge(g, name, 52);
    if (SETT.showEmblems) {
      const badges = (exp.passes || []).filter(p => p.perk === 'badge' && ownedHere.includes(p.id)).map(p => p.name);
      if (badges.length) {
        g.font = '600 27px system-ui, sans-serif';
        g.lineWidth = 6;
        const line = badges.join('  ·  ');
        g.strokeText(line, 256, 96); g.fillStyle = '#c9aef0'; g.fillText(line, 256, 96);
      }
    }
    plateTex.needsUpdate = true;
  }
  {
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 128;
    plateCtx = cv.getContext('2d');
    plateTex = new THREE.CanvasTexture(cv);
    plate = new THREE.Sprite(new THREE.SpriteMaterial({ map: plateTex, transparent: true, depthWrite: false }));
    plate.scale.set(5.6, 1.4, 1);
    drawPlate();
    scene.add(plate);
  }

  // ---------- Entrada ----------
  S.onKeyDown = (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.code === 'Enter') {
      const cb = document.getElementById('chatBox');
      if (cb && chatApi) { cb.classList.remove('hidden'); const ci = document.getElementById('chatInput'); if (ci) ci.focus(); e.preventDefault(); }
      return;
    }
    // La tecla / abre el chat con el campo VACÍO (pieza 43, corrección
    // del usuario 2026-11-14: revierte la pieza 36, que dejaba la /
    // escrita). Los comandos se teclean a mano igual que antes.
    // Con el menu de pausa abierto, no.
    if (e.key === '/' && !S.paused) {
      const cb = document.getElementById('chatBox');
      if (cb && chatApi && !chatApi.disabled) {
        cb.classList.remove('hidden');
        const ci = document.getElementById('chatInput');
        if (ci) { ci.value = ''; ci.focus(); }
        e.preventDefault();
      }
      return;
    }
    if (e.code === 'Escape') { togglePause(); return; }
    if (e.code === 'F3') { e.preventDefault(); S.perfOn = !S.perfOn; const ph = document.getElementById('perfHud'); if (ph) ph.classList.toggle('hidden', !S.perfOn); return; }
    if (COMBAT && e.code === 'Digit1') { combatSetTool(1); return; }
    if (COMBAT && e.code === 'Digit2') { combatSetTool(2); return; }
    if (S.paused && e.code === 'KeyQ') { const xb = document.getElementById('exitBtn'); if (xb) xb.click(); return; }
    if (S.paused && e.code === 'KeyR') { const rb = document.getElementById('respawnBtn'); if (rb) rb.click(); return; }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { if (!e.repeat) setShiftLock(!S.shiftLock); return; }
    if (e.code === 'KeyC') { if (!e.repeat) { S.crouchToggle = !S.crouchToggle; syncToggleBtns(); } return; }
    S.keys[e.code] = true;
    if (e.code === 'Space') { S.jumpQueued = true; e.preventDefault(); }
  };
  S.onKeyUp = (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    S.keys[e.code] = false;
  };
  window.addEventListener('keydown', S.onKeyDown);
  window.addEventListener('keyup', S.onKeyUp);
  S.onBlur = () => { if (SETT.muteBlur) audio.setMuted(true); };
  S.onFocus = () => audio.setMuted(false);
  S.onVis = () => { if (document.hidden) S.onBlur(); else S.onFocus(); };
  window.addEventListener('blur', S.onBlur);
  window.addEventListener('focus', S.onFocus);
  document.addEventListener('visibilitychange', S.onVis);

  let dragId = null, lastX = 0, lastY = 0;
  const ptrs = new Map();
  let pinchD = 0;
  let joyFromCanvas = null;
  canvas.addEventListener('pointerdown', (e) => {
    // Mitad izquierda de la pantalla = joystick, siempre: el pulgar
    // que camina jamas puede arrancar un arrastre de camara, empiece
    // donde empiece dentro de su mitad. El circulo mide 118 px, el
    // pulgar de Jairon es mas grande y el margen de 48 px de la
    // primera correccion no bastaba: seguia pasando.
    if (e.pointerType === 'touch' && stickId === null && e.clientX < window.innerWidth * 0.5) {
      stickId = e.pointerId; joyFromCanvas = e.pointerId; moveStick(e);
      return;
    }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {
      dragId = null;
      const v = [...ptrs.values()];
      pinchD = Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y);
      return;
    }
    dragId = e.pointerId; lastX = e.clientX; lastY = e.clientY;
    if (COMBAT && !(BUILD && buildOn) && e.pointerType === 'mouse' && !S.paused) {
      if (!document.pointerLockElement) {
        try { const lp = canvas.requestPointerLock(); if (lp && lp.catch) lp.catch(() => {}); } catch (err) {}
      } else {
        S.firing = true;
        if (S.tool === 2) combatSwing();
      }
    } else if (S.shiftLock && e.pointerType === 'mouse' && !document.pointerLockElement) {
      try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (err) {}
    }
  });
  window.addEventListener('pointerup', (e) => { ptrs.delete(e.pointerId); if (e.pointerId === dragId) dragId = null; S.firing = false; if (e.pointerId === joyFromCanvas) { joyFromCanvas = null; endStick(e); } });
  window.addEventListener('pointercancel', (e) => { ptrs.delete(e.pointerId); if (e.pointerId === dragId) dragId = null; if (e.pointerId === joyFromCanvas) { joyFromCanvas = null; endStick(e); } });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId === joyFromCanvas) { moveStick(e); return; }
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {
      const v = [...ptrs.values()];
      const d = Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y);
      if (pinchD > 0) S.dist = THREE.MathUtils.clamp(S.dist + (pinchD - d) * 0.03, 2.5, 20);
      pinchD = d;
    }
  });
  window.addEventListener('pointermove', (e) => {
    if (document.pointerLockElement === canvas) {
      if (S.paused) return;
      S.yaw -= e.movementX * 0.0038 * S.sens;
      S.pitch = THREE.MathUtils.clamp(S.pitch + e.movementY * 0.0032 * S.sens * (SETT.camInv ? -1 : 1), -1.45, 1.45);
      return;
    }
    if (dragId === null || e.pointerId !== dragId || S.paused) return;
    S.yaw -= (e.clientX - lastX) * 0.0052 * S.sens;
    S.pitch = THREE.MathUtils.clamp(S.pitch + (e.clientY - lastY) * 0.0042 * S.sens * (SETT.camInv ? -1 : 1), -1.45, 1.45);
    lastX = e.clientX; lastY = e.clientY;
  });
  canvas.addEventListener('wheel', (e) => {
    S.dist = THREE.MathUtils.clamp(S.dist + Math.sign(e.deltaY) * 1.4, 6, 20);
  }, { passive: true });

  // Táctil
  const isTouch = 'ontouchstart' in window;
  const touchUI = document.getElementById('touchUI');
  if (isTouch) touchUI.classList.remove('hidden'); else touchUI.classList.add('hidden');
  const stick = document.getElementById('stick');
  const knob = document.getElementById('stickKnob');
  let stickId = null;
  stick.addEventListener('pointerdown', (e) => { stickId = e.pointerId; stick.setPointerCapture(e.pointerId); moveStick(e); });
  stick.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) moveStick(e); });
  const endStick = (e) => { if (e.pointerId === stickId) { stickId = null; S.joy.x = 0; S.joy.y = 0; knob.style.left = '34px'; knob.style.top = '34px'; } };
  stick.addEventListener('pointerup', endStick);
  stick.addEventListener('pointercancel', endStick);
  function moveStick(e) {
    const r = stick.getBoundingClientRect();
    let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    S.joy.x = dx; S.joy.y = dy;
    knob.style.left = (34 + dx * 32) + 'px';
    knob.style.top = (34 + dy * 32) + 'px';
  }
  document.getElementById('jumpBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); S.jumpQueued = true; });
  const stickZone = document.getElementById('stickZone');
  if (stickZone) {
    stickZone.addEventListener('pointerdown', (e) => {
      if (SETT.moveMode !== 'dinamico') return;
      stick.style.left = (e.clientX - 55) + 'px';
      stick.style.top = (e.clientY - 55) + 'px';
      stick.style.bottom = 'auto';
      stickId = e.pointerId;
      try { stickZone.setPointerCapture(e.pointerId); } catch (err) {}
      moveStick(e);
    });
    stickZone.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) moveStick(e); });
    stickZone.addEventListener('pointerup', endStick);
    stickZone.addEventListener('pointercancel', endStick);
  }
  const crouchBtn = document.getElementById('crouchBtn');
  const shiftBtn = document.getElementById('shiftBtn');
  if (crouchBtn) crouchBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); S.crouchToggle = !S.crouchToggle; syncToggleBtns(); });
  if (shiftBtn) shiftBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); setShiftLock(!S.shiftLock); });
  function syncToggleBtns() {
    if (crouchBtn) crouchBtn.classList.toggle('active', S.crouchToggle);
    if (shiftBtn) shiftBtn.classList.toggle('active', S.shiftLock);
  }
  // Shift Lock: camara al hombro, personaje mirando a la camara y
  // puntero bloqueado al hacer clic (si el navegador lo permite).
  function setShiftLock(on) {
    if (on && !SETT.shiftLock) on = false;
    S.shiftLock = on;
    const dot = document.getElementById('centerDot');
    if (dot) { dot.classList.toggle('hidden', !on); dot.classList.toggle('nomotion', !!SETT.reduceMotion); }
    if (!on && document.pointerLockElement) document.exitPointerLock();
    syncToggleBtns();
  }
  S.setShiftLock = setShiftLock;

  // Pausa
  const menuBtn = document.getElementById('hudMenuBtn');
  function togglePause(force) {
    S.paused = force !== undefined ? force : !S.paused;
    pauseMenu.classList.toggle('hidden', !S.paused);
    if (S.paused) refreshMenu();
  }
  menuBtn.onclick = () => togglePause();
  document.getElementById('resumeBtn').onclick = () => togglePause(false);
  document.getElementById('exitBtn').onclick = () => { stopExperience(); overlay.classList.add('hidden'); onExit && onExit(); };
  document.getElementById('setSens').oninput = (e) => { SETT.sens = Number(e.target.value); S.sens = SETT.sens; saveSettings(SETT); };

  // ---------- Menu de juego: pestanas y ajustes reales ----------
  const CYCLES = {
    camMode: { opts: ['libre', 'seguir', 'primera'], labels: ['val.free', 'val.follow', 'val.first'] },
    camInv: { bool: true, labels: ['val.off', 'val.on'] },
    moveMode: { opts: ['fijo', 'dinamico'], labels: ['val.fixed', 'val.dynamic'] },
    showNames: { bool: true, labels: ['val.hide', 'val.show'] },
    showEmblems: { bool: true, labels: ['val.hide', 'val.show'] },
    multi: { bool: true, labels: ['val.off', 'val.on'] },
    gfxMode: { opts: ['manual', 'auto'], labels: ['val.manual', 'val.auto'] },
    gfxProfile: { opts: ['rendimiento', 'equilibrio', 'fidelidad', 'personalizado'], labels: ['val.perf', 'val.balance', 'val.fidelity', 'val.custom'] },
    haptics: { bool: true, labels: ['val.off', 'val.on'] },
    fpsCap: { opts: [0, 30, 60, 120], labels: ['val.unlimited', '30', '60', '120'] },
    reduceMotion: { bool: true, labels: ['val.off', 'val.on'] }
  };
  function paintCycles() {
    for (const [key, def] of Object.entries(CYCLES)) {
      const el = document.getElementById('val-' + key);
      if (!el) continue;
      el.textContent = t(def.bool ? def.labels[SETT[key] ? 1 : 0] : def.labels[def.opts.indexOf(SETT[key])]);
    }
    const fsEl = document.getElementById('val-fs');
    if (fsEl) fsEl.textContent = document.fullscreenElement ? t('val.on') : t('val.off');
  }
  document.querySelectorAll('[data-set]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.set, def = CYCLES[key];
      if (!def) return;
      if (def.bool) SETT[key] = !SETT[key];
      else {
        let i = def.opts.indexOf(SETT[key]) + Number(btn.dataset.dir || 1);
        i = (i + def.opts.length) % def.opts.length;
        SETT[key] = def.opts[i];
      }
      if (key === 'gfxProfile') {
        // Cada perfil fija modo y calidad juntos: Rendimiento manual
        // q=3, Equilibrio automático q=6, Fidelidad manual q=10.
        const P = { rendimiento: ['manual', 3], equilibrio: ['auto', 6], fidelidad: ['manual', 10] }[SETT.gfxProfile];
        if (P) { SETT.gfxMode = P[0]; SETT.gfxQ = P[1]; }
      }
      saveSettings(SETT);
      applySettings();
    });
  });
  const SEG_CONF = {
    volume: { count: 10, toValue: i => i + 1, active: () => SETT.volume, set: v => { SETT.volume = v; } },
    gfxQ: { count: 10, toValue: i => i + 1, active: () => SETT.gfxQ, set: v => { SETT.gfxQ = v; SETT.gfxProfile = 'personalizado'; } },
    menuAlpha: { count: 10, toValue: i => 58 + (i + 1) * 4, active: () => Math.round((SETT.menuAlpha - 58) / 4), set: v => { SETT.menuAlpha = v; } },
    textSize: { count: 6, toValue: i => i, active: () => SETT.textSize + 1, set: v => { SETT.textSize = v; } }
  };
  document.querySelectorAll('[data-seg]').forEach(box => {
    const conf = SEG_CONF[box.dataset.seg];
    if (!conf) return;
    for (let i = 0; i < conf.count; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn';
      b.addEventListener('click', () => { conf.set(conf.toValue(i)); saveSettings(SETT); applySettings(); });
      box.appendChild(b);
    }
  });
  function paintSegs() {
    document.querySelectorAll('[data-seg]').forEach(box => {
      const conf = SEG_CONF[box.dataset.seg];
      if (!conf) return;
      const act = conf.active();
      [...box.children].forEach((b, i) => b.classList.toggle('on', i < act));
    });
  }
  // Casillas si/no y deslizadores del menu estilo Luduvo
  document.querySelectorAll('[data-check]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.check;
      SETT[key] = !SETT[key];
      if (key === 'shiftLock' && !SETT.shiftLock) setShiftLock(false);
      saveSettings(SETT);
      applySettings();
    });
  });
  function paintChecks() {
    document.querySelectorAll('[data-check]').forEach(b => b.classList.toggle('on', !!SETT[b.dataset.check]));
    const fs = document.getElementById('fsBtn');
    if (fs) fs.classList.toggle('on', !!document.fullscreenElement);
  }
  const RNG_CONF = {
    volume: { get: () => SETT.volume * 10, set: v => { SETT.volume = Math.round(v / 10); }, fmt: v => Math.round(v) + '%' },
    sfxVol: { get: () => SETT.sfxVol * 10, set: v => { SETT.sfxVol = Math.round(v / 10); }, fmt: v => Math.round(v) + '%' },
    musicVol: { get: () => SETT.musicVol * 10, set: v => { SETT.musicVol = Math.round(v / 10); }, fmt: v => Math.round(v) + '%' },
    gfxQ: { get: () => SETT.gfxQ, set: v => { SETT.gfxQ = v; SETT.gfxProfile = 'personalizado'; }, fmt: v => String(v) },
    menuAlpha: { get: () => SETT.menuAlpha, set: v => { SETT.menuAlpha = v; }, fmt: v => Math.round(v) + '%' },
    textSize: { get: () => SETT.textSize, set: v => { SETT.textSize = v; }, fmt: v => (0.85 + v * 0.07).toFixed(2) + '\u00d7' },
    fov: { get: () => SETT.fov, set: v => { SETT.fov = v; }, fmt: v => Math.round(v) + '\u00b0' }
  };
  document.querySelectorAll('[data-rng]').forEach(el => {
    el.addEventListener('input', () => {
      const conf = RNG_CONF[el.dataset.rng];
      if (!conf) return;
      conf.set(Number(el.value));
      saveSettings(SETT);
      applySettings();
    });
  });
  function paintSliders() {
    document.querySelectorAll('[data-rng]').forEach(el => {
      const conf = RNG_CONF[el.dataset.rng];
      if (!conf) return;
      el.value = conf.get();
      const lab = document.querySelector('[data-rngv="' + el.dataset.rng + '"]');
      if (lab) lab.textContent = conf.fmt(conf.get());
    });
    const sv = document.getElementById('rngv-sens');
    if (sv) sv.textContent = Math.round(SETT.sens * 100) + '%';
  }
  // Resolucion dinamica (solo modo automatico): multiplica la
  // resolucion base de la calidad entre 0.6 y 1 segun los FPS medios,
  // con pasos cada ~2 s para no oscilar (ver adjustDynRes).
  let dynScale = 1, dynTimer = 0;
  // Distancia de dibujado por calidad (pieza 27): la barrita manda.
  // Calidad 10 = mundo completo como siempre (sin recorte); al bajar,
  // la distancia cae por escalones (la media queda cerca de la mitad)
  // y la niebla y el plano lejano acompanan para que el corte no se
  // vea como un muro. El recorte se evalua por intervalos, no por frame.
  let drawDist = Infinity, culledCount = 0, cullTimer = 0, lastCullX = 1e9, lastCullZ = 1e9;
  function drawDistFor(q) {
    if (q >= 10) return Infinity;
    return 45 + (q - 1) * 22;
  }
  function evalCull() {
    if (!isFinite(drawDist)) {
      if (culledCount) { for (const c of cullList) c.m.visible = true; culledCount = 0; }
      lastCullX = camera.position.x; lastCullZ = camera.position.z;
      return;
    }
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    let n = 0;
    for (const c of cullList) {
      const dx = c.x - cx, dy = c.y - cy, dz = c.z - cz;
      const vis = (dx * dx + dy * dy + dz * dz) < (drawDist + c.r) * (drawDist + c.r);
      if (c.m.visible !== vis) c.m.visible = vis;
      if (!vis) n++;
    }
    culledCount = n;
    lastCullX = cx; lastCullZ = cz;
  }
  function applyGfx() {
    const q = SETT.gfxQ;
    drawDist = drawDistFor(q);
    if (isFinite(drawDist)) {
      // El plano lejano NO se acorta con la distancia de dibujado: la
      // cupula del cielo (radio 320) y los resplandores del sol viven
      // mas lejos que cualquier drawDist y acortarlo dejaba el cielo
      // negro con los sprites flotando (pieza 35). El recorte visual
      // lo hacen la niebla y el culling de piezas, no el far plane.
      if (camera.far !== 400) { camera.far = 400; camera.updateProjectionMatrix(); }
      airFog.near = Math.round(drawDist * 0.45);
      airFog.far = Math.round(drawDist);
    } else {
      if (camera.far !== 400) { camera.far = 400; camera.updateProjectionMatrix(); }
      airFog.near = 55;
      airFog.far = 185;
    }
    if (!underNow) { scene.fog.near = airFog.near; scene.fog.far = airFog.far; }
    waterUniforms.uCaust.value = q >= 4 ? 1 : 0;
    waterAnim = q >= 4;
    evalCull();
    let pr = Math.min(devicePixelRatio || 1, PR_CAP, 0.6 + q * 0.13);
    if (SETT.gfxMode === 'auto') pr = Math.max(0.55, pr * dynScale);
    renderer.setPixelRatio(pr);
    // Sombras por escalones: baja = sin sombras, media = PCF con mapa
    // 1024 y camara apretada, alta = PCFSoft con mapa 2048.
    const sh = q >= 4;
    const shType = q >= 7 ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    const shSize = q >= 7 ? 2048 : 1024;
    const shExt = q >= 7 ? 44 : 34;
    if (renderer.shadowMap.enabled !== sh || renderer.shadowMap.type !== shType) {
      renderer.shadowMap.enabled = sh;
      renderer.shadowMap.type = shType;
      sun.castShadow = sh;
      scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
    }
    if (sun.shadow.mapSize.x !== shSize) {
      sun.shadow.mapSize.set(shSize, shSize);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    const sc = sun.shadow.camera;
    if (sc.right !== shExt) {
      sc.left = -shExt; sc.right = shExt; sc.top = shExt; sc.bottom = -shExt;
      sc.updateProjectionMatrix();
    }
    moteGeo.setDrawRange(0, q < 3 ? 70 : q < 6 ? 150 : MOTES);
    if (spray) spray.visible = q >= 3;
    if (sparks) sparks.visible = q >= 3;
    // FX de sol y destellos: lo primero que se apaga al bajar la
    // calidad (o cuando el automatico la baja), antes que lo demas.
    sunSpr.visible = q >= 3;
    sunCore.visible = q >= 4;
    sunBeams.visible = q >= 7;
    lampHalos.visible = q >= 4;
    const nSpark = q >= 7 ? SPARK_MAX : q >= 4 ? 14 : 0;
    sparkGeo.setDrawRange(0, nSpark);
    sparkPts.visible = nSpark > 0;
    sparkPts.userData.n = nSpark;
    resize();
  }
  function autoQuality(fps) {
    if (S.qCool > 0) { S.qCool -= 0.5; return; }
    if (fps < 45 && SETT.gfxQ > 2) { SETT.gfxQ--; S.qCool = 2; saveSettings(SETT); applySettings(); }
    else if (fps > 57 && SETT.gfxQ < 9) { SETT.gfxQ++; S.qCool = 2; saveSettings(SETT); applySettings(); }
  }
  function adjustDynRes() {
    const avg = S.fpsAvg || 60;
    let nd = dynScale;
    if (avg < 50) nd = Math.max(0.6, dynScale - 0.12);
    else if (avg > 57) nd = Math.min(1, dynScale + 0.05);
    if (nd !== dynScale) { dynScale = nd; applyGfx(); }
  }
  function applySettings() {
    S.sens = SETT.sens;
    audio.setVolume(SETT.volume / 10);
    audio.setBus('sfx', SETT.sfxVol / 10);
    audio.setBus('music', SETT.musicVol / 10);
    if (camera.fov !== SETT.fov) { camera.fov = SETT.fov; camera.updateProjectionMatrix(); }
    const sensEl = document.getElementById('setSens');
    if (sensEl) sensEl.value = SETT.sens;
    const card = document.querySelector('#pauseMenu .pause-card');
    if (card) {
      card.style.background = 'rgba(13, 13, 18, ' + (SETT.menuAlpha / 100) + ')';
      card.style.zoom = String(0.85 + SETT.textSize * 0.07);
    }
    const zone = document.getElementById('stickZone');
    if (zone) zone.style.display = SETT.moveMode === 'dinamico' ? 'block' : 'none';
    if (SETT.moveMode === 'fijo') { stick.style.left = ''; stick.style.top = ''; stick.style.bottom = ''; }
    drawPlate();
    applyGfx();
    paintCycles();
    paintChecks();
    paintSliders();
  }
  function refreshMenu() {
    paintCycles();
    paintChecks();
    paintSliders();
    buildPeople();
    const nm = document.getElementById('pauseExpName');
    if (nm) nm.textContent = exp.name;
    const vc = document.getElementById('verCore');
    if (vc) vc.textContent = window.__vortxCore === 'rust-wasm' ? 'Rust/WebAssembly' : 'JavaScript (respaldo)';
    const ve = document.getElementById('verExp');
    if (ve) ve.textContent = exp.name + ' (' + ((TEMPLATES[exp.template] || {}).name || exp.template) + ')';
  }
  // Pestanas del menu
  document.querySelectorAll('[data-mtab]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-mtab]').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('[data-mpage]').forEach(p => p.classList.toggle('hidden', p.dataset.mpage !== btn.dataset.mtab));
    });
  });
  const hpBtn = document.getElementById('hudPeopleBtn');
  if (hpBtn) hpBtn.onclick = () => {
    const tabB = document.querySelector('[data-mtab="personas"]');
    if (tabB) tabB.click();
    togglePause(true);
  };
  const invBtn = document.getElementById('inviteBtn');
  if (invBtn) invBtn.onclick = () => {
    const url = location.origin + location.pathname + '#/exp/' + exp.id;
    const done = () => {
      const lab = invBtn.querySelector('span');
      if (!lab) return;
      lab.textContent = t('menu.copied');
      setTimeout(() => { lab.textContent = t('menu.invite'); }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, done);
    else done();
  };
  // Cabezas 3D de los jugadores (las genera y cachea app.js con su
  // renderizador de cabezas; aquí solo se pide la imagen). Los remotos
  // traen en su presencia los datos de su avatar (colores, forma de
  // cabeza, cara y cara equipada), los mismos con los que se construye
  // su rig; sin datos, app.js devuelve la cabeza por defecto.
  function headImgFor(obj) {
    try { return (window.__vortxHeadshot && window.__vortxHeadshot(obj)) || ''; } catch (e) { return ''; }
  }
  function remoteHeadObj(r) {
    return { id: 'net:' + (r.meta.name || ''), avatar: { colors: r.meta.colors || {}, headShape: r.meta.headShape || 'block', face: r.meta.face || false, equipped: r.meta.faceItem ? { face: r.meta.faceItem } : {} } };
  }
  // Personas: solo jugadores reales (por ahora, tu) y acciones reales.
  function buildPeople() {
    const total = (SETT.multi && netStatus === 'online') ? remotes.size + 1 : 1;
    const pc = document.getElementById('peopleCount');
    if (pc) pc.textContent = t('menu.peopleCount', { n: total });
    const meta = document.getElementById('pauseExpMeta');
    if (meta) meta.textContent = t('menu.by', { name: '@' + exp.creator }) + ' \u2022 ' + fmtClock(S.t);
    const mp = document.getElementById('menuPeople');
    if (mp) {
      mp.innerHTML = '<div class="person-card"><img class="uavatar" alt="" src="' + headImgFor(user) + '">' +
        '<div><b>' + escHtml(user.display) + (iAmOwner ? ownerBadgeHtml() : '') + '</b><span>@' + escHtml(user.username) + ' ' + t('pl.you') + '</span></div></div>' +
        [...remotes.values()].map(r => '<div class="person-card"><img class="uavatar" alt="" src="' + headImgFor(remoteHeadObj(r)) + '">' +
          '<div><b>' + escHtml(r.meta.name || 'VORTX') + ((isOwnerUser(r.meta.un) || isOwnerUser(r.meta.name)) ? ownerBadgeHtml() : '') + '</b><span>' + t('pl.online') + '</span></div></div>').join('');
    }
  }
  window.__vortxLangHook = () => { paintCycles(); paintFxBar(); paintPlayers(); buildPeople(); };
  const respawnBtn = document.getElementById('respawnBtn');
  if (respawnBtn) respawnBtn.onclick = () => {
    S.pos.set(spawn[0], spawn[1], spawn[2]);
    S.vel.set(0, 0, 0);
    S.climbing = null; S.sitting = null;
    if (tpl.timed) S.runT = 0;
    togglePause(false);
  };
  const fsBtn = document.getElementById('fsBtn');
  if (fsBtn) fsBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
    setTimeout(() => { paintCycles(); paintChecks(); }, 350);
  };
  document.addEventListener('fullscreenchange', () => { paintCycles(); paintChecks(); });
  // Galeria: capturas reales del canvas, con descarga.
  const capBtn = document.getElementById('captureBtn');
  if (capBtn) capBtn.onclick = () => {
    renderer.render(scene, camera);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'vortx-' + exp.id + '.png';
      a.click();
      const grid = document.getElementById('galleryGrid');
      if (grid) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = 'Captura de ' + exp.name;
        grid.prepend(img);
      }
      const note = document.getElementById('galleryNote');
      if (note) note.textContent = t('menu.shotSaved');
    });
  };
  applySettings();
  const ptEl = document.getElementById('pauseExpName');
  if (ptEl) ptEl.textContent = exp.name;
  const timerEl = document.getElementById('hudTimer');
  if (timerEl) {
    if (tpl.timed) { timerEl.classList.remove('hidden'); timerEl.textContent = '0.0'; }
    else timerEl.classList.add('hidden');
  }
  const winBanner = document.getElementById('winBanner');
  if (winBanner) {
    winBanner.classList.add('hidden');
    document.getElementById('winContinue').onclick = () => winBanner.classList.add('hidden');
    document.getElementById('winExit').onclick = () => { stopExperience(); overlay.classList.add('hidden'); onExit && onExit(); };
  }
  const soundSel = document.getElementById('setSound');
  if (soundSel) soundSel.onchange = (e) => audio.setMuted(e.target.value === 'off');
  // ---------- Admin de partida (pieza 44, con la corrección) ----------
  // Comandos del chat que NUNCA se publican como mensaje. Solo los
  // owners de OWNER_USERS (ethera y Noobz) pueden usarlos; el creador
  // de la experiencia NO es admin. /close es para todos los jugadores.
  // freeze y ban viajan por el broadcast de la sala y el cliente del
  // objetivo los aplica; el ban se guarda en el navegador del baneado,
  // por experiencia, y le impide reentrar a ESA experiencia desde ese
  // navegador (sin servidor de cuentas no hay baneo global).
  const adminFrozen = new Set();
  const adminBanned = new Set();
  function exitToWeb() { stopExperience(); overlay.classList.add('hidden'); if (onExit) onExit(); }
  function persistMyBan() {
    try {
      const all = JSON.parse(localStorage.getItem('vortx_bans_v1') || '{}');
      const arr = Array.isArray(all[exp.id]) ? all[exp.id] : [];
      const meLow = myUn.toLowerCase();
      if (meLow && arr.indexOf(meLow) < 0) arr.push(meLow);
      all[exp.id] = arr;
      localStorage.setItem('vortx_bans_v1', JSON.stringify(all));
    } catch (e) {}
  }
  function applyFreezeMe(on) {
    S.frozenMe = on;
    if (on) S.jumpQueued = false;
    chatLine('<span class="sys">' + t(on ? 'pl.frozenYou' : 'pl.unfrozenYou') + '</span>');
  }
  function adminReceive(pl) {
    if (!pl || !isOwnerUser(pl.byUn)) return; // solo ordenes de un owner
    const low = String(pl.name || '').toLowerCase();
    if (pl.act === 'freeze') { adminFrozen.add(low); if (pl.to === myKey) applyFreezeMe(true); }
    else if (pl.act === 'unfreeze') { adminFrozen.delete(low); if (pl.to === myKey) applyFreezeMe(false); }
    else if (pl.act === 'ban') { adminBanned.add(low); if (pl.to === myKey) { persistMyBan(); exitToWeb(); } }
  }
  function findPresentPlayer(name) {
    const q = String(name || '').trim().toLowerCase();
    if (!q) return null;
    if (q === myName.toLowerCase() || (myUn && q === myUn.toLowerCase())) return { key: myKey, name: myName, self: true };
    for (const [k, r] of remotes) {
      if (q === (r.meta.name || '').toLowerCase() || (r.meta.un && q === String(r.meta.un).toLowerCase())) return { key: k, name: r.meta.name || q, self: false };
    }
    return null;
  }
  function adminTargetCmd(act, argName) {
    const tgt = findPresentPlayer(argName);
    if (!tgt) { chatLine('<span class="sys">' + t('pl.adminNoPlayer', { name: escHtml(argName) }) + '</span>'); return; }
    const low = tgt.name.toLowerCase();
    if (act === 'freeze') adminFrozen.add(low);
    else if (act === 'unfreeze') adminFrozen.delete(low);
    else if (act === 'ban') adminBanned.add(low);
    if (tgt.self) {
      if (act === 'freeze') applyFreezeMe(true);
      else if (act === 'unfreeze') applyFreezeMe(false);
      else if (act === 'ban') { persistMyBan(); chatLine('<span class="sys">' + t('pl.adminBanned', { name: escHtml(tgt.name) }) + '</span>'); exitToWeb(); return; }
    } else if (netRoom) {
      netRoom.send('admin', { act: act, to: tgt.key, name: tgt.name, by: myKey, byUn: myUn });
    }
    chatLine('<span class="sys">' + t(act === 'freeze' ? 'pl.adminFroze' : act === 'unfreeze' ? 'pl.adminUnfroze' : 'pl.adminBanned', { name: escHtml(tgt.name) }) + '</span>');
  }
  function handleAdminCmd(cmd, arg) {
    if (cmd === 'close') { exitToWeb(); return; }
    if (!iAmOwner) { chatLine('<span class="sys">' + t('pl.adminOnly') + '</span>'); return; }
    if (cmd === 'fly') {
      S.flying = !S.flying;
      if (S.flying) { S.climbing = null; S.sitting = null; S.vel.y = 0; }
      chatLine('<span class="sys">' + t(S.flying ? 'pl.adminFlyOn' : 'pl.adminFlyOff') + '</span>');
      return;
    }
    if (cmd === 'speed') {
      const n = parseFloat(arg);
      if (!arg || isNaN(n) || n === 0) { S.adminSpeed = 0; chatLine('<span class="sys">' + t('pl.adminSpeedBase') + '</span>'); return; }
      S.adminSpeed = Math.max(0, Math.min(200, n));
      chatLine('<span class="sys">' + (S.adminSpeed > 0 ? t('pl.adminSpeed', { n: S.adminSpeed }) : t('pl.adminSpeedBase')) + '</span>');
      return;
    }
    adminTargetCmd(cmd, arg);
  }
  window.__vortxAdmin = () => ({ isAdmin: iAmOwner, flying: !!S.flying, speed: S.adminSpeed || 0, frozen: [...adminFrozen], banned: [...adminBanned], frozenMe: !!S.frozenMe });
  // Chat de la experiencia (historial local compartido entre las cuentas
  // de este navegador; el chat en linea entre dispositivos llega en la Fase 4).
  const chatBox = document.getElementById('chatBox');
  const chatLog = document.getElementById('chatLog');
  const chatForm = document.getElementById('chatForm');
  const chatInput = document.getElementById('chatInput');
  function chatLine(html) {
    if (!chatLog) return;
    const div = document.createElement('div');
    div.className = 'chat-line';
    div.innerHTML = html;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function chatMsgLine(m) {
    const hh = new Date(m.at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    const badge = (isOwnerUser(m.un) || isOwnerUser(m.d)) ? ownerBadgeHtml() : '';
    chatLine('<span class="chat-time">' + hh + '</span><b>' + escHtml(m.d) + badge + '</b> ' + escHtml(m.text));
  }
  if (chatApi && chatApi.disabled) { const cbd = document.getElementById('chatBtn'); if (cbd) cbd.style.display = 'none'; chatBox.classList.add('hidden'); }
  else if (chatApi && chatBox) { const cbe = document.getElementById('chatBtn'); if (cbe) cbe.style.display = '';
    if (chatLog) chatLog.innerHTML = '';
    const badge = document.getElementById('chatBadge');
    const unseen = chatApi.history().length;
    if (badge && unseen > 0) { badge.textContent = unseen; badge.classList.remove('hidden'); }
    for (const m of chatApi.history()) chatMsgLine(m);
    if (!chatApi.history().length) chatLine('<span class="sys">' + t('pl.chatWelcome') + '</span>');
    document.getElementById('chatBtn').onclick = () => {
      chatBox.classList.toggle('hidden');
      if (badge) badge.classList.add('hidden');
      if (!chatBox.classList.contains('hidden') && chatInput) chatInput.focus();
    };
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const raw = chatInput.value;
      if (!raw.trim()) return;
      // Comandos de admin (pieza 44): /fly, /speed, /freeze,
      // /unfreeze, /ban (solo owners) y /close (todos). Nunca se
      // publican como mensaje.
      const admCmd = /^\s*\/(fly|speed|freeze|unfreeze|ban|close)\b\s*(.*)$/i.exec(raw);
      if (admCmd) {
        chatInput.value = '';
        handleAdminCmd(admCmd[1].toLowerCase(), (admCmd[2] || '').trim());
        chatInput.blur();
        return;
      }
      // Comandos de baile (pieza 36): /e dance y /e dance2 no se
      // publican como mensaje; activan el bucle procedural del avatar
      // y viajan a los remotos en el campo em del estado.
      const emCmd = /^\s*\/e\s+(dance2?)\s*$/i.exec(raw);
      if (emCmd) {
        S.emote = emCmd[1].toLowerCase();
        chatInput.value = '';
        chatInput.blur();
        return;
      }
      if (/^\s*\/e\b/i.test(raw)) { chatInput.value = ''; return; }
      const r = chatApi.post(raw);
      chatInput.value = '';
      if (r && r.msg) {
        chatMsgLine({ d: r.msg.d, text: r.msg.text, at: r.msg.at, un: myUn });
        if (netRoom) netRoom.send('chat', { name: myName, un: myUn, k: myKey, text: r.msg.text });
        if (r.filtered) chatLine('<span class="sys">' + t('pl.chatFiltered') + '</span>');
      }
    });
    chatInput.addEventListener('keydown', (e) => { if (e.code === 'Escape') { chatInput.blur(); e.stopPropagation(); } });
  } else if (chatBox) {
    const cbn = document.getElementById('chatBtn'); if (cbn) cbn.style.display = '';
    chatBox.classList.add('hidden');
  }
  // Barra de consumibles: usar una unidad activa su ventaja unos segundos.
  const fxBar = document.getElementById('fxBar');
  function paintFxBar() {
    if (!fxBar) return;
    const items = (exp.passes || []).filter(p => p.kind === 'consumable' &&
      ((consCounts[p.id] || 0) > 0 || (p.perk === 'speed' && S.t < fxSpeedUntil) || (p.perk === 'jump' && S.t < fxJumpUntil)));
    fxBar.innerHTML = items.map(p => {
      const n = consCounts[p.id] || 0;
      const activo = (p.perk === 'speed' && S.t < fxSpeedUntil) || (p.perk === 'jump' && S.t < fxJumpUntil);
      return '<button class="hud-btn fx-btn" data-fx="' + p.id + '" type="button"' + (n <= 0 && !activo ? ' disabled' : '') + '>' +
        (activo ? escHtml(p.name) + ' ' + t('pl.active') : t('pl.use') + ' ' + escHtml(p.name) + ' (×' + n + ')') + '</button>';
    }).join('');
    fxBar.querySelectorAll('[data-fx]').forEach(b => b.addEventListener('click', () => {
      const p = (exp.passes || []).find(x => x.id === b.dataset.fx);
      if (!p || (consCounts[p.id] || 0) <= 0) return;
      consCounts[p.id]--;
      if (p.perk === 'speed') fxSpeedUntil = S.t + (p.seconds || 30);
      if (p.perk === 'jump') fxJumpUntil = S.t + (p.seconds || 30);
      window.dispatchEvent(new CustomEvent('vortx-consumable', { detail: { expId: exp.id, passId: p.id } }));
      paintFxBar();
    }));
  }
  paintFxBar();
  // ---------- Multijugador en linea (Supabase Realtime) ----------
  const remotes = new Map();
  // ================= Construcción en la baseplate (tpl.build) ======
  // Bloques cúbicos de 4x4x4 encajados a la rejilla de la placa (el
  // concepto de l/place con sistemas propios de VORTX): colocar y
  // borrar con vista previa fantasma, paleta de colores planos,
  // difusión por la sala (net.js) con sincronización de estado al
  // entrar, y persistencia local por experiencia. Render: UN
  // InstancedMesh con color por instancia (tope declarado en la
  // interfaz: 4000 bloques). Colisión: un colisionador por columna
  // que se muta al editar. El bucle caliente no asigna: el fantasma
  // reutiliza vectores y solo recalcula el objetivo si la cámara o
  // el puntero se movieron.
  const BCELL = 4, BGRID = 128, BMAXH = 24, BCAP = 4000;
  let buildOn = false, buildMode = 'place', buildColor = 5, buildCount = 0;
  const bCols = new Map();
  let bMesh = null, bGhost = null;
  const bInstCells = [];
  const bRay = new THREE.Raycaster();
  const bNdc = new THREE.Vector2(0, 0);
  const bMat4 = new THREE.Matrix4();
  const bPos = new THREE.Vector3();
  const bQuat = new THREE.Quaternion();
  const bScl = new THREE.Vector3(1, 1, 1);
  const bCol3 = new THREE.Color();
  let bPtrSeen = false;
  let bDownX = 0, bDownY = 0, bDownT = 0;
  let bCacheSig = '', bCacheTgt = null;
  const bKey = (cx, cz) => cx + ',' + cz;
  const bWX = (cx) => -256 + cx * BCELL + BCELL / 2;
  const bWZ = (cz) => -256 + cz * BCELL + BCELL / 2;
  function buildToast(msg) { chatLine('<span class="sys">' + escHtml(msg) + '</span>'); }
  function paintBuildCount() { const el = document.getElementById('buildCount'); if (el) el.textContent = buildCount + ' / ' + BCAP; }
  function paintBuildPal() {
    const pal = document.getElementById('buildPal');
    if (pal) [...pal.children].forEach((b, i) => b.classList.toggle('sel', i === buildColor));
    const cur = document.getElementById('buildCur');
    if (cur) cur.style.background = '#' + (PALETTE[buildColor] || 0xffffff).toString(16).padStart(6, '0');
  }
  function paintBuildMode() { const b = document.getElementById('buildModeBtn'); if (b) b.textContent = t(buildMode === 'place' ? 'bd.place' : 'bd.erase'); }
  function syncBCol(cx, cz) {
    const k = bKey(cx, cz);
    const col = bCols.get(k);
    if (!col) return;
    if (!col.cells.length) {
      if (col.col) { const i = colliders.indexOf(col.col); if (i >= 0) colliders.splice(i, 1); }
      bCols.delete(k);
      return;
    }
    if (!col.col) {
      col.col = { minX: -256 + cx * BCELL, maxX: -256 + (cx + 1) * BCELL, minZ: -256 + cz * BCELL, maxZ: -256 + (cz + 1) * BCELL, top: 0, bottom: 0, kill: false, win: false, climb: false, seat: false, seatYaw: 0 };
      colliders.push(col.col);
    }
    col.col.top = col.cells.length * BCELL;
  }
  function rebuildB() {
    if (!bMesh) return;
    let n = 0;
    bInstCells.length = 0;
    for (const [k, col] of bCols) {
      const p = k.split(',');
      const cx = +p[0], cz = +p[1];
      for (let l = 0; l < col.cells.length && n < BCAP; l++) {
        bPos.set(bWX(cx), l * BCELL + BCELL / 2, bWZ(cz));
        bMat4.compose(bPos, bQuat, bScl);
        bMesh.setMatrixAt(n, bMat4);
        bMesh.setColorAt(n, bCol3.setHex(PALETTE[col.cells[l]] || 0xffffff));
        bInstCells.push({ cx: cx, cz: cz, l: l });
        n++;
      }
    }
    buildCount = n;
    bMesh.count = n;
    bMesh.instanceMatrix.needsUpdate = true;
    if (bMesh.instanceColor) bMesh.instanceColor.needsUpdate = true;
    paintBuildCount();
  }
  let bSaveT = 0;
  function saveB() {
    if (bSaveT) return;
    bSaveT = setTimeout(() => {
      bSaveT = 0;
      const list = [];
      for (const [k, col] of bCols) { const p = k.split(','); for (const c of col.cells) list.push([+p[0], +p[1], c]); }
      try { localStorage.setItem('vortx_build_' + exp.id, JSON.stringify(list)); } catch (e) {}
    }, 250);
  }
  function loadB() {
    try {
      const list = JSON.parse(localStorage.getItem('vortx_build_' + exp.id) || '[]');
      if (!Array.isArray(list)) return;
      for (const it of list) {
        const cx = it[0] | 0, cz = it[1] | 0, c = it[2] | 0;
        if (cx < 0 || cz < 0 || cx >= BGRID || cz >= BGRID) continue;
        const k = bKey(cx, cz);
        let col = bCols.get(k);
        if (!col) { col = { cells: [], col: null }; bCols.set(k, col); }
        if (col.cells.length < BMAXH) col.cells.push(c);
      }
      for (const [k] of bCols) { const p = k.split(','); syncBCol(+p[0], +p[1]); }
      rebuildB();
    } catch (e) {}
  }
  function addB(cx, cz, c, fromNet) {
    if (!BUILD || cx < 0 || cz < 0 || cx >= BGRID || cz >= BGRID) return false;
    const k = bKey(cx, cz);
    let col = bCols.get(k);
    if (!col) { col = { cells: [], col: null }; bCols.set(k, col); }
    if (col.cells.length >= BMAXH) { if (!fromNet) buildToast(t('bd.maxh')); return false; }
    if (buildCount >= BCAP) { if (!fromNet) buildToast(t('bd.cap')); return false; }
    col.cells.push(c);
    syncBCol(cx, cz);
    rebuildB();
    saveB();
    if (!fromNet && netRoom) netRoom.send('blk', { op: 'add', cx: cx, cz: cz, c: c });
    return true;
  }
  function delB(cx, cz, fromNet) {
    if (!BUILD) return false;
    const col = bCols.get(bKey(cx, cz));
    if (!col || !col.cells.length) return false;
    col.cells.pop();
    syncBCol(cx, cz);
    rebuildB();
    saveB();
    if (!fromNet && netRoom) netRoom.send('blk', { op: 'del', cx: cx, cz: cz });
    return true;
  }
  function buildTarget() {
    if (!plateMeshRef) return null;
    bRay.setFromCamera(bNdc, camera);
    const objs = bMesh && buildCount ? [bMesh, plateMeshRef] : [plateMeshRef];
    const hits = bRay.intersectObjects(objs, false);
    for (const h of hits) {
      if (h.object === plateMeshRef) {
        if (!h.face || h.face.normal.y < 0.5) continue;
        const cx = Math.floor((h.point.x + 256) / BCELL), cz = Math.floor((h.point.z + 256) / BCELL);
        if (cx < 0 || cz < 0 || cx >= BGRID || cz >= BGRID) return null;
        const col = bCols.get(bKey(cx, cz));
        const top = col ? col.cells.length : 0;
        if (buildMode === 'erase') return top ? { cx: cx, cz: cz, l: top - 1, erase: true } : null;
        return { cx: cx, cz: cz, l: top };
      }
      const cell = bInstCells[h.instanceId];
      if (!cell) continue;
      const col = bCols.get(bKey(cell.cx, cell.cz));
      const top = col ? col.cells.length : 0;
      if (buildMode === 'erase') return top ? { cx: cell.cx, cz: cell.cz, l: top - 1, erase: true } : null;
      const n = h.face ? h.face.normal : null;
      if (n && (Math.abs(n.x) > 0.5 || Math.abs(n.z) > 0.5)) {
        const tx = cell.cx + Math.round(n.x), tz = cell.cz + Math.round(n.z);
        if (tx < 0 || tz < 0 || tx >= BGRID || tz >= BGRID) return null;
        const tc = bCols.get(bKey(tx, tz));
        return { cx: tx, cz: tz, l: tc ? tc.cells.length : 0 };
      }
      return { cx: cell.cx, cz: cell.cz, l: top };
    }
    return null;
  }
  function buildGhostTick() {
    if (!bGhost) return;
    if (!buildOn) { bGhost.visible = false; return; }
    if (document.pointerLockElement === canvas) bNdc.set(0, 0);
    else if (!bPtrSeen) { bGhost.visible = false; return; }
    const sig = camera.position.x.toFixed(1) + '|' + camera.position.y.toFixed(1) + '|' + camera.position.z.toFixed(1) + '|' + S.yaw.toFixed(3) + '|' + S.pitch.toFixed(3) + '|' + bNdc.x.toFixed(3) + '|' + bNdc.y.toFixed(3) + '|' + buildCount + '|' + buildMode + '|' + buildColor;
    if (sig !== bCacheSig) { bCacheSig = sig; bCacheTgt = buildTarget(); }
    const tgt = bCacheTgt;
    if (!tgt) { bGhost.visible = false; return; }
    bGhost.visible = true;
    bGhost.position.set(bWX(tgt.cx), tgt.l * BCELL + BCELL / 2, bWZ(tgt.cz));
    bGhost.material.color.setHex(buildMode === 'erase' ? 0xe23b3b : (PALETTE[buildColor] || 0xffffff));
  }
  function setBuildOn(v) {
    buildOn = v;
    const tools = document.getElementById('buildTools');
    if (tools) tools.classList.toggle('hidden', !v);
    const tg = document.getElementById('buildToggle');
    if (tg) tg.classList.toggle('on', v);
    const fb = document.getElementById('fireBtn'); if (fb) fb.style.display = v ? 'none' : '';
    const tb = document.getElementById('toolBar'); if (tb) tb.style.display = v ? 'none' : '';
    if (bGhost) bGhost.visible = false;
    if (v) buildToast(t('bd.hint'));
  }
  function buildNetMsg(ev, pl) {
    if (!BUILD || !pl) return;
    if (ev === 'blk') {
      if (pl.op === 'add') addB(pl.cx | 0, pl.cz | 0, pl.c | 0, true);
      else if (pl.op === 'del') delB(pl.cx | 0, pl.cz | 0, true);
    } else if (ev === 'blkReq') {
      if (!buildCount || !netRoom) return;
      const colsArr = [];
      for (const [k, col] of bCols) { const p = k.split(','); colsArr.push([+p[0], +p[1], col.cells]); }
      const CH = 150;
      const partsN = Math.max(1, Math.ceil(colsArr.length / CH));
      for (let i = 0; i < partsN; i++) netRoom.send('blkState', { to: pl.k, part: i, parts: partsN, cols: colsArr.slice(i * CH, (i + 1) * CH) });
    } else if (ev === 'blkState') {
      if (pl.to !== myKey || !Array.isArray(pl.cols)) return;
      for (const ent of pl.cols) {
        const cx = ent[0] | 0, cz = ent[1] | 0, cells = ent[2] || [];
        const k = bKey(cx, cz);
        let col = bCols.get(k);
        if (!col) { col = { cells: [], col: null }; bCols.set(k, col); }
        for (let l = col.cells.length; l < cells.length && l < BMAXH; l++) col.cells.push(cells[l]);
        syncBCol(cx, cz);
      }
      rebuildB();
      saveB();
    }
  }
  if (BUILD) {
    bMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(BCELL, BCELL, BCELL), new THREE.MeshStandardMaterial({ roughness: 0.65, metalness: 0.02, envMapIntensity: 0.4 }), BCAP);
    bMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    bMesh.castShadow = true;
    bMesh.receiveShadow = true;
    bMesh.frustumCulled = false;
    bMesh.count = 0;
    scene.add(bMesh);
    bGhost = new THREE.Mesh(new THREE.BoxGeometry(BCELL + 0.08, BCELL + 0.08, BCELL + 0.08), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false }));
    bGhost.visible = false;
    scene.add(bGhost);
    const bar = document.getElementById('buildBar');
    if (bar) {
      bar.classList.remove('hidden');
      const pal = document.getElementById('buildPal');
      if (pal) PALETTE.forEach((hex, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bsw' + (i === buildColor ? ' sel' : '');
        b.style.background = '#' + hex.toString(16).padStart(6, '0');
        b.addEventListener('click', () => { buildColor = i; paintBuildPal(); });
        pal.appendChild(b);
      });
      const tg = document.getElementById('buildToggle');
      if (tg) tg.addEventListener('click', () => setBuildOn(!buildOn));
      const mb = document.getElementById('buildModeBtn');
      if (mb) mb.addEventListener('click', () => { buildMode = buildMode === 'place' ? 'erase' : 'place'; paintBuildMode(); });
      paintBuildMode();
      paintBuildPal();
    }
    loadB();
    paintBuildCount();
    window.addEventListener('pointermove', (e) => {
      bPtrSeen = true;
      bNdc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    });
    canvas.addEventListener('pointerdown', (e) => { bDownX = e.clientX; bDownY = e.clientY; bDownT = performance.now(); });
    window.addEventListener('pointerup', (e) => {
      if (!buildOn || S.paused) return;
      if (performance.now() - bDownT > 500) return;
      if (Math.hypot(e.clientX - bDownX, e.clientY - bDownY) > 7) return;
      if (e.target !== canvas && document.pointerLockElement !== canvas) return;
      if (document.pointerLockElement === canvas) bNdc.set(0, 0);
      else bNdc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      const tgt = buildTarget();
      if (!tgt) return;
      if (tgt.erase) delB(tgt.cx, tgt.cz, false);
      else addB(tgt.cx, tgt.cz, buildColor, false);
    });
    window.addEventListener('keydown', (e) => {
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
      if (e.code === 'KeyB') setBuildOn(!buildOn);
      else if (e.code === 'KeyX' && buildOn) { buildMode = buildMode === 'place' ? 'erase' : 'place'; paintBuildMode(); }
    });
    window.__vortxBuild = {
      count: () => buildCount,
      add: (cx, cz, c) => addB(cx, cz, c, false),
      del: (cx, cz) => delB(cx, cz, false),
      colTop: (cx, cz) => { const col = bCols.get(bKey(cx, cz)); return col ? col.cells.length * BCELL : 0; },
      state: () => ({ on: buildOn, mode: buildMode, color: buildColor, count: buildCount }),
      setOn: (v) => setBuildOn(!!v)
    };
    const cleanB = setInterval(() => {
      if (!document.body.classList.contains('playing')) {
        clearInterval(cleanB);
        window.__vortxBuild = null;
        const bb = document.getElementById('buildBar'); if (bb) bb.classList.add('hidden');
        setBuildOn(false);
      }
    }, 400);
  }

  let netRoom = null, netStatus = 'off', netAcc = 0;
  const myName = (user && (user.display || user.username)) || 'VORTX';
  const myUn = (user && user.username) || '';
  const myKey = (user && user.id) || ('invitado-' + Math.random().toString(36).slice(2, 10));
  const iAmOwner = isOwnerUser(myUn);
  function ownerBadgeHtml() { return ' <span class="owner-tag">' + t('pl.ownerTag') + '</span>'; }
  function makeRemoteRig(meta) {
    const r = buildRig({ colors: meta.colors || {}, headShape: meta.headShape || 'block', face: meta.face || null });
    if (meta.faceItem) r.setEquipped([meta.faceItem], catalog);
    r.group.rotation.order = 'YXZ';
    r.group.visible = false;
    scene.add(r.group);
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 128;
    const g = cv.getContext('2d');
    g.textAlign = 'center'; g.font = '700 46px system-ui, sans-serif'; g.lineWidth = 8; g.strokeStyle = 'rgba(8,8,12,0.85)';
    const nm = meta.name || 'VORTX';
    g.strokeText(nm, 256, 60); g.fillStyle = '#ffffff'; g.fillText(nm, 256, 60);
    if (isOwnerUser(meta.un) || isOwnerUser(meta.name)) plateOwnerBadge(g, nm, 60);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false }));
    spr.scale.set(5.6, 1.4, 1);
    spr.visible = false;
    scene.add(spr);
    return { rig: r, anim: createAnimator(r), plate: spr, meta, target: null, blend: 0, t: Math.random() * 10, plateCtx: g, plateTex: spr.material.map, hp: -1, tool: 1, swingT: 0, tools: null, bubble: null, bubbleCtx: null, bubbleTex: null, bubbleUntil: 0, bubbleText: '' };
  }
  // ---------- Bubble chat (pieza 42) ----------
  // Burbuja sobre la cabeza de un jugador REMOTO cuando chatea: un
  // sprite con canvas, por la misma ruta que la placa del nombre (se
  // posiciona cada fotograma sobre el rig). El jugador local NUNCA
  // tiene burbuja: esta funcion solo se llama desde la recepcion de
  // mensajes de otros. Fuera avisos del sistema (remitente VORTX) y
  // fuera comandos /e. Una burbuja por jugador: la ultima sustituye.
  function drawBubblePill(g, lines) {
    g.clearRect(0, 0, 512, 224);
    const lh = 40, padY = 22;
    const h = padY * 2 + lines.length * lh;
    const y0 = 224 - 26 - h;
    g.beginPath();
    const x = 26, w = 460, r = 26;
    g.moveTo(x + r, y0);
    g.lineTo(x + w - r, y0); g.arcTo(x + w, y0, x + w, y0 + r, r);
    g.lineTo(x + w, y0 + h - r); g.arcTo(x + w, y0 + h, x + w - r, y0 + h, r);
    g.lineTo(276, y0 + h); g.lineTo(256, y0 + h + 22); g.lineTo(236, y0 + h);
    g.lineTo(x + r, y0 + h); g.arcTo(x, y0 + h, x, y0 + h - r, r);
    g.lineTo(x, y0 + r); g.arcTo(x, y0, x + r, y0, r);
    g.closePath();
    g.fillStyle = 'rgba(255,255,255,0.98)'; g.fill();
    g.lineWidth = 3; g.strokeStyle = 'rgba(10,10,16,0.22)'; g.stroke();
    g.font = '600 31px system-ui, sans-serif';
    g.textAlign = 'center'; g.fillStyle = '#141419';
    lines.forEach((ln, i) => g.fillText(ln, 256, y0 + padY + 30 + i * lh));
  }
  function remoteBubble(r, rawText) {
    const text = String(rawText || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!text || /^\s*\/e\b/i.test(text)) return;
    if (!r.bubble) {
      const cv = document.createElement('canvas');
      cv.width = 512; cv.height = 224;
      r.bubbleCtx = cv.getContext('2d');
      r.bubbleTex = new THREE.CanvasTexture(cv);
      r.bubble = new THREE.Sprite(new THREE.SpriteMaterial({ map: r.bubbleTex, transparent: true, depthWrite: false }));
      r.bubble.scale.set(5.4, 2.36, 1);
      r.bubble.visible = false;
      scene.add(r.bubble);
    }
    // Envolver a mano: maximo ~30 caracteres por linea, 3 lineas.
    const words = text.split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > 30) { if (cur) lines.push(cur); cur = w; if (lines.length === 3) break; }
      else cur = (cur + ' ' + w).trim();
    }
    if (cur && lines.length < 3) lines.push(cur);
    if (lines.length === 3) lines[2] = lines[2].replace(/.{0,3}$/, '…');
    drawBubblePill(r.bubbleCtx, lines);
    r.bubbleTex.needsUpdate = true;
    r.bubbleText = text;
    r.bubbleUntil = Date.now() + 7000;
    r.bubble.visible = true;
    r.bubble.material.opacity = 1;
  }
  // Leaderstats por experiencia: cada plantilla declara sus columnas
  // (tpl.stats) y los valores son contadores reales del motor, en vivo.
  const STAT_LABEL = { time: 'board.time', falls: 'board.falls', wins: 'board.wins', jumps: 'board.jumps', kos: 'board.kos', cash: 'board.cash' };
  function statCols() { return (tpl.stats && tpl.stats.length) ? tpl.stats : ['time', 'falls']; }
  function myStats() { return { time: S.sessionT, falls: S.falls, wins: S.wins, jumps: S.jumps, kos: S.kos, cash: S.earned }; }
  function remoteStats(r) {
    if (r.ls) return { time: r.ls.t || 0, falls: r.ls.f || 0, wins: r.ls.w || 0, jumps: r.ls.j || 0, kos: r.ls.ko || 0, cash: r.ls.c || 0 };
    return { time: (Date.now() - (r.seenAt || Date.now())) / 1000, falls: 0, wins: 0, jumps: 0, kos: 0, cash: 0 };
  }
  function statCells(vals) {
    return statCols().map(k => '<span class="pl-v' + (k === 'time' ? ' wide' : '') + '">' + (k === 'time' ? fmtTime(vals[k] || 0) : (vals[k] || 0)) + '</span>').join('');
  }
  function paintPlayers() {
    const el = document.getElementById('hudPlayers');
    if (!el) return;
    // Leaderstats de ESTA experiencia; la tabla se puede esconder.
    el.classList.toggle('board-off', !SETT.showBoard);
    const sb = document.getElementById('boardShowBtn');
    if (sb) {
      sb.classList.toggle('on', !SETT.showBoard);
      sb.onclick = () => { SETT.showBoard = true; saveSettings(SETT); paintPlayers(); };
    }
    el.innerHTML = '<button id="boardHideBtn" class="board-hide" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg></button>' +
      '<div class="pl-head"><span class="pl-name">' + t('board.player') + '</span>' + statCols().map(k => '<span class="pl-v' + (k === 'time' ? ' wide' : '') + '">' + t(STAT_LABEL[k]) + '</span>').join('') + '</div>' +
      '<div class="pl"><img class="uavatar" alt="" style="width:22px;height:22px;border-radius:6px" src="' + headImgFor(user) + '"><span class="pl-name">' + escHtml(user.display) + (iAmOwner ? ownerBadgeHtml() : '') + '</span>' + statCells(myStats()) + '</div>' +
      [...remotes.values()].map(r => '<div class="pl"><img class="uavatar" alt="" style="width:22px;height:22px;border-radius:6px" src="' + headImgFor(remoteHeadObj(r)) + '"><span class="pl-name">' + escHtml(r.meta.name || 'VORTX') + ((isOwnerUser(r.meta.un) || isOwnerUser(r.meta.name)) ? ownerBadgeHtml() : '') + '</span>' + statCells(remoteStats(r)) + '</div>').join('');
    const hb = document.getElementById('boardHideBtn');
    if (hb) hb.onclick = () => { SETT.showBoard = false; saveSettings(SETT); paintPlayers(); };
    buildPeople();
  }
  function syncRemotes(pres) {
    const seen = new Set();
    for (const k of Object.keys(pres)) {
      if (k === myKey) continue;
      seen.add(k);
      if (!remotes.has(k)) {
        const r = makeRemoteRig(pres[k] || {});
        r.seenAt = Date.now(); r.ls = null;
        if (COMBAT) combatRemoteInit(r);
        remotes.set(k, r);
        chatLine('<span class="sys">' + t('pl.joined', { name: escHtml(r.meta.name || t('pl.aPlayer')) }) + '</span>');
      }
    }
    for (const [k, r] of [...remotes]) {
      if (!seen.has(k)) {
        scene.remove(r.rig.group);
        scene.remove(r.plate);
        if (r.bubble) scene.remove(r.bubble);
        chatLine('<span class="sys">' + t('pl.left', { name: escHtml(r.meta.name || t('pl.aPlayer')) }) + '</span>');
        remotes.delete(k);
      }
    }
    paintPlayers();
  }
  // Sala privada por codigo (oleada 3): la pagina de la experiencia
  // guarda el codigo en sessionStorage junto al id; sin codigo, la
  // sala es la publica de siempre. El tema lleva -p<codigo>.
  let joinCode = '';
  try {
    if (sessionStorage.getItem('vortx_join_exp') === exp.id) joinCode = String(sessionStorage.getItem('vortx_join_code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  } catch (e) {}
  const roomTopic = 'vortx-exp-' + exp.id + (joinCode ? '-p' + joinCode : '');
  if (SETT.multi) {
    fill.style.width = '80%';
    loadText.textContent = t('load.connect');
    netStatus = 'connecting';
    netRoom = connectRoom({
      topic: roomTopic,
      key: myKey,
      meta: { name: myName, un: myUn, colors: user.avatar.colors, headShape: user.avatar.headShape || 'block', face: user.avatar.face || null, faceItem: (user.avatar.equipped || {}).face || null },
      onStatus: (st) => { netStatus = st; paintPlayers(); if (st === 'online') { chatLine('<span class="sys">' + t('pl.onlineLine') + '</span>'); if (BUILD) setTimeout(() => { if (netRoom) netRoom.send('blkReq', { k: myKey }); }, 1500); } },
      onPresence: (pres) => syncRemotes(pres),
      onMsg: (ev, pl) => {
        if (!pl) return;
        if (ev === 'pos') {
          const r = remotes.get(pl.k);
          if (!r) return;
          if (!r.target) {
            r.rig.group.position.set(pl.x, pl.y, pl.z);
            r.rig.group.rotation.y = pl.ry || 0;
            r.rig.group.visible = true;
            r.plate.visible = true;
          }
          r.ls = pl.ls || null;
          if (COMBAT) combatRemotePos(r, pl);
          r.target = pl;
        } else if (ev === 'shot') {
          if (COMBAT) combatRemoteShot(pl);
        } else if (ev === 'swing') {
          if (COMBAT) { const r2 = remotes.get(pl.k); if (r2) { r2.swingT = 1; audio.swing(); } }
        } else if (ev === 'hit') {
          if (COMBAT) combatHit(pl);
        } else if (ev === 'dead') {
          if (COMBAT) combatDead(pl);
        } else if (ev === 'admin') {
          adminReceive(pl);
        } else if (ev === 'blk' || ev === 'blkReq' || ev === 'blkState') {
          buildNetMsg(ev, pl);
        } else if (ev === 'chat') {
          chatMsgLine({ d: pl.name || 'VORTX', text: pl.text || '', at: Date.now(), un: pl.un || '' });
          // Bubble chat (pieza 42): solo mensajes de jugadores (el
          // remitente VORTX es el sistema), localizados por clave si el
          // mensaje la trae y si no por el nombre del remoto.
          if (pl.name && pl.name !== 'VORTX') {
            let rr = pl.k ? remotes.get(pl.k) : null;
            if (!rr) for (const [, cand] of remotes) { if (cand.meta && cand.meta.name === pl.name) { rr = cand; break; } }
            if (rr) remoteBubble(rr, pl.text || '');
          }
          const badge = document.getElementById('chatBadge');
          const cb = document.getElementById('chatBox');
          if (badge && cb && cb.classList.contains('hidden')) { badge.textContent = (parseInt(badge.textContent, 10) || 0) + 1; badge.classList.remove('hidden'); }
        }
      }
    });
    S.netClose = () => {
      try { netRoom.close(); } catch (e) {}
      for (const [, r] of remotes) { scene.remove(r.rig.group); scene.remove(r.plate); if (r.bubble) scene.remove(r.bubble); }
      remotes.clear();
    };
  }
  window.__vortxNet = () => ({ status: SETT.multi ? netStatus : 'off', remotes: remotes.size, topic: roomTopic, wireTopic: 'realtime:' + roomTopic, room: joinCode || null });
  // Gancho de depuracion (misma familia que __vortxState/__vortxNet):
  // inyecta un jugador remoto falso por la MISMA ruta que usa la
  // presencia real (makeRemoteRig + primer paquete pos), para probar
  // el render de remotos donde el WebSocket no llega (laboratorio).
  window.__vortxFakeRemote = (meta, pl) => {
    const k = 'fake-' + ((meta && meta.name) || 'remoto');
    if (!remotes.has(k)) {
      const r = makeRemoteRig(meta || {});
      r.seenAt = Date.now(); r.ls = null;
      if (COMBAT) combatRemoteInit(r);
      remotes.set(k, r);
      paintPlayers();
    }
    const r = remotes.get(k);
    if (pl) {
      if (!r.target) {
        r.rig.group.position.set(pl.x || 0, pl.y || 0, pl.z || 0);
        r.rig.group.rotation.y = pl.ry || 0;
        r.rig.group.visible = true;
        r.plate.visible = true;
      }
      r.target = pl;
    }
    return k;
  };
  window.__vortxFakeChat = (k, text) => {
    const r = remotes.get(k);
    if (r) remoteBubble(r, text);
  };
  window.__vortxBubbleInfo = (k) => {
    const r = remotes.get(k);
    if (!r) return null;
    return { has: !!r.bubble, visible: !!(r.bubble && r.bubble.visible), text: r.bubbleText || '' };
  };
  window.__vortxLocalBubble = () => ({ plateOnly: !!plate, bubble: false });
  window.__vortxFakeRemoteInfo = (k) => {
    const r = remotes.get(k || [...remotes.keys()].find(x => x.startsWith('fake-')));
    if (!r) return null;
    const out = { parts: {}, groupScale: r.rig.group.scale.toArray(), innerScale: r.rig.inner.scale.toArray() };
    const box = new THREE.Box3().setFromObject(r.rig.group);
    out.total = { min: box.min.toArray().map(v => +v.toFixed(2)), max: box.max.toArray().map(v => +v.toFixed(2)) };
    for (const key of Object.keys(r.rig.parts)) {
      const p = r.rig.parts[key];
      const b = new THREE.Box3().setFromObject(p.userData.mesh || p);
      out.parts[key] = { min: b.min.toArray().map(v => +v.toFixed(2)), max: b.max.toArray().map(v => +v.toFixed(2)) };
    }
    return out;
  };
  paintPlayers();
  S.boardInt = setInterval(() => {
    if (!document.body.classList.contains('playing')) { clearInterval(S.boardInt); return; }
    if (SETT.showBoard) paintPlayers();
  }, 1000);

  // ================= Combate VORTX =================
  // Sistema propio de la plataforma, activo solo en plantillas con
  // combat: true. Vida, blaster de proyectiles y espada, con dano y KOs
  // sincronizados por el mismo broadcast del multijugador. Cada cliente
  // aplica el dano sobre SU personaje: el que dispara detecta el impacto
  // y avisa, la victima descuenta su vida y anuncia la muerte.
  const projectiles = [];
  const flashes = [];
  let myTools = null, combatHud = null, hpFill = null, hpTxt = null, toolBtns = {}, fireBtnEl = null, combatAbort = null;
  const projGeo = new THREE.SphereGeometry(0.22, 10, 8);
  const projMat = new THREE.MeshBasicMaterial({ color: 0xc9a7ff });
  const flashGeo = new THREE.SphereGeometry(0.34, 8, 6);
  function toolGroup(kind) {
    const g = new THREE.Group();
    const M = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.05 });
    const B = (sx, sy, sz, c, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), M(c)); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
    if (kind === 1) {
      B(0.34, 0.52, 1.5, 0x2a2a30, 0, 0, 0.45);
      B(0.18, 0.18, 0.95, 0x5b2a86, 0, 0.08, 1.45);
      B(0.3, 0.55, 0.34, 0x17171c, 0, -0.42, -0.15);
      B(0.36, 0.14, 0.5, 0xa583d6, 0, 0.33, 0.5);
    } else {
      B(0.16, 0.5, 0.16, 0x17171c, 0, -0.2, 0);
      B(0.52, 0.13, 0.52, 0x5b2a86, 0, -0.5, 0);
      B(0.1, 2.5, 0.36, 0xd8d8de, 0, -1.85, 0);
    }
    return g;
  }
  function attachTool(rigX, kind) {
    const g = toolGroup(kind);
    g.position.set(0, -1.85, 0.12);
    rigX.parts.armR.add(g);
    return g;
  }
  function combatSetTool(n) {
    if (!COMBAT) return;
    S.tool = n;
    if (myTools) { myTools[1].visible = n === 1; myTools[2].visible = n === 2; }
    if (toolBtns[1]) toolBtns[1].classList.toggle('active', n === 1);
    if (toolBtns[2]) toolBtns[2].classList.toggle('active', n === 2);
  }
  function syncHpHud(flash) {
    if (hpFill) { hpFill.style.width = Math.max(S.hp, 0) + '%'; hpFill.style.background = S.hp > 30 ? '#43b02a' : '#d33f2e'; }
    if (hpTxt) hpTxt.textContent = String(Math.ceil(Math.max(S.hp, 0)));
    if (flash && combatHud) { combatHud.classList.remove('dmg'); void combatHud.offsetWidth; combatHud.classList.add('dmg'); }
  }
  function combatOnRespawn() {
    if (!COMBAT) return;
    S.hp = 100; S.protUntil = performance.now() + 2000;
    syncHpHud();
  }
  function spawnFlash(pos) {
    const m = new THREE.Mesh(flashGeo, new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 1 }));
    m.position.copy(pos);
    scene.add(m);
    flashes.push({ m, t: 0.14, dur: 0.14, grow: 14 });
  }
  function spawnProjectile(org, dir, mine, fromKey) {
    const m = new THREE.Mesh(projGeo, projMat);
    m.position.copy(org);
    scene.add(m);
    projectiles.push({ m, vel: dir.clone().multiplyScalar(95), life: 1.6, mine, from: fromKey });
  }
  function combatFireOnce() {
    if (!COMBAT || S.paused || S.hp <= 0) return;
    const now = performance.now();
    if (now < S.nextShot) return;
    S.nextShot = now + 150;
    const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
    const org = S.pos.clone(); org.y += 4.15; org.addScaledVector(dir, 1.4);
    spawnProjectile(org, dir, true, myKey);
    audio.shot(); vibrate(12);
    if (netRoom) netRoom.send('shot', { k: myKey, o: [+org.x.toFixed(2), +org.y.toFixed(2), +org.z.toFixed(2)], d: [+dir.x.toFixed(3), +dir.y.toFixed(3), +dir.z.toFixed(3)] });
  }
  function combatSwing() {
    if (!COMBAT || S.paused || S.hp <= 0) return;
    const now = performance.now();
    if (now < S.nextSwing) return;
    S.nextSwing = now + 450;
    S.swingT = 1;
    audio.swing();
    if (netRoom) netRoom.send('swing', { k: myKey });
    const dir = new THREE.Vector3(); camera.getWorldDirection(dir); dir.y = 0;
    if (dir.lengthSq() < 0.001) return;
    dir.normalize();
    for (const [k, r] of remotes) {
      if (!r.rig.group.visible) continue;
      const rp = r.rig.group.position;
      const dx = rp.x - S.pos.x, dz = rp.z - S.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 6 || Math.abs(rp.y - S.pos.y) > 5) continue;
      if ((dx * dir.x + dz * dir.z) / (dist || 1) < 0.35) continue;
      if (netRoom) netRoom.send('hit', { to: k, dmg: 45, by: myKey, name: myName });
    }
  }
  function combatDamage(dmg, byKey, byName) {
    if (!COMBAT || S.hp <= 0) return;
    const now = performance.now();
    if (now < S.protUntil) return;
    S.hp -= dmg; S.lastDmgT = now;
    audio.hit(); vibrate(40);
    if (S.hp > 0) { syncHpHud(true); return; }
    S.hp = 0; S.falls++;
    if (netRoom) netRoom.send('dead', { by: byKey, byName: byName || '', victim: myName, k: myKey });
    chatLine('<span class="sys">' + t('cb.koFeed', { k: escHtml(byName || 'VORTX'), v: escHtml(myName) }) + '</span>');
    audio.death(); vibrate(90);
    S.pos.set(spawn[0], spawn[1], spawn[2]); S.vel.set(0, 0, 0);
    S.climbing = null; S.sitting = null;
    S.hp = 100; S.protUntil = performance.now() + 2500; S.lastDmgT = performance.now();
    syncHpHud();
    paintPlayers();
  }
  function combatHit(pl) { if (pl.to === myKey) combatDamage(pl.dmg || 10, pl.by, pl.name); }
  function combatDead(pl) {
    chatLine('<span class="sys">' + t('cb.koFeed', { k: escHtml(pl.byName || 'VORTX'), v: escHtml(pl.victim || 'VORTX') }) + '</span>');
    if (pl.by === myKey) { S.kos++; audio.ko(); paintPlayers(); }
  }
  function combatRemoteShot(pl) {
    if (!pl.o || !pl.d) return;
    spawnProjectile(new THREE.Vector3(pl.o[0], pl.o[1], pl.o[2]), new THREE.Vector3(pl.d[0], pl.d[1], pl.d[2]), false, pl.k);
    audio.shot();
  }
  function drawRemotePlate(r) {
    if (!r.plateCtx) return;
    const g = r.plateCtx;
    g.clearRect(0, 0, 512, 128);
    g.textAlign = 'center'; g.font = '700 46px system-ui, sans-serif'; g.lineWidth = 8; g.strokeStyle = 'rgba(8,8,12,0.85)';
    const nm = r.meta.name || 'VORTX';
    g.strokeText(nm, 256, 52); g.fillStyle = '#ffffff'; g.fillText(nm, 256, 52);
    if (isOwnerUser(r.meta.un) || isOwnerUser(r.meta.name)) plateOwnerBadge(g, nm, 52);
    if (COMBAT && r.hp >= 0) {
      g.fillStyle = 'rgba(8,8,12,0.7)'; g.fillRect(156, 78, 200, 18);
      g.fillStyle = r.hp > 30 ? '#43b02a' : '#d33f2e';
      g.fillRect(158, 80, Math.round(196 * Math.max(r.hp, 0) / 100), 14);
    }
    if (r.plateTex) r.plateTex.needsUpdate = true;
  }
  function combatRemoteInit(r) {
    r.tools = { 1: attachTool(r.rig, 1), 2: attachTool(r.rig, 2) };
    r.tools[2].visible = false;
    r.hp = 100;
    drawRemotePlate(r);
  }
  function combatRemotePos(r, pl) {
    if (pl.tl && r.tools && r.tool !== pl.tl) {
      r.tool = pl.tl;
      r.tools[1].visible = pl.tl === 1;
      r.tools[2].visible = pl.tl === 2;
    }
    if (typeof pl.hp === 'number' && pl.hp >= 0 && r.hp !== pl.hp) { r.hp = pl.hp; drawRemotePlate(r); }
  }
  function combatFrame(dt) {
    if (S.firing && S.tool === 1) combatFireOnce();
    if (S.swingT > 0) {
      S.swingT = Math.max(0, S.swingT - dt * 3.2);
      if (myTools) myTools[2].rotation.x = -2.3 * Math.sin(S.swingT * Math.PI);
    }
    for (const [, r] of remotes) {
      if (r.swingT > 0 && r.tools) {
        r.swingT = Math.max(0, r.swingT - dt * 3.2);
        r.tools[2].rotation.x = -2.3 * Math.sin(r.swingT * Math.PI);
      }
    }
    if (S.hp > 0 && S.hp < 100 && performance.now() - S.lastDmgT > 4000) { S.hp = Math.min(100, S.hp + 6 * dt); syncHpHud(); }
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const pr = projectiles[i];
      pr.m.position.addScaledVector(pr.vel, dt);
      pr.life -= dt;
      let dead = pr.life <= 0;
      const pos = pr.m.position;
      if (!dead) {
        for (const c of colliders) {
          if (pos.x > c.minX - 0.1 && pos.x < c.maxX + 0.1 && pos.z > c.minZ - 0.1 && pos.z < c.maxZ + 0.1 && pos.y > c.bottom - 0.1 && pos.y < c.top + 0.1) { dead = true; break; }
        }
      }
      if (!dead && pr.mine) {
        for (const [k, r] of remotes) {
          if (!r.rig.group.visible) continue;
          const rp = r.rig.group.position;
          if (pos.y < rp.y - 0.2 || pos.y > rp.y + 5) continue;
          const dx = pos.x - rp.x, dz = pos.z - rp.z;
          if (dx * dx + dz * dz < 1.45) {
            dead = true;
            if (netRoom) netRoom.send('hit', { to: k, dmg: 20, by: myKey, name: myName });
            break;
          }
        }
      }
      if (dead) { spawnFlash(pos); scene.remove(pr.m); projectiles.splice(i, 1); }
    }
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      f.t -= dt;
      const fk = 1 - Math.max(f.t, 0) / f.dur;
      f.m.scale.setScalar(1 + fk * f.grow);
      f.m.material.opacity = 1 - fk;
      if (f.t <= 0) { scene.remove(f.m); f.m.material.dispose(); flashes.splice(i, 1); }
    }
  }
  if (COMBAT) {
    myTools = { 1: attachTool(rig, 1), 2: attachTool(rig, 2) };
    const gv = document.getElementById('hud') || document.body;
    combatHud = document.createElement('div');
    combatHud.id = 'hudHp';
    combatHud.innerHTML = '<div id="hudHpBar"><div id="hudHpFill"></div></div><span id="hudHpTxt">100</span>';
    gv.appendChild(combatHud);
    hpFill = combatHud.querySelector('#hudHpFill');
    hpTxt = combatHud.querySelector('#hudHpTxt');
    const bar = document.createElement('div');
    bar.id = 'toolBar';
    bar.innerHTML = '<button type="button" data-tool="1">1 · ' + t('cb.blaster') + '</button><button type="button" data-tool="2">2 · ' + t('cb.sword') + '</button>';
    gv.appendChild(bar);
    toolBtns = { 1: bar.querySelector('[data-tool="1"]'), 2: bar.querySelector('[data-tool="2"]') };
    toolBtns[1].addEventListener('click', () => combatSetTool(1));
    toolBtns[2].addEventListener('click', () => combatSetTool(2));
    combatSetTool(1);
    if ('ontouchstart' in window) {
      fireBtnEl = document.createElement('button');
      fireBtnEl.id = 'fireBtn'; fireBtnEl.type = 'button';
      fireBtnEl.setAttribute('aria-label', 'Disparar');
      fireBtnEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';
      gv.appendChild(fireBtnEl);
      fireBtnEl.addEventListener('pointerdown', (e) => { e.preventDefault(); S.firing = true; if (S.tool === 2) combatSwing(); });
      const endFire = () => { S.firing = false; };
      fireBtnEl.addEventListener('pointerup', endFire);
      fireBtnEl.addEventListener('pointercancel', endFire);
      fireBtnEl.addEventListener('pointerleave', endFire);
    }
    combatAbort = new AbortController();
    document.addEventListener('pointerlockchange', () => {
      S.aimLock = document.pointerLockElement === canvas;
      if (!S.aimLock) S.firing = false;
    }, { signal: combatAbort.signal });
    chatLine('<span class="sys">' + t('cb.hint') + '</span>');
    syncHpHud();
    window.__vortxCombat = {
      fire: () => { if (S.tool === 2) combatSwing(); else combatFireOnce(); },
      swing: combatSwing,
      damage: (n, by, name) => combatDamage(n, by || 'probe', name || 'Sonda'),
      setTool: combatSetTool,
      state: () => ({ hp: Math.round(S.hp), tool: S.tool, kos: S.kos, projs: projectiles.length })
    };
    const cleanInt = setInterval(() => {
      if (!document.body.classList.contains('playing')) {
        clearInterval(cleanInt);
        if (combatAbort) combatAbort.abort();
        if (combatHud) combatHud.remove();
        const tb = document.getElementById('toolBar'); if (tb) tb.remove();
        const fb = document.getElementById('fireBtn'); if (fb) fb.remove();
        const hb = document.getElementById('hudBomb'); if (hb) hb.remove();
        for (const pr of projectiles) scene.remove(pr.m);
        projectiles.length = 0;
        window.__vortxCombat = null;
      }
    }, 400);
  }



  function resize() {
    const w = overlay.clientWidth, h = overlay.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // En vertical (telefono) se abre el campo de vision para compensar
    // lo estrecho de la pantalla; en horizontal manda el ajuste del jugador.
    const baseFov = SETT.fov || 62;
    camera.fov = camera.aspect < 1 ? Math.min(100, baseFov + (1 - camera.aspect) * 22) : baseFov;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  fill.style.width = '100%';
  loadText.textContent = t('load.entering');
  setTimeout(() => {
    if (S.dead) return;
    loading.classList.add('hidden');
    hud.classList.remove('hidden');
  }, 420);

  const clock = new THREE.Clock();
  // Un subpaso de fisica: mover, empujar fuera, gravedad y piezas
  // especiales. Se llama varias veces por frame (ver frame()).
  // Piezas especiales: mortales (kill) y meta (win). Se revisan en
  // todos los modos de movimiento.
  function checkHazards() {
      for (const h of hazards) {
        if (S.pos.x < h.minX - 0.28 || S.pos.x > h.maxX + 0.28 || S.pos.z < h.minZ - 0.28 || S.pos.z > h.maxZ + 0.28) continue;
        if (S.pos.y < h.top - 0.7 || S.pos.y > h.top + 0.12) continue;
        if (h.kill) {
          S.pos.set(spawn[0], spawn[1], spawn[2]); S.vel.set(0, 0, 0);
          S.falls++; S.runT = 0; audio.death(); vibrate(70); S.climbing = null; S.sitting = null; combatOnRespawn(); paintPlayers();
          break;
        }
        if (h.win && !S.won) {
          S.wins++; S.won = true; S.winTime = S.runT; audio.win(); vibrate([50, 60, 50]);
          const prevBest = user.bestTimes && user.bestTimes[exp.id];
          window.__vortxWin = { exp: exp.id, time: S.runT };
          window.dispatchEvent(new CustomEvent('vortx-win', { detail: { expId: exp.id, time: S.runT } }));
          const wb = document.getElementById('winBanner');
          if (wb) {
            document.getElementById('winTime').textContent = fmtTime(S.runT);
            document.getElementById('winBest').textContent =
              prevBest == null ? t('pl.winFirst') :
              (S.runT < prevBest ? t('pl.winNew', { t: fmtTime(prevBest) }) : t('pl.winKeep', { t: fmtTime(prevBest) }));
            wb.classList.remove('hidden');
          }
        }
      }
  }

  // Un subpaso en modo escalada: sin gravedad, pegado a la cara de la
  // pieza climb; W sube, S baja, A/D se desliza, Space salta fuera.
  function climbStep(sdt) {
    const cl = S.climbing, b = cl.box;
    S.pos.y += S.climbDir * 5.4 * sdt;
    const tx = -cl.nz, tz = cl.nx;
    S.pos.x += tx * S.climbStrafe * 4.2 * sdt;
    S.pos.z += tz * S.climbStrafe * 4.2 * sdt;
    if (Math.abs(cl.nx) > 0.5) S.pos.z = THREE.MathUtils.clamp(S.pos.z, b.minZ + 0.25, b.maxZ - 0.25);
    else S.pos.x = THREE.MathUtils.clamp(S.pos.x, b.minX + 0.25, b.maxX - 0.25);
    if (cl.nx) S.pos.x = cl.nx > 0 ? b.maxX + 0.42 : b.minX - 0.42;
    else S.pos.z = cl.nz > 0 ? b.maxZ + 0.42 : b.minZ - 0.42;
    S.vel.y = 0;
    S.grounded = false;
    if (S.jumpQueued) {
      S.jumpQueued = false;
      S.climbing = null;
      S.pos.x += cl.nx * 0.55; S.pos.z += cl.nz * 0.55;
      S.vel.y = 12.5;
      audio.jump();
      return;
    }
    if (S.pos.y >= b.top - 0.02) {
      // Arriba del todo: se sube a la superficie y sale de la
      // escalada. El paso hacia dentro se recorta a la huella de la
      // pieza: en piezas finas el paso fijo de 0.95 cruzaba al otro
      // lado y el jugador caía por el borde contrario.
      S.pos.y = b.top;
      S.pos.x -= cl.nx * 0.95; S.pos.z -= cl.nz * 0.95;
      S.pos.x = THREE.MathUtils.clamp(S.pos.x, b.minX + 0.1, b.maxX - 0.1);
      S.pos.z = THREE.MathUtils.clamp(S.pos.z, b.minZ + 0.1, b.maxZ - 0.1);
      S.climbing = null; S.grounded = true;
      return;
    }
    if (S.pos.y <= b.bottom + 0.02) {
      S.pos.y = b.bottom;
      S.climbing = null; S.grounded = true;
    }
  }

  // Un subpaso de fisica segun el modo: escalada, sentado, nado o el
  // movimiento normal (mover, empujar fuera, gravedad con tolerancia de
  // escalon medida ANTES de integrar la gravedad, salto y especiales).
  function physicsStep(sdt, mx, mz, speed) {
    // Congelado por un owner (pieza 44): ni moverse ni saltar ni caer
    // hasta /unfreeze o salir de la experiencia.
    if (S.frozenMe) { S.jumpQueued = false; S.vel.set(0, 0, 0); return; }
    // Vuelo de owner (pieza 44): WASD en el plano de la cámara,
    // Espacio/E sube y Q baja; sin gravedad ni suelo mientras vuela.
    if (S.flying) {
      S.pos.x += mx * speed * sdt;
      S.pos.z += mz * speed * sdt;
      const vy = ((S.keys.Space || S.keys.KeyE) ? 1 : 0) - (S.keys.KeyQ ? 1 : 0);
      S.pos.y += vy * 15 * sdt;
      S.vel.y = 0;
      S.grounded = false;
      S.jumpQueued = false;
      checkHazards();
      return;
    }
    if (S.climbing) { climbStep(sdt); checkHazards(); return; }
    if (S.sitting) { S.vel.set(0, 0, 0); checkHazards(); return; }
    S.pos.x += mx * speed * sdt;
    S.pos.z += mz * speed * sdt;
    pushOut();
    const feetBefore = S.pos.y;
    if (S.inWater) {
      // Nado: flotacion hacia la linea de superficie, Space nada hacia
      // arriba y el fondo de la piscina sigue siendo suelo firme.
      const surf = S.swimSurf;
      if (S.keys.Space) S.vel.y = Math.min(S.vel.y + 42 * sdt, 5.5);
      else if (S.pos.y + 2.05 < surf) S.vel.y = Math.min(S.vel.y + 26 * sdt, 3.2);
      else S.vel.y = Math.max(S.vel.y - 16 * sdt, -2.4);
      S.pos.y += S.vel.y * sdt;
      const g = groundAt(S.pos.x, S.pos.z, feetBefore);
      if (g > -Infinity && S.pos.y <= g) { S.pos.y = g; S.vel.y = 0; S.grounded = true; }
      else S.grounded = false;
      if (S.jumpQueued) {
        if (S.grounded) { S.vel.y = 20.5 * ((perkJump || S.t < fxJumpUntil) ? 1.35 : 1); S.grounded = false; S.jumps++; audio.jump(); }
        else S.vel.y = 8.5;
        S.jumpQueued = false;
      }
    } else {
      S.vel.y -= 55 * sdt;
      if (S.vel.y < -55) S.vel.y = -55; // caida maxima: no atravesar piezas finas
      S.pos.y += S.vel.y * sdt;
      const g = groundAt(S.pos.x, S.pos.z, feetBefore);
      if (g > -Infinity && S.pos.y <= g) { S.pos.y = g; S.vel.y = 0; S.grounded = true; }
      else S.grounded = false;
      if (S.jumpQueued) {
        if (S.grounded) { S.vel.y = 20.5 * ((perkJump || S.t < fxJumpUntil) ? 1.35 : 1); S.grounded = false; S.jumps++; audio.jump(); }
        S.jumpQueued = false;
      }
    }
    if (S.pos.y < -18) { S.pos.set(spawn[0], spawn[1], spawn[2]); S.vel.set(0, 0, 0); S.falls++; combatOnRespawn(); paintPlayers(); }
    checkHazards();
  }

  function frame() {
    if (S.dead) return;
    S.raf = requestAnimationFrame(frame);
    if (SETT.fpsCap > 0) {
      const nowMs = performance.now();
      if (S.lastCap && nowMs - S.lastCap < (1000 / SETT.fpsCap) - 1) return;
      S.lastCap = nowMs;
    }
    const dt = Math.min(clock.getDelta(), 0.05);
    S.sessionT += dt;
    if (isFinite(drawDist)) {
      cullTimer += dt;
      const moved = Math.abs(camera.position.x - lastCullX) + Math.abs(camera.position.z - lastCullZ);
      if (cullTimer > 0.25 || moved > 8) { cullTimer = 0; evalCull(); }
    }
    S.frameMs = S.frameMs ? S.frameMs * 0.92 + dt * 1000 * 0.08 : dt * 1000;
    if (!S.paused) {
      S.t += dt;
      S.fpsFrames = (S.fpsFrames || 0) + 1;
      S.fpsTime = (S.fpsTime || 0) + dt;
      if (S.fpsTime >= 0.5) {
        const fps = Math.round(S.fpsFrames / S.fpsTime);
        S.fpsFrames = 0; S.fpsTime = 0; S.fpsNow = fps;
        const fe = document.getElementById('hudFps');
        if (fe) fe.textContent = 'FPS ' + fps;
        S.fpsAvg = S.fpsAvg ? S.fpsAvg * 0.6 + fps * 0.4 : fps;
        if (SETT.gfxMode === 'auto') {
          autoQuality(fps);
          dynTimer += 0.5;
          if (dynTimer >= 2) { dynTimer = 0; adjustDynRes(); }
        }
        if (S.perfOn) {
          const ph = document.getElementById('perfHud');
          if (ph) {
            const ri = renderer.info.render;
            ph.innerHTML = '<b>VORTX</b><br>fps ' + fps + '<br>frame ' + S.frameMs.toFixed(1) + ' ms<br>draws ' + ri.calls + '<br>tris ' + ri.triangles;
          }
        }
        if (S.paused) buildPeople();
      }
      if (CORE && !coreDone) coreSetup();
      if (tpl.timed && !S.won) {
        S.runT += dt;
        const te = document.getElementById('hudTimer');
        if (te) te.textContent = fmtTime(S.runT);
      }
      // Dirección de movimiento según teclas / joystick / mando.
      let ix = 0, iz = 0;
      if (S.keys.KeyW || S.keys.ArrowUp) iz -= 1;
      if (S.keys.KeyS || S.keys.ArrowDown) iz += 1;
      if (S.keys.KeyA || S.keys.ArrowLeft) ix -= 1;
      if (S.keys.KeyD || S.keys.ArrowRight) ix += 1;
      ix += S.joy.x; iz += S.joy.y;
      const gp = navigator.getGamepads && navigator.getGamepads()[0];
      if (gp) {
        if (Math.abs(gp.axes[0]) > 0.18) ix += gp.axes[0];
        if (Math.abs(gp.axes[1]) > 0.18) iz += gp.axes[1];
        if (gp.buttons[0] && gp.buttons[0].pressed) S.jumpQueued = true;
        const bNow = !!(gp.buttons[1] && gp.buttons[1].pressed);
        if (bNow && !S.gpCrouchWas) { S.crouchToggle = !S.crouchToggle; syncToggleBtns(); }
        S.gpCrouchWas = bNow;
      }
      const len = Math.hypot(ix, iz);
      let mx = 0, mz = 0;
      if (len > 0.01) {
        const n = Math.min(1, len);
        ix = ix / (len || 1) * n; iz = iz / (len || 1) * n;
        const sin = Math.sin(S.yaw), cos = Math.cos(S.yaw);
        // Adelante (W) = alejarse de la cámara; derecha (D) = perpendicular.
        mx = ix * cos + iz * sin;
        mz = -ix * sin + iz * cos;
      }
      // Agua: dentro de una caja de agua y bajo la superficie = nadar.
      S.inWater = false;
      for (const w of waterBoxes) {
        if (S.pos.x > w.x - w.sx / 2 && S.pos.x < w.x + w.sx / 2 && S.pos.z > w.z - w.sz / 2 && S.pos.z < w.z + w.sz / 2 && S.pos.y < w.y - 0.45 && S.pos.y > w.y - 3.6) {
          S.inWater = true; S.swimSurf = w.y; break;
        }
      }
      S.crouchOn = (S.crouchToggle || !!S.keys.ControlLeft) && !S.climbing && !S.inWater && !S.sitting;
      // Asiento: moverse o saltar levanta al jugador.
      if (S.sitting && (Math.hypot(ix, iz) > 0.2 || S.jumpQueued)) S.sitting = null;
      // Sentarse: quieto y en el suelo sobre una pieza seat durante 0,25 s.
      if (!S.sitting && !S.climbing && S.grounded && Math.hypot(mx, mz) < 0.05 && !S.inWater) {
        const gi = groundInfo(S.pos.x, S.pos.z, S.pos.y);
        if (gi.col && gi.col.seat && Math.abs(gi.g - S.pos.y) < 0.06) {
          S.seatTimer += dt;
          if (S.seatTimer > 0.25) S.sitting = gi.col;
        } else S.seatTimer = 0;
      } else if (!S.sitting) S.seatTimer = 0;
      // Escalada: empujar hacia una pieza climb cercana engancha al
      // jugador. La cara se elige por la distancia FUERA de la caja
      // en cada eje (la cara de verdad, sin normalizar por el tamaño
      // de la pieza): la versión anterior comparaba la posición
      // relativa al centro dividida por la mitad del tamaño, y en
      // piezas alargadas (un panel ancho y fino) elegía la cara
      // larga al acercarse por un extremo — el jugador empujaba de
      // derecha a izquierda contra el extremo y nunca se enganchaba
      // a esa cara, o quedaba pegado fuera del borde. Ahora también
      // se ajusta la coordenada tangencial al interior de la cara,
      // así el extremo engancha igual que el centro (pieza 45).
      if (!S.climbing && !S.sitting && !S.inWater && Math.hypot(mx, mz) > 0.25) {
        for (const b of climbBoxes) {
          if (S.pos.y < b.bottom - 0.1 || S.pos.y > b.top - 0.5) continue;
          const outX = S.pos.x < b.minX ? b.minX - S.pos.x : (S.pos.x > b.maxX ? S.pos.x - b.maxX : 0);
          const outZ = S.pos.z < b.minZ ? b.minZ - S.pos.z : (S.pos.z > b.maxZ ? S.pos.z - b.maxZ : 0);
          if (outX === 0 && outZ === 0) continue;
          if (Math.hypot(outX, outZ) > 0.75) continue;
          let nx = 0, nz = 0;
          if (outX >= outZ) nx = S.pos.x < b.minX ? -1 : 1;
          else nz = S.pos.z < b.minZ ? -1 : 1;
          // Hay que estar empujando HACIA la cara elegida.
          if (mx * -nx + mz * -nz < 0.25) continue;
          if (nx) {
            S.pos.x = nx > 0 ? b.maxX + 0.42 : b.minX - 0.42;
            S.pos.z = THREE.MathUtils.clamp(S.pos.z, b.minZ + 0.2, b.maxZ - 0.2);
          } else {
            S.pos.z = nz > 0 ? b.maxZ + 0.42 : b.minZ - 0.42;
            S.pos.x = THREE.MathUtils.clamp(S.pos.x, b.minX + 0.2, b.maxX - 0.2);
          }
          S.climbing = { box: b, nx, nz };
          S.vel.y = 0;
          break;
        }
      }
      if (S.climbing) {
        const gpUp = S.joy.y < -0.3, gpDown = S.joy.y > 0.3;
        S.climbDir = (S.keys.KeyW || S.keys.ArrowUp || gpUp) ? 1 : (S.keys.KeyS || S.keys.ArrowDown || gpDown) ? -1 : 0;
        S.climbStrafe = THREE.MathUtils.clamp(((S.keys.KeyD || S.keys.ArrowRight) ? 1 : 0) - ((S.keys.KeyA || S.keys.ArrowLeft) ? 1 : 0) + S.joy.x, -1, 1);
      }
      // /speed de owner (pieza 44): si hay velocidad fijada manda
      // ella; con 0 (o sin comando) manda la base del motor con sus
      // modificadores de siempre.
      const speed = (S.adminSpeed > 0 ? S.adminSpeed : 15 * ((perkSpeed || S.t < fxSpeedUntil) ? 1.5 : 1)) * (S.crouchOn ? 0.45 : 1) * (S.inWater ? 0.55 : 1);
      if (S.frozenMe) { mx = 0; mz = 0; }
      S.velYBefore = S.vel.y;
      // Fisica en subpasos: con un frame largo (pocos FPS) el avatar
      // atravesaria piezas finas; subpasos de <=1/60 s lo evitan.
      const physSteps = Math.min(4, Math.max(1, Math.ceil(dt / (1 / 60))));
      const sdt = dt / physSteps;
      for (let st = 0; st < physSteps; st++) physicsStep(sdt, mx, mz, speed);
      if (luaRuntime) {
        luaRuntime.update(S.t, dt);
        for (const h of luaHandles) {
          const overlap = S.pos.x + 0.45 > h.col.minX && S.pos.x - 0.45 < h.col.maxX &&
            S.pos.z + 0.45 > h.col.minZ && S.pos.z - 0.45 < h.col.maxZ &&
            S.pos.y + 4.8 >= h.col.bottom && S.pos.y <= h.col.top + 0.25;
          if (overlap && !h.touching) { h.touching = true; luaRuntime.fireTouched(h); }
          else if (!overlap) h.touching = false;
        }
      }
      // Personaje: orientacion segun el modo activo.
      rig.group.position.copy(S.pos);
      const moving = Math.hypot(mx, mz);
      if (S.climbing) {
        rig.group.rotation.y = dampAngle(rig.group.rotation.y, Math.atan2(-S.climbing.nx, -S.climbing.nz), 16, dt);
      } else if (S.sitting) {
        rig.group.rotation.y = dampAngle(rig.group.rotation.y, S.sitting.seatYaw, 10, dt);
      } else if (S.shiftLock || S.aimLock) {
        // Shift Lock (o mira de combate bloqueada): el personaje mira hacia donde mira la camara.
        rig.group.rotation.y = dampAngle(rig.group.rotation.y, S.yaw + Math.PI, 18, dt);
      } else if (moving > 0.05) {
        rig.group.rotation.y = dampAngle(rig.group.rotation.y, Math.atan2(mx, mz), 14, dt);
      }
      // Maquina de estados de animacion: la fisica manda, el
      // AnimationController posa con blending (ver anim.js).
      const speedH = moving * speed;
      if (!S.wasGrounded && S.grounded && !S.climbing && !S.inWater) {
        const impact = -S.velYBefore;
        if (impact > 15 || S.airTime > 0.38) {
          S.landT = impact > 25 ? 0.26 : 0.17;
          S.landDepth = impact > 25 ? 0.34 : 0.22;
          vibrate(22);
        }
        S.airTime = 0;
      }
      if (!S.grounded) S.airTime += dt;
      else if (S.landT <= 0) S.airTime = 0;
      if (S.landT > 0) S.landT -= dt;
      let st;
      if (S.climbing) st = 'climb';
      else if (S.inWater) st = 'swim';
      else if (S.sitting) st = 'sit';
      else if (S.landT > 0) st = 'land';
      else if (!S.grounded) st = S.vel.y > 1.5 ? 'jump' : 'fall';
      else if (S.crouchOn) st = 'crouch';
      else if (speedH > 16.5) st = 'run';
      else if (speedH > 0.6) st = 'walk';
      else st = 'idle';
      // Baile activo (pieza 36): manda sobre idle mientras el jugador
      // este quieto y en el suelo; moverse, saltar, sentarse, nadar o
      // escalar lo cancela, como en el comportamiento clasico.
      if (S.emote) {
        if (speedH > 0.6 || !S.grounded || S.climbing || S.sitting || S.inWater || S.jumpQueued) S.emote = null;
        else st = S.emote;
      }
      S.charState = st;
      S.wasGrounded = S.grounded;
      S.moveBlend += ((speedH > 0.6 ? 1 : 0) - S.moveBlend) * Math.min(1, dt * 9);
      const phaseVel = st === 'walk' || st === 'run' ? speedH * 0.62
        : st === 'crouch' ? speedH * 0.5
        : st === 'climb' ? S.climbDir * 4.6
        : st === 'dance' ? 7.5
        : st === 'dance2' ? 7.0
        : st === 'swim' ? (speedH > 0.6 ? 6.2 : 2.0) : 0;
      const groupPitch = anim.update(dt, {
        state: st, t: S.t, speedH, moveBlend: S.moveBlend,
        fallTime: S.airTime, landDepth: S.landDepth, phaseVel
      });
      rig.group.rotation.x = SETT.reduceMotion ? 0 : groupPitch + (st === 'walk' || st === 'run' ? 0.08 * S.moveBlend : 0);
      if (plate) {
        plate.visible = SETT.showNames;
        plate.position.set(S.pos.x, S.pos.y + 5.75, S.pos.z);
      }
      // Multijugador: emitir mi posicion (10 veces por segundo) y
      // interpolar a los demas jugadores con su propio Animator.
      if (netRoom) {
        netAcc += dt;
        if (netAcc >= 0.1) {
          netAcc = 0;
          netRoom.send('pos', { k: myKey, x: +S.pos.x.toFixed(2), y: +S.pos.y.toFixed(2), z: +S.pos.z.toFixed(2), ry: +rig.group.rotation.y.toFixed(3), st: S.charState || 'idle', em: S.emote || '', ls: { t: Math.floor(S.sessionT), f: S.falls, w: S.wins, j: S.jumps, ko: S.kos, c: Math.floor(S.earned) }, tl: COMBAT ? S.tool : 0, hp: COMBAT ? Math.round(S.hp) : -1 });
        }
      }
      for (const [, r] of remotes) {
        if (!r.target) continue;
        const tg = r.target, gp = r.rig.group.position;
        gp.set(
          gp.x + (tg.x - gp.x) * Math.min(1, dt * 10),
          gp.y + (tg.y - gp.y) * Math.min(1, dt * 10),
          gp.z + (tg.z - gp.z) * Math.min(1, dt * 10));
        let dy = (tg.ry || 0) - r.rig.group.rotation.y;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        r.rig.group.rotation.y += dy * Math.min(1, dt * 12);
        r.t += dt;
        // El baile del remoto viaja en el campo em del estado (pieza
        // 36): si viene, manda sobre el estado fisico para la pose.
        const rst = tg.em ? tg.em : (tg.st || 'idle');
        const rSpeedH = rst === 'run' ? 17 : rst === 'walk' ? 8 : rst === 'crouch' ? 4 : 0;
        r.blend += ((rSpeedH > 0.6 ? 1 : 0) - r.blend) * Math.min(1, dt * 9);
        const rPitch = r.anim.update(dt, { state: rst, t: r.t, speedH: rSpeedH, moveBlend: r.blend, fallTime: 0, landDepth: 0, phaseVel: rst === 'walk' || rst === 'run' ? rSpeedH * 0.62 : rst === 'swim' ? 5 : rst === 'climb' ? 4.6 : rst === 'dance' ? 7.5 : rst === 'dance2' ? 7.0 : 0 });
        r.rig.group.rotation.x = SETT.reduceMotion ? 0 : rPitch;
        r.plate.visible = SETT.showNames;
        r.plate.position.set(gp.x, gp.y + 5.75, gp.z);
        if (r.bubble) {
          const left = r.bubbleUntil - Date.now();
          if (left <= 0) r.bubble.visible = false;
          else {
            r.bubble.visible = true;
            r.bubble.material.opacity = Math.min(1, left / 900);
            r.bubble.position.set(gp.x, gp.y + 7.45, gp.z);
          }
        }
      }
      // Ambiente: nubes a la deriva, agua viva y particulas.
      if (waterAnim) waterUniforms.uTime.value = S.t;
      for (const c of clouds.children) { c.position.x += dt * 0.7; if (c.position.x > 250) c.position.x = -250; }
      if (coreReady()) {
        CORE.vc_step_motes(motePosPtr, moteBasePtr, motePhasePtr, MOTES, S.t);
      } else {
        for (let i = 0; i < MOTES; i++) {
          mPos[i * 3] = mBase[i * 3] + Math.sin(S.t * 0.24 + mPhase[i]) * 1.6;
          mPos[i * 3 + 1] = mBase[i * 3 + 1] + Math.sin(S.t * 0.4 + mPhase[i] * 1.7) * 0.9;
          mPos[i * 3 + 2] = mBase[i * 3 + 2] + Math.cos(S.t * 0.19 + mPhase[i]) * 1.6;
        }
      }
      moteGeo.attributes.position.needsUpdate = true;
      if (spray) {
        if (coreReady()) {
          CORE.vc_step_spray(sprayPosPtr, sprayVelPtr, spray.userData.N, dt, spray.userData.floor, tpl.water[0].x, 2.55, tpl.water[0].z, ((S.t * 1000) | 0) ^ 0x9e3779b9);
        } else {
          const sp = spray.geometry.attributes.position.array;
          for (let i = 0; i < spray.userData.N; i++) {
            sprayVel[i * 3 + 1] -= 8.5 * dt;
            sp[i * 3] += sprayVel[i * 3] * dt;
            sp[i * 3 + 1] += sprayVel[i * 3 + 1] * dt;
            sp[i * 3 + 2] += sprayVel[i * 3 + 2] * dt;
            if (sp[i * 3 + 1] < spray.userData.floor) spray.userData.reset(i, false);
          }
        }
        spray.geometry.attributes.position.needsUpdate = true;
      }
      if (sparks) {
        const sp0 = sparks.userData.base, sp = sparks.userData.pos;
        for (let i = 0; i < sp0.n; i++) {
          sp[i * 3 + 1] += sparkVel[i] * dt;
          sp[i * 3] += Math.sin(S.t * 2 + i) * 0.25 * dt;
          if (sp[i * 3 + 1] > sp0.y + 5.5) sp[i * 3 + 1] = sp0.y;
        }
        sparks.geometry.attributes.position.needsUpdate = true;
      }
      // Estela del jugador.
      trailClock += dt;
      if (trailClock > 0.045) {
        trailClock = 0;
        if (Math.hypot(mx, mz) > 0.05 && !SETT.reduceMotion) {
          trailPos[trailIdx * 3] = S.pos.x;
          trailPos[trailIdx * 3 + 1] = S.pos.y + 1.6;
          trailPos[trailIdx * 3 + 2] = S.pos.z;
          trailAge[trailIdx] = 0;
          trailIdx = (trailIdx + 1) % TRAIL_N;
        }
      }
      for (let i = 0; i < TRAIL_N; i++) {
        trailAge[i] += dt;
        const f = Math.max(0, 1 - trailAge[i] / 0.55);
        trailCol[i * 3] = 0.65 * f; trailCol[i * 3 + 1] = 0.51 * f; trailCol[i * 3 + 2] = 0.84 * f;
        if (f <= 0) trailPos[i * 3 + 1] = -999;
      }
      trailGeo.attributes.position.needsUpdate = true;
      trailGeo.attributes.color.needsUpdate = true;
      // Modos de camara: Seguir alinea la camara tras el avatar al
      // moverse; Primera persona pone la camara en la cabeza y oculta
      // la cabeza (como en los clientes clasicos).
      if (SETT.camMode === 'seguir' && !S.shiftLock && speedH > 1) {
        S.yaw = dampAngle(S.yaw, rig.group.rotation.y + Math.PI, 3.0, dt);
      }
      rig.parts.head.visible = SETT.camMode !== 'primera';
      if (SETT.camMode === 'primera') {
        const fx = -Math.sin(S.yaw), fz = -Math.cos(S.yaw);
        camera.position.set(S.pos.x + fx * 0.25, S.pos.y + 4.42, S.pos.z + fz * 0.25);
        camera.lookAt(S.pos.x + fx * 10, S.pos.y + 4.42 - (THREE.MathUtils.clamp(S.pitch, -0.15, 1.25) - 0.32) * 7, S.pos.z + fz * 10);
      } else {
      // Cámara tercera persona. Si una pared queda entre la camara y el
      // jugador, la camara se acerca (prueba de segmento contra las cajas
      // de colision) en vez de quedarse fuera del recinto.
      const cx = S.pos.x + Math.sin(S.yaw) * Math.cos(S.pitch) * S.dist;
      const cz = S.pos.z + Math.cos(S.yaw) * Math.cos(S.pitch) * S.dist;
      const cy = S.pos.y + 2.8 + Math.sin(S.pitch) * S.dist;
      let px = S.pos.x, py = S.pos.y + 3.0, pz = S.pos.z;
      if (S.shiftLock) {
        // Desplazamiento lateral de hombro, marca del Shift Lock.
        px += Math.cos(S.yaw) * 1.7;
        pz += -Math.sin(S.yaw) * 1.7;
        py += 0.35;
      }
      let dx = cx - px, dy = cy - py, dz = cz - pz;
      const dLen = Math.hypot(dx, dy, dz) || 1;
      dx /= dLen; dy /= dLen; dz /= dLen;
      let maxT = dLen;
      for (const c of colliders) {
        let tmin = 0.05, tmax = maxT, ok = true;
        const axes = [[px, dx, c.minX, c.maxX], [py, dy, c.bottom, c.top], [pz, dz, c.minZ, c.maxZ]];
        for (const [o, d, mn, mx] of axes) {
          if (Math.abs(d) < 1e-8) { if (o < mn || o > mx) { ok = false; break; } continue; }
          let t1 = (mn - o) / d, t2 = (mx - o) / d;
          if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
          tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
          if (tmin > tmax) { ok = false; break; }
        }
        if (ok && tmin < maxT) maxT = Math.max(1.2, tmin - 0.4);
      }
      const ex = px + dx * maxT, ey = py + dy * maxT, ez = pz + dz * maxT;
      // El suelo que cuenta para no hundir la camara es el alcanzable
      // desde el pivote (misma tolerancia de escalon): un techo o una
      // pasarela alta NO es suelo para la camara.
      const cg = groundAt(ex, ez, py);
      camera.position.set(ex, Math.max(ey, (cg > -Infinity ? cg : -Infinity) + 0.5), ez);
      camera.lookAt(px, py + 0.1, pz);
      }
    }
    // Bajo el agua (camara sumergida en una caja de agua): tinte azul
    // general y niebla corta, como en las fotos del usuario. Solo en
    // calidad media/alta; al salir se restaura la niebla de aire.
    {
      let sub = false;
      if (waterAnim) {
        for (const w of waterBoxes) {
          if (camera.position.y < w.y - 0.05 && Math.abs(camera.position.x - w.x) <= w.sx / 2 + 1 && Math.abs(camera.position.z - w.z) <= w.sz / 2 + 1) { sub = true; break; }
        }
      }
      if (sub !== underNow) {
        underNow = sub;
        const tint = document.getElementById('uwTint');
        if (tint) tint.classList.toggle('hidden', !sub);
        if (sub) { scene.fog.color.set(0x175d86); scene.fog.near = 0.5; scene.fog.far = 30; }
        else { scene.fog.color.set(0xdce6ee); scene.fog.near = airFog.near; scene.fog.far = airFog.far; }
      }
    }
    // El cielo sigue a la camara: la cupula y los resplandores del sol
    // son elementos direccionales, no del mundo; anclados al origen se
    // perdian al alejarse o al girar (cielo negro, pieza 35).
    skyMesh.position.copy(camera.position);
    sunSpr.position.copy(camera.position).addScaledVector(SUN_DIR, 285);
    sunCore.position.copy(camera.position).addScaledVector(SUN_DIR, 283);
    if (COMBAT) combatFrame(dt);
    // La camara de sombras sigue al jugador, cuantizada al tamano del
    // texel para que las sombras no "naden" al moverse: la zona con
    // sombras es el area de juego real alrededor del avatar, no un
    // fijo enorme centrado en el origen (antes el spawn de The
    // Underground War quedaba directamente fuera de la zona).
    if (sun.castShadow) {
      const scm = sun.shadow.camera;
      const texel = (scm.right * 2) / sun.shadow.mapSize.x;
      const cx = Math.round(S.pos.x / texel) * texel;
      const cy = Math.round(S.pos.y / texel) * texel;
      const cz = Math.round(S.pos.z / texel) * texel;
      sun.target.position.set(cx, cy, cz);
      sun.position.set(cx + SUN_DIR.x * 60, cy + SUN_DIR.y * 60, cz + SUN_DIR.z * 60);
      sun.target.updateMatrixWorld();
    }
    sparkMat.uniforms.uTime.value = S.t;
    if (BUILD) buildGhostTick();
    renderFrame();
  }
  // ---------- Motor Lua: scripts de la experiencia ----------
  const luaHandles = new Set();
  let luaRuntime = null;
  window.__vortxLua = () => null;
  if ((exp.scripts || []).length) {
    const luaGroup = new THREE.Group();
    scene.add(luaGroup);
    const syncCol = (h) => {
      h.col.minX = h.cx - h.sx / 2; h.col.maxX = h.cx + h.sx / 2;
      h.col.minZ = h.cz - h.sz / 2; h.col.maxZ = h.cz + h.sz / 2;
      h.col.top = h.cy + h.sy / 2; h.col.bottom = h.cy - h.sy / 2;
    };
    const bridge = {
      print(name, text) { chatLine('<span class="sys">[' + escHtml(name) + '] ' + escHtml(text) + '</span>'); },
      error(name, message) { chatLine('<span class="sys">[Lua · ' + escHtml(name) + '] ' + escHtml(message) + '</span>'); },
      spawnPart(props) {
        const geo = new THREE.BoxGeometry(Math.max(0.1, props.sx), Math.max(0.1, props.sy), Math.max(0.1, props.sz));
        const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(props.r, props.g, props.b), roughness: 0.8, metalness: 0.02, transparent: props.transparency > 0.01, opacity: 1 - props.transparency });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(props.px, props.py, props.pz);
        mesh.castShadow = true; mesh.receiveShadow = true;
        luaGroup.add(mesh);
        const handle = { mesh, mat, geo, col: {}, solid: false, touching: false,
          cx: props.px, cy: props.py, cz: props.pz, sx: props.sx, sy: props.sy, sz: props.sz, baseSx: props.sx, baseSy: props.sy, baseSz: props.sz };
        syncCol(handle);
        if (props.canCollide) { colliders.push(handle.col); handle.solid = true; luaPartCount++; }
        luaHandles.add(handle);
        return handle;
      },
      updatePart(handle, patch) {
        if (patch.position) { handle.cx = patch.position.x; handle.cy = patch.position.y; handle.cz = patch.position.z; handle.mesh.position.set(handle.cx, handle.cy, handle.cz); syncCol(handle); }
        if (patch.size) {
          handle.sx = Math.max(0.1, patch.size.x); handle.sy = Math.max(0.1, patch.size.y); handle.sz = Math.max(0.1, patch.size.z);
          handle.mesh.scale.set(handle.sx / handle.baseSx, handle.sy / handle.baseSy, handle.sz / handle.baseSz);
          syncCol(handle);
        }
        if (patch.color) handle.mat.color.setRGB(patch.color.r, patch.color.g, patch.color.b);
        if (typeof patch.transparency === 'number') { handle.mat.opacity = 1 - patch.transparency; handle.mat.transparent = patch.transparency > 0.01; }
        if (typeof patch.canCollide === 'boolean' && patch.canCollide !== handle.solid) {
          if (patch.canCollide) { colliders.push(handle.col); handle.solid = true; luaPartCount++; }
          else { const i = colliders.indexOf(handle.col); if (i >= 0) colliders.splice(i, 1); handle.solid = false; luaPartCount--; }
        }
      },
      destroyPart(handle) {
        if (handle.solid) { const i = colliders.indexOf(handle.col); if (i >= 0) colliders.splice(i, 1); luaPartCount--; }
        luaGroup.remove(handle.mesh);
        handle.geo.dispose(); handle.mat.dispose();
        luaHandles.delete(handle);
      },
      getPlayerPos() { return { x: S.pos.x, y: S.pos.y + 2.4, z: S.pos.z }; },
      setPlayerPos(x, y, z) { S.pos.set(x, y - 2.4, z); S.vel.set(0, 0, 0); },
      respawnPlayer() { S.pos.set(spawn[0], spawn[1], spawn[2]); S.vel.set(0, 0, 0); S.climbing = null; S.sitting = null; },
      playerName() { return user.display || user.username || 'VORTX'; }
    };
    luaRuntime = createLuaRuntime(bridge);
    if (luaRuntime) {
      S.luaRuntime = luaRuntime;
      for (const sc of exp.scripts) luaRuntime.addScript(sc.name || 'Script', sc.code || '');
      window.__vortxLua = () => ({ scripts: luaRuntime.aliveScripts(), parts: luaRuntime.partCount() });
    }
  }
  frame();
}

function equippedIds(user) {
  return Object.values((user.avatar && user.avatar.equipped) || {}).filter(Boolean);
}
function dampAngle(a, b, lambda, dt) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-lambda * dt));
}
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.addEventListener('vortx-lang', () => { if (window.__vortxLangHook) window.__vortxLangHook(); });
