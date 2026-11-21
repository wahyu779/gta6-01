// Arcade car for Azure Bay: box-built cars in three body variants —
// sedan, van and box truck — with cylinder wheels, headlights and
// DYNAMIC brake lights (the taillights flare brighter while braking).
// W accelerates, S brakes/reverses, A/D steer. Faster on roads and the
// bridge, slower off-road, and it bounces off buildings instead of
// driving through them.

import * as THREE from 'three';

const WHEELBASE = 2.8;
const MAX_STEER = 0.55;
const ACCEL = 14;
const BRAKE = 26;
const REVERSE_ACCEL = 9;
const MAX_REVERSE = 9;
const ROAD_MAX = 40;
const OFFROAD_MAX = 20;
const DRAG = 0.25; // low enough that accel 14 beats drag below the 40 m/s cap (14/0.25 = 56)

// Taillight glow: dim running light vs bright flare while braking.
const TAIL_IDLE = 1.2;
const TAIL_BRAKING = 4.5;

// Collision radius per body variant (the car is a circle in the
// physics; the longer bodies get a slightly larger circle so the
// truck's nose/tail don't clip through buildings on a turn).
const VARIANT_RADIUS = { sedan: 1.7, van: 1.9, truck: 2.2 };

// Visual detail lives here and nowhere else: paint + glass + trim +
// lights + wheels. `options.police` builds the black-and-white livery
// (white doors with a POLICE decal + a roof light bar) and returns the
// light-bar materials so police.js can flash them. `options.variant`
// picks the body: 'sedan' (default), 'van' or 'truck'. The physics in
// createCar/update below is untouched apart from the per-variant
// collision radius and wheel radius.
function buildMesh(color, options = {}) {
  const police = !!options.police;
  const variant = options.variant === 'van' || options.variant === 'truck'
    ? options.variant
    : 'sedan';
  const group = new THREE.Group();

  // Police livery (Lane B): bright royal-blue paint, not the old
  // near-black 0x111827 — the body was a black silhouette in chase /
  // combat shots, readable only via the light bar. Lower metalness +
  // higher roughness so the blue catches diffuse golden-hour light
  // instead of mirroring the dark road. White doors stay, taller now
  // so the black-and-white livery reads from the side as well.
  const paint = new THREE.MeshStandardMaterial({
    color: police ? 0x2563eb : color,
    metalness: police ? 0.3 : 0.55,
    roughness: police ? 0.45 : 0.35,
  });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0d1b2a, metalness: 0.4, roughness: 0.12 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x1f2937, metalness: 0.3, roughness: 0.7 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.95 });
  const rim = new THREE.MeshStandardMaterial({ color: 0xd1d5db, metalness: 0.85, roughness: 0.25 });
  const doorWhite = new THREE.MeshStandardMaterial({ color: 0xf8fafc, metalness: 0.4, roughness: 0.4 });

  // Each body builder adds its own shell to the group and returns the
  // dimensions the shared lights / wheels / police livery need:
  // frontZ/rearZ (nose/tail), headY/tailY (light height), roofY (top
  // of the roof), halfW (body half-width), wheelR/wheelX/wheelFrontZ/
  // wheelRearZ, tailStyle ('bar' or 'towers'), and the police door/bar
  // placement. Front faces +Z everywhere.
  let dims;
  if (variant === 'van') dims = buildVan(group, paint, glass, trim);
  else if (variant === 'truck') dims = buildTruck(group, paint, glass, trim);
  else dims = buildSedan(group, paint, glass, trim);

  // Bumpers front and rear, sized to the body.
  const bumperGeo = new THREE.BoxGeometry(dims.halfW * 2 + 0.04, 0.18, 0.22);
  const bumperF = new THREE.Mesh(bumperGeo, trim);
  bumperF.position.set(0, 0.38, dims.frontZ);
  group.add(bumperF);
  const bumperR = new THREE.Mesh(bumperGeo, trim);
  bumperR.position.set(0, 0.38, dims.rearZ);
  group.add(bumperR);
  // Grille on the nose (sedan + truck; the van's flat face is its grille).
  if (variant !== 'van') {
    const grille = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.16, 0.06), trim);
    grille.position.set(0, dims.headY, dims.frontZ + 0.01);
    group.add(grille);
  }

  // Headlights (emissive) + amber indicators, and the taillights.
  // The taillight material is returned so createCar can flare it while
  // the car brakes; it is NOT constant — see TAIL_IDLE / TAIL_BRAKING.
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff7cc, emissive: 0xffedb5, emissiveIntensity: 1.6 });
  const indicatorMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xf59e0b, emissiveIntensity: 0.9 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x7f1d1d, emissive: 0xef4444, emissiveIntensity: TAIL_IDLE });
  const headGeo = new THREE.BoxGeometry(0.36, 0.14, 0.06);
  const indGeo = new THREE.BoxGeometry(0.16, 0.12, 0.06);
  for (const sx of [-0.62, 0.62]) {
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.set(sx, dims.headY, dims.frontZ + 0.01);
    group.add(head);
    const ind = new THREE.Mesh(indGeo, indicatorMat);
    ind.position.set(sx * 1.45, dims.headY, dims.frontZ + 0.01);
    group.add(ind);
  }
  if (dims.tailStyle === 'towers') {
    // Van + truck: tall vertical tail-light towers at the rear corners.
    const towerGeo = new THREE.BoxGeometry(0.2, 0.5, 0.06);
    for (const sx of [-0.8, 0.8]) {
      const tower = new THREE.Mesh(towerGeo, tailMat);
      tower.position.set(sx, dims.tailY, dims.rearZ - 0.01);
      group.add(tower);
    }
  } else {
    const tailBar = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.14, 0.06), tailMat);
    tailBar.position.set(0, dims.tailY, dims.rearZ - 0.01);
    group.add(tailBar);
  }

  // Four wheels: tyre + alloy hubcap + dark centre cap, on steer pivots.
  const wheelGeo = new THREE.CylinderGeometry(dims.wheelR, dims.wheelR, 0.28, 18);
  wheelGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(dims.wheelR * 0.55, dims.wheelR * 0.55, 0.3, 12);
  hubGeo.rotateZ(Math.PI / 2);
  const capGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.32, 8);
  capGeo.rotateZ(Math.PI / 2);
  const wheels = [];
  const steerPivots = [];
  for (const [wx, wz, front] of [
    [-dims.wheelX, dims.wheelFrontZ, true], [dims.wheelX, dims.wheelFrontZ, true],
    [-dims.wheelX, dims.wheelRearZ, false], [dims.wheelX, dims.wheelRearZ, false],
  ]) {
    const pivot = new THREE.Group();
    pivot.position.set(wx, dims.wheelR, wz);
    const wheel = new THREE.Mesh(wheelGeo, tyre);
    wheel.castShadow = true;
    const hub = new THREE.Mesh(hubGeo, rim);
    const cap = new THREE.Mesh(capGeo, trim);
    pivot.add(wheel);
    pivot.add(hub);
    pivot.add(cap);
    group.add(pivot);
    wheels.push(wheel);
    steerPivots.push(front ? pivot : null);
  }

  // ---- police livery: white doors with a POLICE decal + roof light bar --
  let lightRed = null;
  let lightBlue = null;
  if (police) {
    const p = dims.police;
    const doorGeo = new THREE.BoxGeometry(0.04, 0.58, p.doorLen);
    for (const sx of [-1, 1]) {
      const door = new THREE.Mesh(doorGeo, doorWhite);
      door.position.set(sx * (dims.halfW + 0.01), p.doorY, p.doorZ);
      group.add(door);
    }
    // POLICE decal drawn on a canvas, one plane per door.
    const decal = document.createElement('canvas');
    decal.width = 512;
    decal.height = 128;
    const dctx = decal.getContext('2d');
    dctx.fillStyle = '#f8fafc';
    dctx.fillRect(0, 0, 512, 128);
    dctx.fillStyle = '#1e3a8a';
    dctx.font = 'bold 84px sans-serif';
    dctx.textAlign = 'center';
    dctx.textBaseline = 'middle';
    dctx.fillText('POLICE', 256, 68);
    const decalTex = new THREE.CanvasTexture(decal);
    const decalGeo = new THREE.PlaneGeometry(Math.max(0.9, p.doorLen - 0.1), 0.55);
    const decalMat = new THREE.MeshBasicMaterial({ map: decalTex });
    for (const sx of [-1, 1]) {
      const plane = new THREE.Mesh(decalGeo, decalMat);
      plane.position.set(sx * (dims.halfW + 0.04), p.doorY, p.doorZ);
      plane.rotation.y = sx * Math.PI / 2;
      group.add(plane);
    }
    // Roof light bar: black base + red left / blue right beacons.
    const barBase = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.1, 0.5), trim);
    barBase.position.set(0, p.barY, p.barZ);
    group.add(barBase);
    const barGeo = new THREE.BoxGeometry(0.55, 0.16, 0.44);
    lightRed = new THREE.MeshStandardMaterial({
      color: 0xef4444, emissive: 0xef4444, emissiveIntensity: 2,
    });
    lightBlue = new THREE.MeshStandardMaterial({
      color: 0x3b82f6, emissive: 0x3b82f6, emissiveIntensity: 2,
    });
    const red = new THREE.Mesh(barGeo, lightRed);
    red.position.set(-0.33, p.barY + 0.1, p.barZ);
    group.add(red);
    const blue = new THREE.Mesh(barGeo, lightBlue);
    blue.position.set(0.33, p.barY + 0.1, p.barZ);
    group.add(blue);
  }

  return {
    group, wheels, steerPivots, lightRed, lightBlue, tailMat,
    variant, wheelRadius: dims.wheelR,
    collisionRadius: VARIANT_RADIUS[variant],
  };
}

