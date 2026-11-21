// AZURE BAY — two-island coastal city: water, islands, bridge, roads,
// buildings, palms, streetlights and a marina. All dimensions come from
// CONFIG; geometry here is only built from those numbers.
//
// buildCity(scene) returns:
//   colliders   — AABB list {min:{x,y,z}, max:{x,y,z}} for every building
//                 plus the bridge rails
//   isWalkable  — (x, z) => true on either island or the bridge deck
//   isDrivable  — (x, z) => true on a road or the bridge
//   spawnPoint  — THREE.Vector3, on foot beside a north-island road
//   carSpawns   — [THREE.Vector3 x3], parked on roads
//   mapData     — {islands, roads, bridge} for the minimap lane
//
// ROUND-2 NOTE — the "big dark-blue roof" in the city shot is NOT from
// this file. City roofs are browns and greys by design (roofColors
// #8a5a3a / #5a5a5a / #7a4a3a) and no city wall is dark blue either; a
// probe over the real scene proved the corner-filling dark-blue slab is
// skyline tower #10 (props.js), 70 m from the city-shot camera. It is
// fixed in props.js by making the skyline ring follow the camera, so
// this file keeps its roofs and only gains the genuine improvements
// listed below.
//
// Round-2 improvements in this file:
//   - Streetlight poles and lamp heads are InstancedMesh now (was one
//     mesh per lamp, ~120+ draw calls for the whole city); the lamp
//     positions are unchanged, only the draw cost drops.
//   - Each tower's faces and its street-facing side are computed ONCE
//     and reused for windows, shopfront and neon, instead of rebuilt
//     three times per tower.
//   - Neon / awning colours are tracked as one index per tower (parallel
//     to the strip/sign lists) instead of the old double-push + j*2
//     indexing, which was one miscount away from miscoloured signs.
//   - Plot validation precomputes each island's scaled plot ellipse
//     once instead of spreading a fresh object per candidate.
//   - The shop awning tilt no longer carries a dead ternary branch.
//
// The deterministic layout is preserved byte-for-byte: the seeded RNG
// calls happen in exactly the same order as before, so building plots,
// heights, colours, colliders and palm spots are identical to the
// previous revision — only the code around them changed.

import * as THREE from 'three';
import { CONFIG } from './config.js';

// Small deterministic RNG (mulberry32) so every load builds the same city.
function makeSeededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const GROUND = CONFIG.groundY;

