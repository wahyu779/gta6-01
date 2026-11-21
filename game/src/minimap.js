// minimap.js — AZURE BAY minimap (Lane C, Fase 1)
// Draws the two-island city onto a <canvas id="minimap"> with its 2D context.
// mapData contract (world coordinates, x east, z south, meters):
//   { islands: [{ cx, cz, rx, rz }], roads: [{ x1, z1, x2, z2 }],
//     bridge: { x1, z1, x2, z2 } }
// Player is a white arrow rotated by heading; the car (when given) is a
// small amber rectangle. World coordinates are scaled to the canvas with a
// fixed transform computed once from the mapData extents.

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

  // ---- Fixed world-to-map transform from the map extents ----
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  const include = (x, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };

  islands.forEach((island) => {
    include(island.cx - island.rx, island.cz - island.rz);
    include(island.cx + island.rx, island.cz + island.rz);
  });
  roads.forEach((road) => {
    include(road.x1, road.z1);
    include(road.x2, road.z2);
  });
  if (bridge) {
    include(bridge.x1, bridge.z1);
    include(bridge.x2, bridge.z2);
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

  const w = canvas.width || 220;
  const h = canvas.height || 220;
  const scale = Math.min(w / (maxX - minX), h / (maxZ - minZ));
  const offsetX = (w - (maxX - minX) * scale) / 2 - minX * scale;
  const offsetZ = (h - (maxZ - minZ) * scale) / 2 - minZ * scale;

  const toMapX = (x) => x * scale + offsetX;
  const toMapZ = (z) => z * scale + offsetZ;

  function posOf(p) {
    if (!p) return null;
    const x = Number(p.x);
    const z = Number(p.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    return { x: toMapX(x), y: toMapZ(z) };
  }

  function drawDots(list, color, size) {
    if (!Array.isArray(list)) return;
    for (const p of list) {
      const m = posOf(p);
      if (!m) continue;
      // Dark ring around each blip so it reads on the pale sand.
      ctx.beginPath();
      ctx.arc(m.x, m.y, size / 2 + 1, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(m.x, m.y, size / 2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  function update(playerPos, heading, carPos, extras) {
    // Water: a deep blue so the sand islands and the light roads pop.
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0a4a73';
    ctx.fillRect(0, 0, w, h);

    // Islands as sand-colored filled ellipses with a soft dark edge.
    ctx.fillStyle = '#d9c27a';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.lineWidth = 1.5;
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
    ctx.lineWidth = 3;
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
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(toMapX(bridge.x1), toMapZ(bridge.z1));
      ctx.lineTo(toMapX(bridge.x2), toMapZ(bridge.z2));
      ctx.stroke();
    }

    // The car, when given, as a small amber rectangle with a dark edge.
    const car = posOf(carPos);
    if (car) {
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(car.x - 3, car.y - 2, 6, 4);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.lineWidth = 1;
      ctx.strokeRect(car.x - 3, car.y - 2, 6, 4);
    }

    // Extra blips (all optional; skipped when extras is undefined, so the
    // menu and older callers keep working unchanged): police blue 4px,
    // traffic amber 3px, pedestrians green 2px. Drawn under the player
    // arrow so the player stays on top.
    if (extras) {
      drawDots(extras.traffic, '#f59e0b', 3);
      drawDots(extras.peds, '#22c55e', 2);
      drawDots(extras.police, '#3b82f6', 4);
      // Fase 3 (Lane E): named places (safehouse / shops / NPCs /
      // mission starts) as coloured dots, and the active objective as a
      // gold diamond so the current job reads at a glance.
      if (Array.isArray(extras.places)) {
        for (const p of extras.places) {
          const m = posOf(p);
          if (!m) continue;
          ctx.beginPath();
          ctx.arc(m.x, m.y, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = p.color || '#ffd24a';
          ctx.fill();
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      if (extras.objective) {
        const m = posOf(extras.objective);
        if (m) {
          ctx.save();
          ctx.translate(m.x, m.y);
          ctx.rotate(Math.PI / 4);
          ctx.fillStyle = '#fbbf24';
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
          ctx.lineWidth = 1.5;
          ctx.fillRect(-4, -4, 8, 8);
          ctx.strokeRect(-4, -4, 8, 8);
          ctx.restore();
        }
      }
    }

    // The player as a white arrow rotated by heading (0 = north / up),
    // with a heavier dark outline so it never melts into the sand.
    const player = posOf(playerPos);
    if (player) {
      const angle = Number(heading) || 0;
      ctx.save();
      ctx.translate(player.x, player.y);
      ctx.rotate(angle);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#111827';
      ctx.lineWidth = 1.5;
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
    ctx.beginPath();
    ctx.arc(w - 10, 11, 9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', w - 10, 12);

    // Dark translucent frame so the minimap reads over the 3D view.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, w - 3, h - 3);
  }

  return { update };
}
