# VORTX — Next-Generation Browser Gaming Platform

Plataforma de videojuegos UGC que se juega y se crea desde el navegador.
Identidad, código, personajes, geometría y accesorios **completamente
originales de VORTX**: sin assets, meshes, texturas ni caras de Roblox.

## Cómo se ejecuta

Es un sitio estático, sin build:

```bash
python3 -m http.server 8080 --directory .
# abre http://localhost:8080
```

También se puede desplegar tal cual en cualquier hosting estático
(Cloudflare, Netlify, GitHub Pages…).

## Estado por fases

- **Fase 1 — Web (hecha):** Discover con secciones (Destacadas, Popular,
  Recomendado, Actualizadas, Más jugadas, Nuevas, Seguir jugando),
  páginas de experiencia con estadísticas reales de este navegador,
  registro e inicio de sesión, perfiles con avatar 3D, seguidores,
  amigos y grupos.
- **Fase 2 — Avatar (núcleo hecho):** rig R6 propio de seis piezas
  (Head, Torso, brazos y piernas) con sistema de attachments (hat,
  hair, face, neck, back, waist, shoulders, manos y pies), editor de
  avatar con colores por pieza, dos cabezas originales, rostro opcional
  dibujado por código, outfits e inventario.
- **Fase 3 — Motor (núcleo hecho):** Three.js con física y colisiones,
  cámara en tercera persona, tres experiencias jugables reales
  (Baseplate, Obby de Cristal, Plaza VORTX) y mundos por plantillas
  para las experiencias creadas en el Creator Hub. Controles de
  teclado/ratón, táctil y mando. La física y las partículas corren en
  un núcleo propio en **Rust compilado a WebAssembly**
  (`rust/src/lib.rs`, cargado desde `js/wasm-data.js`), con respaldo
  en JavaScript si el WASM no está disponible.
- **Fase 4 — Multijugador (pendiente, sin simular):** servidores,
  sincronización y chat en línea con Supabase. Hoy las cuentas y los
  datos viven en el navegador local; nadie finge otros jugadores.
- **Fase 5 — Creator Hub (parcial):** crear, editar, publicar y borrar
  experiencias con plantillas, con visitas reales. **Game Passes:**
  cada experiencia puede vender pases con V-Coins (el creador recibe
  el 70 %) cuyas ventajas —velocidad, super salto, insignia de
  perfil— se aplican de verdad dentro del juego. El editor 3D libre
  (Explorer/Properties) es el siguiente paso de esta fase.
- **Fase 6 — Marketplace (núcleo hecho):** catálogo original con vista
  previa 3D, compra con V-Coins, historial de transacciones e
  inventario equipable. La moneda es local en esta fase; la validación
  en servidor llega con la Fase 4.

## Reglas del proyecto

1. Solo R6. Nada de R15 ni R5.
2. Nada de assets extraídos de Roblox ni caras de Roblox.
   - Excepción (orden de Jairon, 2026-11-14): la ropa del catálogo de Roblox (446 shirts y 448 pants) se añadió al Marketplace; el resto del contenido sigue siendo original de VORTX.
   - Las imágenes de esa ropa se cargan desde este repo en GitHub (raw.githubusercontent.com); para que carguen en el navegador el repo tiene que ser público.
3. Sin botones decorativos: todo lo visible funciona o no está.
4. Sin jugadores ni estadísticas falsas: los números son los reales
   de uso en este navegador hasta que exista servidor.