// ---- sedan (the original body, unchanged geometry) ------------------------
// Lower body with a narrower hood/trunk deck, greenhouse with a glass
// band, slim B-pillars and a tilted windshield. Total length 4.4 m,
// roof at ~1.44 m.
function buildSedan(group, paint, glass, trim) {
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.55, 4.4), paint);
  body.position.y = 0.55;
  body.castShadow = true;
  group.add(body);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.16, 4.0), paint);
  deck.position.y = 0.88;
  deck.castShadow = true;
  group.add(deck);

  // Exhaust tips.
  const tipGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.12, 10);
  tipGeo.rotateX(Math.PI / 2);
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, metalness: 0.85, roughness: 0.25 });
  for (const sx of [-0.5, 0.5]) {
    const tip = new THREE.Mesh(tipGeo, rimMat);
    tip.position.set(sx, 0.38, -2.28);
    group.add(tip);
  }

  // Greenhouse: paint base, a dark glass band all round, paint roof,
  // and a slim B-pillar on each side so the glass reads as windows.
  const cabinBase = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.34, 2.1), paint);
  cabinBase.position.set(0, 1.0, -0.25);
  cabinBase.castShadow = true;
  group.add(cabinBase);
  const glassBand = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.3, 2.0), glass);
  glassBand.position.set(0, 1.22, -0.25);
  group.add(glassBand);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.08, 1.9), paint);
  roof.position.set(0, 1.4, -0.25);
  roof.castShadow = true;
  group.add(roof);
  const pillarGeo = new THREE.BoxGeometry(0.06, 0.3, 0.12);
  for (const sx of [-0.82, 0.82]) {
    const pillar = new THREE.Mesh(pillarGeo, paint);
    pillar.position.set(sx, 1.22, -0.25);
    group.add(pillar);
  }
  // Windshield: a slightly tilted glass pane at the front of the cabin.
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.34, 0.04), glass);
  windshield.position.set(0, 1.2, 0.78);
  windshield.rotation.x = -0.18;
  group.add(windshield);

  return {
    frontZ: 2.2, rearZ: -2.2, headY: 0.62, tailY: 0.62, roofY: 1.44,
    halfW: 0.95, wheelR: 0.36, wheelX: 0.85, wheelFrontZ: 1.45, wheelRearZ: -1.45,
    tailStyle: 'bar',
    police: { doorY: 0.6, doorZ: -0.1, doorLen: 1.7, barY: 1.48, barZ: -0.25 },
  };
}

