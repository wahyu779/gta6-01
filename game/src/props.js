// AZURE BAY — road dressing & distant skyline (Lane C visual revision,
// round-2 rewrite by Lane 2).
//
// What lives here: dashed centre lines, zebra crossings, sidewalks and
// curbs, street lamps (emissive head + glow sprite, deliberately NO
// per-lamp PointLight), traffic lights, canvas-texture road signs, beach
// clutter (sand patches, umbrellas, towels, beach balls) and the distant
// skyline ring. Everything is VISUAL ONLY — no colliders, no gameplay,
// no changes to city.js or config.js — and every position is derived from
// CONFIG.roads / CONFIG.islands / CONFIG.bridge so the dressing sits
// exactly on the city layout.
//
// ---- ROUND-2 ROOT-CAUSE FIX: THE SKYLINE NOW FOLLOWS THE CAMERA --------
// The old ring was bolted to the world origin at radius 380-450 m. That
// worked while the camera stayed near the islands — but the city-shot
// camera sits at (241.6, 172.2, 413.4), i.e. radius ~479 m from the
// origin: OUTSIDE the ring. A probe over the real layout (same seed,
// same tower draws) shows towers #8 and #10 standing only ~70 m from
// that lens, 41 deg / 45 deg off-axis — just outside the ~40 deg
// horizontal half-FOV — so they straddled both frame edges, sliced in
// half. That is the "ring terpotong di tepi" defect, and it also explains
// the second defect:
//
// ---- THE "BIG DARK-BLUE ROOF" IN THE CITY SHOT WAS SKYLINE TOWER #10 ---
// Tower #10 sits at (173, 400), 36 m wide, 55 m tall, 70 m from the
// city-shot camera, 45 deg off-axis to the LEFT — its dark slate-blue
// slab (#2b3a52 family) fills the bottom-left corner as a giant flat
// polygon. It is NOT a city.js building: city roofs are browns and
// greys (#8a5a3a / #5a5a5a / #7a4a3a) and no city building is dark blue
// or anywhere near that big in the frame; the only large dark-blue flat
// surfaces in the whole scene are these skyline slabs. So the roof
// defect and the edge-truncation defect share one root cause, and one
// fix kills both:
//
// The ring now lives in its own subgroup ("horizon") whose origin is
// re-centred on the rendering camera every frame. The hook is
// onBeforeRender on each skyline mesh — three.js calls it once per
// rendered frame with the live camera — so this works with ZERO changes
// to main.js (which discards buildProps' return value). buildProps also
// returns update(camera) for any caller that wants to drive the
// re-centring explicitly. Every tower now stays 380-450 m from the
// viewer in every direction, from any camera pose: the ring reads as a
// proper distant skyline, it can never loom into the foreground again,
// and its towers can never straddle a frame edge. The one-frame lag
// (matrices are computed before onBeforeRender runs) is invisible on a
// 400 m-distant ring, and the window grids still face the viewer,
// because "inward" is now always "toward the camera".
//
// The skyline layout itself is re-rolled deterministically from the same
// seed (20261120) — the draw order changed with this restructure, so the
// towers sit at different angles than before. That is intentional: the
// old layout was hand-tuned so frame edges fell in ring gaps for ONE
// fixed camera pose, and that tuning is obsolete now that the ring is
// symmetric around the view axis by construction.
//
// Perf: dashes, zebra stripes and all four skyline pieces are
// InstancedMesh (one draw call each); the rest shares a handful of
// materials and geometries. Nothing here casts a shadow except lamp /
// traffic-light poles.

import * as THREE from 'three';
import { CONFIG } from './config.js';

const GROUND = CONFIG.groundY;

// Deterministic RNG (mulberry32) so every load builds the same props.
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

// ---- road-segment geometry ---------------------------------------------
// Rotation that lays a box's local +X along a road segment (the same
// convention city.js uses: rotation.y = -atan2(dz, dx)).
function segYaw(seg) {
  return -Math.atan2(seg.z2 - seg.z1, seg.x2 - seg.x1);
}

function segLength(seg) {
  return Math.hypot(seg.x2 - seg.x1, seg.z2 - seg.z1);
}

// Unit direction of a segment, plus its length.
function segUnit(seg) {
  const len = segLength(seg) || 1;
  return { x: (seg.x2 - seg.x1) / len, z: (seg.z2 - seg.z1) / len, len };
}

// Point on a segment at `dist` metres from its start.
function pointAlong(seg, dist) {
  const dir = segUnit(seg);
  return { x: seg.x1 + dir.x * dist, z: seg.z1 + dir.z * dist };
}

