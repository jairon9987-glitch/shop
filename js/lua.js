// VORTX — motor Lua para scripts de experiencias (Fengari, licencia MIT).
// Un estado Lua por script, con scheduler por frames: wait(n) es una
// corrutina que se reanuda cuando vence su tiempo. API estilo Roblox
// reducida y honesta: print/warn, tick, Vector3, Color3, Instance.new("Part")
// con Position/Size/Color/Transparency/CanCollide/Anchored/Parent/Destroy y
// el evento Touched, workspace y game.Players.LocalPlayer (Position y
// Respawn/Kill). Sin os/io/package/debug: el sandbox no tiene acceso al
// sistema de archivos ni a la red. Los errores de un script se reportan
// y solo muere ese script.

const PRELUDE = String.raw`
wait = function(n) return coroutine.yield(n or 0) end

Vector3 = {}
local V3MT = {
  __add = function(a, b) return Vector3.new(a.X + b.X, a.Y + b.Y, a.Z + b.Z) end,
  __sub = function(a, b) return Vector3.new(a.X - b.X, a.Y - b.Y, a.Z - b.Z) end,
  __mul = function(a, b)
    if type(a) == "number" then a, b = b, a end
    return Vector3.new(a.X * b, a.Y * b, a.Z * b)
  end,
  __div = function(a, b) return Vector3.new(a.X / b, a.Y / b, a.Z / b) end,
  __eq = function(a, b) return a.X == b.X and a.Y == b.Y and a.Z == b.Z end,
  __tostring = function(v) return v.X .. ", " .. v.Y .. ", " .. v.Z end,
  __index = function(v, k)
    if k == "Magnitude" then return math.sqrt(v.X * v.X + v.Y * v.Y + v.Z * v.Z) end
    if k == "Unit" then local m = v.Magnitude; if m == 0 then return Vector3.new(0, 0, 0) end return v / m end
    return nil
  end
}
function Vector3.new(x, y, z)
  return setmetatable({ X = x or 0, Y = y or 0, Z = z or 0, __type = "Vector3" }, V3MT)
end

Color3 = {}
local C3MT = { __tostring = function(c) return c.R .. ", " .. c.G .. ", " .. c.B end }
function Color3.new(r, g, b)
  return setmetatable({ R = r or 0, G = g or 0, B = b or 0, __type = "Color3" }, C3MT)
end
function Color3.fromRGB(r, g, b)
  return Color3.new((r or 0) / 255, (g or 0) / 255, (b or 0) / 255)
end

workspace = { __isWorkspace = true }

local function propsOf(d)
  return {
    Name = d.Name, Px = d.Position.X, Py = d.Position.Y, Pz = d.Position.Z,
    Sx = d.Size.X, Sy = d.Size.Y, Sz = d.Size.Z,
    Cr = d.Color.R, Cg = d.Color.G, Cb = d.Color.B,
    Transparency = d.Transparency, CanCollide = d.CanCollide, Anchored = d.Anchored
  }
end

local function newPart()
  local data = {
    _id = nil, Name = "Part",
    Position = Vector3.new(0, 5, 0), Size = Vector3.new(4, 1, 4),
    Color = Color3.new(1, 1, 1), Transparency = 0,
    CanCollide = true, Anchored = true, Parent = nil, _pendingTouched = {}
  }
  local proxy = {}
  local event = { Connect = function(_, fn)
    if data._id then __connectTouched(data._id, fn)
    else data._pendingTouched[#data._pendingTouched + 1] = fn end
  end }
  local mt = {
    __index = function(_, k)
      if k == "Touched" then return event end
      if k == "Destroy" then
        return function()
          if data._id then __destroy(data._id); data._id = nil end
          data.Parent = nil
        end
      end
      return data[k]
    end,
    __newindex = function(_, k, v)
      data[k] = v
      if k == "Parent" then
        if v == workspace and not data._id then
          data._id = __spawn(propsOf(data))
          for _, fn in ipairs(data._pendingTouched) do __connectTouched(data._id, fn) end
          data._pendingTouched = {}
        elseif v == nil and data._id then
          __destroy(data._id); data._id = nil
        end
      elseif data._id then
        if k == "Position" then __update(data._id, "Position", v.X, v.Y, v.Z)
        elseif k == "Size" then __update(data._id, "Size", v.X, v.Y, v.Z)
        elseif k == "Color" then __update(data._id, "Color", v.R, v.G, v.B)
        elseif k == "Transparency" then __update(data._id, "Transparency", v)
        elseif k == "CanCollide" then __update(data._id, "CanCollide", v and true or false)
        elseif k == "Anchored" then __update(data._id, "Anchored", v and true or false)
        elseif k == "Name" then __update(data._id, "Name", v) end
      end
    end,
    __tostring = function() return data.Name end
  }
  return setmetatable(proxy, mt)
end

Instance = { new = function(className)
  if className ~= "Part" then error("VORTX Lua: por ahora solo Instance.new(\"Part\")") end
  return newPart()
end }

local playerData = {}
local LocalPlayer = setmetatable({}, {
  __index = function(_, k)
    if k == "Position" then local x, y, z = __playerPos(); return Vector3.new(x, y, z) end
    if k == "Name" then return __playerName() end
    if k == "Kill" or k == "Respawn" then return function() __playerRespawn() end end
    return playerData[k]
  end,
  __newindex = function(_, k, v)
    if k == "Position" then __playerTeleport(v.X, v.Y, v.Z)
    else playerData[k] = v end
  end
})
game = { Players = { LocalPlayer = LocalPlayer }, Workspace = workspace }
`;

