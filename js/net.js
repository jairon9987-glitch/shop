// VORTX — multijugador en línea con Supabase Realtime.
// Canales públicos de presencia y broadcast por experiencia: cada jugador
// anuncia su avatar en la presencia y emite su posición por broadcast.
// La identidad es la cuenta local de VORTX (las cuentas en la nube son el
// siguiente paso de la Fase 4). Sin conexión, el juego sigue en solitario
// y el HUD lo dice: nunca se fingen jugadores.
//
// Protocolo Phoenix con vsn=2.0.0 y serializador de ARREGLOS:
// es el único formato que el Realtime de Supabase acepta; los mensajes
// como objeto los ignora en silencio (lección de Polexite, 2026-10-27).

export const SB_URL = 'https://oinywccahwwonkbxsfnh.supabase.co';
export const SB_KEY = 'sb_publishable_stctCOxyU9F66k3T8xvtUg_bKExZyKZ';

export function connectRoom(opts) {
  const topic = opts.topic;
  const key = opts.key;
  const meta = opts.meta || {};
  const onPresence = opts.onPresence || (() => {});
  const onMsg = opts.onMsg || (() => {});
  const onStatus = opts.onStatus || (() => {});
  const wsUrl = SB_URL.replace('https://', 'wss://') + '/realtime/v1/websocket?apikey=' + SB_KEY + '&vsn=2.0.0';
  // En el cable el tema lleva el prefijo realtime:; sin el, el servidor
  // responde "unmatched topic" y rechaza el join.
  const wireTopic = 'realtime:' + topic;

  let ws = null;
  let ref = 0;
  let joinRef = null;
  let hbTimer = null;
  let retryTimer = null;
  let retries = 0;
  let closed = false;
  let joined = false;
  const presence = new Map();

  const nextRef = () => String(++ref);
  function sendRaw(arr) {
    try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(arr)); } catch (e) {}
  }
  function emitPresence() {
    const out = {};
    for (const [k, v] of presence) out[k] = v;
    onPresence(out);
  }
  function applyPresence(state, isDiff) {
    if (!state) return;
    const readMetas = (entry) => {
      if (Array.isArray(entry)) return entry;
      if (entry && Array.isArray(entry.metas)) return entry.metas;
      return [];
    };
    if (!isDiff) {
      presence.clear();
      for (const k of Object.keys(state)) {
        const metas = readMetas(state[k]);
        if (metas.length) presence.set(k, metas[0]);
      }
    } else {
      for (const k of Object.keys(state.joins || {})) {
        const metas = readMetas(state.joins[k]);
        if (metas.length) presence.set(k, metas[0]);
      }
      for (const k of Object.keys(state.leaves || {})) presence.delete(k);
    }
    emitPresence();
  }
  function scheduleRetry() {
    if (closed || retryTimer) return;
    const wait = Math.min(15000, Math.round(1000 * Math.pow(1.6, retries)));
    retries++;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, wait);
  }
  function drop() {
    if (closed) return;
    joined = false;
    presence.clear();
    emitPresence();
    onStatus('offline');
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    scheduleRetry();
  }
  function connect() {
    if (closed) return;
    onStatus('connecting');
    try { ws = new WebSocket(wsUrl); } catch (e) { scheduleRetry(); return; }
    ws.onopen = () => {
      retries = 0;
      joinRef = nextRef();
      const join = { config: { broadcast: { ack: false, self: false }, presence: { key: key, enabled: true }, postgres_changes: [], private: false } };
      join['access_token'] = SB_KEY;
      sendRaw([joinRef, nextRef(), wireTopic, 'phx_join', join]);
      if (hbTimer) clearInterval(hbTimer);
      hbTimer = setInterval(() => sendRaw([null, nextRef(), 'phoenix', 'heartbeat', {}]), 25000);
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!Array.isArray(m)) return;
      const top = m[2], event = m[3], payload = m[4];
      if (top !== wireTopic) return;
      if (event === 'phx_reply') {
        if (payload && payload.status === 'ok' && !joined) {
          joined = true;
          onStatus('online');
          sendRaw([joinRef, nextRef(), wireTopic, 'presence', { type: 'presence', event: 'track', payload: meta }]);
        }
        return;
      }
      if (event === 'presence_state') { applyPresence(payload, false); return; }
      if (event === 'presence_diff') { applyPresence(payload, true); return; }
      if (event === 'broadcast') { if (payload) onMsg(payload.event, payload.payload); return; }
      if (event === 'phx_error' || event === 'phx_close') drop();
    };
    ws.onclose = () => drop();
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }
  connect();
  return {
    send(event, payload) {
      if (!joined) return false;
      sendRaw([joinRef, nextRef(), wireTopic, 'broadcast', { type: 'broadcast', event: event, payload: payload }]);
      return true;
    },
    get online() { return joined; },
    close() {
      closed = true;
      if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      try { sendRaw([joinRef, nextRef(), wireTopic, 'phx_leave', {}]); } catch (e) {}
      try { if (ws) ws.close(); } catch (e) {}
    }
  };
}

// Consulta de presencia de SOLO LECTURA para la pestaña Servers: se une
// al canal sin anunciarse (sin presence track), espera el presence_state
// inicial y se va. Quien juega no ve visitas fantasma en su lista y el
// conteo que devuelve es el de jugadores reales anunciados en la sala.
export function peekPresence(topic, timeoutMs) {
  return new Promise((resolve) => {
    const wireTopic = 'realtime:' + topic;
    const wsUrl = SB_URL.replace('https://', 'wss://') + '/realtime/v1/websocket?apikey=' + SB_KEY + '&vsn=2.0.0';
    let ws = null, ref = 0, done = false;
    const finish = (out) => {
      if (done) return; done = true;
      try { if (ws) ws.close(); } catch (e) {}
      resolve(out);
    };
    const timer = setTimeout(() => finish({ ok: false, players: [] }), timeoutMs || 4000);
    try { ws = new WebSocket(wsUrl); } catch (e) { clearTimeout(timer); finish({ ok: false, players: [] }); return; }
    ws.onopen = () => {
      const joinRef = String(++ref);
      const join = { config: { broadcast: { ack: false, self: false }, presence: { key: 'peek-' + Math.random().toString(36).slice(2, 8), enabled: true }, postgres_changes: [], private: false } };
      join['access_token'] = SB_KEY;
      try { ws.send(JSON.stringify([joinRef, String(++ref), wireTopic, 'phx_join', join])); } catch (e) {}
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!Array.isArray(m) || m[2] !== wireTopic) return;
      if (m[3] === 'presence_state') {
        const players = [];
        const state = m[4] || {};
        for (const k of Object.keys(state)) {
          const entry = state[k];
          const metas = Array.isArray(entry) ? entry : (entry && Array.isArray(entry.metas) ? entry.metas : []);
          if (metas.length) players.push({ key: k, name: metas[0].name || '' });
        }
        clearTimeout(timer);
        finish({ ok: true, players });
      }
    };
    ws.onerror = () => { clearTimeout(timer); finish({ ok: false, players: [] }); };
  });
}
