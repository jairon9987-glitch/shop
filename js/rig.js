// VORTX — Motor de personaje R6.
// El cuerpo es el modelo propio de Jairon (seis piezas: Head, Torso,
// Left/Right Arm, Left/Right Leg) hecho por el con ayuda de ChatGPT y
// exportado de Blender; su geometria vive en rig-geometry.js, ya
// convertida a posiciones relativas al pivote de cada pieza.
// Sin R15 ni R5, sin meshes ni caras de Roblox: el rostro (opcional)
// se dibuja por codigo aqui mismo.
// Sistema de attachments: puntos de anclaje con nombre sobre las
// piezas; los accesorios son objetos independientes que se montan
// en esos puntos.
import * as THREE from '../vendor/three.module.js';
import { PART_GEOMETRY } from './rig-geometry.js';
import { templateGeometryData } from './template-uv.js';

// Offsets relativos al pivote de cada pieza (ver rig-geometry.js).
export const ATTACHMENTS = {
  hat:      { part: 'head',  pos: [0, 1.30, 0] },
  hair:     { part: 'head',  pos: [0, 1.22, -0.05] },
  face:     { part: 'head',  pos: [0, 0.63, 0.60] },
  neck:     { part: 'torso', pos: [0, 0.95, 0] },
  back:     { part: 'torso', pos: [0, 0.15, -0.56] },
  waist:    { part: 'torso', pos: [0, -0.95, 0] },
  shoulderL:{ part: 'armL',  pos: [0, -0.06, 0] },
  shoulderR:{ part: 'armR',  pos: [0, -0.06, 0] },
  handL:    { part: 'armL',  pos: [0, -1.85, 0] },
  handR:    { part: 'armR',  pos: [0, -1.85, 0] },
  footL:    { part: 'legL',  pos: [0, -1.85, 0] },
  footR:    { part: 'legR',  pos: [0, -1.85, 0] }
};

const mat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.05 });

// ---------------- Ropa con plantilla 585x559 ----------------
// Las piezas que llevan ropa (torso, brazos, piernas) usan la
// geometría expandida con UVs de template-uv.js: las mismas posiciones
// que el modelo propio, pero con UVs en espacio de plantilla para que
// cada cara muestree su rectángulo. Sin prenda equipada, la pieza usa
// su material de color sólido de siempre (las UVs quedan sin usar).
const CLOTHABLE = ['torso', 'armL', 'armR', 'legL', 'legR'];
const clothingGeoCache = {};
function clothingGeo(key) {
  if (!clothingGeoCache[key]) {
    const g = PART_GEOMETRY[key];
    const d = templateGeometryData(key, g.positions, g.indices);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(d.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(d.nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(d.uv, 2));
    clothingGeoCache[key] = geo;
  }
  return clothingGeoCache[key];
}

// Texturas de plantilla (PNG 585x559 tal cual): se componen sobre
// blanco para que las zonas transparentes del diseño no salgan negras
// (el RGB guardado bajo alfa 0 suele ser negro). La textura existe
// desde el primer cuadro (lienzo blanco) y se rellena al cargar la
// imagen; los bucles de render la muestran sola y las vistas fijas
// (itemPreview) se re-renderizan con whenTemplateTexReady.
const templateTexCache = {};
export function loadTemplateTex(url, onLoad) {
  let e = templateTexCache[url];
  if (!e) {
    const canvas = document.createElement('canvas');
    canvas.width = 585; canvas.height = 559;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 585, 559);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    e = { tex, loaded: false, cbs: [] };
    templateTexCache[url] = e;
    const img = new Image();
    const done = () => {
      e.loaded = true;
      const cbs = e.cbs; e.cbs = [];
      for (const cb of cbs) { try { cb(); } catch (_) { /* vista ya cerrada */ } }
    };
    img.onload = () => {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 585, 559);
      ctx.drawImage(img, 0, 0, 585, 559);
      tex.needsUpdate = true;
      done();
    };
    img.onerror = done;
    img.src = url;
  }
  if (onLoad && !e.loaded) e.cbs.push(onLoad);
  return e.tex;
}
// Registra un re-render cuando la textura termine de cargar. Si ya
// está cargada no hace nada (el render actual ya la usa).
export function whenTemplateTexReady(url, cb) { loadTemplateTex(url, cb); }

const clothingMatCache = {};
function clothingMaterial(url) {
  if (!clothingMatCache[url]) {
    clothingMatCache[url] = new THREE.MeshStandardMaterial({ map: loadTemplateTex(url), roughness: 0.85 });
  }
  return clothingMatCache[url];
}

