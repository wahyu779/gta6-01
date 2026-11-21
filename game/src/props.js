// AZURE BAY — Lane C visual revision: roads & props.
// Adds lane markings, zebra crossings, sidewalks + curbs, street lamps
// (emissive + glow sprite, NO per-lamp PointLight), traffic lights, road
// signs, beach detail and a distant skyline ring — all VISUAL ONLY, no
// gameplay, no colliders, no changes to city.js / config.js.
// Every position is derived from CONFIG.roads / CONFIG.islands /
// CONFIG.bridge so the props sit exactly on the city layout.
//
// Perf: dashes, zebra stripes and the skyline are InstancedMesh (one draw
// call each); all other props share a handful of materials/geometries.
// Nothing here casts a shadow except lamp / traffic-light poles.

import * as THREE from 'three';
import { CONFIG } from './config.js';

const GROUND = CONFIG.groundY;

// Small deterministic RNG (mulberry32) so every load builds the same props.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Rotation that lays a box's local +X along a road segment (same
// convention as city.js: rotation.y = -atan2(dz, dx)).
function segAngle(s) {
  return -Math.atan2(s.z2 - s.z1, s.x2 - s.x1);
}

function segLen(s) {
  return Math.hypot(s.x2 - s.x1, s.z2 - s.z1);
}

// Unit direction of a segment, and its unit sideways normal.
function segDir(s) {
  const len = segLen(s);
  return { x: (s.x2 - s.x1) / len, z: (s.z2 - s.z1) / len, len };
}

// Point on a segment at distance d from its start.
function pointAt(s, d) {
  const dir = segDir(s);
  return { x: s.x1 + dir.x * d, z: s.z1 + dir.z * d, dir };
}

// ---- intersections -------------------------------------------------------
// Axis-aligned roads meet at shared endpoints or at H/V crossings. Every
// crossing point, with the list of incident ARMS (directions out of the
// point), drives the zebra crossings, traffic lights, lamps and signs.
// Arms, not segments, are what matter: a T-junction is one through-road
// segment plus one side-road segment, but THREE arms.
function findIntersections() {
  const roads = CONFIG.roads;
  const key = (x, z) => `${x},${z}`;
  // Candidate points: every segment endpoint plus every H/V crossing.
  const points = new Map();
  for (const s of roads) {
    points.set(key(s.x1, s.z1), { x: s.x1, z: s.z1 });
    points.set(key(s.x2, s.z2), { x: s.x2, z: s.z2 });
  }
  for (let i = 0; i < roads.length; i++) {
    for (let j = i + 1; j < roads.length; j++) {
      const a = roads[i];
      const b = roads[j];
      const aH = a.z1 === a.z2;
      const bH = b.z1 === b.z2;
      if (aH === bH) continue;
      const h = aH ? a : b;
      const v = aH ? b : a;
      const x = v.x1;
      const z = h.z1;
      const inH = x >= Math.min(h.x1, h.x2) && x <= Math.max(h.x1, h.x2);
      const inV = z >= Math.min(v.z1, v.z2) && z <= Math.max(v.z1, v.z2);
      if (inH && inV) points.set(key(x, z), { x, z });
    }
  }
  const nodes = [];
  for (const p of points.values()) {
    const arms = [];
    const segs = [];
    for (const s of roads) {
      // Axis-aligned point-on-segment test (endpoints and interiors).
      const onSeg = s.z1 === s.z2
        ? (p.z === s.z1 && p.x >= Math.min(s.x1, s.x2) && p.x <= Math.max(s.x1, s.x2))
        : (p.x === s.x1 && p.z >= Math.min(s.z1, s.z2) && p.z <= Math.max(s.z1, s.z2));
      if (!onSeg) continue;
      segs.push(s);
      const atStart = p.x === s.x1 && p.z === s.z1;
      const atEnd = p.x === s.x2 && p.z === s.z2;
      const dir = segDir(s);
      // A through road contributes one arm each way; an ending road one.
      if (!atStart) arms.push({ x: -dir.x, z: -dir.z });
      if (!atEnd) arms.push({ x: dir.x, z: dir.z });
    }
    if (arms.length >= 2) nodes.push({ x: p.x, z: p.z, arms, segs });
  }
  return nodes;
}