// ---- van ------------------------------------------------------------------
// One tall boxy shell instead of a separate cabin: 4.9 m long, roof at
// ~1.83 m, a long side-glass strip, a flat nose with a tilted windshield
// and roof rails. Reads as a delivery van next to the low sedan.
function buildVan(group, paint, glass, trim) {
  // Lower body + tall upper box (the cargo/passenger shell).
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.8, 4.9), paint);
  body.position.y = 0.68;
  body.castShadow = true;
  group.add(body);
  const upper = new THREE.Mesh(new THREE.BoxGeometry(1.96, 0.72, 4.5), paint);
  upper.position.set(0, 1.42, -0.1);
  upper.castShadow = true;
  group.add(upper);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.08, 4.5), paint);
  roof.position.set(0, 1.79, -0.1);
  roof.castShadow = true;
  group.add(roof);

  // Long side-glass strips on the upper box + a tilted windshield.
  const sideGlassGeo = new THREE.BoxGeometry(0.04, 0.4, 3.6);
  for (const sx of [-0.99, 0.99]) {
    const pane = new THREE.Mesh(sideGlassGeo, glass);
    pane.position.set(sx, 1.45, -0.15);
    group.add(pane);
  }
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.5, 0.04), glass);
  windshield.position.set(0, 1.42, 2.18);
  windshield.rotation.x = -0.28;
  group.add(windshield);
  // Sliding-door seam on each flank, behind the front doors.
  const seamGeo = new THREE.BoxGeometry(0.03, 0.9, 0.05);
  for (const sx of [-1.01, 1.01]) {
    const seam = new THREE.Mesh(seamGeo, trim);
    seam.position.set(sx, 0.75, 0.55);
    group.add(seam);
  }
  // Roof rails.
  const railGeo = new THREE.BoxGeometry(0.08, 0.06, 3.6);
  for (const sx of [-0.7, 0.7]) {
    const rail = new THREE.Mesh(railGeo, trim);
    rail.position.set(sx, 1.86, -0.1);
    group.add(rail);
  }
  // Flat nose: a wide dark panel where the grille would be.
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.3, 0.06), trim);
  nose.position.set(0, 0.85, 2.46);
  group.add(nose);

  return {
    frontZ: 2.46, rearZ: -2.46, headY: 0.78, tailY: 0.78, roofY: 1.83,
    halfW: 1.0, wheelR: 0.42, wheelX: 0.92, wheelFrontZ: 1.8, wheelRearZ: -1.8,
    tailStyle: 'towers',
    police: { doorY: 0.75, doorZ: 1.35, doorLen: 1.5, barY: 1.88, barZ: 1.2 },
  };
}

