// minimap.js — AZURE BAY minimap (round-2 rewrite by Lane 2).
// Draws the two-island city onto a <canvas id="minimap"> with its 2D context.
// mapData contract (world coordinates, x east, z south, meters):
//   { islands: [{ cx, cz, rx, rz }], roads: [{ x1, z1, x2, z2 }],
//     bridge: { x1, z1, x2, z2 } }
// Player is a white arrow rotated by heading; the car (when given) is a
// small amber rectangle. World coordinates are scaled to the canvas with
// a transform computed from the mapData extents.
//
// ROUND-2 FIX — SMALL VIEWPORTS. The old code computed its transform
// once from the 220x220 backing store and drew everything at fixed
// pixel sizes. But the stylesheet shrinks this canvas to 150x150 CSS px
// at the compact breakpoint (<=960px wide or <=620px tall) while the
// backing store stays 220px — the browser then downscales the whole
// 220px drawing into 150px, so 1px lines and 2px blips turn to mush and
// the N disc, frame and blips crowd each other. Now:
//   - syncBackingStore() runs every update: when the displayed (CSS)
//     size changes, the backing store is resized to displayed size
//     times devicePixelRatio (clamped 80-440px) and the transform is
//     recomputed, so the map always renders at native resolution
//     instead of being a downscaled image;
//   - every drawn size rides one UI scale factor `ui` (backing size /
//     220, clamped 0.5-2.0): roads, bridge, blips, the player arrow,
//     the N marker and the frame all shrink proportionally with the
//     canvas, with minimum legibility floors so nothing vanishes;
//   - below ui 0.7 the dark ring around extra blips is dropped — at
//     that size the ring is clutter, not contrast.
// The canvas position itself stays in the stylesheet (bottom-right,
// pulled inward at the compact breakpoint, clear of the ammo readout);
// this file makes the DRAWING adapt so it stays readable wherever the
// stylesheet puts it.

