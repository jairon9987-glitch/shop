// VORTX — mapeo de plantillas de ropa 585x559 sobre el R6 propio.
// Adaptación de templateUV.js (Vyplax v36, mapeo verificado en v34):
//
//  - Los rectángulos de la plantilla (TSEC) y el mapa por dirección
//    (TEMPLATE_MAP) son los mismos, copiados tal cual: no se inventan.
//  - La geometría VORTX no trae normales ni UVs (solo positions +
//    indices, export de Blender), así que las normales suaves se
//    calculan aquí (mismo algoritmo que THREE.computeVertexNormals) y
//    la dirección de cada triángulo sale de su normal de cara.
//  - El rango plano de cada cara se toma de los vértices en el plano
//    extremo (coordenada == máximo/mínimo en el eje de la dirección,
//    tolerancia 0,002): la cara plana de la caja redondeada es la
//    superficie más exterior. Equivale a filtrar por normal en
//    templateUV.js; los vértices de bisel quedan fuera del rango y se
//    fijan al borde (clamp), igual que en v34. Los rangos se miden en
//    coordenadas del espectador (ejes VIEW, ya con el signo aplicado),
//    igual que en templateUV.js.
//  - Caras superior/inferior (+y/-y): la geometría VORTX no tiene UVs
//    originales (templateUV.js usaba el bbox UV del triángulo), así
//    que se proyectan en plano: h = x, v = z. La arista delantera de
//    la cara superior cae en el borde inferior del panel Up (adyacente
//    al panel frontal) y la de la cara inferior en el borde superior
//    del panel Down — continuidad con el panel frontal, como en la
//    plantilla dibujada.
//  - ADAPTACIÓN DE LADO (brazos/piernas): en el clásico de Vyplax el
//    brazo llamado 'armL' va en -x y el 'armR' en +x; en VORTX el
//    'armL' va en +x (pivote +1,3541) y el 'armR' en -x (pivote
//    -1,3541), igual las piernas. El juego de paneles es por miembro
//    físico (T = izquierdo, S = derecho), no por nombre: se conservan
//    +z/-z/+y/-y y se intercambian las entradas ±x de los cuatro
//    miembros, para que el panel interior caiga en la cara interior
//    (hacia el torso) y el exterior en la exterior. El torso está
//    centrado y no cambia.
//  - Límite declarado: la asignación interior/exterior sigue del
//    razonamiento físico anterior (cara hacia el torso = panel
//    interior del clásico); frente/espalda/arriba/abajo siguen del
//    mapeo verificado en v34. Si en la prueba en vivo un diseño se ve
//    intercambiado de lado en brazos o piernas, es un cambio de una
//    línea en TEMPLATE_MAP (intercambiar las entradas ±x de ese miembro).
//
// Módulo PURO (sin THREE, sin DOM): lo usa rig.js en el navegador y
// la verificación en Node con el mismo código.

