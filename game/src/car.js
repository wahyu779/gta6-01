// Arcade car for Azure Bay, rewritten round 2.
// Box-built cars in three body shapes — sedan, van and box truck —
// with cylinder wheels, headlights and DYNAMIC brake lights (the
// taillights flare brighter while braking). W accelerates, S brakes
// or reverses, A/D steer. Faster on roads and the bridge, slower
// off-road, and it bounces off buildings instead of driving through
// them.
//
// DEATH IN A CAR (round-2 fix): a car whose driver dies used to keep
// its speed and its occupied flag until something else happened to
// touch it — the wreck could roll on driverless, or traffic could
// never reclaim it. Now exit() always parks the car (speed and
// steering zeroed, brake lights back to dim) because a car with no
// driver does not keep rolling, and abandon() is the explicit
// death-eject entry point player.js calls so the car is left exactly
// where it stopped. Geometry is unchanged from round 1 — every box,
// wheel and light sits at the same coordinates, only the code around
// it is reorganised.

import * as THREE from 'three';

const AXLE_SPACING = 2.8;
const STEER_LIMIT = 0.55;
const ENGINE_ACCEL = 14;
const BRAKE_FORCE = 26;
const REVERSE_FORCE = 9;
const REVERSE_CAP = 9;
const ROAD_TOP_SPEED = 40;
const DIRT_TOP_SPEED = 20;
const AERO_DRAG = 0.25; // low enough that accel 14 beats drag below the 40 m/s cap (14/0.25 = 56)

// Taillight glow: dim running light vs bright flare while braking.
const TAIL_DIM = 1.2;
const TAIL_BRIGHT = 4.5;

// Collision circle per body shape (the car is a circle in the
// physics; the longer bodies get a slightly larger circle so the
// truck's nose/tail don't clip through buildings on a turn).
const BODY_RADIUS = { sedan: 1.7, van: 1.9, truck: 2.2 };

// Shared paint/glass/trim/tyre materials for one car. `police` swaps
// in the bright royal-blue patrol paint (never the old near-black —
// the body was a black silhouette in chase / combat shots, readable
// only via the light bar).
function shellMaterials(paintColor, police) {
  return {
    paint: new THREE.MeshStandardMaterial({
      color: police ? 0x2563eb : paintColor,
      metalness: police ? 0.3 : 0.55,
      roughness: police ? 0.45 : 0.35,
    }),
    glass: new THREE.MeshStandardMaterial({ color: 0x0d1b2a, metalness: 0.4, roughness: 0.12 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x1f2937, metalness: 0.3, roughness: 0.7 }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.95 }),
    rim: new THREE.MeshStandardMaterial({ color: 0xd1d5db, metalness: 0.85, roughness: 0.25 }),
    doorWhite: new THREE.MeshStandardMaterial({ color: 0xf8fafc, metalness: 0.4, roughness: 0.4 }),
  };
}