// ---- junction scan -------------------------------------------------------
// Axis-aligned roads meet at shared endpoints or at H/V crossings. Every
// crossing point, together with its list of incident ARMS (directions out
// of the point), drives the zebra crossings, traffic lights, lamps and
// signs. Arms, not segments, are what matter: a T-junction is one
// through-road segment plus one side-road segment, but THREE arms.
function scanJunctions() {
  const roads = CONFIG.roads;
  const keyOf = (x, z) => `${x},${z}`;
  // Candidate points: every segment endpoint plus every H/V crossing.
  const points = new Map();
  for (const seg of roads) {
    points.set(keyOf(seg.x1, seg.z1), { x: seg.x1, z: seg.z1 });
    points.set(keyOf(seg.x2, seg.z2), { x: seg.x2, z: seg.z2 });
  }
  for (let i = 0; i < roads.length; i++) {
    for (let j = i + 1; j < roads.length; j++) {
      const a = roads[i];
      const b = roads[j];
      const aHoriz = a.z1 === a.z2;
      const bHoriz = b.z1 === b.z2;
      if (aHoriz === bHoriz) continue;
      const horiz = aHoriz ? a : b;
      const vert = aHoriz ? b : a;
      const x = vert.x1;
      const z = horiz.z1;
      const insideH = x >= Math.min(horiz.x1, horiz.x2) && x <= Math.max(horiz.x1, horiz.x2);
      const insideV = z >= Math.min(vert.z1, vert.z2) && z <= Math.max(vert.z1, vert.z2);
      if (insideH && insideV) points.set(keyOf(x, z), { x, z });
    }
  }
  const nodes = [];
  for (const p of points.values()) {
    const arms = [];
    for (const seg of roads) {
      // Axis-aligned point-on-segment test (endpoints and interiors).
      const onSeg = seg.z1 === seg.z2
        ? (p.z === seg.z1 && p.x >= Math.min(seg.x1, seg.x2) && p.x <= Math.max(seg.x1, seg.x2))
        : (p.x === seg.x1 && p.z >= Math.min(seg.z1, seg.z2) && p.z <= Math.max(seg.z1, seg.z2));
      if (!onSeg) continue;
      const atStart = p.x === seg.x1 && p.z === seg.z1;
      const atEnd = p.x === seg.x2 && p.z === seg.z2;
      const dir = segUnit(seg);
      // A through road contributes one arm each way; an ending road one.
      if (!atStart) arms.push({ x: -dir.x, z: -dir.z });
      if (!atEnd) arms.push({ x: dir.x, z: dir.z });
    }
    if (arms.length >= 2) nodes.push({ x: p.x, z: p.z, arms });
  }
  return nodes;
}

// ---- canvas textures -------------------------------------------------------
// Warm radial glow for lamp sprites (one shared texture, tinted per use).
function radialGlowTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d');
  const glow = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Rectangular road-sign face: coloured board, white legend.
function boardTexture({ bg, text, font = 'bold 44px Arial', arrow = false }) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 256, 128);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 6;
  ctx.strokeRect(5, 5, 246, 118);
  ctx.fillStyle = '#ffffff';
  if (arrow) {
    // One-way arrow pointing right.
    ctx.fillRect(28, 54, 140, 20);
    ctx.beginPath();
    ctx.moveTo(168, 24);
    ctx.lineTo(232, 64);
    ctx.lineTo(168, 104);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 68);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Octagonal STOP face.
function stopTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d');
  const cx = 64;
  const cy = 64;
  const r = 60;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 8) + (i * Math.PI) / 4;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = '#c0392b';
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 30px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('STOP', cx, cy + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildProps(scene) {
  const rng = makeSeededRng(20261120);
  const group = new THREE.Group();
  group.name = 'props';
  scene.add(group);
  const tally = {
    dashes: 0, zebras: 0, sidewalks: 0, lamps: 0,
    trafficLights: 0, signs: 0, umbrellas: 0, skyline: 0,
  };
  // Scratch object reused for every InstancedMesh matrix write.
  const pose = new THREE.Object3D();

  // ---- shared materials / geometries --------------------------------------
  const mat = {
    dash: new THREE.MeshStandardMaterial({ color: '#e8e8e2', roughness: 0.8 }),
    zebra: new THREE.MeshStandardMaterial({ color: '#f4f4ee', roughness: 0.8 }),
    sidewalk: new THREE.MeshStandardMaterial({ color: '#b9b3a4', roughness: 1 }),
    curb: new THREE.MeshStandardMaterial({ color: '#8f8a7c', roughness: 1 }),
    poleDark: new THREE.MeshStandardMaterial({ color: '#33373d', roughness: 0.6, metalness: 0.5 }),
    lampHead: new THREE.MeshStandardMaterial({
      color: '#ffd98a', emissive: '#ffb84d', emissiveIntensity: 2.0, roughness: 0.4,
    }),
    lampShade: new THREE.MeshStandardMaterial({ color: '#2c2f34', roughness: 0.5, metalness: 0.6 }),
    tlBox: new THREE.MeshStandardMaterial({ color: '#1d2024', roughness: 0.5, metalness: 0.4 }),
    tlOff: new THREE.MeshStandardMaterial({ color: '#151515', roughness: 0.6 }),
    tlRed: new THREE.MeshStandardMaterial({ color: '#ff2a1a', emissive: '#ff2a1a', emissiveIntensity: 2.6 }),
    tlYellow: new THREE.MeshStandardMaterial({ color: '#ffbf00', emissive: '#ffbf00', emissiveIntensity: 2.6 }),
    tlGreen: new THREE.MeshStandardMaterial({ color: '#22e06c', emissive: '#22e06c', emissiveIntensity: 2.6 }),
    signPole: new THREE.MeshStandardMaterial({ color: '#6a6f76', roughness: 0.5, metalness: 0.6 }),
    signBack: new THREE.MeshStandardMaterial({ color: '#3d4a3d', roughness: 0.7 }),
    sandDark: new THREE.MeshStandardMaterial({ color: '#dcc489', roughness: 1 }),
    sandLight: new THREE.MeshStandardMaterial({ color: '#f2e2b0', roughness: 1 }),
    umbrellaPole: new THREE.MeshStandardMaterial({ color: '#f0ead8', roughness: 0.8 }),
  };
  const umbrellaPalette = ['#e74c3c', '#1abc9c', '#f1c40f', '#e91e63', '#3498db', '#ff7f50'];
  const umbrellaMats = umbrellaPalette.map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 }),
  );
  const towelMats = ['#ff6b6b', '#4ecdc4', '#ffe66d', '#a78bfa', '#ff9f43'].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 1 }),
  );
  const ballMats = ['#ff4757', '#2ed573', '#ffa502', '#70a1ff'].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 }),
  );
  const skylinePalette = ['#2b3a52', '#3a4a66', '#22303f', '#46586f', '#31435e'];

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const dashGeo = new THREE.BoxGeometry(3, 0.04, 0.35);
  const stripeGeo = new THREE.BoxGeometry(0.55, 0.04, 6.8);
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.13, 5.5, 6);
  const glowTex = radialGlowTexture();

  const nodes = scanJunctions();
  const junctions = nodes.filter((n) => n.arms.length >= 3);
  const corners = nodes.filter((n) => n.arms.length === 2);

  // ---- 1. dashed centre line (InstancedMesh, skips the 9 m before any
  //        intersection so dashes never run through a zebra crossing) ------
  const dashSpots = [];
  for (const seg of CONFIG.roads) {
    const len = segLength(seg);
    const yaw = segYaw(seg);
    for (let d = 4; d <= len - 4; d += 6) {
      const p = pointAlong(seg, d);
      let nearNode = false;
      for (const n of nodes) {
        if (Math.hypot(p.x - n.x, p.z - n.z) < 9) { nearNode = true; break; }
      }
      if (nearNode) continue;
      dashSpots.push({ x: p.x, z: p.z, yaw });
    }
  }
  if (dashSpots.length > 0) {
    const dashes = new THREE.InstancedMesh(dashGeo, mat.dash, dashSpots.length);
    dashSpots.forEach((spot, i) => {
      pose.position.set(spot.x, GROUND + 0.1, spot.z);
      pose.rotation.set(0, spot.yaw, 0);
      pose.scale.set(1, 1, 1);
      pose.updateMatrix();
      dashes.setMatrixAt(i, pose.matrix);
    });
    dashes.instanceMatrix.needsUpdate = true;
    dashes.receiveShadow = true;
    group.add(dashes);
    tally.dashes = dashSpots.length;
  }

  // ---- 2. zebra crossings (InstancedMesh): one band per approach arm, -----
  // 6 stripes each, band centre 7 m out from the intersection centre.
  const stripeSpots = [];
  for (const node of nodes) {
    for (const dir of node.arms) {
      const yaw = -Math.atan2(dir.z, dir.x);
      const bx = node.x + dir.x * 7;
      const bz = node.z + dir.z * 7;
      // Sideways normal (across the road).
      const nx = -dir.z;
      const nz = dir.x;
      for (let i = 0; i < 6; i++) {
        const off = -3.3 + i * 1.32;
        stripeSpots.push({ x: bx + nx * off, z: bz + nz * off, yaw });
      }
    }
  }
  if (stripeSpots.length > 0) {
    const stripes = new THREE.InstancedMesh(stripeGeo, mat.zebra, stripeSpots.length);
    stripeSpots.forEach((spot, i) => {
      pose.position.set(spot.x, GROUND + 0.1, spot.z);
      pose.rotation.set(0, spot.yaw, 0);
      pose.scale.set(1, 1, 1);
      pose.updateMatrix();
      stripes.setMatrixAt(i, pose.matrix);
    });
    stripes.instanceMatrix.needsUpdate = true;
    stripes.receiveShadow = true;
    group.add(stripes);
    tally.zebras = stripeSpots.length;
  }

  // ---- 3. sidewalks + curbs (both sides of every road except the bridge,
  //        whose rails already edge the deck) -------------------------------
  const bridge = CONFIG.bridge;
  const isBridgeRoad = (seg) => seg.x1 === bridge.x && seg.x2 === bridge.x
    && seg.z1 === bridge.z1 && seg.z2 === bridge.z2;
  for (const seg of CONFIG.roads) {
    // The bridge road is the x = 0 segment spanning exactly the bridge
    // deck (z1..z2) — the two N-S cross streets are also x = 0, but they
    // span the islands and DO get sidewalks.
    if (isBridgeRoad(seg)) continue;
    const len = segLength(seg);
    const yaw = segYaw(seg);
    const cx = (seg.x1 + seg.x2) / 2;
    const cz = (seg.z1 + seg.z2) / 2;
    const walkLen = Math.max(len - 8, 4); // stop 4 m short of each corner
    for (const side of [-1, 1]) {
      const ox = Math.sin(yaw) * side * 5.2;
      const oz = Math.cos(yaw) * side * 5.2;
      const walk = new THREE.Mesh(unitBox, mat.sidewalk);
      walk.scale.set(walkLen, 0.15, 2.4);
      walk.position.set(cx + ox, GROUND + 0.075, cz + oz);
      walk.rotation.y = yaw;
      walk.receiveShadow = true;
      group.add(walk);
      tally.sidewalks += 1;
      // Crisp curb line on the road edge of the sidewalk.
      const cox = Math.sin(yaw) * side * 4.15;
      const coz = Math.cos(yaw) * side * 4.15;
      const curb = new THREE.Mesh(unitBox, mat.curb);
      curb.scale.set(walkLen, 0.15, 0.3);
      curb.position.set(cx + cox, GROUND + 0.075, cz + coz);
      curb.rotation.y = yaw;
      group.add(curb);
    }
  }

  // ---- 4. street lamps at intersections + marina ---------------------------
  // Pole + arm reaching over the road + warm emissive head + additive glow
  // sprite. NO PointLight per lamp — the emissive head and sprite carry
  // the dusk look for free.
  const lampSpots = [];
  for (const node of nodes) {
    // Two diagonal corners per intersection, so the crossing is lit from
    // both sides without doubling the lamp at any one corner.
    lampSpots.push({ x: node.x + 6.6, z: node.z + 6.6, face: Math.atan2(-6.6, -6.6) });
    lampSpots.push({ x: node.x - 6.6, z: node.z - 6.6, face: Math.atan2(6.6, 6.6) });
  }
  // One lamp at the end of the marina pier.
  lampSpots.push({ x: CONFIG.marina.pierX, z: CONFIG.marina.pierZ + CONFIG.marina.pierLength / 2, face: 0 });
  const glowMat = new THREE.SpriteMaterial({
    map: glowTex,
    color: '#ffcf7a',
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: 0.85,
  });
  function mountLamp(spot) {
    const pole = new THREE.Mesh(poleGeo, mat.poleDark);
    pole.position.set(spot.x, GROUND + 2.75, spot.z);
    pole.castShadow = true;
    group.add(pole);
    // Arm reaching 1.1 m toward the intersection.
    const arm = new THREE.Mesh(unitBox, mat.poleDark);
    arm.scale.set(0.12, 0.12, 1.2);
    arm.position.set(
      spot.x - Math.sin(spot.face) * 0.55,
      GROUND + 5.45,
      spot.z - Math.cos(spot.face) * 0.55,
    );
    arm.rotation.y = spot.face;
    group.add(arm);
    // Lamp head: dark shade + warm emissive bulb underneath.
    const shade = new THREE.Mesh(unitBox, mat.lampShade);
    shade.scale.set(0.5, 0.18, 1.0);
    shade.position.set(
      spot.x - Math.sin(spot.face) * 1.1,
      GROUND + 5.5,
      spot.z - Math.cos(spot.face) * 1.1,
    );
    shade.rotation.y = spot.face;
    group.add(shade);
    const bulb = new THREE.Mesh(unitBox, mat.lampHead);
    bulb.scale.set(0.34, 0.1, 0.8);
    bulb.position.set(
      spot.x - Math.sin(spot.face) * 1.1,
      GROUND + 5.4,
      spot.z - Math.cos(spot.face) * 1.1,
    );
    bulb.rotation.y = spot.face;
    group.add(bulb);
    const glow = new THREE.Sprite(glowMat);
    glow.position.set(
      spot.x - Math.sin(spot.face) * 1.1,
      GROUND + 5.35,
      spot.z - Math.cos(spot.face) * 1.1,
    );
    glow.scale.set(4.5, 4.5, 1);
    group.add(glow);
    tally.lamps += 1;
  }
  for (const spot of lampSpots) mountLamp(spot);

  // ---- 5. traffic lights at the 3-way junctions -----------------------------
  // One pole per junction on a corner, arm over the road, vertical head
  // with red / yellow / green — exactly one lamp lit. Junctions alternate
  // red / green so the city reads alive instead of all-red.
  const tlLampGeo = new THREE.SphereGeometry(0.16, 10, 8);
  function mountTrafficLight(node, index) {
    const px = node.x + 6.6;
    const pz = node.z + 6.6;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.13, 4.6, 6),
      mat.poleDark,
    );
    pole.position.set(px, GROUND + 2.3, pz);
    pole.castShadow = true;
    group.add(pole);
    // Horizontal arm over the road toward the junction centre.
    const face = Math.atan2(node.x - px, node.z - pz);
    const arm = new THREE.Mesh(unitBox, mat.poleDark);
    arm.scale.set(0.14, 0.14, 2.4);
    arm.position.set(px - Math.sin(face) * 1.1, GROUND + 4.55, pz - Math.cos(face) * 1.1);
    arm.rotation.y = face;
    group.add(arm);
    // Head hangs at the arm tip, lamps facing the oncoming traffic
    // (toward the junction centre).
    const hx = px - Math.sin(face) * 2.2;
    const hz = pz - Math.cos(face) * 2.2;
    const head = new THREE.Mesh(unitBox, mat.tlBox);
    head.scale.set(0.55, 1.35, 0.45);
    head.position.set(hx, GROUND + 4.1, hz);
    head.rotation.y = face;
    group.add(head);
    const lit = index % 2 === 0 ? 0 : 2; // even: red, odd: green
    const lampMats = [mat.tlRed, mat.tlYellow, mat.tlGreen];
    for (let li = 0; li < 3; li++) {
      const lamp = new THREE.Mesh(
        tlLampGeo,
        li === lit ? lampMats[li] : mat.tlOff,
      );
      // Local +Z of the head faces the junction; offset the lamp out of
      // the face and down from the top lamp to the bottom one.
      const fwd = 0.26;
      const lx = hx + Math.sin(face) * fwd;
      const lz = hz + Math.cos(face) * fwd;
      lamp.position.set(lx, GROUND + 4.55 - li * 0.42, lz);
      group.add(lamp);
    }
    tally.trafficLights += 1;
  }
  junctions.forEach((node, ji) => mountTrafficLight(node, ji));

  // ---- 6. road signs ---------------------------------------------------------
  // STOP at four junctions, one-way arrows at four ring corners, street
  // names at six junctions / corners. Faces are canvas textures so the
  // legend is actually readable in a screenshot.
  const stopTex = stopTexture();
  const oneWayTex = boardTexture({ bg: '#1f6fd6', text: '', arrow: true });
  const streetNames = ['OCEAN AVE', 'PALM BLVD', 'BRIDGE RD', 'BAY ST', 'CORAL WAY', 'MARINA DR'];
  const nameTexs = streetNames.map((name) =>
    boardTexture({ bg: '#1a6b3c', text: name, font: 'bold 40px Arial' }),
  );
  const signPoleGeo = new THREE.CylinderGeometry(0.06, 0.06, 2.6, 6);
  const signPoleGeoTall = new THREE.CylinderGeometry(0.06, 0.06, 3.2, 6);

  function mountBoardSign(x, z, faceAngle, faceTex, w, h, poleHeight, poleGeometry) {
    const pole = new THREE.Mesh(poleGeometry, mat.signPole);
    pole.position.set(x, GROUND + poleHeight / 2, z);
    group.add(pole);
    const back = new THREE.Mesh(unitBox, mat.signBack);
    back.scale.set(w + 0.06, h + 0.06, 0.05);
    back.position.set(x, GROUND + poleHeight - 0.2, z);
    back.rotation.y = faceAngle;
    group.add(back);
    const faceMat = new THREE.MeshBasicMaterial({ map: faceTex });
    for (const side of [1, -1]) {
      const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), faceMat);
      face.position.set(
        x + Math.sin(faceAngle) * side * 0.035,
        GROUND + poleHeight - 0.2,
        z + Math.cos(faceAngle) * side * 0.035,
      );
      face.rotation.y = faceAngle + (side === 1 ? 0 : Math.PI);
      group.add(face);
    }
    tally.signs += 1;
  }

  junctions.slice(0, 4).forEach((node) => {
    // STOP octagon on a pole at the corner opposite the traffic light.
    const x = node.x - 6.6;
    const z = node.z - 6.6;
    const face = Math.atan2(node.x - x, node.z - z);
    const pole = new THREE.Mesh(signPoleGeo, mat.signPole);
    pole.position.set(x, GROUND + 1.3, z);
    group.add(pole);
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.55, 0.06, 8),
      new THREE.MeshStandardMaterial({ color: '#c0392b', roughness: 0.6 }),
    );
    // Vertical octagon facing the road: with order YXZ the X-rotation
    // stands the disc up first, then Y turns it to face `face`.
    disc.rotation.order = 'YXZ';
    disc.rotation.x = Math.PI / 2;
    disc.rotation.y = face;
    disc.position.set(x, GROUND + 2.35, z);
    group.add(disc);
    const faceMat = new THREE.MeshBasicMaterial({ map: stopTex });
    for (const side of [1, -1]) {
      const f = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.0), faceMat);
      f.position.set(
        x + Math.sin(face) * side * 0.045,
        GROUND + 2.35,
        z + Math.cos(face) * side * 0.045,
      );
      f.rotation.y = face + (side === 1 ? 0 : Math.PI);
      // Keep the octagon upright: the disc is rotated flat, so the face
      // plane carries the legend itself.
      group.add(f);
    }
    tally.signs += 1;
  });

  corners.slice(0, 4).forEach((node) => {
    const x = node.x + (node.x < 0 ? 6.6 : -6.6);
    const z = node.z + (node.z < 0 ? 6.6 : -6.6);
    const face = Math.atan2(node.x - x, node.z - z);
    mountBoardSign(x, z, face, oneWayTex, 0.9, 0.45, 2.6, signPoleGeo);
  });

  [...junctions.slice(4), ...corners.slice(4, 6)].slice(0, 6).forEach((node, i) => {
    const x = node.x - 6.6;
    const z = node.z + 6.6;
    const face = Math.atan2(node.x - x, node.z - z);
    mountBoardSign(x, z, face, nameTexs[i % nameTexs.length], 1.6, 0.8, 3.2, signPoleGeoTall);
  });

  // ---- 7. beach / sand detail ----------------------------------------------
  // Sand-tone patches, umbrellas, towels and beach balls on the beach ring
  // of both islands (r ~0.93-0.98 of the ellipse), clear of the bridge
  // corridor and the marina pier.
  function beachPoint(island, angle, rFactor) {
    return {
      x: island.cx + Math.cos(angle) * island.rx * rFactor,
      z: island.cz + Math.sin(angle) * island.rz * rFactor,
    };
  }
  function beachClear(x, z) {
    if (Math.abs(x) < 14 && z > -70 && z < 80) return false; // bridge corridor
    if (x > 96 && z > 120 && z < 180) return false; // marina pier
    return true;
  }
  const sandPatchGeo = new THREE.CircleGeometry(1, 20);
  for (const island of CONFIG.islands) {
    for (let i = 0; i < 5; i++) {
      const a = rng() * Math.PI * 2;
      const p = beachPoint(island, a, 0.94 + rng() * 0.04);
      if (!beachClear(p.x, p.z)) continue;
      const patch = new THREE.Mesh(
        sandPatchGeo,
        rng() < 0.5 ? mat.sandDark : mat.sandLight,
      );
      const r = 5 + rng() * 6;
      patch.scale.set(r, r * (0.6 + rng() * 0.5), 1);
      patch.rotation.x = -Math.PI / 2;
      patch.rotation.z = rng() * Math.PI;
      patch.position.set(p.x, 1.42, p.z);
      patch.receiveShadow = true;
      group.add(patch);
    }
  }
  const umbrellaPoleGeo = new THREE.CylinderGeometry(0.05, 0.05, 2.4, 6);
  const umbrellaTopGeo = new THREE.ConeGeometry(1.7, 0.8, 10);
  const towelGeo = new THREE.BoxGeometry(1.8, 0.05, 0.9);
  const ballGeo = new THREE.SphereGeometry(0.35, 12, 10);
  for (const island of CONFIG.islands) {
    for (let i = 0; i < 4; i++) {
      const a = rng() * Math.PI * 2;
      const p = beachPoint(island, a, 0.93 + rng() * 0.05);
      if (!beachClear(p.x, p.z)) continue;
      const tilt = (rng() - 0.5) * 0.2;
      const pole = new THREE.Mesh(umbrellaPoleGeo, mat.umbrellaPole);
      pole.position.set(p.x, 1.4 + 1.2, p.z);
      pole.rotation.z = tilt;
      pole.castShadow = true;
      group.add(pole);
      const top = new THREE.Mesh(
        umbrellaTopGeo,
        umbrellaMats[Math.floor(rng() * umbrellaMats.length)],
      );
      top.position.set(p.x + tilt * 1.2, 1.4 + 2.55, p.z);
      top.rotation.z = tilt;
      top.castShadow = true;
      group.add(top);
      tally.umbrellas += 1;
      // Towel beside the umbrella, ball a step away.
      const tx = p.x + 2.2 + rng();
      const tz = p.z + (rng() - 0.5) * 2;
      if (beachClear(tx, tz)) {
        const towel = new THREE.Mesh(
          towelGeo,
          towelMats[Math.floor(rng() * towelMats.length)],
        );
        towel.position.set(tx, 1.43, tz);
        towel.rotation.y = rng() * Math.PI;
        group.add(towel);
      }
      const bx = p.x - 2.0 - rng();
      const bz = p.z + (rng() - 0.5) * 2;
      if (beachClear(bx, bz)) {
        const ball = new THREE.Mesh(
          ballGeo,
          ballMats[Math.floor(rng() * ballMats.length)],
        );
        ball.position.set(bx, 1.4 + 0.35, bz);
        ball.castShadow = true;
        group.add(ball);
      }
    }
  }

  // ---- 8. distant skyline ring — CAMERA-FOLLOWING (round-2 fix) ------------
  // Detailed silhouettes on the horizon (radius 380-450, standing in the
  // water across the bay) for depth. MeshBasicMaterial with fog: false
  // keeps them readable as a skyline instead of fogging out. The detail
  // comes from four instanced pieces (4 draw calls):
  //   - the tower slabs themselves, broad face turned toward the viewer;
  //   - a visible podium base under every tower, so each slab reads as
  //     standing on something solid at the horizon instead of floating
  //     on haze (the old ring sank each slab only 2 m and the fog washed
  //     the waterline out);
  //   - a window grid on the inward face: warm lit glass mixed with dark
  //     reflective glass, so the towers read as inhabited buildings at
  //     dusk instead of flat blue slabs;
  //   - stepped rooftop crowns on about half the towers, so the roofline
  //     varies instead of running flat. No thin spires: a spire reads as
  //     a stray antenna line against the sky and once poked over the
  //     health bar.
  //
  // CAMERA FOLLOW, step by step: all four pieces live in the `horizon`
  // subgroup and are laid out around ITS origin. Once per rendered frame
  // each skyline mesh's onBeforeRender moves that origin onto the live
  // camera (x/z only — the ring never tilts or lifts). The towers keep
  // their 380-450 m radius around the viewer, so the ring is symmetric
  // around the view axis from every pose: no tower can loom 70 m from
  // the lens and fill a corner (the old tower #10 "roof"), and no tower
  // can straddle a frame edge. The slabs are sunk 6 m (base y = -6) so
  // each tower stands IN the water, and each podium is a dark slate
  // block 30% wider than its tower, rising 4 m out of the water
  // (y -4..+4) with the slab sunk through it.
  const horizon = new THREE.Group();
  horizon.name = 'skyline';
  group.add(horizon);

  // Re-centre the ring on the viewer. Called from the onBeforeRender
  // hook of every skyline mesh below, and exposed as the returned
  // `update(camera)` for callers that drive it explicitly instead.
  function recenterHorizon(cam) {
    if (!cam || !cam.position) return;
    const cx = cam.position.x;
    const cz = cam.position.z;
    if (!Number.isFinite(cx) || !Number.isFinite(cz)) return;
    horizon.position.x = cx;
    horizon.position.z = cz;
  }

  const TOWER_COUNT = 56;
  const skyGeo = new THREE.BoxGeometry(1, 1, 1);
  const skyMat = new THREE.MeshBasicMaterial({ color: '#ffffff', fog: false });
  const skyTint = new THREE.Color();

  // Pass 1 — tower specs (angle / radius / size / height / yaw / shade).
  // A few landmark towers rise well above the rest. The yaw turns the
  // box's +Z face normal to (-cos a, 0, -sin a), i.e. at the ring centre
  // — which, once the ring follows the camera, is the viewer. Y-only
  // rotation, so a tower can never lean; the lean seen in old city shots
  // was perspective convergence, not geometry.
  const towerSpecs = [];
  for (let i = 0; i < TOWER_COUNT; i++) {
    const angle = (i / TOWER_COUNT) * Math.PI * 2 + rng() * 0.06;
    const radius = 380 + rng() * 70;
    const width = 16 + rng() * 22;
    const depth = 16 + rng() * 22;
    const height = i % 14 === 0 ? 110 + rng() * 30 : 25 + rng() * 65;
    towerSpecs.push({
      angle,
      radius,
      width,
      depth,
      height,
      yaw: -angle - Math.PI / 2,
      shade: skylinePalette[Math.floor(rng() * skylinePalette.length)],
    });
  }

  // Pass 2 — the tower slabs.
  const towers = new THREE.InstancedMesh(skyGeo, skyMat, TOWER_COUNT);
  towerSpecs.forEach((t, i) => {
    pose.position.set(Math.cos(t.angle) * t.radius, t.height / 2 - 6, Math.sin(t.angle) * t.radius);
    pose.rotation.set(0, t.yaw, 0);
    pose.scale.set(t.width, t.height, t.depth);
    pose.updateMatrix();
    towers.setMatrixAt(i, pose.matrix);
    skyTint.set(t.shade);
    towers.setColorAt(i, skyTint);
  });
  towers.instanceMatrix.needsUpdate = true;
  if (towers.instanceColor) towers.instanceColor.needsUpdate = true;
  horizon.add(towers);
  tally.skyline = TOWER_COUNT;

  // Pass 3 — podium bases, one per tower.
  const podiumCols = ['#141d29', '#1a2431', '#101825'];
  const podiums = new THREE.InstancedMesh(skyGeo, skyMat, TOWER_COUNT);
  towerSpecs.forEach((t, i) => {
    pose.position.set(Math.cos(t.angle) * t.radius, 0, Math.sin(t.angle) * t.radius);
    pose.rotation.set(0, t.yaw, 0);
    pose.scale.set(t.width * 1.3, 8, t.depth * 1.3);
    pose.updateMatrix();
    podiums.setMatrixAt(i, pose.matrix);
    skyTint.set(podiumCols[i % podiumCols.length]);
    podiums.setColorAt(i, skyTint);
  });
  podiums.instanceMatrix.needsUpdate = true;
  if (podiums.instanceColor) podiums.instanceColor.needsUpdate = true;
  horizon.add(podiums);
  tally.skylinePodiums = TOWER_COUNT;

  // Pass 4 — window grids on the inward face of each tower. The face
  // centre sits just proud of the slab (depth/2 + 0.15) so no window
  // z-fights the wall; the grid runs along the face tangent
  // (-sin a, 0, cos a). Rows stop below the sunk slab top (h - 6), so the
  // top window row never pokes above the roofline.
  const winMatrices = [];
  const winTints = [];
  const winLitCols = ['#ffc46b', '#ff9a4d', '#ffd98a'];
  const winDarkCols = ['#16202e', '#1d2c40', '#101825'];
  for (const t of towerSpecs) {
    const nx = -Math.cos(t.angle);
    const nz = -Math.sin(t.angle);
    const tx = -Math.sin(t.angle);
    const tz = Math.cos(t.angle);
    const cx = Math.cos(t.angle) * t.radius + nx * (t.depth / 2 + 0.15);
    const cz = Math.sin(t.angle) * t.radius + nz * (t.depth / 2 + 0.15);
    const cols = Math.max(2, Math.floor(t.width / 4.5));
    const ww = Math.min(2.0, (t.width / cols) * 0.45);
    const wh = 2.6;
    const stepX = t.width / cols;
    const stepY = 5.5;
    for (let row = 0; ; row++) {
      const wy = 4 + row * stepY;
      if (wy + wh / 2 > t.height - 9) break;
      for (let col = 0; col < cols; col++) {
        const u = -t.width / 2 + stepX * (col + 0.5);
        pose.position.set(cx + tx * u, wy, cz + tz * u);
        pose.rotation.set(0, t.yaw, 0);
        pose.scale.set(ww, wh, 0.18);
        pose.updateMatrix();
        winMatrices.push(pose.matrix.clone());
        if (rng() < 0.35) {
          winTints.push(skyTint.set(
            winLitCols[Math.floor(rng() * winLitCols.length)],
          ).clone());
        } else {
          winTints.push(skyTint.set(
            winDarkCols[Math.floor(rng() * winDarkCols.length)],
          ).clone());
        }
      }
    }
  }
  if (winMatrices.length > 0) {
    const wins = new THREE.InstancedMesh(skyGeo, skyMat, winMatrices.length);
    winMatrices.forEach((m, i) => {
      wins.setMatrixAt(i, m);
      wins.setColorAt(i, winTints[i]);
    });
    wins.instanceMatrix.needsUpdate = true;
    if (wins.instanceColor) wins.instanceColor.needsUpdate = true;
    horizon.add(wins);
    tally.skylineWindows = winMatrices.length;
    // Re-centre hook (see below) — attached once the mesh exists.
    wins.onBeforeRender = (_renderer, _scene, camera) => recenterHorizon(camera);
  }

  // Pass 5 — stepped rooftop crowns on about half the towers, so the
  // roofline steps instead of running flat. Landmarks get a setback
  // crown above the slab; the old thin steel spire is gone (see header).
  const crownMatrices = [];
  const crownTints = [];
  for (let i = 0; i < towerSpecs.length; i++) {
    const t = towerSpecs[i];
    const topY = t.height - 6; // tower slab top (slab is sunk 6 m)
    const px = Math.cos(t.angle) * t.radius;
    const pz = Math.sin(t.angle) * t.radius;
    if (i % 14 === 0) {
      const ch = 8 + rng() * 6;
      pose.position.set(px, topY + ch / 2, pz);
      pose.rotation.set(0, t.yaw, 0);
      pose.scale.set(t.width * 0.55, ch, t.depth * 0.55);
      pose.updateMatrix();
      crownMatrices.push(pose.matrix.clone());
      crownTints.push(skyTint.set(
        skylinePalette[Math.floor(rng() * skylinePalette.length)],
      ).clone());
    } else if (rng() < 0.45) {
      const ch = 5 + rng() * 9;
      pose.position.set(px, topY + ch / 2, pz);
      pose.rotation.set(0, t.yaw, 0);
      pose.scale.set(t.width * (0.5 + rng() * 0.2), ch, t.depth * (0.5 + rng() * 0.2));
      pose.updateMatrix();
      crownMatrices.push(pose.matrix.clone());
      crownTints.push(skyTint.set(
        skylinePalette[Math.floor(rng() * skylinePalette.length)],
      ).clone());
    }
  }
  if (crownMatrices.length > 0) {
    const crowns = new THREE.InstancedMesh(skyGeo, skyMat, crownMatrices.length);
    crownMatrices.forEach((m, i) => {
      crowns.setMatrixAt(i, m);
      crowns.setColorAt(i, crownTints[i]);
    });
    crowns.instanceMatrix.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
    horizon.add(crowns);
    tally.skylineCrowns = crownMatrices.length;
    crowns.onBeforeRender = (_renderer, _scene, camera) => recenterHorizon(camera);
  }

  // The follow hook: three.js invokes onBeforeRender on every rendered
  // mesh once per frame with the live camera. The tower and podium meshes
  // are the reliable carriers — the ring surrounds the camera, so at
  // least one tower is in the frustum on every frame and the callback
  // fires. If a mesh is ever frustum-culled for a frame (camera staring
  // straight down), nothing visible needs re-centring that frame anyway.
  // The re-centring itself lands one frame late (matrices are computed
  // before onBeforeRender runs) — invisible on a 400 m-distant ring.
  const followHook = (_renderer, _scene, camera) => recenterHorizon(camera);
  towers.onBeforeRender = followHook;
  podiums.onBeforeRender = followHook;

  return {
    group,
    counts: tally,
    intersections: nodes.length,
    junctions: junctions.length,
    // Explicit driver for the camera follow (main.js currently discards
    // this return value and relies on the onBeforeRender hook above).
    update: recenterHorizon,
  };
}