// ---- box truck ------------------------------------------------------------
// Long chassis (5.6 m) with a cab up front and a tall ribbed cargo box
// behind it — the longest and tallest silhouette of the three, with a
// visibly separate cab and load. Roof of the cargo box at ~2.0 m.
function buildTruck(group, paint, glass, trim) {
  // Long low chassis.
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.55, 5.6), paint);
  body.position.y = 0.55;
  body.castShadow = true;
  group.add(body);
  // Cab up front: taller box + tilted windshield + side glass.
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.95, 1.5), paint);
  cab.position.set(0, 1.25, 1.95);
  cab.castShadow = true;
  group.add(cab);
  const cabRoof = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.08, 1.5), paint);
  cabRoof.position.set(0, 1.76, 1.95);
  cabRoof.castShadow = true;
  group.add(cabRoof);
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.45, 0.04), glass);
  windshield.position.set(0, 1.32, 2.68);
  windshield.rotation.x = -0.22;
  group.add(windshield);
  const cabGlassGeo = new THREE.BoxGeometry(0.04, 0.4, 0.9);
  for (const sx of [-0.99, 0.99]) {
    const pane = new THREE.Mesh(cabGlassGeo, glass);
    pane.position.set(sx, 1.35, 1.95);
    group.add(pane);
  }
  // Cargo box: tall, ribbed, filling the rear two-thirds of the chassis.
  const cargo = new THREE.Mesh(new THREE.BoxGeometry(2.05, 1.4, 3.3), paint);
  cargo.position.set(0, 1.3, -1.05);
  cargo.castShadow = true;
  group.add(cargo);
  const ribGeo = new THREE.BoxGeometry(0.04, 1.3, 0.1);
  for (const sx of [-1.04, 1.04]) {
    for (const rz of [-2.3, -1.05, 0.2]) {
      const rib = new THREE.Mesh(ribGeo, trim);
      rib.position.set(sx, 1.3, rz);
      group.add(rib);
    }
  }
  // Rear roll-up door outline on the back of the cargo box.
  const doorOutline = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.15, 0.04), trim);
  doorOutline.position.set(0, 1.3, -2.72);
  group.add(doorOutline);
  // Side steps under the cab doors.
  const stepGeo = new THREE.BoxGeometry(0.3, 0.08, 0.9);
  for (const sx of [-1.05, 1.05]) {
    const step = new THREE.Mesh(stepGeo, trim);
    step.position.set(sx, 0.32, 1.95);
    group.add(step);
  }

  return {
    frontZ: 2.81, rearZ: -2.81, headY: 0.62, tailY: 0.7, roofY: 2.0,
    halfW: 1.0, wheelR: 0.44, wheelX: 0.92, wheelFrontZ: 2.0, wheelRearZ: -2.0,
    tailStyle: 'towers',
    police: { doorY: 0.7, doorZ: 1.95, doorLen: 1.3, barY: 1.84, barZ: 1.95 },
  };
}