function box(w, h, d, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

// ---- sedan ------------------------------------------------------------
// Lower body with a narrower hood/trunk deck, greenhouse with a glass
// band, slim B-pillars and a tilted windshield. Total length 4.4 m,
// roof at ~1.44 m.
function buildSedanBody(group, mats) {
  const { paint, glass, trim, rim } = mats;
  const body = box(1.9, 0.55, 4.4, paint, 0, 0.55, 0);
  body.castShadow = true;
  group.add(body);
  const deck = box(1.7, 0.16, 4.0, paint, 0, 0.88, 0);
  deck.castShadow = true;
  group.add(deck);

  // Exhaust tips.
  const tipGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.12, 10);
  tipGeo.rotateX(Math.PI / 2);
  for (const sx of [-0.5, 0.5]) {
    const tip = new THREE.Mesh(tipGeo, rim);
    tip.position.set(sx, 0.38, -2.28);
    group.add(tip);
  }

  // Greenhouse: paint base, a dark glass band all round, paint roof,
  // and a slim B-pillar on each side so the glass reads as windows.
  const cabinBase = box(1.6, 0.34, 2.1, paint, 0, 1.0, -0.25);
  cabinBase.castShadow = true;
  group.add(cabinBase);
  group.add(box(1.62, 0.3, 2.0, glass, 0, 1.22, -0.25));
  const roof = box(1.66, 0.08, 1.9, paint, 0, 1.4, -0.25);
  roof.castShadow = true;
  group.add(roof);
  for (const sx of [-0.82, 0.82]) {
    group.add(box(0.06, 0.3, 0.12, paint, sx, 1.22, -0.25));
  }
  // Windshield: a slightly tilted glass pane at the front of the cabin.
  const shield = box(1.5, 0.34, 0.04, glass, 0, 1.2, 0.78);
  shield.rotation.x = -0.18;
  group.add(shield);

  return {
    frontZ: 2.2, rearZ: -2.2, headY: 0.62, tailY: 0.62, roofY: 1.44,
    halfW: 0.95, wheelR: 0.36, wheelX: 0.85, wheelFrontZ: 1.45, wheelRearZ: -1.45,
    tailStyle: 'bar',
    police: { doorY: 0.6, doorZ: -0.1, doorLen: 1.7, barY: 1.48, barZ: -0.25 },
  };
}

// ---- van ----------------------------------------------------------------
// One tall boxy shell instead of a separate cabin: 4.9 m long, roof at
// ~1.83 m, a long side-glass strip, a flat nose with a tilted windshield
// and roof rails. Reads as a delivery van next to the low sedan.
function buildVanBody(group, mats) {
  const { paint, glass, trim } = mats;
  const body = box(2.0, 0.8, 4.9, paint, 0, 0.68, 0);
  body.castShadow = true;
  group.add(body);
  const upper = box(1.96, 0.72, 4.5, paint, 0, 1.42, -0.1);
  upper.castShadow = true;
  group.add(upper);
  const roof = box(2.0, 0.08, 4.5, paint, 0, 1.79, -0.1);
  roof.castShadow = true;
  group.add(roof);

  // Long side-glass strips on the upper box + a tilted windshield.
  for (const sx of [-0.99, 0.99]) {
    group.add(box(0.04, 0.4, 3.6, glass, sx, 1.45, -0.15));
  }
  const shield = box(1.7, 0.5, 0.04, glass, 0, 1.42, 2.18);
  shield.rotation.x = -0.28;
  group.add(shield);
  // Sliding-door seam on each flank, behind the front doors.
  for (const sx of [-1.01, 1.01]) {
    group.add(box(0.03, 0.9, 0.05, trim, sx, 0.75, 0.55));
  }
  // Roof rails.
  for (const sx of [-0.7, 0.7]) {
    group.add(box(0.08, 0.06, 3.6, trim, sx, 1.86, -0.1));
  }
  // Flat nose: a wide dark panel where the grille would be.
  group.add(box(1.6, 0.3, 0.06, trim, 0, 0.85, 2.46));

  return {
    frontZ: 2.46, rearZ: -2.46, headY: 0.78, tailY: 0.78, roofY: 1.83,
    halfW: 1.0, wheelR: 0.42, wheelX: 0.92, wheelFrontZ: 1.8, wheelRearZ: -1.8,
    tailStyle: 'towers',
    police: { doorY: 0.75, doorZ: 1.35, doorLen: 1.5, barY: 1.88, barZ: 1.2 },
  };
}