export function createLuaRuntime(bridge) {
  const F = window.fengari;
  if (!F || !F.lua || !F.lauxlib || !F.lualib) {
    bridge.error('motor', 'Fengari no cargó: los scripts Lua están desactivados');
    return null;
  }
  const { lua, lauxlib, lualib } = F;
  const toStr = F.to_luastring;
  const toJs = (bytes) => (bytes ? F.to_jsstring(bytes) : '');
  const REG = typeof lua.LUA_REGISTRYINDEX === 'number' ? lua.LUA_REGISTRYINDEX : -1001000;
  const LUA_OK = 0, LUA_YIELD = 1;

  let nextId = 1;
  const parts = new Map();       // id -> { handle, owner }
  const touched = new Map();     // id -> [{ L, ref }]
  const threads = [];            // { name, L, co, wakeAt, dead, owner }
  const states = [];             // { name, L }
  let clock = 0;
  let destroyed = false;

  function stackText(Ls) {
    const v = lua.lua_tostring(Ls, -1);
    return v ? toJs(v) : 'error desconocido';
  }
  function fmtArgs(Ls) {
    const parts2 = [];
    const n = lua.lua_gettop(Ls);
    for (let i = 1; i <= n; i++) {
      const v = lauxlib.luaL_tolstring(Ls, i);
      parts2.push(v ? toJs(v) : 'nil');
    }
    return parts2.join(' ');
  }
  function getNum(Ls, idx, name) {
    lua.lua_getfield(Ls, idx, toStr(name));
    const v = lua.lua_tonumber(Ls, -1);
    lua.lua_pop(Ls, 1);
    return v;
  }
  function getBool(Ls, idx, name) {
    lua.lua_getfield(Ls, idx, toStr(name));
    const v = lua.lua_toboolean(Ls, -1);
    lua.lua_pop(Ls, 1);
    return !!v;
  }
  function getStr(Ls, idx, name) {
    lua.lua_getfield(Ls, idx, toStr(name));
    const v = lua.lua_tostring(Ls, -1);
    lua.lua_pop(Ls, 1);
    return v ? toJs(v) : '';
  }

  function openState(name) {
    const L = lauxlib.luaL_newstate();
    const libs = [
      ['_G', lualib.luaopen_base], ['coroutine', lualib.luaopen_coroutine],
      ['table', lualib.luaopen_table], ['string', lualib.luaopen_string],
      ['math', lualib.luaopen_math], ['utf8', lualib.luaopen_utf8]
    ];
    for (const [libName, open] of libs) { lauxlib.luaL_requiref(L, toStr(libName), open, 1); lua.lua_pop(L, 1); }

    const pushGlobal = (gname, fn) => { lua.lua_pushjsfunction(L, fn); lua.lua_setglobal(L, toStr(gname)); };
    pushGlobal('print', (Ls) => { bridge.print(name, fmtArgs(Ls)); return 0; });
    pushGlobal('warn', (Ls) => { bridge.print(name, fmtArgs(Ls)); return 0; });
    pushGlobal('tick', () => { lua.lua_pushnumber(L, clock); return 1; });
    pushGlobal('__spawn', (Ls) => {
      const props = {
        name: getStr(Ls, 1, 'Name'),
        px: getNum(Ls, 1, 'Px'), py: getNum(Ls, 1, 'Py'), pz: getNum(Ls, 1, 'Pz'),
        sx: getNum(Ls, 1, 'Sx'), sy: getNum(Ls, 1, 'Sy'), sz: getNum(Ls, 1, 'Sz'),
        r: getNum(Ls, 1, 'Cr'), g: getNum(Ls, 1, 'Cg'), b: getNum(Ls, 1, 'Cb'),
        transparency: getNum(Ls, 1, 'Transparency'),
        canCollide: getBool(Ls, 1, 'CanCollide'), anchored: getBool(Ls, 1, 'Anchored')
      };
      const id = nextId++;
      const handle = bridge.spawnPart(props);
      parts.set(id, { handle, owner: name });
      lua.lua_pushnumber(Ls, id);
      return 1;
    });
    pushGlobal('__update', (Ls) => {
      const id = lua.lua_tonumber(Ls, 1);
      const rec = parts.get(id);
      if (!rec) return 0;
      const key = toJs(lua.lua_tostring(Ls, 2) || toStr(''));
      const patch = {};
      if (key === 'Position' || key === 'Size') {
        patch[key.toLowerCase()] = { x: lua.lua_tonumber(Ls, 3), y: lua.lua_tonumber(Ls, 4), z: lua.lua_tonumber(Ls, 5) };
      } else if (key === 'Color') {
        patch.color = { r: lua.lua_tonumber(Ls, 3), g: lua.lua_tonumber(Ls, 4), b: lua.lua_tonumber(Ls, 5) };
      } else if (key === 'Transparency') patch.transparency = lua.lua_tonumber(Ls, 3);
      else if (key === 'CanCollide') patch.canCollide = !!lua.lua_toboolean(Ls, 3);
      else if (key === 'Anchored') patch.anchored = !!lua.lua_toboolean(Ls, 3);
      else if (key === 'Name') patch.name = toJs(lua.lua_tostring(Ls, 3) || toStr(''));
      bridge.updatePart(rec.handle, patch);
      return 0;
    });
    pushGlobal('__destroy', (Ls) => {
      const id = lua.lua_tonumber(Ls, 1);
      const rec = parts.get(id);
      if (rec) { bridge.destroyPart(rec.handle); parts.delete(id); }
      touched.delete(id);
      return 0;
    });
    pushGlobal('__connectTouched', (Ls) => {
      const id = lua.lua_tonumber(Ls, 1);
      lua.lua_pushvalue(Ls, 2);
      const ref = lauxlib.luaL_ref(Ls, REG);
      if (!touched.has(id)) touched.set(id, []);
      touched.get(id).push({ L: Ls, ref });
      return 0;
    });
    pushGlobal('__playerPos', (Ls) => {
      const p = bridge.getPlayerPos();
      lua.lua_pushnumber(Ls, p.x); lua.lua_pushnumber(Ls, p.y); lua.lua_pushnumber(Ls, p.z);
      return 3;
    });
    pushGlobal('__playerTeleport', (Ls) => {
      bridge.setPlayerPos(lua.lua_tonumber(Ls, 1), lua.lua_tonumber(Ls, 2), lua.lua_tonumber(Ls, 3));
      return 0;
    });
    pushGlobal('__playerRespawn', () => { bridge.respawnPlayer(); return 0; });
    pushGlobal('__playerName', (Ls) => { lua.lua_pushstring(Ls, toStr(bridge.playerName())); return 1; });

    // El prelude define la API estilo Roblox sobre estas primitivas.
    const stPre = lauxlib.luaL_loadstring(L, toStr(PRELUDE));
    if (stPre !== LUA_OK || lua.lua_pcall(L, 0, 0, 0) !== LUA_OK) {
      bridge.error(name, 'error en el prelude Lua: ' + stackText(L));
      lua.lua_close(L);
      return null;
    }
    // script.Name para el script que corre en este estado
    lua.lua_createtable(L, 0, 1);
    lua.lua_pushstring(L, toStr(name));
    lua.lua_setfield(L, -2, toStr('Name'));
    lua.lua_setglobal(L, toStr('script'));
    states.push({ name, L });
    return L;
  }

  function resumeThread(th, dt) {
    lua.lua_pushnumber(th.co, dt);
    const st = lua.lua_resume(th.co, th.L, 1);
    if (st === LUA_YIELD) {
      const n = lua.lua_gettop(th.co);
      const waitSecs = n > 0 && lua.lua_isnumber(th.co, -1) ? Math.max(0, lua.lua_tonumber(th.co, -1)) : 0;
      lua.lua_settop(th.co, 0);
      th.wakeAt = clock + waitSecs;
    } else if (st === LUA_OK) {
      th.dead = true;
    } else {
      bridge.error(th.name, stackText(th.co));
      th.dead = true;
    }
  }

  return {
    addScript(name, code) {
      if (destroyed) return;
      const L = openState(name);
      if (!L) return;
      const co = lua.lua_newthread(L);
      const st = lauxlib.luaL_loadstring(co, toStr(String(code || '')));
      if (st !== LUA_OK) { bridge.error(name, stackText(co)); return; }
      const th = { name, L, co, wakeAt: clock, dead: false, owner: name };
      threads.push(th);
      resumeThread(th, 0);
    },
    update(now, dt) {
      if (destroyed) return;
      clock = now;
      for (const th of [...threads]) {
        if (!th.dead && now >= th.wakeAt) resumeThread(th, dt);
      }
      for (let i = threads.length - 1; i >= 0; i--) if (threads[i].dead) threads.splice(i, 1);
    },
    fireTouched(handle) {
      if (destroyed) return;
      for (const [id, rec] of parts) {
        if (rec.handle !== handle) continue;
        for (const cb of touched.get(id) || []) {
          const co = lua.lua_newthread(cb.L);
          lua.lua_rawgeti(cb.L, REG, cb.ref);
          lua.lua_xmove(cb.L, co, 1);
          threads.push({ name: rec.owner + ':Touched', L: cb.L, co, wakeAt: clock, dead: false, owner: rec.owner });
        }
      }
    },
    partCount() { return parts.size; },
    aliveScripts() { return threads.filter(t => !t.dead).length; },
    destroy() {
      destroyed = true;
      for (const rec of parts.values()) bridge.destroyPart(rec.handle);
      parts.clear();
      touched.clear();
      threads.length = 0;
      for (const st of states) { try { lua.lua_close(st.L); } catch (e) {} }
      states.length = 0;
    }
  };
}