// ---- canvas textures -------------------------------------------------------
// Warm radial glow for lamp sprites (one shared texture, tinted per use).
function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Rectangular road-sign face: coloured board, white legend.
function makeSignTexture({ bg, text, font = 'bold 44px Arial', arrow = false }) {
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
function makeStopTexture() {
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
  const rand = mulberry32(20261120);
  const group = new THREE.Group();
  group.name = 'props';
  scene.add(group);
  const counts = {
    dashes: 0, zebras: 0, sidewalks: 0, lamps: 0,
    trafficLights: 0, signs: 0, umbrellas: 0, skyline: 0,
  };
  const dummy = new THREE.Object3D();

  // ---- shared materials / geometries --------------------------------------
  const mat = {
    dashWhite: new THREE.MeshStandardMaterial({ color: '#e8e8e2', roughness: 0.8 }),
    zebraWhite: new THREE.MeshStandardMaterial({ color: '#f4f4ee', roughness: 0.8 }),
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
  const umbrellaColors = ['#e74c3c', '#1abc9c', '#f1c40f', '#e91e63', '#3498db', '#ff7f50'];
  const umbrellaMats = umbrellaColors.map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 }),
  );
  const towelMats = ['#ff6b6b', '#4ecdc4', '#ffe66d', '#a78bfa', '#ff9f43'].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 1 }),
  );
  const ballMats = ['#ff4757', '#2ed573', '#ffa502', '#70a1ff'].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 }),
  );
  const skylineColors = ['#2b3a52', '#3a4a66', '#22303f', '#46586f', '#31435e'];

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const dashGeo = new THREE.BoxGeometry(3, 0.04, 0.35);
  const stripeGeo = new THREE.BoxGeometry(0.55, 0.04, 6.8);
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.13, 5.5, 6);
  const glowTex = makeGlowTexture();

  const intersections = findIntersections();
  const junctions = intersections.filter((n) => n.arms.length >= 3);
  const corners = intersections.filter((n) => n.arms.length === 2);

  // ---- 1. dashed centre line (InstancedMesh, skips the 9 m before any
  //        intersection so dashes never run through a zebra crossing) ------
  const dashSpots = [];
  for (const s of CONFIG.roads) {
    const len = segLen(s);
    const angle = segAngle(s);
    for (let d = 4; d <= len - 4; d += 6) {
      const p = pointAt(s, d);
      let nearJunction = false;
      for (const n of intersections) {
        if (Math.hypot(p.x - n.x, p.z - n.z) < 9) { nearJunction = true; break; }
      }
      if (nearJunction) continue;
      dashSpots.push({ x: p.x, z: p.z, angle });
    }
  }
  if (dashSpots.length > 0) {
    const dashes = new THREE.InstancedMesh(dashGeo, mat.dashWhite, dashSpots.length);
    dashSpots.forEach((spot, i) => {
      dummy.position.set(spot.x, GROUND + 0.1, spot.z);
      dummy.rotation.set(0, spot.angle, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      dashes.setMatrixAt(i, dummy.matrix);
    });
    dashes.instanceMatrix.needsUpdate = true;
    dashes.receiveShadow = true;
    group.add(dashes);
    counts.dashes = dashSpots.length;
  }

  // ---- 2. zebra crossings (InstancedMesh): one band per approach arm, -----
  // 6 stripes each, band centre 7 m out from the intersection centre.
  const stripeSpots = [];
  for (const node of intersections) {
    for (const dir of node.arms) {
      const angle = -Math.atan2(dir.z, dir.x);
      const bx = node.x + dir.x * 7;
      const bz = node.z + dir.z * 7;
      // Sideways normal (across the road).
      const nx = -dir.z;
      const nz = dir.x;
      for (let i = 0; i < 6; i++) {
        const off = -3.3 + i * 1.32;
        stripeSpots.push({ x: bx + nx * off, z: bz + nz * off, angle });
      }
    }
  }
  if (stripeSpots.length > 0) {
    const stripes = new THREE.InstancedMesh(stripeGeo, mat.zebraWhite, stripeSpots.length);
    stripeSpots.forEach((spot, i) => {
      dummy.position.set(spot.x, GROUND + 0.1, spot.z);
      dummy.rotation.set(0, spot.angle, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      stripes.setMatrixAt(i, dummy.matrix);
    });
    stripes.instanceMatrix.needsUpdate = true;
    stripes.receiveShadow = true;
    group.add(stripes);
    counts.zebras = stripeSpots.length;
  }

  // ---- 3. sidewalks + curbs (both sides of every road except the bridge,
  //        whose rails already edge the deck) -------------------------------
  const bridge = CONFIG.bridge;
  for (const s of CONFIG.roads) {
    // The bridge road is the x = 0 segment spanning exactly the bridge
    // deck (z1..z2) — the two N-S cross streets are also x = 0, but they
    // span the islands and DO get sidewalks.
    const isBridgeRoad = s.x1 === bridge.x && s.x2 === bridge.x
      && s.z1 === bridge.z1 && s.z2 === bridge.z2;
    if (isBridgeRoad) continue;
    const len = segLen(s);
    const angle = segAngle(s);
    const cx = (s.x1 + s.x2) / 2;
    const cz = (s.z1 + s.z2) / 2;
    const walkLen = Math.max(len - 8, 4); // stop 4 m short of each corner
    for (const side of [-1, 1]) {
      const ox = Math.sin(angle) * side * 5.2;
      const oz = Math.cos(angle) * side * 5.2;
      const walk = new THREE.Mesh(unitBox, mat.sidewalk);
      walk.scale.set(walkLen, 0.15, 2.4);
      walk.position.set(cx + ox, GROUND + 0.075, cz + oz);
      walk.rotation.y = angle;
      walk.receiveShadow = true;
      group.add(walk);
      counts.sidewalks += 1;
      // Crisp curb line on the road edge of the sidewalk.
      const cox = Math.sin(angle) * side * 4.15;
      const coz = Math.cos(angle) * side * 4.15;
      const curb = new THREE.Mesh(unitBox, mat.curb);
      curb.scale.set(walkLen, 0.15, 0.3);
      curb.position.set(cx + cox, GROUND + 0.075, cz + coz);
      curb.rotation.y = angle;
      group.add(curb);
    }
  }

  // ---- 4. street lamps at intersections + marina ---------------------------
  // Pole + arm reaching over the road + warm emissive head + additive glow
  // sprite. NO PointLight per lamp — the emissive head and sprite carry
  // the dusk look for free.
  const lampSpots = [];
  for (const node of intersections) {
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
  for (const spot of lampSpots) {
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
    counts.lamps += 1;
  }

  // ---- 5. traffic lights at the 3-way junctions -----------------------------
  // One pole per junction on a corner, arm over the road, vertical head
  // with red / yellow / green — exactly one lamp lit. Junctions alternate
  // red / green so the city reads alive instead of all-red.
  const tlLampGeo = new THREE.SphereGeometry(0.16, 10, 8);
  junctions.forEach((node, ji) => {
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
    const lit = ji % 2 === 0 ? 0 : 2; // even: red, odd: green
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
    counts.trafficLights += 1;
  });

  // ---- 6. road signs ---------------------------------------------------------
  // STOP at four junctions, one-way arrows at four ring corners, street
  // names at six junctions / corners. Faces are canvas textures so the
  // legend is actually readable in a screenshot.
  const stopTex = makeStopTexture();
  const oneWayTex = makeSignTexture({ bg: '#1f6fd6', text: '', arrow: true });
  const streetNames = ['OCEAN AVE', 'PALM BLVD', 'BRIDGE RD', 'BAY ST', 'CORAL WAY', 'MARINA DR'];
  const nameTexs = streetNames.map((name) =>
    makeSignTexture({ bg: '#1a6b3c', text: name, font: 'bold 40px Arial' }),
  );
  const signPoleGeo = new THREE.CylinderGeometry(0.06, 0.06, 2.6, 6);
  const signPoleGeoTall = new THREE.CylinderGeometry(0.06, 0.06, 3.2, 6);

  function addPoleSign(x, z, faceAngle, faceTex, w, h, poleHeight, poleGeo) {
    const pole = new THREE.Mesh(poleGeo, mat.signPole);
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
    counts.signs += 1;
  }

  junctions.slice(0, 4).forEach((node, i) => {
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
    counts.signs += 1;
    void i;
  });

  corners.slice(0, 4).forEach((node, i) => {
    const x = node.x + (node.x < 0 ? 6.6 : -6.6);
    const z = node.z + (node.z < 0 ? 6.6 : -6.6);
    const face = Math.atan2(node.x - x, node.z - z);
    addPoleSign(x, z, face, oneWayTex, 0.9, 0.45, 2.6, signPoleGeo);
    void i;
  });

  [...junctions.slice(4), ...corners.slice(4, 6)].slice(0, 6).forEach((node, i) => {
    const x = node.x - 6.6;
    const z = node.z + 6.6;
    const face = Math.atan2(node.x - x, node.z - z);
    addPoleSign(x, z, face, nameTexs[i % nameTexs.length], 1.6, 0.8, 3.2, signPoleGeoTall);
  });

  // ---- 7. beach / sand detail ----------------------------------------------
  // Sand-tone patches, umbrellas, towels and beach balls on the beach ring
  // of both islands (r ~0.93-0.98 of the ellipse), clear of the bridge
  // corridor and the marina pier.
  function beachSpot(island, angle, rFactor) {
    return {
      x: island.cx + Math.cos(angle) * island.rx * rFactor,
      z: island.cz + Math.sin(angle) * island.rz * rFactor,
    };
  }
  function beachOk(x, z) {
    if (Math.abs(x) < 14 && z > -70 && z < 80) return false; // bridge corridor
    if (x > 96 && z > 120 && z < 180) return false; // marina pier
    return true;
  }
  const sandPatchGeo = new THREE.CircleGeometry(1, 20);
  for (const island of CONFIG.islands) {
    for (let i = 0; i < 5; i++) {
      const a = rand() * Math.PI * 2;
      const p = beachSpot(island, a, 0.94 + rand() * 0.04);
      if (!beachOk(p.x, p.z)) continue;
      const patch = new THREE.Mesh(
        sandPatchGeo,
        rand() < 0.5 ? mat.sandDark : mat.sandLight,
      );
      const r = 5 + rand() * 6;
      patch.scale.set(r, r * (0.6 + rand() * 0.5), 1);
      patch.rotation.x = -Math.PI / 2;
      patch.rotation.z = rand() * Math.PI;
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
      const a = rand() * Math.PI * 2;
      const p = beachSpot(island, a, 0.93 + rand() * 0.05);
      if (!beachOk(p.x, p.z)) continue;
      const tilt = (rand() - 0.5) * 0.2;
      const pole = new THREE.Mesh(umbrellaPoleGeo, mat.umbrellaPole);
      pole.position.set(p.x, 1.4 + 1.2, p.z);
      pole.rotation.z = tilt;
      pole.castShadow = true;
      group.add(pole);
      const top = new THREE.Mesh(
        umbrellaTopGeo,
        umbrellaMats[Math.floor(rand() * umbrellaMats.length)],
      );
      top.position.set(p.x + tilt * 1.2, 1.4 + 2.55, p.z);
      top.rotation.z = tilt;
      top.castShadow = true;
      group.add(top);
      counts.umbrellas += 1;
      // Towel beside the umbrella, ball a step away.
      const tx = p.x + 2.2 + rand();
      const tz = p.z + (rand() - 0.5) * 2;
      if (beachOk(tx, tz)) {
        const towel = new THREE.Mesh(
          towelGeo,
          towelMats[Math.floor(rand() * towelMats.length)],
        );
        towel.position.set(tx, 1.43, tz);
        towel.rotation.y = rand() * Math.PI;
        group.add(towel);
      }
      const bx = p.x - 2.0 - rand();
      const bz = p.z + (rand() - 0.5) * 2;
      if (beachOk(bx, bz)) {
        const ball = new THREE.Mesh(
          ballGeo,
          ballMats[Math.floor(rand() * ballMats.length)],
        );
        ball.position.set(bx, 1.4 + 0.35, bz);
        ball.castShadow = true;
        group.add(ball);
      }
    }
  }

  // ---- 8. distant skyline ring ----------------------------------------------
  // Detailed silhouettes on the horizon (radius 380-450, standing in the
  // water across the bay) for depth. MeshBasicMaterial with fog: false
  // keeps them readable as a skyline instead of fogging out. The detail
  // comes from three instanced pieces (3 draw calls):
  //   - the tower slabs themselves, broad face turned toward the city so
  //     the face every in-city viewpoint sees is the flat one;
  //   - a window grid on that inward face: warm lit glass mixed with dark
  //     reflective glass, so the towers read as inhabited buildings at
  //     dusk instead of flat blue slabs;
  //   - stepped rooftop crowns on about half the towers, so the roofline
  //     varies instead of running flat. (Lane H: the old thin spire on
  //     the tallest landmarks is removed — it read as a stray antenna
  //     line against the sky and poked over the health bar.)
  const skylineCount = 56;
  const skyGeo = new THREE.BoxGeometry(1, 1, 1);
  const skyMat = new THREE.MeshBasicMaterial({ color: '#ffffff', fog: false });
  const skyline = new THREE.InstancedMesh(skyGeo, skyMat, skylineCount);
  const skyColor = new THREE.Color();
  // Per-tower data kept for the window / crown passes below.
  const skyTowers = [];
  for (let i = 0; i < skylineCount; i++) {
    const a = (i / skylineCount) * Math.PI * 2 + rand() * 0.06;
    const r = 380 + rand() * 70;
    const w = 16 + rand() * 22;
    const d = 16 + rand() * 22;
    // A few landmark towers rise well above the rest.
    const h = i % 14 === 0 ? 110 + rand() * 30 : 25 + rand() * 65;
    // Broad face toward the city centre: rotation.y = -a - PI/2 turns the
    // box's +Z face normal to (-cos a, 0, -sin a), i.e. at the origin.
    // NOTE (Lane H): this rotation is Y-only, so it CANNOT tilt a tower —
    // verified by hand: sin(-a-PI/2) = -cos a, cos(-a-PI/2) = -sin a.
    // The lean seen in city.jpg is perspective convergence from the
    // city-shot camera (31 deg pitch down + 62 deg FOV), fixed in main.js
    // staging, not here. The slab is sunk 6 m (base y = -6) so the tower
    // stands IN the water instead of balancing on its waterline.
    const rotY = -a - Math.PI / 2;
    dummy.position.set(Math.cos(a) * r, h / 2 - 6, Math.sin(a) * r);
    dummy.rotation.set(0, rotY, 0);
    dummy.scale.set(w, h, d);
    dummy.updateMatrix();
    skyline.setMatrixAt(i, dummy.matrix);
    skyColor.set(skylineColors[Math.floor(rand() * skylineColors.length)]);
    skyline.setColorAt(i, skyColor);
    skyTowers.push({ a, r, w, d, h, rotY });
  }
  skyline.instanceMatrix.needsUpdate = true;
  if (skyline.instanceColor) skyline.instanceColor.needsUpdate = true;
  group.add(skyline);
  counts.skyline = skylineCount;

  // Lane H: a visible base under every tower. The old ring sank each slab
  // only 2 m, so at 400+ m — where the fog washes the water to pale gold
  // while the fog:false slabs stay crisp blue — a tower had no readable
  // waterline and looked like it floated on haze. Each podium is a dark
  // slate block 30% wider than its tower, rising 4 m out of the water
  // (y -4..+4) with the slab sunk through it to -6, so every tower now
  // reads as standing on something solid at the horizon.
  {
    const podiums = new THREE.InstancedMesh(
      skyGeo,
      new THREE.MeshBasicMaterial({ color: '#ffffff', fog: false }),
      skylineCount,
    );
    const podiumCol = new THREE.Color();
    const podiumCols = ['#141d29', '#1a2431', '#101825'];
    skyTowers.forEach((t, i) => {
      dummy.position.set(Math.cos(t.a) * t.r, 0, Math.sin(t.a) * t.r);
      dummy.rotation.set(0, t.rotY, 0);
      dummy.scale.set(t.w * 1.3, 8, t.d * 1.3);
      dummy.updateMatrix();
      podiums.setMatrixAt(i, dummy.matrix);
      podiumCol.set(podiumCols[i % podiumCols.length]);
      podiums.setColorAt(i, podiumCol);
    });
    podiums.instanceMatrix.needsUpdate = true;
    if (podiums.instanceColor) podiums.instanceColor.needsUpdate = true;
    group.add(podiums);
    counts.skylinePodiums = skylineCount;
  }

  // Window grids on the inward face of each tower. The face centre sits
  // just proud of the slab (d/2 + 0.15) so no window z-fights the wall;
  // the grid runs along the face tangent (-sin a, 0, cos a).
  const winList = [];
  const winColorList = [];
  const winCol = new THREE.Color();
  const winLitCols = ['#ffc46b', '#ff9a4d', '#ffd98a'];
  const winDarkCols = ['#16202e', '#1d2c40', '#101825'];
  for (const t of skyTowers) {
    const nx = -Math.cos(t.a);
    const nz = -Math.sin(t.a);
    const tx = -Math.sin(t.a);
    const tz = Math.cos(t.a);
    const cx = Math.cos(t.a) * t.r + nx * (t.d / 2 + 0.15);
    const cz = Math.sin(t.a) * t.r + nz * (t.d / 2 + 0.15);
    const cols = Math.max(2, Math.floor(t.w / 4.5));
    const ww = Math.min(2.0, (t.w / cols) * 0.45);
    const wh = 2.6;
    const stepX = t.w / cols;
    const stepY = 5.5;
    for (let row = 0; ; row++) {
      const wy = 4 + row * stepY;
      // Lane H: limit follows the sunk slab (top at h-6, was h-2), so the
      // top window row never pokes above the roofline.
      if (wy + wh / 2 > t.h - 9) break;
      for (let col = 0; col < cols; col++) {
        const u = -t.w / 2 + stepX * (col + 0.5);
        dummy.position.set(cx + tx * u, wy, cz + tz * u);
        dummy.rotation.set(0, t.rotY, 0);
        dummy.scale.set(ww, wh, 0.18);
        dummy.updateMatrix();
        winList.push(dummy.matrix.clone());
        if (rand() < 0.35) {
          winColorList.push(winCol.set(
            winLitCols[Math.floor(rand() * winLitCols.length)],
          ).clone());
        } else {
          winColorList.push(winCol.set(
            winDarkCols[Math.floor(rand() * winDarkCols.length)],
          ).clone());
        }
      }
    }
  }
  if (winList.length > 0) {
    const wins = new THREE.InstancedMesh(
      skyGeo,
      new THREE.MeshBasicMaterial({ color: '#ffffff', fog: false }),
      winList.length,
    );
    winList.forEach((m, i) => {
      wins.setMatrixAt(i, m);
      wins.setColorAt(i, winColorList[i]);
    });
    wins.instanceMatrix.needsUpdate = true;
    if (wins.instanceColor) wins.instanceColor.needsUpdate = true;
    group.add(wins);
    counts.skylineWindows = winList.length;
  }

  // Stepped rooftop crowns on about half the towers, so the roofline steps
  // instead of running flat across the whole ring. (Lane H: no spires —
  // see the landmark branch below.)
  const crownList = [];
  const crownColorList = [];
  const crownCol = new THREE.Color();
  for (let i = 0; i < skyTowers.length; i++) {
    const t = skyTowers[i];
    // Lane H: slab top is h-6 now that the slab is sunk 6 m (was h-2).
    const topY = t.h - 6; // tower slab top
    const px = Math.cos(t.a) * t.r;
    const pz = Math.sin(t.a) * t.r;
    if (i % 14 === 0) {
      // Landmark: setback crown above the slab. Lane H: the old thin
      // steel spire (1.4 m wide, 14-24 m tall, dark #2a3444) is GONE —
      // against the bright sky it read as a stray black antenna line,
      // and in city.jpg one poked straight up over the health bar. The
      // setback crown alone marks the landmark now.
      const ch = 8 + rand() * 6;
      dummy.position.set(px, topY + ch / 2, pz);
      dummy.rotation.set(0, t.rotY, 0);
      dummy.scale.set(t.w * 0.55, ch, t.d * 0.55);
      dummy.updateMatrix();
      crownList.push(dummy.matrix.clone());
      crownColorList.push(crownCol.set(
        skylineColors[Math.floor(rand() * skylineColors.length)],
      ).clone());
    } else if (rand() < 0.45) {
      const ch = 5 + rand() * 9;
      dummy.position.set(px, topY + ch / 2, pz);
      dummy.rotation.set(0, t.rotY, 0);
      dummy.scale.set(t.w * (0.5 + rand() * 0.2), ch, t.d * (0.5 + rand() * 0.2));
      dummy.updateMatrix();
      crownList.push(dummy.matrix.clone());
      crownColorList.push(crownCol.set(
        skylineColors[Math.floor(rand() * skylineColors.length)],
      ).clone());
    }
  }
  if (crownList.length > 0) {
    const crowns = new THREE.InstancedMesh(skyGeo, skyMat, crownList.length);
    crownList.forEach((m, i) => {
      crowns.setMatrixAt(i, m);
      crowns.setColorAt(i, crownColorList[i]);
    });
    crowns.instanceMatrix.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
    group.add(crowns);
    counts.skylineCrowns = crownList.length;
  }

  return { group, counts, intersections: intersections.length, junctions: junctions.length };
}