// ---- box truck ----------------------------------------------------------
// Long chassis (5.6 m) with a cab up front and a tall ribbed cargo box
// behind it — the longest and tallest silhouette of the three, with a
// visibly separate cab and load. Roof of the cargo box at ~2.0 m.
function buildTruckBody(group, mats) {
  const { paint, glass, trim } = mats;
  const body = box(2.0, 0.55, 5.6, paint, 0, 0.55, 0);
  body.castShadow = true;
  group.add(body);
  // Cab up front: taller box + tilted windshield + side glass.
  const cab = box(1.95, 0.95, 1.5, paint, 0, 1.25, 1.95);
  cab.castShadow = true;
  group.add(cab);
  const cabRoof = box(1.95, 0.08, 1.5, paint, 0, 1.76, 1.95);
  cabRoof.castShadow = true;
  group.add(cabRoof);
  const shield = box(1.7, 0.45, 0.04, glass, 0, 1.32, 2.68);
  shield.rotation.x = -0.22;
  group.add(shield);
  for (const sx of [-0.99, 0.99]) {
    group.add(box(0.04, 0.4, 0.9, glass, sx, 1.35, 1.95));
  }
  // Cargo box: tall, ribbed, filling the rear two-thirds of the chassis.
  const cargo = box(2.05, 1.4, 3.3, paint, 0, 1.3, -1.05);
  cargo.castShadow = true;
  group.add(cargo);
  for (const sx of [-1.04, 1.04]) {
    for (const rz of [-2.3, -1.05, 0.2]) {
      group.add(box(0.04, 1.3, 0.1, trim, sx, 1.3, rz));
    }
  }
  // Rear roll-up door outline on the back of the cargo box.
  group.add(box(1.7, 1.15, 0.04, trim, 0, 1.3, -2.72));
  // Side steps under the cab doors.
  for (const sx of [-1.05, 1.05]) {
    group.add(box(0.3, 0.08, 0.9, trim, sx, 0.32, 1.95));
  }

  return {
    frontZ: 2.81, rearZ: -2.81, headY: 0.62, tailY: 0.7, roofY: 2.0,
    halfW: 1.0, wheelR: 0.44, wheelX: 0.92, wheelFrontZ: 2.0, wheelRearZ: -2.0,
    tailStyle: 'towers',
    police: { doorY: 0.7, doorZ: 1.95, doorLen: 1.3, barY: 1.84, barZ: 1.95 },
  };
}

// Bumpers front and rear, sized to the body. Grille on the nose for
// sedan + truck (the van's flat face is its grille).
function addBumpersAndGrille(group, mats, dims, variant) {
  const bumperGeo = new THREE.BoxGeometry(dims.halfW * 2 + 0.04, 0.18, 0.22);
  for (const z of [dims.frontZ, dims.rearZ]) {
    const bumper = new THREE.Mesh(bumperGeo, mats.trim);
    bumper.position.set(0, 0.38, z);
    group.add(bumper);
  }
  if (variant !== 'van') {
    group.add(box(1.1, 0.16, 0.06, mats.trim, 0, dims.headY, dims.frontZ + 0.01));
  }
}

// Headlights (emissive) + amber indicators, and the taillights. The
// taillight material is returned so the car can flare it while braking;
// it is NOT constant — see TAIL_DIM / TAIL_BRIGHT.
function addLights(group, dims) {
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff7cc, emissive: 0xffedb5, emissiveIntensity: 1.6 });
  const indicatorMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xf59e0b, emissiveIntensity: 0.9 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x7f1d1d, emissive: 0xef4444, emissiveIntensity: TAIL_DIM });
  const headGeo = new THREE.BoxGeometry(0.36, 0.14, 0.06);
  const indGeo = new THREE.BoxGeometry(0.16, 0.12, 0.06);
  for (const sx of [-0.62, 0.62]) {
    group.add(box(0.36, 0.14, 0.06, headMat, sx, dims.headY, dims.frontZ + 0.01));
    group.add(box(0.16, 0.12, 0.06, indicatorMat, sx * 1.45, dims.headY, dims.frontZ + 0.01));
  }
  if (dims.tailStyle === 'towers') {
    // Van + truck: tall vertical tail-light towers at the rear corners.
    for (const sx of [-0.8, 0.8]) {
      group.add(box(0.2, 0.5, 0.06, tailMat, sx, dims.tailY, dims.rearZ - 0.01));
    }
  } else {
    group.add(box(1.5, 0.14, 0.06, tailMat, 0, dims.tailY, dims.rearZ - 0.01));
  }
  return tailMat;
}