// Layout estándar de plantilla Roblox 585x559 (coordenadas en px,
// origen arriba-izquierda, idénticas a v34).
export const TEMPLATE_W = 585;
export const TEMPLATE_H = 559;
const TSEC = {
  torsoUp: [231, 8, 359, 72], torsoFront: [231, 74, 359, 202],
  torsoBack: [427, 74, 555, 201], torsoLeft: [361, 74, 424, 201],
  torsoRight: [165, 74, 229, 201], torsoDown: [231, 204, 356, 268],
  limbRUp: [217, 289, 280, 353], limbRDown: [217, 485, 280, 549],
  limbLUp: [309, 289, 372, 353], limbLDown: [309, 485, 372, 549],
  limbRSides: [[19, 358, 83, 483], [85, 358, 149, 483], [151, 355, 215, 483], [217, 355, 280, 483]],
  limbLSides: [[309, 355, 372, 483], [374, 356, 438, 483], [440, 358, 504, 483], [506, 358, 570, 483]]
};
const S = TSEC.limbRSides, T = TSEC.limbLSides;
// MAP v34 con la adaptación de lado VORTX (ver encabezado): torso
// igual; en los cuatro miembros las entradas ±x van intercambiadas
// respecto al clásico porque los miembros van del lado opuesto.
export const TEMPLATE_MAP = {
  'torso:+z': TSEC.torsoFront, 'torso:-z': TSEC.torsoBack,
  'torso:+x': TSEC.torsoLeft, 'torso:-x': TSEC.torsoRight,
  'torso:+y': TSEC.torsoUp, 'torso:-y': TSEC.torsoDown,
  'armR:+z': S[3], 'armR:-z': S[1], 'armR:-x': S[0], 'armR:+x': S[2],
  'armR:+y': TSEC.limbRUp, 'armR:-y': TSEC.limbRDown,
  'armL:+z': T[0], 'armL:-z': T[2], 'armL:-x': T[1], 'armL:+x': T[3],
  'armL:+y': TSEC.limbLUp, 'armL:-y': TSEC.limbLDown,
  'legR:+z': S[1], 'legR:-z': S[3], 'legR:-x': S[0], 'legR:+x': S[2],
  'legR:+y': TSEC.limbRUp, 'legR:-y': TSEC.limbRDown,
  'legL:+z': T[2], 'legL:-z': T[0], 'legL:-x': T[1], 'legL:+x': T[3],
  'legL:+y': TSEC.limbLUp, 'legL:-y': TSEC.limbLDown
};
// Ejes del espectador por cara lateral: (h = izq->der desde fuera, v = abajo->arriba).
const VIEW = { '+z': ['x', 'y'], '-z': ['-x', 'y'], '+x': ['-z', 'y'], '-x': ['z', 'y'] };
const AXIS = { x: 0, y: 1, z: 2 };
function axisVal(name, x, y, z) {
  const v = [x, y, z][AXIS[name[name.length - 1]]];
  return name[0] === '-' ? -v : v;
}
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

function faceNormal(pos, idx, f) {
  const a = idx[f], b = idx[f + 1], c = idx[f + 2];
  const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
  const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
  const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
  // Igual que THREE.computeVertexNormals: (C-B) x (A-B).
  const cbx = cx - bx, cby = cy - by, cbz = cz - bz;
  const abx = ax - bx, aby = ay - by, abz = az - bz;
  return [cby * abz - cbz * aby, cbz * abx - cbx * abz, cbx * aby - cby * abx];
}

// Normales suaves por vértice (mismo algoritmo que
// THREE.computeVertexNormals sobre la geometría indexada).
function smoothNormals(pos, idx) {
  const nrm = new Array(pos.length).fill(0);
  for (let f = 0; f < idx.length; f += 3) {
    const n = faceNormal(pos, idx, f);
    for (let k = 0; k < 3; k++) {
      const vi = idx[f + k];
      nrm[vi * 3] += n[0]; nrm[vi * 3 + 1] += n[1]; nrm[vi * 3 + 2] += n[2];
    }
  }
  for (let i = 0; i < nrm.length; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
    nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l;
  }
  return nrm;
}

function dirOfNormal(n) {
  let k = 0;
  for (let c = 1; c < 3; c++) if (Math.abs(n[c]) > Math.abs(n[k])) k = c;
  return (n[k] >= 0 ? '+' : '-') + 'xyz'[k];
}