/** Push a circle (x, z, radius) out of every AABB it overlaps. Returns the corrected point. */
function pushOutOfColliders(x, z, radius, colliders) {
  let hit = false;
  for (const box of colliders) {
    if (box.max.y < 0.3) continue;
    const cx = Math.max(box.min.x, Math.min(x, box.max.x));
    const cz = Math.max(box.min.z, Math.min(z, box.max.z));
    const dx = x - cx;
    const dz = z - cz;
    const distSq = dx * dx + dz * dz;
    if (distSq >= radius * radius) continue;
    hit = true;
    if (distSq > 1e-8) {
      const dist = Math.sqrt(distSq);
      const push = radius - dist;
      x += (dx / dist) * push;
      z += (dz / dist) * push;
    } else {
      const pl = x - box.min.x;
      const pr = box.max.x - x;
      const pt = z - box.min.z;
      const pb = box.max.z - z;
      const m = Math.min(pl, pr, pt, pb);
      if (m === pl) x = box.min.x - radius;
      else if (m === pr) x = box.max.x + radius;
      else if (m === pt) z = box.min.z - radius;
      else z = box.max.z + radius;
    }
  }
  return { x, z, hit };
}

export function createCar(scene, startPos, color = 0xef4444, options = {}) {
  const {
    group, wheels, steerPivots, lightRed, lightBlue, tailMat,
    variant, wheelRadius, collisionRadius,
  } = buildMesh(color, options);
  group.position.copy(startPos);
  scene.add(group);

  const api = {
    mesh: group,
    /** Roof light-bar materials (police cars only, null otherwise). */
    lightRed,
    lightBlue,
    /** Body variant: 'sedan' | 'van' | 'truck'. */
    variant,
    /** Taillight material — its emissiveIntensity flares while braking. */
    tailMat,
    /** True while the brake lights are flared this frame. */
    braking: false,
    /** The car's world position (the mesh position). */
    position: group.position,
    /** Facing angle in radians; 0 faces +Z. */
    heading: 0,
    /** Signed forward speed in m/s. */
    speed: 0,
    occupied: false,
    steerAngle: 0,

    update(dt, input, city) {
      const onRoad = city && city.isDrivable ? city.isDrivable(group.position.x, group.position.z) : true;
      const maxSpeed = onRoad ? ROAD_MAX : OFFROAD_MAX;

      const gas = input.isDown('KeyW') || input.isDown('ArrowUp');
      const brake = input.isDown('KeyS') || input.isDown('ArrowDown');
      const steerInput = (input.isDown('KeyA') || input.isDown('ArrowLeft') ? 1 : 0)
        - (input.isDown('KeyD') || input.isDown('ArrowRight') ? 1 : 0);

      if (gas) api.speed += ACCEL * dt;
      if (brake) {
        if (api.speed > 0.5) api.speed -= BRAKE * dt;
        else api.speed -= REVERSE_ACCEL * dt;
      }
      if (!gas && !brake) {
        // Coast down gently.
        api.speed -= api.speed * 0.4 * dt;
        if (Math.abs(api.speed) < 0.05) api.speed = 0;
      }
      // Drag + speed caps.
      api.speed *= Math.exp(-DRAG * dt);
      if (api.speed > maxSpeed) api.speed = maxSpeed;
      if (api.speed < -MAX_REVERSE) api.speed = -MAX_REVERSE;

      // Dynamic brake lights: flare while the brake pedal is down and
      // the car is still moving forward; dim running light otherwise.
      // This reads the same input the AI and the player use, so traffic
      // and police cars brake-light exactly like the player's car.
      api.braking = brake && api.speed > 0.2;
      tailMat.emissiveIntensity = api.braking ? TAIL_BRAKING : TAIL_IDLE;

      // Steering weakens at high speed so the car stays controllable.
      const steerTarget = steerInput * MAX_STEER / (1 + Math.abs(api.speed) * 0.055);
      api.steerAngle += (steerTarget - api.steerAngle) * Math.min(1, 10 * dt);
      api.heading += (api.speed / WHEELBASE) * Math.tan(api.steerAngle) * dt;
      group.rotation.y = api.heading;

      // Advance along the heading.
      let nx = group.position.x + Math.sin(api.heading) * api.speed * dt;
      let nz = group.position.z + Math.cos(api.heading) * api.speed * dt;

      // No driving into open water: a step is legal on land or on a road/bridge.
      if (city) {
        const walkable = city.isWalkable ? city.isWalkable(nx, nz) : true;
        const drivable = city.isDrivable ? city.isDrivable(nx, nz) : true;
        if (!walkable && !drivable) {
          nx = group.position.x;
          nz = group.position.z;
          api.speed *= 0.3;
        }
      }
      if (city && city.colliders) {
        const pushed = pushOutOfColliders(nx, nz, collisionRadius, city.colliders);
        if (pushed.hit) api.speed *= 0.3;
        nx = pushed.x;
        nz = pushed.z;
      }
      group.position.x = nx;
      group.position.z = nz;

      // Spin the wheels and yaw the front ones with the steering.
      const spin = (api.speed * dt) / wheelRadius;
      for (const wheel of wheels) wheel.rotation.x += spin;
      for (const pivot of steerPivots) {
        if (pivot) pivot.rotation.y = api.steerAngle;
      }
    },

    enter() {
      api.occupied = true;
    },

    exit() {
      api.occupied = false;
    },
  };
  return api;
}