function faceTexture(style) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  g.fillStyle = '#20242c';
  g.strokeStyle = '#20242c';
  g.lineCap = 'round';
  const eyeDot = (x, y) => { g.beginPath(); g.ellipse(x, y, 13, 19, 0, 0, Math.PI * 2); g.fill(); };
  const eyeHappy = (x, y) => { g.lineWidth = 12; g.beginPath(); g.arc(x, y + 8, 17, Math.PI * 1.12, Math.PI * 1.88); g.stroke(); };
  if (style === 'feliz') {
    // Cara Feliz: ojos cerrados de alegria y sonrisa abierta.
    eyeHappy(88, 104); eyeHappy(168, 104);
    g.beginPath(); g.arc(128, 142, 46, Math.PI * 0.12, Math.PI * 0.88); g.lineWidth = 12; g.stroke();
    g.beginPath(); g.arc(128, 150, 34, Math.PI * 0.2, Math.PI * 0.8); g.fill();
  } else if (style === 'eclipse') {
    // Cara Eclipse (Limited): ojos de media luna y anillo de eclipse.
    const crescent = (x, y) => {
      g.save();
      g.beginPath(); g.ellipse(x, y, 15, 20, 0, 0, Math.PI * 2); g.fill();
      g.globalCompositeOperation = 'destination-out';
      g.beginPath(); g.ellipse(x + 9, y - 6, 13, 18, 0, 0, Math.PI * 2); g.fill();
      g.restore();
    };
    crescent(88, 108); crescent(168, 108);
    g.lineWidth = 7; g.beginPath(); g.arc(128, 50, 13, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(128, 50, 4, 0, Math.PI * 2); g.fill();
    g.lineWidth = 11; g.beginPath(); g.arc(128, 138, 44, Math.PI * 0.18, Math.PI * 0.82); g.stroke();
  } else if (style === 'guino') {
    eyeDot(88, 108);
    g.lineWidth = 12; g.beginPath(); g.moveTo(150, 108); g.lineTo(186, 108); g.stroke();
    g.lineWidth = 11; g.beginPath(); g.arc(128, 138, 44, Math.PI * 0.18, Math.PI * 0.82); g.stroke();
  } else {
    // Clasica VORTX: dos ojos y sonrisa sencilla.
    eyeDot(88, 108); eyeDot(168, 108);
    g.lineWidth = 11; g.beginPath(); g.arc(128, 138, 44, Math.PI * 0.18, Math.PI * 0.82); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

export function buildRig(cfg) {
  cfg = cfg || {};
  const colors = Object.assign({ head: 0xf5f5f5, torso: 0x4c1d95, armL: 0xf5f5f5, armR: 0xf5f5f5, legL: 0x17171c, legR: 0x17171c }, cfg.colors || {});
  // Color base por pieza (el que se ve cuando la pieza no lleva ropa).
  const baseColors = Object.assign({}, colors);
  // Material sólido propio de cada pieza (para volver a él al quitar ropa).
  const solidMats = {};
  const root = new THREE.Group();
  const inner = new THREE.Group();
  root.add(inner);
  const parts = {};

  function partMesh(key, color) {
    let geo;
    if (CLOTHABLE.includes(key)) {
      // Geometría con UVs de plantilla (mismas posiciones que el modelo).
      geo = clothingGeo(key);
    } else {
      const g = PART_GEOMETRY[key];
      geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(g.positions, 3));
      geo.setIndex(g.indices);
      geo.computeVertexNormals();
    }
    const material = mat(color);
    solidMats[key] = material;
    const m = new THREE.Mesh(geo, material);
    m.castShadow = true;
    return m;
  }

  // Piezas con pivote (piernas, brazos, cabeza): el pivote esta en la
  // articulacion y la geometria cuelga de el.
  for (const key of ['legL', 'legR', 'armL', 'armR']) {
    const pivot = new THREE.Group();
    const p = PART_GEOMETRY[key].pivot;
    pivot.position.set(p[0], p[1], p[2]);
    const mesh = partMesh(key, colors[key]);
    pivot.add(mesh);
    pivot.userData.mesh = mesh;
    inner.add(pivot);
    parts[key] = pivot;
  }
  // Torso: pieza fija, geometria relativa a su centro.
  const torso = partMesh('torso', colors.torso);
  const tp = PART_GEOMETRY.torso.pivot;
  torso.position.set(tp[0], tp[1], tp[2]);
  torso.userData.mesh = torso;
  inner.add(torso);
  parts.torso = torso;
  // Cabeza con pivote en el cuello.
  const headPivot = new THREE.Group();
  const hp = PART_GEOMETRY.head.pivot;
  headPivot.position.set(hp[0], hp[1], hp[2]);
  // La cabeza es SIEMPRE la pieza del modelo propio (rig-geometry.js):
  // bloque redondeado con las proporciones de Jairon, igual en el
  // editor, en los retratos y en partida. Sin primitivas sustitutas:
  // el antiguo atajo de headShape 'round' dibujaba una esfera perfecta
  // de THREE que no es la cabeza del modelo (pieza 29). El dato
  // headShape se conserva en las cuentas pero ya no cambia la geometria.
  const headMesh = partMesh('head', colors.head);
  headPivot.add(headMesh);
  headPivot.userData.mesh = headMesh;
  inner.add(headPivot);
  parts.head = headPivot;

  // Puntos de anclaje.
  const anchors = {};
  for (const [name, def] of Object.entries(ATTACHMENTS)) {
    const a = new THREE.Group();
    a.position.set(def.pos[0], def.pos[1], def.pos[2]);
    parts[def.part].add(a);
    anchors[name] = a;
  }

  // Rostro opcional, dibujado por codigo (original de VORTX). Los
  // articulos de tipo cara del catalogo cambian el estilo con setFace.
  let facePlane = null;
  function setFace(style) {
    if (facePlane) { anchors.face.remove(facePlane); facePlane.material.map.dispose(); facePlane.material.dispose(); facePlane = null; }
    if (!style) return;
    facePlane = new THREE.Mesh(
      new THREE.PlaneGeometry(0.95, 0.95),
      new THREE.MeshBasicMaterial({ map: faceTexture(style === true ? 'clasica' : style), transparent: true })
    );
    facePlane.position.set(0, 0, 0.03);
    anchors.face.add(facePlane);
  }
  if (cfg.face) setFace(cfg.face);

  // Ropa equipada (una camisa y un pantalón a la vez: en el editor,
  // equipped es un dict por slot). La pieza con prenda usa el material
  // con la textura de su plantilla; sin prenda, su material sólido
  // con el color base guardado.
  let shirtItem = null, pantsItem = null;
  function applyClothing() {
    for (const k of ['torso', 'armL', 'armR']) {
      const mesh = parts[k].userData.mesh || parts[k];
      mesh.material = (shirtItem && shirtItem.templateTex) ? clothingMaterial(shirtItem.templateTex) : solidMats[k];
      if (!shirtItem) solidMats[k].color.set(baseColors[k]);
    }
    for (const k of ['legL', 'legR']) {
      const mesh = parts[k].userData.mesh || parts[k];
      mesh.material = (pantsItem && pantsItem.templateTex) ? clothingMaterial(pantsItem.templateTex) : solidMats[k];
      if (!pantsItem) solidMats[k].color.set(baseColors[k]);
    }
  }

  const rig = {
    group: root,
    inner,
    parts,
    anchors,
    setFace,
    setColors(next) {
      for (const k of Object.keys(next || {})) {
        baseColors[k] = next[k];
        // El color se guarda en el material sólido de la pieza: si
        // lleva ropa puesta, la textura manda y el color vuelve a
        // verse al quitar la prenda (no se tiñe la textura).
        if (solidMats[k]) solidMats[k].color.set(next[k]);
      }
    },
    setEquipped(itemIds, catalog) {
      // Equipo visual del catálogo: cara + camisa + pantalón.
      const items = (itemIds || []).map(id => (catalog || []).find(i => i.id === id)).filter(Boolean);
      const faceItem = items.find(i => i.kind === 'face');
      if (faceItem) setFace(faceItem.face);
      else if (cfg.face) setFace(cfg.face);
      else setFace(null);
      shirtItem = items.find(i => i.kind === 'shirt') || null;
      pantsItem = items.find(i => i.kind === 'pants') || null;
      applyClothing();
    },
    animate(t, move) {
      const s = Math.sin(t * (move > 0.05 ? 10.5 : 1.8));
      const amp = move > 0.05 ? 0.62 : 0.03;
      parts.armL.rotation.x = s * amp;
      parts.armR.rotation.x = -s * amp;
      parts.legL.rotation.x = -s * (move > 0.05 ? 0.66 : 0.0);
      parts.legR.rotation.x = s * (move > 0.05 ? 0.66 : 0.0);
      inner.position.y = move > 0.05 ? Math.abs(Math.sin(t * 10.5)) * 0.09 : Math.sin(t * 1.8) * 0.02;
      headPivot.rotation.y = Math.sin(t * 0.6) * 0.03;
    }
  };
  return rig;
}