// Devuelve la geometría de la pieza EXPANDIDA por triángulo, con UVs
// en espacio de plantilla 585x559 (u = px/585, v = 1 - py/559, por el
// flipY de Three). `positions`/`indices` son los de PART_GEOMETRY.
export function templateGeometryData(partName, positions, indices) {
  const pos = positions, idx = indices;
  const nrm = smoothNormals(pos, idx);
  const outPos = [], outNrm = [], outUv = [];
  const stats = { triangles: 0, skipped: 0, faces: {}, uvMin: [1, 1], uvMax: [0, 0] };
  // Paso 1: agrupar triángulos por cara y rango plano (h,v) por cara.
  const groups = {};
  const faceDir = new Array(idx.length / 3);
  for (let f = 0; f < idx.length; f += 3) {
    const n = faceNormal(pos, idx, f);
    const d = dirOfNormal(n);
    faceDir[f / 3] = d;
    (groups[d] || (groups[d] = [])).push(f);
  }
  const ranges = {};
  for (const d of Object.keys(groups)) {
    const axis = AXIS[d[1]];
    const isLateral = d === '+x' || d === '-x' || d === '+z' || d === '-z';
    const ha = isLateral ? VIEW[d][0] : 'x';
    const va = isLateral ? VIEW[d][1] : 'z';
    // Extremo de la cara en su eje: la cara plana es lo más exterior.
    let extreme = d[0] === '+' ? -Infinity : Infinity;
    for (const f of groups[d]) {
      for (let k = 0; k < 3; k++) {
        const v = pos[idx[f + k] * 3 + axis];
        extreme = d[0] === '+' ? Math.max(extreme, v) : Math.min(extreme, v);
      }
    }
    const eps = 0.002;
    const pts = [];
    const collect = (vi) => {
      if (Math.abs(pos[vi * 3 + axis] - extreme) <= eps) {
        pts.push([pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]]);
      }
    };
    for (const f of groups[d]) for (let k = 0; k < 3; k++) collect(idx[f + k]);
    // Si no hay vértices en el plano extremo, usar todos los del grupo.
    if (!pts.length) {
      for (const f of groups[d]) {
        for (let k = 0; k < 3; k++) {
          const vi = idx[f + k];
          pts.push([pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]]);
        }
      }
    }
    const hs = pts.map(p => axisVal(ha, p[0], p[1], p[2]));
    const vs = pts.map(p => axisVal(va, p[0], p[1], p[2]));
    ranges[d] = [Math.min(...hs), Math.max(...hs), Math.min(...vs), Math.max(...vs)];
  }
  // Paso 2: por triángulo, UV nueva según su cara.
  for (let f = 0; f < idx.length; f += 3) {
    const d = faceDir[f / 3];
    const panel = TEMPLATE_MAP[partName + ':' + d];
    stats.faces[d] = (stats.faces[d] || 0) + 1;
    stats.triangles++;
    if (!panel) { stats.skipped++; }
    const isLateral = d === '+x' || d === '-x' || d === '+z' || d === '-z';
    const range = ranges[d];
    const pw = panel ? panel[2] - panel[0] : 0, ph = panel ? panel[3] - panel[1] : 0;
    for (let k = 0; k < 3; k++) {
      const vi = idx[f + k];
      const x = pos[vi * 3], y = pos[vi * 3 + 1], z = pos[vi * 3 + 2];
      outPos.push(x, y, z);
      outNrm.push(nrm[vi * 3], nrm[vi * 3 + 1], nrm[vi * 3 + 2]);
      if (!panel || !range) { outUv.push(0, 0); continue; }
      let px, py;
      if (isLateral) {
        const ha = VIEW[d][0], va = VIEW[d][1];
        const hn = clamp01((axisVal(ha, x, y, z) - range[0]) / (range[1] - range[0] || 1));
        const vn = clamp01((axisVal(va, x, y, z) - range[2]) / (range[3] - range[2] || 1));
        px = panel[0] + hn * pw;
        py = panel[1] + (1 - vn) * ph;
      } else {
        // Cara superior/inferior: proyección en plano, h = x, v = z.
        // +y: la arista delantera va al borde inferior del panel Up.
        // -y: la arista delantera va al borde superior del panel Down.
        const hn = clamp01((x - range[0]) / (range[1] - range[0] || 1));
        const vn = clamp01((z - range[2]) / (range[3] - range[2] || 1));
        px = panel[0] + hn * pw;
        py = d === '+y' ? panel[1] + vn * ph : panel[1] + (1 - vn) * ph;
      }
      const u = px / TEMPLATE_W, v = 1 - py / TEMPLATE_H;
      outUv.push(u, v);
      stats.uvMin[0] = Math.min(stats.uvMin[0], u); stats.uvMin[1] = Math.min(stats.uvMin[1], v);
      stats.uvMax[0] = Math.max(stats.uvMax[0], u); stats.uvMax[1] = Math.max(stats.uvMax[1], v);
    }
  }
  return { pos: outPos, nrm: outNrm, uv: outUv, stats };
}
