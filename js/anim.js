// VORTX — AnimationController del personaje R6.
// Maquina de estados con poses procedurales 100 % originales de VORTX:
// nada de animaciones, IDs ni archivos de Roblox. Cada estado calcula
// una pose objetivo (angulos de las articulaciones del rig) y el
// controlador interpola hacia ella con amortiguacion exponencial
// dependiente de deltaTime: eso es el blending entre estados, sin
// saltos bruscos y a cualquier FPS.
//
// Estados: idle, walk, run, jump, fall, land, climb, swim, sit,
// crouch (crouch incluye caminar agachado con el mismo ciclo atenuado).
// La fisica decide el estado (ver play.js); aqui solo se posa el rig.
// Para anadir un estado nuevo: una entrada en POSES y su condicion en
// el motor; el controlador no hay que tocarlo.

const POSE_KEYS = ['armLx', 'armRx', 'armLz', 'armRz', 'legLx', 'legRx', 'innerY', 'lean', 'headY', 'sway', 'innerX'];

export function createAnimator(rig) {
  const parts = rig.parts;
  const inner = rig.inner;
  const cur = { armLx: 0, armRx: 0, armLz: 0.08, armRz: -0.08, legLx: 0, legRx: 0, innerY: 0, lean: 0, headY: 0, sway: 0, innerX: 0 };
  let phase = 0;      // ciclo de pasos / brazadas / escalada
  let groupPitch = 0; // inclinacion del cuerpo entero (nadar)

  function targetFor(ctx) {
    const t = ctx.t;
    const s = Math.sin(phase), c = Math.cos(phase);
    const mb = ctx.moveBlend; // 0 quieto .. 1 en movimiento
    switch (ctx.state) {
      case 'walk': {
        const amp = 0.62 * mb;
        return { armLx: s * amp * 0.85, armRx: -s * amp * 0.85, armLz: 0.09, armRz: -0.09,
                 legLx: -s * amp, legRx: s * amp, innerY: Math.abs(c) * 0.085 * mb, lean: 0.07 * mb, headY: 0 };
      }
      case 'run': {
        const amp = 0.98 * mb;
        return { armLx: s * amp - 0.3, armRx: -s * amp - 0.3, armLz: 0.13, armRz: -0.13,
                 legLx: -s * amp, legRx: s * amp, innerY: Math.abs(c) * 0.12 * mb, lean: 0.17 * mb, headY: 0 };
      }
      case 'jump':
        // Impulso: una pierna adelanta flexionada, la otra se estira
        // atras y los brazos suben. El cuerpo se inclina al frente.
        return { armLx: -2.35, armRx: -1.85, armLz: 0.3, armRz: -0.22,
                 legLx: -0.55, legRx: 0.62, innerY: 0.04, lean: 0.12, headY: 0 };
      case 'fall': {
        // Brazos abiertos, piernas algo flexionadas; en caidas largas
        // las extremidades aletean un poco (movimiento dinamico).
        const fl = Math.min(1, ctx.fallTime / 1.6);
        const wob = Math.sin(t * 12.5) * 0.09 * fl;
        return { armLx: -0.55 + wob, armRx: -0.55 - wob, armLz: 0.85 + wob, armRz: -0.85 + wob,
                 legLx: -0.32 + wob * 0.7, legRx: 0.18 - wob * 0.7, innerY: 0,
                 lean: 0.05 + Math.min(0.2, ctx.speedH * 0.008), headY: 0 };
      }
      case 'land': {
        // Impacto: el cuerpo se comprime y los brazos bajan al frente.
        const d = ctx.landDepth || 0.3;
        return { armLx: 0.42, armRx: 0.42, armLz: 0.14, armRz: -0.14,
                 legLx: -0.5, legRx: -0.22, innerY: -d, lean: 0.2, headY: 0 };
      }
      case 'climb': {
        // Agarre alterno: un brazo arriba mientras el otro baja,
        // piernas alternas flexionadas como en una escalera.
        return { armLx: -2.8 + s * 0.42, armRx: -2.8 - s * 0.42, armLz: 0.14, armRz: -0.14,
                 legLx: -0.72 + c * 0.32, legRx: -0.72 - c * 0.32, innerY: 0, lean: 0.05, headY: 0 };
      }
      case 'swim': {
        // Brazada alterna ampla y patada de aleteo; lo aplica la
        // inclinacion del cuerpo que devuelve update() en groupPitch.
        return { armLx: s * 1.45 - 0.5, armRx: -s * 1.45 - 0.5, armLz: 0.16, armRz: -0.16,
                 legLx: Math.sin(phase * 1.6) * 0.38, legRx: -Math.sin(phase * 1.6) * 0.38,
                 innerY: Math.sin(t * 2.2) * 0.05, lean: 0, headY: 0 };
      }
      case 'dance': {
        // Baile clasico (/e dance): rebote al ritmo, los dos brazos se
        // balancean juntos de lado a lado, el torso se mece (sway) y
        // la cabeza acompana. Todo procedural, sin archivos externos.
        const b = Math.abs(Math.sin(phase));
        return { armLx: c * 0.3, armRx: c * 0.3, armLz: 0.3 + s * 0.6, armRz: -0.3 + s * 0.6,
                 legLx: s * 0.24, legRx: -s * 0.24, innerY: b * 0.15, lean: 0.03, headY: s * 0.14,
                 sway: s * 0.09, innerX: 0 };
      }
      case 'dance2': {
        // Segundo baile (/e dance2): paso lateral de un lado a otro
        // (innerX) con bombeo alterno de brazos hacia arriba/al frente.
        const step = Math.sin(phase * 0.5);
        return { armLx: -1.7 + s * 0.45, armRx: -1.7 - s * 0.45, armLz: 0.18, armRz: -0.18,
                 legLx: step > 0 ? 0.38 : -0.1, legRx: step > 0 ? -0.1 : 0.38,
                 innerY: Math.abs(c) * 0.1, lean: 0.14, headY: s * 0.08,
                 sway: step * 0.06, innerX: step * 0.42 };
      }
      case 'sit':
        // Piernas rectas al frente, cuerpo apoyado, brazos abajo.
        return { armLx: 0.12, armRx: 0.12, armLz: 0.06, armRz: -0.06,
                 legLx: -1.5, legRx: -1.5, innerY: -1.88, lean: 0.03, headY: Math.sin(t * 0.6) * 0.04 };
      case 'crouch': {
        const amp = 0.3 * mb;
        return { armLx: s * amp + 0.28, armRx: -s * amp + 0.28, armLz: 0.1, armRz: -0.1,
                 legLx: -0.95 - s * amp, legRx: -0.5 + s * amp, innerY: -0.55, lean: 0.3, headY: 0 };
      }
      default: { // idle: respiracion y un vaiven minimo
        return { armLx: Math.sin(t * 1.8) * 0.035, armRx: -Math.sin(t * 1.8) * 0.035, armLz: 0.08, armRz: -0.08,
                 legLx: 0, legRx: 0, innerY: Math.sin(t * 1.8) * 0.022, lean: 0, headY: Math.sin(t * 0.6) * 0.03 };
      }
    }
  }

  return {
    // ctx: { state, t, dt, speedH, moveBlend, fallTime, landDepth,
    //        phaseVel } — phaseVel avanza el ciclo (pasos, brazada,
    //        escalada con signo segun direccion vertical).
    update(dt, ctx) {
      if (ctx.phaseVel) phase += ctx.phaseVel * dt;
      const tg = targetFor(ctx);
      const lam = ctx.state === 'land' ? 22 : (ctx.state === 'jump' || ctx.state === 'fall' ? 10.5 : 13);
      const k = 1 - Math.exp(-lam * dt);
      for (const key of POSE_KEYS) { const tv = tg[key] != null ? tg[key] : 0; cur[key] += (tv - cur[key]) * k; }
      parts.armL.rotation.x = cur.armLx;
      parts.armR.rotation.x = cur.armRx;
      parts.armL.rotation.z = cur.armLz;
      parts.armR.rotation.z = cur.armRz;
      parts.legL.rotation.x = cur.legLx;
      parts.legR.rotation.x = cur.legRx;
      parts.head.rotation.y = cur.headY;
      inner.position.y = cur.innerY;
      inner.position.x = cur.innerX;
      inner.rotation.x = cur.lean;
      inner.rotation.z = cur.sway;
      // Al nadar el cuerpo entero se acuesta hacia adelante; en el
      // resto de estados vuelve a vertical suavemente.
      const targetPitch = ctx.state === 'swim' ? (ctx.moveBlend > 0.1 ? 0.62 : 0.3) : 0;
      groupPitch += (targetPitch - groupPitch) * (1 - Math.exp(-6 * dt));
      return groupPitch;
    },
    get phase() { return phase; }
  };
}