// Distance from a point to an axis-aligned road segment (2D, x/z plane).
function segDistance(px, pz, seg) {
  const dx = seg.x2 - seg.x1;
  const dz = seg.z2 - seg.z1;
  const lenSq = dx * dx + dz * dz;
  let t = lenSq === 0 ? 0 : ((px - seg.x1) * dx + (pz - seg.z1) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = seg.x1 + t * dx;
  const cz = seg.z1 + t * dz;
  return Math.hypot(px - cx, pz - cz);
}

function insideEllipse(x, z, island) {
  const nx = (x - island.cx) / island.rx;
  const nz = (z - island.cz) / island.rz;
  return nx * nx + nz * nz <= 1;
}

// ---- instancing helpers ------------------------------------------------------
// Repeated small parts (windows, rooftop kit, palm fronds) are collected as
// matrices first and flushed into one InstancedMesh each, so the detailed
// facades cost a handful of draw calls instead of thousands of meshes.
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();

function pushMatrix(list, px, py, pz, rx, ry, rz, sx, sy, sz, order = 'XYZ') {
  _euler.set(rx, ry, rz, order);
  _quat.setFromEuler(_euler);
  _pos.set(px, py, pz);
  _scale.set(sx, sy, sz);
  list.push(new THREE.Matrix4().compose(_pos, _quat, _scale));
}

function flushInstances(scene, geo, material, list, shadow = false) {
  if (list.length === 0) return null;
  const mesh = new THREE.InstancedMesh(geo, material, list.length);
  for (let i = 0; i < list.length; i++) mesh.setMatrixAt(i, list[i]);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = shadow;
  scene.add(mesh);
  return mesh;
}

export function buildCity(scene) {
  const P = CONFIG.palette;
  const rand = makeSeededRng(CONFIG.seed);
  const colliders = [];

  // Shared materials — one per colour, reused by every mesh that uses it.
  const mat = {
    water: new THREE.MeshStandardMaterial({
      // Lane C (fase4, nit d): roughness 0.25 -> 0.45. The low sun's
      // GGX specular on near-mirror water blew a third of the city
      // frame out to white-gold; rougher water keeps the sparkle
      // (the engine's injected Blinn glint still runs, dimmed in
      // CONFIG) but spreads and dims the broad sun sheen to a soft
      // glow instead of a blown-out patch.
      color: P.water, transparent: true, opacity: 0.85, roughness: 0.45, metalness: 0.1,
    }),
    sand: new THREE.MeshStandardMaterial({ color: P.sand, roughness: 1 }),
    grass: new THREE.MeshStandardMaterial({ color: P.grass, roughness: 1 }),
    road: new THREE.MeshStandardMaterial({ color: P.road, roughness: 0.95 }),
    roadLine: new THREE.MeshStandardMaterial({ color: P.roadLine, roughness: 0.8 }),
    bridgeDeck: new THREE.MeshStandardMaterial({ color: P.bridgeDeck, roughness: 0.9 }),
    bridgeRail: new THREE.MeshStandardMaterial({ color: P.bridgeRail, roughness: 0.5, metalness: 0.4 }),
    pier: new THREE.MeshStandardMaterial({ color: P.pier, roughness: 1 }),
    palmTrunk: new THREE.MeshStandardMaterial({ color: P.palmTrunk, roughness: 1 }),
    palmCanopy: new THREE.MeshStandardMaterial({ color: P.palmCanopy, roughness: 1 }),
    lampPole: new THREE.MeshStandardMaterial({ color: '#3a3f46', roughness: 0.6, metalness: 0.5 }),
    lampGlow: new THREE.MeshStandardMaterial({
      color: P.lampGlow, emissive: P.lampGlow, emissiveIntensity: 1.6,
    }),
    boatHull: new THREE.MeshStandardMaterial({ color: P.boatHull, roughness: 0.4 }),
    boatCabin: new THREE.MeshStandardMaterial({ color: P.boatCabin, roughness: 0.6 }),
    boatMast: new THREE.MeshStandardMaterial({ color: '#5a5a5a', roughness: 0.6 }),
    // ---- facade dressing ----
    // Dark frame backing every window, so glass reads as a punched opening.
    windowFrame: new THREE.MeshStandardMaterial({ color: '#1d232b', roughness: 0.6 }),
    // Warm lit glass — golden-hour interiors, only some windows are on.
    windowLit: new THREE.MeshStandardMaterial({
      color: '#4a3418', emissive: '#ffb45c', emissiveIntensity: 1.5, roughness: 0.3,
    }),
    // Dark reflective glass for the windows that are off.
    windowDark: new THREE.MeshStandardMaterial({
      color: '#26313d', roughness: 0.2, metalness: 0.6,
    }),
    // Dark trim: plinth band, cornice band, parapet.
    trim: new THREE.MeshStandardMaterial({ color: '#3d3a36', roughness: 0.9 }),
    acUnit: new THREE.MeshStandardMaterial({ color: '#9aa0a6', roughness: 0.5, metalness: 0.4 }),
    tank: new THREE.MeshStandardMaterial({ color: '#6b5a4a', roughness: 0.8 }),
    antenna: new THREE.MeshStandardMaterial({ color: '#4a4e54', roughness: 0.5, metalness: 0.6 }),
    antennaTip: new THREE.MeshStandardMaterial({
      color: '#ff2a2a', emissive: '#ff2a2a', emissiveIntensity: 2.2,
    }),
    // Ground-floor shop glass with a warm interior glow behind it.
    shopGlass: new THREE.MeshStandardMaterial({
      color: '#2c3838', emissive: '#ff9a4d', emissiveIntensity: 0.55,
      roughness: 0.15, metalness: 0.5,
    }),
    shopDoor: new THREE.MeshStandardMaterial({ color: '#14181d', roughness: 0.4, metalness: 0.4 }),
    // Palm fronds: pointed leaf shape, double-sided so both faces catch light.
    frond: new THREE.MeshStandardMaterial({
      color: '#2e7d32', roughness: 0.9, side: THREE.DoubleSide,
    }),
    coconut: new THREE.MeshStandardMaterial({ color: '#6b4a2a', roughness: 1 }),
    sail: new THREE.MeshStandardMaterial({
      color: '#f8f4e8', roughness: 0.8, side: THREE.DoubleSide,
    }),
    boatGlass: new THREE.MeshStandardMaterial({
      color: '#1e2c38', roughness: 0.15, metalness: 0.6,
    }),
  };
  // Awning canvas colours, one per shop.
  const awningMats = ['#d94f4f', '#2f8f7f', '#e8a83d', '#3f6fb8', '#8f4fd8'].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }),
  );
  // Neon sign colours for the landmark towers.
  const neonMats = ['#ff4fd8', '#35e0ff', '#ff9a3d', '#4dff88', '#ffe14d'].map(
    (c) => new THREE.MeshStandardMaterial({
      color: c, emissive: c, emissiveIntensity: 2.4, roughness: 0.3,
    }),
  );
  // Facade palette: the config colours plus extra warm coastal shades so no
  // two neighbouring towers look alike.
  const facadeExtra = [
    '#e8c8a0', '#c8d8c8', '#d8b8d8', '#f8e8c8', '#b8c8d8',
    '#e8a878', '#9ab8a8', '#d8d0c0', '#f0c8b8', '#a8b8c8',
  ];
  const wallMats = [...CONFIG.buildings.colors, ...facadeExtra].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 }),
  );
  // Roof slabs: browns and greys only, by design — no blue roof exists
  // anywhere in this file (see the round-2 note at the top).
  const roofMats = CONFIG.buildings.roofColors.map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.95 }),
  );

  // Shared geometries — unit box scaled per building keeps mesh variety cheap.
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const poleGeo = new THREE.CylinderGeometry(0.08, 0.12, CONFIG.streetlights.poleHeight, 6);
  const lampGeo = new THREE.BoxGeometry(0.5, 0.22, 1.1);

  // ---- water -----------------------------------------------------------------
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(CONFIG.waterSize, CONFIG.waterSize),
    mat.water,
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = CONFIG.waterY;
  scene.add(water);

  // ---- islands: sand beach ring + grass top -----------------------------------
  for (const island of CONFIG.islands) {
    const sand = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1.4, 48), mat.sand);
    sand.scale.set(island.rx + 10, 1, island.rz + 10);
    sand.position.set(island.cx, 0.7, island.cz);
    sand.receiveShadow = true;
    scene.add(sand);

    const grass = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1.6, 48), mat.grass);
    grass.scale.set(island.rx, 1, island.rz);
    grass.position.set(island.cx, 0.7, island.cz);
    grass.receiveShadow = true;
    scene.add(grass);
  }

  // ---- bridge: deck, rails, support pillars ------------------------------------
  const bridge = CONFIG.bridge;
  const deckLen = bridge.z2 - bridge.z1;
  const deck = new THREE.Mesh(unitBox, mat.bridgeDeck);
  deck.scale.set(bridge.width, 1.2, deckLen);
  deck.position.set(bridge.x, GROUND - 0.6, (bridge.z1 + bridge.z2) / 2);
  deck.receiveShadow = true;
  scene.add(deck);

  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(unitBox, mat.bridgeRail);
    rail.scale.set(0.4, bridge.railHeight, deckLen);
    rail.position.set(
      bridge.x + side * (bridge.width / 2 - 0.2),
      GROUND + bridge.railHeight / 2,
      (bridge.z1 + bridge.z2) / 2,
    );
    rail.castShadow = true;
    scene.add(rail);
    colliders.push({
      min: {
        x: rail.position.x - 0.2,
        y: GROUND,
        z: bridge.z1,
      },
      max: {
        x: rail.position.x + 0.2,
        y: GROUND + bridge.railHeight,
        z: bridge.z2,
      },
    });
  }
  // Two pillars standing in the water under the deck.
  for (const pz of [-25, 30]) {
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 2.0, GROUND + 1, 10),
      mat.bridgeDeck,
    );
    pillar.position.set(bridge.x, (GROUND + 1) / 2 - 0.5, pz);
    scene.add(pillar);
  }

  // ---- roads: asphalt strips with pale edge lines --------------------------------
  const roadHalf = CONFIG.roadWidth / 2;
  for (const seg of CONFIG.roads) {
    const len = Math.hypot(seg.x2 - seg.x1, seg.z2 - seg.z1);
    const angle = -Math.atan2(seg.z2 - seg.z1, seg.x2 - seg.x1);
    const cx = (seg.x1 + seg.x2) / 2;
    const cz = (seg.z1 + seg.z2) / 2;

    const strip = new THREE.Mesh(unitBox, mat.road);
    strip.scale.set(len, 0.1, CONFIG.roadWidth);
    strip.position.set(cx, GROUND + 0.02, cz);
    strip.rotation.y = angle;
    strip.receiveShadow = true;
    scene.add(strip);

    // Edge lines, offset sideways from the centreline.
    for (const side of [-1, 1]) {
      const line = new THREE.Mesh(unitBox, mat.roadLine);
      line.scale.set(len, 0.06, 0.3);
      const ox = Math.sin(angle) * side * CONFIG.roadLineOffset;
      const oz = Math.cos(angle) * side * CONFIG.roadLineOffset;
      line.position.set(cx + ox, GROUND + 0.08, cz + oz);
      line.rotation.y = angle;
      scene.add(line);
    }
  }

  // ---- buildings ---------------------------------------------------------------
  const B = CONFIG.buildings;
  const keepOutPoints = [
    CONFIG.spawn,
    ...CONFIG.carSpawns,
  ];
  // Each island's plot ellipse, precomputed once: plots must sit inside
  // the island scaled by sqrt(ellipseMargin), clear of roads and spawns.
  const plotEllipses = CONFIG.islands.map((island) => ({
    cx: island.cx,
    cz: island.cz,
    rx: island.rx * Math.sqrt(B.ellipseMargin),
    rz: island.rz * Math.sqrt(B.ellipseMargin),
  }));
  function plotClear(x, z, island) {
    const ellipse = plotEllipses[CONFIG.islands.indexOf(island)];
    if (!insideEllipse(x, z, ellipse)) return false;
    for (const seg of CONFIG.roads) {
      if (segDistance(x, z, seg) < B.roadClearance) return false;
    }
    for (const p of keepOutPoints) {
      if (Math.hypot(x - p.x, z - p.z) < B.spawnClearance) return false;
    }
    return true;
  }

  // Candidate plots on a jittered grid inside each island's ring road.
  // Columns sit between the N-S road and the ring roads; rows sit in the two
  // bands between the ring roads and the E-W cross street, two rows per band.
  const plots = [];
  const plotGrids = [
    { island: CONFIG.islands[0], xs: [-60, -40, -20, 20, 40, 60], zs: [-175, -155, -125, -105], target: B.targetNorth },
    { island: CONFIG.islands[1], xs: [-60, -40, -20, 20, 40, 60], zs: [105, 125, 155, 175], target: B.targetSouth },
  ];
  for (const grid of plotGrids) {
    const candidates = [];
    for (const x of grid.xs) {
      for (const z of grid.zs) {
        const jx = x + (rand() - 0.5) * 4;
        const jz = z + (rand() - 0.5) * 4;
        if (plotClear(jx, jz, grid.island)) candidates.push({ x: jx, z: jz, island: grid.island });
      }
    }
    // Shuffle deterministically, then take the target count.
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    plots.push(...candidates.slice(0, grid.target));
  }

  // First pass: footprint / height / look, in the same rand order as before
  // so colliders and layout stay identical to earlier phases.
  const buildSpecs = [];
  for (const plot of plots) {
    const w = B.minFoot + rand() * (B.maxFoot - B.minFoot);
    const d = B.minFoot + rand() * (B.maxFoot - B.minFoot);
    // Taller near the island centre, shorter toward the beach.
    const nx = (plot.x - plot.island.cx) / plot.island.rx;
    const nz = (plot.z - plot.island.cz) / plot.island.rz;
    const centre = Math.max(0, 1 - (nx * nx + nz * nz));
    const h = Math.min(
      B.maxHeight,
      B.minHeight + rand() * 20 + centre * 14,
    );
    const wallIdx = Math.floor(rand() * wallMats.length);
    const roofIdx = Math.floor(rand() * roofMats.length);
    // Facade pattern: 0 grid, 1 horizontal ribbon bands, 2 vertical strips,
    // 3 sparse random, 4 grid + balconies on the street face.
    const pattern = Math.floor(rand() * 5);
    const commercial = rand() < 0.45; // ground-floor shopfront
    buildSpecs.push({ plot, w, d, h, wallIdx, roofIdx, pattern, commercial });
  }
  // The six tallest towers get neon signage — the skyline landmarks.
  const neonSet = new Set(
    [...buildSpecs].sort((a, b) => b.h - a.h).slice(0, 6),
  );

  // Instanced collectors for everything repeated across the 34 towers.
  const trimList = [];      // plinth, cornice, parapet
  const acList = [];        // rooftop AC units
  const tankList = [];      // rooftop water tanks
  const tankTopList = [];   // tank cone lids
  const antennaList = [];   // rooftop masts
  const antennaBarList = []; // mast crossbars
  const antennaTipList = []; // red beacon tips on tall towers
  const frameList = [];     // window frames (dark backing)
  const litList = [];       // lit window glass (warm emissive)
  const darkList = [];      // unlit window glass (dark reflective)
  const balconyList = [];   // balcony slabs
  const shopGlassList = []; // storefront glass
  const shopDoorList = [];  // storefront doors
  const awningList = [];    // shop awnings
  const awningPaint = [];   // awning material index per awning instance
  const neonStripList = []; // vertical neon strips
  const neonSignList = [];  // neon sign boards
  const neonPaint = [];     // neon material index per landmark tower

  // A window on one face: frame backing + glass, both slightly proud of the
  // wall so nothing z-fights. rotY orients the quad to the face normal.
  function placeWindow(px, py, pz, rotY, ww, wh) {
    pushMatrix(frameList, px, py, pz, 0, rotY, 0, ww + 0.25, wh + 0.25, 0.08);
    const list = rand() < 0.45 ? litList : darkList;
    pushMatrix(list, px, py, pz, 0, rotY, 0, ww, wh, 0.12);
  }

  // The four faces of a tower, with the outward normal of each.
  function facadeFaces(spec) {
    const { plot, w, d } = spec;
    return [
      { name: '+z', rotY: 0, len: w, nx: 0, nz: 1, cx: plot.x, cz: plot.z + d / 2 },
      { name: '-z', rotY: Math.PI, len: w, nx: 0, nz: -1, cx: plot.x, cz: plot.z - d / 2 },
      { name: '+x', rotY: Math.PI / 2, len: d, nx: 1, nz: 0, cx: plot.x + w / 2, cz: plot.z },
      { name: '-x', rotY: -Math.PI / 2, len: d, nx: -1, nz: 0, cx: plot.x - w / 2, cz: plot.z },
    ];
  }

  // Which face looks at the nearest road — that is the street face, where the
  // shopfront and balconies go.
  function roadsideFace(faces) {
    let best = null;
    let bestDist = Infinity;
    for (const f of faces) {
      let dmin = Infinity;
      for (const seg of CONFIG.roads) dmin = Math.min(dmin, segDistance(f.cx, f.cz, seg));
      if (dmin < bestDist) { bestDist = dmin; best = f; }
    }
    return best;
  }

  for (const spec of buildSpecs) {
    const { plot, w, d, h, pattern } = spec;
    const x = plot.x;
    const z = plot.z;
    // Faces + street face computed once per tower and reused by the
    // windows, the shopfront and the neon below.
    const faces = facadeFaces(spec);
    const street = roadsideFace(faces);

    const body = new THREE.Mesh(unitBox, wallMats[spec.wallIdx]);
    body.scale.set(w, h, d);
    body.position.set(x, GROUND + h / 2, z);
    body.castShadow = true;
    body.receiveShadow = true;
    scene.add(body);

    // Dark plinth band at the base and cornice band just under the roof.
    pushMatrix(trimList, x, GROUND + 0.5, z, 0, 0, 0, w + 0.15, 1.0, d + 0.15);
    pushMatrix(trimList, x, GROUND + h - 0.35, z, 0, 0, 0, w + 0.3, 0.7, d + 0.3);

    const roof = new THREE.Mesh(unitBox, roofMats[spec.roofIdx]);
    roof.scale.set(w * 0.85, 1.2, d * 0.85);
    roof.position.set(x, GROUND + h + 0.6, z);
    roof.castShadow = true;
    scene.add(roof);

    // ---- rooftop kit: parapet, AC units, water tank, antenna ---------------
    const roofY = GROUND + h + 1.2;
    const rw = w * 0.85;
    const rd = d * 0.85;
    // Parapet ring on the roof-slab edge.
    pushMatrix(trimList, x, roofY + 0.45, z + rd / 2 - 0.12, 0, 0, 0, rw, 0.9, 0.25);
    pushMatrix(trimList, x, roofY + 0.45, z - rd / 2 + 0.12, 0, 0, 0, rw, 0.9, 0.25);
    pushMatrix(trimList, x + rw / 2 - 0.12, roofY + 0.45, z, 0, 0, 0, 0.25, 0.9, rd);
    pushMatrix(trimList, x - rw / 2 + 0.12, roofY + 0.45, z, 0, 0, 0, 0.25, 0.9, rd);
    // 1-3 AC condenser boxes scattered on the roof.
    const acCount = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < acCount; i++) {
      pushMatrix(
        acList,
        x + (rand() - 0.5) * (rw - 2.5),
        roofY + 0.4,
        z + (rand() - 0.5) * (rd - 2.5),
        0, rand() * Math.PI, 0,
        1.3, 0.8, 1.0,
      );
    }
    // Water tank on about half the roofs.
    if (rand() < 0.5) {
      const tx = x + (rand() - 0.5) * (rw - 3);
      const tz = z + (rand() - 0.5) * (rd - 3);
      pushMatrix(tankList, tx, roofY + 0.85, tz, 0, 0, 0, 1.8, 1.7, 1.8);
      pushMatrix(tankTopList, tx, roofY + 1.95, tz, 0, 0, 0, 1.9, 0.7, 1.9);
    }
    // Antenna mast on most roofs; tall towers get a red beacon tip.
    if (rand() < 0.65) {
      const ax = x + (rand() - 0.5) * (rw - 2);
      const az = z + (rand() - 0.5) * (rd - 2);
      const ah = 3.5 + rand() * 2.5;
      pushMatrix(antennaList, ax, roofY + ah / 2, az, 0, 0, 0, 0.14, ah, 0.14);
      pushMatrix(antennaBarList, ax, roofY + ah * 0.7, az, 0, rand() * Math.PI, 0, 1.7, 0.08, 0.08);
      if (h > 25) pushMatrix(antennaTipList, ax, roofY + ah + 0.12, az, 0, 0, 0, 0.22, 0.22, 0.22);
    }

    // ---- windows ------------------------------------------------------------
    const floorH = 3.0;
    const firstFloorY = GROUND + floorH + 0.6;
    const rows = Math.max(1, Math.floor((h - floorH) / floorH));
    for (const f of faces) {
      const cols = Math.max(2, Math.floor(f.len / 2.6));
      const step = f.len / cols;
      for (let r = 0; r < rows; r++) {
        const wy = firstFloorY + r * floorH + 0.9;
        if (wy + 0.8 > GROUND + h - 0.6) continue;
        if (pattern === 1) {
          // Horizontal ribbon band: one wide window per floor.
          placeWindow(f.cx + f.nx * 0.07, wy, f.cz + f.nz * 0.07, f.rotY, f.len * 0.72, 1.4);
          continue;
        }
        for (let c = 0; c < cols; c++) {
          if (pattern === 2 && c % 2 === 1) continue; // vertical strips only
          if (pattern === 3 && rand() < 0.45) continue; // sparse, some dark bays
          const along = -f.len / 2 + step * (c + 0.5);
          const wx = f.cx + f.nx * 0.07 + (f.name === '+z' || f.name === '-z' ? along : 0);
          const wz = f.cz + f.nz * 0.07 + (f.name === '+x' || f.name === '-x' ? along : 0);
          placeWindow(wx, wy, wz, f.rotY, 1.2, 1.6);
          if (pattern === 4 && f.name === street.name) {
            // Balcony slab under each street-face window.
            pushMatrix(
              balconyList,
              wx + f.nx * 0.5, wy - 1.0, wz + f.nz * 0.5,
              0, f.rotY, 0, 1.7, 0.14, 1.0,
            );
          }
        }
      }
    }

    // ---- ground-floor shopfront on the street face ---------------------------
    if (spec.commercial) {
      const f = street;
      const awnMat = Math.floor(rand() * awningMats.length);
      const shopW = f.len * 0.8;
      const panels = 3;
      const pw = shopW / panels;
      for (let i = 0; i < panels; i++) {
        const along = -shopW / 2 + pw * (i + 0.5);
        const gx = f.cx + f.nx * 0.08 + (f.name === '+z' || f.name === '-z' ? along : 0);
        const gz = f.cz + f.nz * 0.08 + (f.name === '+x' || f.name === '-x' ? along : 0);
        if (i === 1) {
          // Middle panel is the recessed entrance door.
          pushMatrix(shopDoorList, gx, GROUND + 1.3, gz, 0, f.rotY, 0, pw * 0.7, 2.6, 0.14);
        } else {
          pushMatrix(shopGlassList, gx, GROUND + 1.5, gz, 0, f.rotY, 0, pw * 0.85, 2.6, 0.12);
        }
      }
      // Sloping canvas awning over the shopfront. The tilt axis depends
      // on the face: Z faces slope in X, X faces slope in Z.
      const aPos = {
        x: f.cx + f.nx * 0.75,
        y: GROUND + 3.15,
        z: f.cz + f.nz * 0.75,
      };
      if (f.name === '+x' || f.name === '-x') {
        pushMatrix(awningList, aPos.x, aPos.y, aPos.z, 0, 0, f.name === '+x' ? -0.4 : 0.4, 1.5, 0.12, shopW);
      } else {
        const tilt = f.name === '+z' ? 0.4 : -0.4;
        pushMatrix(awningList, aPos.x, aPos.y, aPos.z, tilt, 0, 0, shopW, 0.12, 1.5);
      }
      awningPaint.push(awnMat);
    }

    // ---- neon signage on the landmark towers ---------------------------------
    if (neonSet.has(spec)) {
      const neonIdx = Math.floor(rand() * neonMats.length);
      const f = spec.commercial ? street : faces[0];
      // Vertical neon strip running up the facade.
      pushMatrix(
        neonStripList,
        f.cx + f.nx * 0.18, GROUND + h * 0.52, f.cz + f.nz * 0.18,
        0, f.rotY, 0, 0.5, h * 0.55, 0.22,
      );
      // Horizontal sign board just under the roofline.
      pushMatrix(
        neonSignList,
        f.cx + f.nx * 0.22, GROUND + h - 1.6, f.cz + f.nz * 0.22,
        0, f.rotY, 0, Math.min(f.len * 0.6, 8), 1.1, 0.3,
      );
      // One colour index per landmark tower, shared by its strip + sign.
      neonPaint.push(neonIdx);
    }

    colliders.push({
      min: { x: x - w / 2, y: GROUND, z: z - d / 2 },
      max: { x: x + w / 2, y: GROUND + h + 1.2, z: z + d / 2 },
    });
  }

  // Flush the instanced collectors.
  const tankGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
  const tankTopGeo = new THREE.ConeGeometry(0.5, 1, 12);
  const antennaGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
  flushInstances(scene, unitBox, mat.trim, trimList, true);
  flushInstances(scene, unitBox, mat.acUnit, acList, true);
  flushInstances(scene, tankGeo, mat.tank, tankList, true);
  flushInstances(scene, tankTopGeo, mat.tank, tankTopList, true);
  flushInstances(scene, antennaGeo, mat.antenna, antennaList, true);
  flushInstances(scene, unitBox, mat.antenna, antennaBarList);
  flushInstances(scene, unitBox, mat.antennaTip, antennaTipList);
  flushInstances(scene, unitBox, mat.windowFrame, frameList);
  flushInstances(scene, unitBox, mat.windowLit, litList);
  flushInstances(scene, unitBox, mat.windowDark, darkList);
  flushInstances(scene, unitBox, mat.trim, balconyList, true);
  flushInstances(scene, unitBox, mat.shopGlass, shopGlassList);
  flushInstances(scene, unitBox, mat.shopDoor, shopDoorList);
  // Awnings and neon signs need one InstancedMesh per colour (few of each).
  for (let i = 0; i < awningMats.length; i++) {
    const sub = [];
    awningList.forEach((m, j) => { if (awningPaint[j] === i) sub.push(m); });
    flushInstances(scene, unitBox, awningMats[i], sub, true);
  }
  for (let i = 0; i < neonMats.length; i++) {
    const stripSub = [];
    const signSub = [];
    neonStripList.forEach((m, j) => { if (neonPaint[j] === i) stripSub.push(m); });
    neonSignList.forEach((m, j) => { if (neonPaint[j] === i) signSub.push(m); });
    flushInstances(scene, unitBox, neonMats[i], stripSub);
    flushInstances(scene, unitBox, neonMats[i], signSub);
  }

  // ---- palm trees: beach ring + a few along the roads ----------------------------
  const palmSites = [];
  for (let i = 0; i < CONFIG.palms.count; i++) {
    const island = CONFIG.islands[i % 2];
    const a = rand() * Math.PI * 2;
    const r = 0.88 + rand() * 0.08;
    const x = island.cx + Math.cos(a) * island.rx * r;
    const z = island.cz + Math.sin(a) * island.rz * r;
    // Keep palms off the bridge corridor and the marina pier.
    if (Math.abs(x) < 12 && z > -70 && z < 80) continue;
    if (x > 96 && z > 120 && z < 180) continue;
    palmSites.push({ x, z });
  }

  // Segmented, gently curving trunks (4 stacked cylinders per palm), pointed
  // fronds fanning from the crown, and a cluster of coconuts — all instanced.
  const trunkSegGeo = new THREE.CylinderGeometry(0.16, 0.22, 1.25, 6);
  const trunkSegList = [];
  const coconutGeo = new THREE.SphereGeometry(0.17, 6, 5);
  const coconutList = [];
  // Pointed leaf: a leaf-shaped plane, base at the origin, tip at +Z.
  const frondShape = new THREE.Shape();
  frondShape.moveTo(0, 0);
  frondShape.quadraticCurveTo(0.55, 0.9, 0.34, 1.9);
  frondShape.quadraticCurveTo(0.22, 2.4, 0, 2.7);
  frondShape.quadraticCurveTo(-0.22, 2.4, -0.34, 1.9);
  frondShape.quadraticCurveTo(-0.55, 0.9, 0, 0);
  const frondGeo = new THREE.ShapeGeometry(frondShape, 8);
  frondGeo.rotateX(Math.PI / 2); // lie flat, base at origin, tip at +Z

  const frondList = [];

  for (const site of palmSites) {
    // Lean direction and amount: the trunk curves toward it as it rises.
    const leanAngle = rand() * Math.PI * 2;
    const leanAmt = 0.3 + rand() * 0.6;
    const leanX = Math.cos(leanAngle);
    const leanZ = Math.sin(leanAngle);
    const tilt = leanAmt * 0.14;
    for (let i = 0; i < 4; i++) {
      const f = i / 3;
      const off = leanAmt * f * f;
      pushMatrix(
        trunkSegList,
        site.x + leanX * off,
        GROUND + (i + 0.5) * 1.25,
        site.z + leanZ * off,
        tilt * leanZ, 0, -tilt * leanX,
        1, 1, 1,
      );
    }
    const crownX = site.x + leanX * leanAmt;
    const crownY = GROUND + CONFIG.palms.trunkHeight + 0.1;
    const crownZ = site.z + leanZ * leanAmt;
    // 8 drooping outer fronds + 5 upright inner fronds.
    const frondBase = rand() * Math.PI * 2;
    for (let i = 0; i < 8; i++) {
      const yaw = frondBase + (i / 8) * Math.PI * 2 + (rand() - 0.5) * 0.2;
      pushMatrix(frondList, crownX, crownY, crownZ, 0.9 + rand() * 0.35, yaw, 0, 1, 1, 1, 'YXZ');
    }
    for (let i = 0; i < 5; i++) {
      const yaw = frondBase + (i / 5) * Math.PI * 2 + 0.5 + (rand() - 0.5) * 0.3;
      pushMatrix(frondList, crownX, crownY + 0.25, crownZ, 0.35 + rand() * 0.25, yaw, 0, 0.85, 0.85, 0.85, 'YXZ');
    }
    // Coconuts tucked under the crown.
    for (let i = 0; i < 3; i++) {
      const a = rand() * Math.PI * 2;
      pushMatrix(
        coconutList,
        crownX + Math.cos(a) * 0.35,
        crownY - 0.25,
        crownZ + Math.sin(a) * 0.35,
        0, 0, 0, 1, 1, 1,
      );
    }
  }
  flushInstances(scene, trunkSegGeo, mat.palmTrunk, trunkSegList, true);
  flushInstances(scene, frondGeo, mat.frond, frondList, true);
  flushInstances(scene, coconutGeo, mat.coconut, coconutList);

  // ---- streetlights along the ring roads -----------------------------------------
  // Round-2: poles and lamp heads are instanced now — the old code made
  // two meshes per lamp (100+ draw calls for the city). Positions are
  // identical; only the draw cost drops. Poles keep casting shadows.
  const lampPoleList = [];
  const lampHeadList = [];
  for (const seg of CONFIG.roads) {
    const len = Math.hypot(seg.x2 - seg.x1, seg.z2 - seg.z1);
    const steps = Math.floor(len / CONFIG.streetlights.spacing);
    if (steps < 1) continue;
    const nx = -(seg.z2 - seg.z1) / len; // unit normal (sideways)
    const nz = (seg.x2 - seg.x1) / len;
    for (let i = 1; i <= steps; i++) {
      const t = i / (steps + 1);
      const side = i % 2 === 0 ? 1 : -1;
      const x = seg.x1 + (seg.x2 - seg.x1) * t + nx * side * CONFIG.streetlights.sideOffset;
      const z = seg.z1 + (seg.z2 - seg.z1) * t + nz * side * CONFIG.streetlights.sideOffset;
      if (!CONFIG.islands.some((is) => insideEllipse(x, z, is))) continue;

      pushMatrix(
        lampPoleList,
        x, GROUND + CONFIG.streetlights.poleHeight / 2, z,
        0, 0, 0, 1, 1, 1,
      );
      pushMatrix(
        lampHeadList,
        x - nx * side * 0.5,
        GROUND + CONFIG.streetlights.poleHeight + 0.1,
        z - nz * side * 0.5,
        0, 0, 0, 1, 1, 1,
      );
    }
  }
  flushInstances(scene, poleGeo, mat.lampPole, lampPoleList, true);
  flushInstances(scene, lampGeo, mat.lampGlow, lampHeadList);

  // ---- marina: wooden pier + detailed boats --------------------------------------
  const marina = CONFIG.marina;
  const pier = new THREE.Mesh(unitBox, mat.pier);
  pier.scale.set(2, 0.5, marina.pierLength);
  pier.position.set(marina.pierX, 0.9, marina.pierZ);
  pier.receiveShadow = true;
  scene.add(pier);

  // Boat hull: main box + a flattened 4-sided cone bow wedge + deck + rub rail.
  const bowGeo = new THREE.ConeGeometry(1.5, 2.4, 4);
  bowGeo.rotateY(Math.PI / 4);
  bowGeo.rotateX(Math.PI / 2);

  function assembleBoat(bx, bz, rotY, type, hullColor) {
    const g = new THREE.Group();
    g.position.set(bx, 0, bz);
    g.rotation.y = rotY;
    const hullMat = new THREE.MeshStandardMaterial({ color: hullColor, roughness: 0.35 });
    const deckMat = new THREE.MeshStandardMaterial({ color: '#e8e2d2', roughness: 0.7 });
    const accentMat = new THREE.MeshStandardMaterial({ color: '#2f5f8f', roughness: 0.5 });
    const add = (mesh) => { mesh.castShadow = true; g.add(mesh); return mesh; };

    const hull = add(new THREE.Mesh(unitBox, hullMat));
    hull.scale.set(3.0, 1.1, 6.5);
    hull.position.y = 0.55;

    const bow = add(new THREE.Mesh(bowGeo, hullMat));
    bow.scale.set(1, 0.5, 1);
    bow.position.set(0, 0.55, 4.15);

    const deckSlab = add(new THREE.Mesh(unitBox, deckMat));
    deckSlab.scale.set(2.8, 0.18, 6.2);
    deckSlab.position.y = 1.15;

    const rail = add(new THREE.Mesh(unitBox, accentMat));
    rail.scale.set(3.05, 0.12, 6.5);
    rail.position.y = 0.95;

    if (type === 'sail') {
      // White cabin + tall mast, boom and two triangular sails.
      const cabin = add(new THREE.Mesh(unitBox, mat.boatCabin));
      cabin.scale.set(2.2, 1.4, 3.0);
      cabin.position.set(0, 1.9, -0.6);
      for (const side of [-1, 1]) {
        const win = add(new THREE.Mesh(unitBox, mat.boatGlass));
        win.scale.set(0.08, 0.5, 1.6);
        win.position.set(side * 1.12, 2.0, -0.6);
      }
      const mast = add(new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.09, 7, 6),
        mat.boatMast,
      ));
      mast.position.set(0, 4.7, 0.3);
      const boom = add(new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, 3.2, 6),
        mat.boatMast,
      ));
      boom.rotation.x = Math.PI / 2;
      boom.position.set(0, 2.7, -1.2);
      // Mainsail: triangle aft of the mast, in the boat's centre plane.
      const mainShape = new THREE.Shape();
      mainShape.moveTo(0, 0);
      mainShape.lineTo(0, 4.4);
      mainShape.lineTo(-2.9, 0.3);
      mainShape.closePath();
      const mainSail = add(new THREE.Mesh(new THREE.ShapeGeometry(mainShape), mat.sail));
      mainSail.rotation.y = -Math.PI / 2; // triangle extends aft (-Z) of the mast
      mainSail.position.set(0, 2.8, 0.3);
      // Jib: triangle from mast top down to the bow.
      const jibShape = new THREE.Shape();
      jibShape.moveTo(0, 0);
      jibShape.lineTo(0, 4.0);
      jibShape.lineTo(3.4, 0.2);
      jibShape.closePath();
      const jib = add(new THREE.Mesh(new THREE.ShapeGeometry(jibShape), mat.sail));
      jib.rotation.y = -Math.PI / 2;
      jib.position.set(0, 2.9, 0.3);
    } else if (type === 'motor') {
      // Big flybridge cabin, slanted windshield, radar arch, outboard motor.
      const cabin = add(new THREE.Mesh(unitBox, mat.boatCabin));
      cabin.scale.set(2.4, 1.5, 3.6);
      cabin.position.set(0, 1.95, -0.5);
      for (const side of [-1, 1]) {
        const win = add(new THREE.Mesh(unitBox, mat.boatGlass));
        win.scale.set(0.08, 0.55, 2.2);
        win.position.set(side * 1.22, 2.1, -0.5);
      }
      const shield = add(new THREE.Mesh(unitBox, mat.boatGlass));
      shield.scale.set(2.2, 0.9, 0.12);
      shield.position.set(0, 2.55, 1.35);
      shield.rotation.x = -0.45;
      const archL = add(new THREE.Mesh(unitBox, mat.boatMast));
      archL.scale.set(0.12, 1.1, 0.12);
      archL.position.set(-1.0, 2.9, -2.1);
      const archR = add(new THREE.Mesh(unitBox, mat.boatMast));
      archR.scale.set(0.12, 1.1, 0.12);
      archR.position.set(1.0, 2.9, -2.1);
      const archTop = add(new THREE.Mesh(unitBox, mat.boatMast));
      archTop.scale.set(2.1, 0.12, 0.12);
      archTop.position.set(0, 3.45, -2.1);
      const motor = add(new THREE.Mesh(unitBox, mat.boatMast));
      motor.scale.set(0.8, 1.0, 0.5);
      motor.position.set(0, 0.6, -3.45);
    } else {
      // Fishing boat: small forward cabin, antenna mast, deck crates.
      const cabin = add(new THREE.Mesh(unitBox, mat.boatCabin));
      cabin.scale.set(2.0, 1.3, 2.2);
      cabin.position.set(0, 1.85, 1.2);
      for (const side of [-1, 1]) {
        const win = add(new THREE.Mesh(unitBox, mat.boatGlass));
        win.scale.set(0.08, 0.45, 1.2);
        win.position.set(side * 1.02, 1.95, 1.2);
      }
      const antenna = add(new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, 4, 6),
        mat.boatMast,
      ));
      antenna.position.set(0, 4.4, 1.2);
      const crate1 = add(new THREE.Mesh(unitBox, mat.pier));
      crate1.scale.set(1.0, 0.7, 1.0);
      crate1.position.set(-0.7, 1.6, -1.6);
      const crate2 = add(new THREE.Mesh(unitBox, mat.pier));
      crate2.scale.set(0.8, 0.6, 0.8);
      crate2.position.set(0.6, 1.55, -2.0);
      crate2.rotation.y = 0.4;
    }
    scene.add(g);
  }

  const boatPlans = [
    { type: 'sail', hull: '#f5f2ea' },
    { type: 'sail', hull: '#2f5f8f' },
    { type: 'motor', hull: '#d94f4f' },
    { type: 'fishing', hull: '#2f8f7f' },
  ];
  for (let i = 0; i < marina.boats; i++) {
    const bx = marina.pierX + 6 + (i % 2) * 9;
    const bz = marina.pierZ - 8 + Math.floor(i / 2) * 16 + (rand() - 0.5) * 2;
    const plan = boatPlans[i % boatPlans.length];
    assembleBoat(bx, bz, (rand() - 0.5) * 0.2, plan.type, plan.hull);
  }

  // ---- queries --------------------------------------------------------------------
  function isWalkable(x, z) {
    if (CONFIG.islands.some((is) => insideEllipse(x, z, is))) return true;
    // Bridge deck.
    if (Math.abs(x - bridge.x) <= bridge.width / 2 && z >= bridge.z1 && z <= bridge.z2) return true;
    return false;
  }

  function isDrivable(x, z) {
    // Bridge deck, inside the rails.
    if (Math.abs(x - bridge.x) <= bridge.width / 2 - 1 && z >= bridge.z1 && z <= bridge.z2) return true;
    for (const seg of CONFIG.roads) {
      if (segDistance(x, z, seg) <= roadHalf + 0.5) return true;
    }
    return false;
  }

  const spawnPoint = new THREE.Vector3(CONFIG.spawn.x, GROUND, CONFIG.spawn.z);
  const carSpawns = CONFIG.carSpawns.map((p) => new THREE.Vector3(p.x, GROUND, p.z));

  const mapData = {
    islands: CONFIG.islands.map((is) => ({ cx: is.cx, cz: is.cz, rx: is.rx, rz: is.rz })),
    roads: CONFIG.roads.map((s) => ({ x1: s.x1, z1: s.z1, x2: s.x2, z2: s.z2 })),
    bridge: { x1: bridge.x, z1: bridge.z1, x2: bridge.x, z2: bridge.z2 },
  };

  return { colliders, isWalkable, isDrivable, spawnPoint, carSpawns, mapData };
}