// Four wheels: tyre + alloy hubcap + dark centre cap, on steer pivots
// (front pivots steer, rears are fixed).
function addWheels(group, mats, dims) {
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
    const wheel = new THREE.Mesh(wheelGeo, mats.tyre);
    wheel.castShadow = true;
    pivot.add(wheel);
    pivot.add(new THREE.Mesh(hubGeo, mats.rim));
    pivot.add(new THREE.Mesh(capGeo, mats.trim));
    group.add(pivot);
    wheels.push(wheel);
    steerPivots.push(front ? pivot : null);
  }
  return { wheels, steerPivots };
}

// Police livery: white doors with a POLICE decal + roof light bar.
// Returns the bar materials so police.js can flash them.
function addPoliceKit(group, mats, dims) {
  const p = dims.police;
  const doorGeo = new THREE.BoxGeometry(0.04, 0.58, p.doorLen);
  for (const sx of [-1, 1]) {
    const door = new THREE.Mesh(doorGeo, mats.doorWhite);
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
  group.add(box(1.3, 0.1, 0.5, mats.trim, 0, p.barY, p.barZ));
  const barGeo = new THREE.BoxGeometry(0.55, 0.16, 0.44);
  const lightRed = new THREE.MeshStandardMaterial({
    color: 0xef4444, emissive: 0xef4444, emissiveIntensity: 2,
  });
  const lightBlue = new THREE.MeshStandardMaterial({
    color: 0x3b82f6, emissive: 0x3b82f6, emissiveIntensity: 2,
  });
  const red = new THREE.Mesh(barGeo, lightRed);
  red.position.set(-0.33, p.barY + 0.1, p.barZ);
  group.add(red);
  const blue = new THREE.Mesh(barGeo, lightBlue);
  blue.position.set(0.33, p.barY + 0.1, p.barZ);
  group.add(blue);
  return { lightRed, lightBlue };
}

// Visual detail lives here and nowhere else: paint + glass + trim +
// lights + wheels. `options.police` builds the black-and-white livery
// and returns the light-bar materials so police.js can flash them.
// `options.variant` picks the body: 'sedan' (default), 'van' or
// 'truck'. The physics in createCar/update below is untouched apart
// from the per-variant collision radius and wheel radius.
function buildCarMesh(color, options = {}) {
  const police = !!options.police;
  const variant = options.variant === 'van' || options.variant === 'truck'
    ? options.variant
    : 'sedan';
  const group = new THREE.Group();
  const mats = shellMaterials(color, police);

  // Each body builder adds its own shell to the group and returns the
  // dimensions the shared lights / wheels / police livery need:
  // frontZ/rearZ (nose/tail), headY/tailY (light height), roofY (top
  // of the roof), halfW (body half-width), wheelR/wheelX/wheelFrontZ/
  // wheelRearZ, tailStyle ('bar' or 'towers'), and the police door/bar
  // placement. Front faces +Z everywhere.
  let dims;
  if (variant === 'van') dims = buildVanBody(group, mats);
  else if (variant === 'truck') dims = buildTruckBody(group, mats);
  else dims = buildSedanBody(group, mats);

  addBumpersAndGrille(group, mats, dims, variant);
  const tailMat = addLights(group, dims);
  const { wheels, steerPivots } = addWheels(group, mats, dims);

  let lightRed = null;
  let lightBlue = null;
  if (police) {
    ({ lightRed, lightBlue } = addPoliceKit(group, mats, dims));
  }

  return {
    group, wheels, steerPivots, lightRed, lightBlue, tailMat,
    variant, wheelRadius: dims.wheelR,
    collisionRadius: BODY_RADIUS[variant],
  };
}

/** Push a circle (x, z, radius) out of every AABB it overlaps. Returns the corrected point + whether it hit. */
function pushCarOutOfBoxes(x, z, radius, boxes) {
  let hit = false;
  for (const box of boxes) {
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
      const left = x - box.min.x;
      const right = box.max.x - x;
      const near = z - box.min.z;
      const far = box.max.z - z;
      const shallowest = Math.min(left, right, near, far);
      if (shallowest === left) x = box.min.x - radius;
      else if (shallowest === right) x = box.max.x + radius;
      else if (shallowest === near) z = box.min.z - radius;
      else z = box.max.z + radius;
    }
  }
  return { x, z, hit };
}