export function createMinimap(canvas, mapData) {
  const noop = () => {};
  if (!canvas || typeof canvas.getContext !== 'function') {
    return { update: noop };
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { update: noop };
  }

  const data = mapData || {};
  const islands = Array.isArray(data.islands) ? data.islands : [];
  const roads = Array.isArray(data.roads) ? data.roads : [];
  const bridge = data.bridge || null;

  // ---- World extents (fixed — the city does not move) -------------------
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  const absorb = (x, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };

  islands.forEach((island) => {
    absorb(island.cx - island.rx, island.cz - island.rz);
    absorb(island.cx + island.rx, island.cz + island.rz);
  });
  roads.forEach((road) => {
    absorb(road.x1, road.z1);
    absorb(road.x2, road.z2);
  });
  if (bridge) {
    absorb(bridge.x1, bridge.z1);
    absorb(bridge.x2, bridge.z2);
  }

  // Fallback world if mapData carries no usable geometry.
  if (!Number.isFinite(minX) || minX === Infinity) {
    minX = -500;
    maxX = 500;
    minZ = -500;
    maxZ = 500;
  }

  // 10% padding so nothing sits exactly on the canvas edge.
  const padX = (maxX - minX) * 0.1 + 1;
  const padZ = (maxZ - minZ) * 0.1 + 1;
  minX -= padX;
  maxX += padX;
  minZ -= padZ;
  maxZ += padZ;

  // ---- View transform (recomputed whenever the backing store changes) ----
  let viewW = 0;
  let viewH = 0;
  let scale = 1;
  let offsetX = 0;
  let offsetZ = 0;
  // UI scale: 1 at the 220px design size; every drawn element multiplies
  // by this, so the map shrinks proportionally instead of going mushy.
  let ui = 1;

  function computeTransform() {
    viewW = canvas.width || 220;
    viewH = canvas.height || 220;
    scale = Math.min(viewW / (maxX - minX), viewH / (maxZ - minZ));
    offsetX = (viewW - (maxX - minX) * scale) / 2 - minX * scale;
    offsetZ = (viewH - (maxZ - minZ) * scale) / 2 - minZ * scale;
    ui = Math.max(0.5, Math.min(2.0, Math.min(viewW, viewH) / 220));
  }
  computeTransform();

  // Keep the backing store matched to the displayed size. The stylesheet
  // shrinks this canvas at the compact breakpoint; without this the
  // browser downscales a 220px drawing and every thin line blurs.
  // Resizing a canvas clears it, so the transform is rebuilt here and
  // update() redraws from scratch right after.
  function syncBackingStore() {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const dispW = canvas.clientWidth || canvas.width || 220;
    const dispH = canvas.clientHeight || canvas.height || 220;
    const wantW = Math.max(80, Math.min(440, Math.round(dispW * dpr)));
    const wantH = Math.max(80, Math.min(440, Math.round(dispH * dpr)));
    if (canvas.width !== wantW || canvas.height !== wantH) {
      canvas.width = wantW;
      canvas.height = wantH;
      computeTransform();
    }
  }

  const toMapX = (x) => x * scale + offsetX;
  const toMapZ = (z) => z * scale + offsetZ;

  function toScreen(p) {
    if (!p) return null;
    const x = Number(p.x);
    const z = Number(p.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    return { x: toMapX(x), y: toMapZ(z) };
  }

  function plotBlips(list, color, size) {
    if (!Array.isArray(list)) return;
    const r = Math.max(1.5, (size / 2) * ui);
    // At small sizes the dark ring is clutter, not contrast — drop it
    // and keep just the coloured dot.
    const ringed = ui >= 0.7;
    for (const p of list) {
      const m = toScreen(p);
      if (!m) continue;
      if (ringed) {
        ctx.beginPath();
        ctx.arc(m.x, m.y, r + 1, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  function update(playerPos, heading, carPos, extras) {
    // Match the backing store to the displayed size first — this also
    // rebuilds the transform (and clears the canvas) when it changes.
    syncBackingStore();

    // Water: a deep blue so the sand islands and the light roads pop.
    ctx.clearRect(0, 0, viewW, viewH);
    ctx.fillStyle = '#0a4a73';
    ctx.fillRect(0, 0, viewW, viewH);

    // Islands as sand-colored filled ellipses with a soft dark edge.
    ctx.fillStyle = '#d9c27a';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.lineWidth = Math.max(1, 1.5 * ui);
    islands.forEach((island) => {
      const cx = toMapX(island.cx);
      const cy = toMapZ(island.cz);
      const rx = Math.max(1, island.rx * scale);
      const rz = Math.max(1, island.rz * scale);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, rz, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });

    // Roads as pale grey lines — light enough to read on sand, dark
    // enough to read on water where they cross the bridge gap.
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = Math.max(1.5, 3 * ui);
    ctx.lineCap = 'round';
    roads.forEach((road) => {
      ctx.beginPath();
      ctx.moveTo(toMapX(road.x1), toMapZ(road.z1));
      ctx.lineTo(toMapX(road.x2), toMapZ(road.z2));
      ctx.stroke();
    });

    // Bridge as one thick white line joining the islands.
    if (bridge) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(2, 5 * ui);
      ctx.beginPath();
      ctx.moveTo(toMapX(bridge.x1), toMapZ(bridge.z1));
      ctx.lineTo(toMapX(bridge.x2), toMapZ(bridge.z2));
      ctx.stroke();
    }

    // The car, when given, as a small amber rectangle with a dark edge.
    const car = toScreen(carPos);
    if (car) {
      const cw = 6 * ui;
      const ch = 4 * ui;
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(car.x - cw / 2, car.y - ch / 2, cw, ch);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.lineWidth = Math.max(1, 1 * ui);
      ctx.strokeRect(car.x - cw / 2, car.y - ch / 2, cw, ch);
    }

    // Extra blips (all optional; skipped when extras is undefined, so the
    // menu and older callers keep working unchanged): police blue 4px,
    // traffic amber 3px, pedestrians green 2px. Drawn under the player
    // arrow so the player stays on top.
    if (extras) {
      plotBlips(extras.traffic, '#f59e0b', 3);
      plotBlips(extras.peds, '#22c55e', 2);
      plotBlips(extras.police, '#3b82f6', 4);
      // Fase 3 (Lane E): named places (safehouse / shops / NPCs /
      // mission starts) as coloured dots, and the active objective as a
      // gold diamond so the current job reads at a glance.
      if (Array.isArray(extras.places)) {
        const pr = Math.max(2, 3.5 * ui);
        for (const p of extras.places) {
          const m = toScreen(p);
          if (!m) continue;
          ctx.beginPath();
          ctx.arc(m.x, m.y, pr, 0, Math.PI * 2);
          ctx.fillStyle = p.color || '#ffd24a';
          ctx.fill();
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
          ctx.lineWidth = Math.max(1, 1 * ui);
          ctx.stroke();
        }
      }
      if (extras.objective) {
        const m = toScreen(extras.objective);
        if (m) {
          const half = Math.max(3, 4 * ui);
          ctx.save();
          ctx.translate(m.x, m.y);
          ctx.rotate(Math.PI / 4);
          ctx.fillStyle = '#fbbf24';
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
          ctx.lineWidth = Math.max(1, 1.5 * ui);
          ctx.fillRect(-half, -half, half * 2, half * 2);
          ctx.strokeRect(-half, -half, half * 2, half * 2);
          ctx.restore();
        }
      }
    }

    // The player as a white arrow rotated by heading (0 = north / up),
    // with a heavier dark outline so it never melts into the sand.
    // The arrow keeps a minimum size so it stays tappable-readable even
    // on the smallest viewport.
    const player = toScreen(playerPos);
    if (player) {
      const angle = Number(heading) || 0;
      const s = Math.max(5 / 7, ui); // arrow geometry is drawn at 7px units
      ctx.save();
      ctx.translate(player.x, player.y);
      ctx.rotate(angle);
      ctx.scale(s, s);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#111827';
      ctx.lineWidth = Math.max(1, 1.5 * ui);
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(5, 6);
      ctx.lineTo(0, 3);
      ctx.lineTo(-5, 6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // North marker: white N on a dark disc so it reads over water or sand.
    const nR = Math.max(6, 9 * ui);
    const nX = viewW - 10 * ui;
    const nY = 11 * ui;
    ctx.beginPath();
    ctx.arc(nX, nY, nR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.max(9, Math.round(12 * ui))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', nX, nY + 1);

    // Dark translucent frame so the minimap reads over the 3D view.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = Math.max(1.5, 3 * ui);
    const f = (3 * ui) / 2;
    ctx.strokeRect(f, f, viewW - 3 * ui, viewH - 3 * ui);
  }

  return { update };
}