export function createCar(scene, startPos, color = 0xef4444, options = {}) {
  const {
    group, wheels, steerPivots, lightRed, lightBlue, tailMat,
    variant, wheelRadius, collisionRadius,
  } = buildCarMesh(color, options);
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
      const topSpeed = onRoad ? ROAD_TOP_SPEED : DIRT_TOP_SPEED;

      const gas = input.isDown('KeyW') || input.isDown('ArrowUp');
      const brake = input.isDown('KeyS') || input.isDown('ArrowDown');
      const steerInput = (input.isDown('KeyA') || input.isDown('ArrowLeft') ? 1 : 0)
        - (input.isDown('KeyD') || input.isDown('ArrowRight') ? 1 : 0);

      if (gas) api.speed += ENGINE_ACCEL * dt;
      if (brake) {
        if (api.speed > 0.5) api.speed -= BRAKE_FORCE * dt;
        else api.speed -= REVERSE_FORCE * dt;
      }
      if (!gas && !brake) {
        // Coast down gently.
        api.speed -= api.speed * 0.4 * dt;
        if (Math.abs(api.speed) < 0.05) api.speed = 0;
      }
      // Drag + speed caps.
      api.speed *= Math.exp(-AERO_DRAG * dt);
      if (api.speed > topSpeed) api.speed = topSpeed;
      if (api.speed < -REVERSE_CAP) api.speed = -REVERSE_CAP;

      // Dynamic brake lights: flare while the brake pedal is down and
      // the car is still moving forward; dim running light otherwise.
      // This reads the same input the AI and the player use, so traffic
      // and police cars brake-light exactly like the player's car.
      api.braking = brake && api.speed > 0.2;
      tailMat.emissiveIntensity = api.braking ? TAIL_BRIGHT : TAIL_DIM;

      // Steering weakens at high speed so the car stays controllable.
      const wantSteer = steerInput * STEER_LIMIT / (1 + Math.abs(api.speed) * 0.055);
      api.steerAngle += (wantSteer - api.steerAngle) * Math.min(1, 10 * dt);
      api.heading += (api.speed / AXLE_SPACING) * Math.tan(api.steerAngle) * dt;
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
        const pushed = pushCarOutOfBoxes(nx, nz, collisionRadius, city.colliders);
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

    // Step out: the car is vacated AND parked. A driverless car does
    // not keep rolling — speed and steering are zeroed and the brake
    // lights go back to dim — so a normal exit and a death-eject both
    // leave the car exactly where it stopped, free for traffic (or the
    // player) to claim again. Idempotent.
    exit() {
      api.occupied = false;
      api.speed = 0;
      api.steerAngle = 0;
      api.braking = false;
      tailMat.emissiveIntensity = TAIL_DIM;
    },

    // Death-eject entry point (player.js ejectFromCar): the driver is
    // gone mid-crash, so the car is vacated and parked in place, never
    // left rolling with a ghost driver. Same mechanics as exit(), kept
    // as its own name so the death path reads as a death path.
    abandon() {
      api.exit();
    },
  };
  return api;
}
