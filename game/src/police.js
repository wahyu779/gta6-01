// AZURE BAY — police response (Lane C, Fase 2).
// Spawns and drives the wanted-level response: police cars that chase and
// ram the player, foot officers who chase and shoot, and a helicopter that
// circles overhead and opens fire at 5 stars. update() returns the HP
// damage dealt to the player this frame — main.js (Lane D) subtracts it
// from health. Browser ES modules only; no Node/Deno APIs.

import * as THREE from 'three';
import { createCar } from './car.js';
import { CONFIG } from './config.js';

const POLICE_BLUE = 0x1e3a8a;
// Lane E: the heli body does NOT use POLICE_BLUE. Navy 0x1e3a8a under the
// warm orange golden-hour sun (#ff9e45) loses its blue channel and the
// metalness 0.4 (with no env map) starves the diffuse — the flank raycast
// proved sunlit yet rendered dark warm brown (mean RGB ~119,92,74). A
// bright sky blue with metalness 0 / high roughness keeps the blue
// identity while the diffuse stays bright under the warm sun. The white
// stripe still reads against it. Police cars + officers keep POLICE_BLUE.
const HELI_BODY_BLUE = 0x7dd3fc;
const MAX_CARS = 3;          // 1 car per wanted level, capped at 3
const OFFICER_COUNT = 2;     // foot officers from level 2 up
const OFFICER_SPEED = 5;     // m/s on foot
const OFFICER_SHOOT_RANGE = 20; // m — officers open fire inside this
const OFFICER_DPS = 2;       // HP per second per officer in range
const HELI_DPS = 3;          // HP per second from the heli at level 5
const RAM_DAMAGE = 5;        // HP per police-car ram
const RAM_RANGE = 3;         // m — ramming distance
const RAM_COOLDOWN = 1.5;    // s between rams from the same car
const HELI_HEIGHT = 35;      // m above the ground
const HELI_RADIUS = 25;      // m circle around the player
const HELI_ORBIT = 0.35;     // rad/s around the player
const DESPAWN_DELAY = 3;     // s after wanted hits 0 before units leave
const SPAWN_CAR_DIST = 26;   // m from the player when a car spawns
const SPAWN_OFFICER_DIST = 16; // m from the player when an officer spawns

// Input object that presses nothing — used while the response stands down.
const IDLE_INPUT = { isDown: () => false };

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function randomOffset(dist) {
  const a = Math.random() * Math.PI * 2;
  return { x: Math.cos(a) * dist, z: Math.sin(a) * dist };
}

// Foot officer: the same proportional silhouette as the player, in a
// dark police-blue uniform with a peaked cap, a gold chest badge, a duty
// belt and black shoes. Visual only — chase/shoot logic lives in update().
function buildOfficerMesh() {
  const group = new THREE.Group();
  const uniform = new THREE.MeshStandardMaterial({ color: POLICE_BLUE, roughness: 0.85 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xe8b88a, roughness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.9 });
  const gold = new THREE.MeshStandardMaterial({
    color: 0xfbbf24, metalness: 0.8, roughness: 0.3, emissive: 0x92600a, emissiveIntensity: 0.3,
  });

  // Legs (hips ~0.83) + black shoes.
  const legGeo = new THREE.CapsuleGeometry(0.095, 0.55, 4, 8);
  const legL = new THREE.Mesh(legGeo, dark);
  legL.position.set(-0.13, 0.46, 0);
  group.add(legL);
  const legR = new THREE.Mesh(legGeo, dark);
  legR.position.set(0.13, 0.46, 0);
  group.add(legR);
  const shoeGeo = new THREE.BoxGeometry(0.17, 0.09, 0.32);
  for (const sx of [-0.13, 0.13]) {
    const shoe = new THREE.Mesh(shoeGeo, dark);
    shoe.position.set(sx, 0.045, 0.04);
    group.add(shoe);
  }

  // Torso (uniform): hips 0.83 to shoulders ~1.48.
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.25, 6, 12), uniform);
  body.position.y = 1.15;
  body.castShadow = true;
  group.add(body);

  // Gold badge on the left chest + a shoulder radio.
  const badge = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 12), gold);
  badge.rotation.x = Math.PI / 2;
  badge.position.set(-0.11, 1.32, 0.215);
  group.add(badge);
  const radio = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.14, 0.05), dark);
  radio.position.set(0.14, 1.38, 0.19);
  group.add(radio);

  // Duty belt.
  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.08, 0.3), dark);
  belt.position.y = 0.86;
  group.add(belt);

  // Neck + head.
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.1, 10), skin);
  neck.position.y = 1.52;
  group.add(neck);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.135, 20, 16), skin);
  head.position.y = 1.62;
  head.castShadow = true;
  group.add(head);

  // Peaked cap: flat crown + brim facing forward (+Z) + gold band.
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.155, 0.09, 16), dark);
  crown.position.y = 1.73;
  group.add(crown);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.155, 0.03, 16), gold);
  band.position.y = 1.7;
  group.add(band);
  const brim = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.14), dark);
  brim.position.set(0, 1.69, 0.15);
  group.add(brim);

  // Arms (shoulders ~1.42) ending in hands at ~0.82.
  const armGeo = new THREE.CapsuleGeometry(0.07, 0.45, 4, 8);
  const armL = new THREE.Mesh(armGeo, uniform);
  armL.position.set(-0.3, 1.14, 0);
  group.add(armL);
  const armR = new THREE.Mesh(armGeo, uniform);
  armR.position.set(0.3, 1.14, 0);
  group.add(armR);
  const handGeo = new THREE.SphereGeometry(0.075, 12, 10);
  const handL = new THREE.Mesh(handGeo, skin);
  handL.position.set(-0.3, 0.82, 0);
  group.add(handL);
  const handR = new THREE.Mesh(handGeo, skin);
  handR.position.set(0.3, 0.82, 0);
  group.add(handR);

  return group;
}

// Helicopter: box body with a white stripe, glass cockpit, cabin side
// windows + panel seams, engine deck, boom stripe and tail stabiliser,
// skids on struts, tail boom + fin + tail rotor, a searchlight under
// the nose, red/green navigation lights, and a 4-blade main rotor on a
// mast. Returns { group, rotor }.
function buildHeliMesh() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: HELI_BODY_BLUE, metalness: 0.0, roughness: 0.85,
  });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x0f172a, metalness: 0.2, roughness: 0.15,
  });
  const steel = new THREE.MeshStandardMaterial({
    color: 0x334155, roughness: 0.6, metalness: 0.5,
  });
  const white = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.5 });
  const navRed = new THREE.MeshStandardMaterial({
    color: 0xef4444, emissive: 0xef4444, emissiveIntensity: 1.5,
  });
  const navGreen = new THREE.MeshStandardMaterial({
    color: 0x22c55e, emissive: 0x22c55e, emissiveIntensity: 1.5,
  });
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0xfff7cc, emissive: 0xfff2a8, emissiveIntensity: 1.5,
  });

  const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.4, 4.6), bodyMat);
  body.castShadow = true;
  group.add(body);
  // White stripe along both flanks.
  const stripeGeo = new THREE.BoxGeometry(0.06, 0.3, 4.0);
  for (const sx of [-1.12, 1.12]) {
    const stripe = new THREE.Mesh(stripeGeo, white);
    stripe.position.set(sx, 0.1, 0);
    group.add(stripe);
  }
  // NIT-POLISH Lane C2: panel detail on the flanks. The body stays the
  // same bright sage (HELI_BODY_BLUE, metalness 0, roughness 0.85) —
  // these are small proud fittings, not a repaint. Cabin side windows
  // (glass, above the white stripe so nothing z-fights it) + a smaller
  // rear-cabin window, vertical panel seams and a low horizontal seam
  // in mid slate-blue. All sit just proud of the body face (x = +/-1.1).
  const seamMat = new THREE.MeshStandardMaterial({
    color: 0x5b7a99, metalness: 0.0, roughness: 0.8,
  });
  const sideWindowGeo = new THREE.BoxGeometry(0.05, 0.42, 1.0);
  const rearWindowGeo = new THREE.BoxGeometry(0.05, 0.4, 0.9);
  const vSeamGeo = new THREE.BoxGeometry(0.04, 1.1, 0.08);
  const hSeamGeo = new THREE.BoxGeometry(0.04, 0.07, 4.3);
  for (const sx of [-1, 1]) {
    const win = new THREE.Mesh(sideWindowGeo, glass);
    win.position.set(sx * 1.12, 0.48, 1.45);
    group.add(win);
    const rearWin = new THREE.Mesh(rearWindowGeo, glass);
    rearWin.position.set(sx * 1.12, 0.45, -0.9);
    group.add(rearWin);
    for (const sz of [0.3, -1.7]) {
      const seam = new THREE.Mesh(vSeamGeo, seamMat);
      seam.position.set(sx * 1.16, 0, sz);
      group.add(seam);
    }
    const hSeam = new THREE.Mesh(hSeamGeo, seamMat);
    hSeam.position.set(sx * 1.16, -0.45, 0);
    group.add(hSeam);
  }
  // Engine deck on the roof behind the mast + two rear exhaust stubs.
  // Steel-grey, small: the roof is barely visible from the low camera,
  // but the deck edge and exhausts read against the bright body.
  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.3, 1.8), steel);
  deck.position.set(0, 0.85, -0.4);
  group.add(deck);
  const exhaustGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.5, 10);
  for (const sx of [-0.45, 0.45]) {
    const exhaust = new THREE.Mesh(exhaustGeo, steel);
    exhaust.rotation.x = Math.PI / 2;
    exhaust.position.set(sx, 0.85, -1.45);
    group.add(exhaust);
  }
  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.9, 1.4), glass);
  cockpit.position.set(0, 0.2, 1.8);
  group.add(cockpit);
  // Searchlight under the nose.
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), lampMat);
  lamp.position.set(0, -0.75, 2.0);
  group.add(lamp);

  // Skids on four short struts.
  const skidGeo = new THREE.BoxGeometry(0.18, 0.18, 4.0);
  const strutGeo = new THREE.BoxGeometry(0.12, 0.5, 0.12);
  for (const sx of [-0.9, 0.9]) {
    const skid = new THREE.Mesh(skidGeo, steel);
    skid.position.set(sx, -0.95, 0);
    group.add(skid);
    for (const sz of [-1.2, 1.2]) {
      const strut = new THREE.Mesh(strutGeo, steel);
      strut.position.set(sx, -0.7, sz);
      group.add(strut);
    }
  }
  // Navigation lights on the skid tips: red port, green starboard.
  const navGeo = new THREE.SphereGeometry(0.09, 8, 8);
  const navL = new THREE.Mesh(navGeo, navRed);
  navL.position.set(-0.9, -0.95, 2.0);
  group.add(navL);
  const navR = new THREE.Mesh(navGeo, navGreen);
  navR.position.set(0.9, -0.95, 2.0);
  group.add(navR);

  const boom = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 3.4), bodyMat);
  boom.position.set(0, 0.2, -3.8);
  group.add(boom);
  // NIT-POLISH Lane C2: white stripe along the boom flanks (continues
  // the body stripe) + a horizontal stabiliser at the tail.
  const boomStripeGeo = new THREE.BoxGeometry(0.04, 0.18, 3.0);
  for (const sx of [-0.37, 0.37]) {
    const bs = new THREE.Mesh(boomStripeGeo, white);
    bs.position.set(sx, 0.2, -3.8);
    group.add(bs);
  }
  const stabiliser = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.08, 0.6), bodyMat);
  stabiliser.position.set(0, 0.35, -4.9);
  group.add(stabiliser);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.4, 0.9), bodyMat);
  fin.position.set(0, 0.8, -5.3);
  group.add(fin);
  // Tail rotor: small hub + two blades on the fin's left side.
  const tailHub = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.16, 8), steel);
  tailHub.rotation.z = Math.PI / 2;
  tailHub.position.set(-0.16, 0.8, -5.3);
  group.add(tailHub);
  const tailBlade = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.1, 0.12), steel);
  tailBlade.position.set(-0.26, 0.8, -5.3);
  group.add(tailBlade);

  const rotor = new THREE.Group();
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.7, 8), steel);
  mast.position.y = 0.9;
  rotor.add(mast);
  // Two crossed blades = a 4-blade rotor disc.
  const bladeGeo = new THREE.BoxGeometry(9, 0.08, 0.5);
  const bladeA = new THREE.Mesh(bladeGeo, steel);
  bladeA.position.y = 1.25;
  rotor.add(bladeA);
  const bladeB = new THREE.Mesh(bladeGeo, steel);
  bladeB.position.y = 1.25;
  bladeB.rotation.y = Math.PI / 2;
  rotor.add(bladeB);
  group.add(rotor);

  return { group, rotor };
}

export function createPolice(scene, city) {
  const cars = [];
  const officers = [];
  const api = { cars, officers, heli: null, update };

  let clearTimer = 0; // s since wanted hit 0 (despawn grace)
  let time = 0;       // s, drives the light-bar flash
  let heliAngle = 0;  // rad, heli position on its orbit circle

  // A spawn point `dist` metres from the player, on walkable land when
  // possible (a few random angles are tried before giving up).
  function spawnPointNear(playerPos, dist) {
    for (let i = 0; i < 6; i++) {
      const off = randomOffset(dist);
      const x = playerPos.x + off.x;
      const z = playerPos.z + off.z;
      if (!city || !city.isWalkable || city.isWalkable(x, z)) return { x, z };
    }
    const off = randomOffset(dist);
    return { x: playerPos.x + off.x, z: playerPos.z + off.z };
  }

  function spawnCar(playerPos) {
    const p = spawnPointNear(playerPos, SPAWN_CAR_DIST);
    // Police livery + roof light bar come from car.js ({ police: true });
    // the bar materials are flashed by flashLights() below. The response
    // is no longer all sedans: mostly patrol sedans, sometimes a police
    // van or a box truck (Lane D flawfix).
    const r = Math.random();
    const variant = r < 0.6 ? 'sedan' : r < 0.8 ? 'van' : 'truck';
    const car = createCar(scene, new THREE.Vector3(p.x, CONFIG.groundY, p.z), POLICE_BLUE, { police: true, variant });
    const unit = {
      car,
      /** Live world position (the car mesh position) — for the minimap. */
      position: car.position,
      lightRed: car.lightRed,
      lightBlue: car.lightBlue,
      ramCooldown: 0,
    };
    cars.push(unit);
    return unit;
  }

  function spawnOfficer(playerPos) {
    const p = spawnPointNear(playerPos, SPAWN_OFFICER_DIST);
    const mesh = buildOfficerMesh();
    mesh.position.set(p.x, CONFIG.groundY, p.z);
    scene.add(mesh);
    const officer = {
      /** Live world position (the officer mesh position) — for the minimap. */
      position: mesh.position,
      heading: 0,
      speed: 0,
      mesh,
      health: 100,
      alive: true,
    };
    officers.push(officer);
    return officer;
  }

  function spawnHeli(playerPos) {
    const { group, rotor } = buildHeliMesh();
    group.position.set(
      playerPos.x + HELI_RADIUS, CONFIG.groundY + HELI_HEIGHT, playerPos.z,
    );
    scene.add(group);
    api.heli = {
      /** Live world position (the heli group position) — for the minimap. */
      position: group.position,
      mesh: group,
      rotor,
    };
    return api.heli;
  }

  function removeCar(unit) {
    scene.remove(unit.car.mesh);
    const i = cars.indexOf(unit);
    if (i >= 0) cars.splice(i, 1);
  }

  function removeOfficer(officer) {
    scene.remove(officer.mesh);
    officer.alive = false;
    const i = officers.indexOf(officer);
    if (i >= 0) officers.splice(i, 1);
  }

  function removeHeli() {
    if (!api.heli) return;
    scene.remove(api.heli.mesh);
    api.heli = null;
  }

  function removeAll() {
    while (cars.length > 0) removeCar(cars[0]);
    while (officers.length > 0) removeOfficer(officers[0]);
    removeHeli();
  }

  // Match the live unit counts to the wanted level.
  function syncSpawns(level, playerPos) {
    const wantCars = level >= 1 ? Math.min(level, MAX_CARS) : 0;
    const wantOfficers = level >= 2 ? OFFICER_COUNT : 0;
    const wantHeli = level >= 4 ? 1 : 0;
    // Fase 4 (Lane A): a killed officer leaves the roster, so a fresh
    // one spawns while the heat is still on. Without this the two
    // officers from level 2 were the only ones a wanted episode ever
    // produced — combat.js hides a dead officer but leaves it in the
    // array, so `officers.length` never dropped below wantOfficers and
    // no replacement ever spawned. A combat stage needing 3-4 kills
    // could then only be finished by shooting pedestrians, and a
    // player who fought only the crew soft-locked the mission.
    for (let i = officers.length - 1; i >= 0; i--) {
      if (!officers[i].alive) removeOfficer(officers[i]);
    }
    while (cars.length < wantCars) spawnCar(playerPos);
    while (cars.length > wantCars) removeCar(cars[cars.length - 1]);
    while (officers.length < wantOfficers) spawnOfficer(playerPos);
    while (officers.length > wantOfficers) removeOfficer(officers[officers.length - 1]);
    if (wantHeli === 1 && !api.heli) spawnHeli(playerPos);
    if (wantHeli === 0 && api.heli) removeHeli();
  }

  // Alternate the red/blue roof lights, ~4 flashes per second.
  function flashLights(unit) {
    const redOn = Math.floor(time * 4) % 2 === 0;
    unit.lightRed.emissiveIntensity = redOn ? 2.5 : 0.25;
    unit.lightBlue.emissiveIntensity = redOn ? 0.25 : 2.5;
  }

  // Fake keyboard input for a police car: KeyW to chase, KeyA/KeyD to
  // steer toward the player, KeyS to brake when the player is behind us
  // so the car can turn around instead of circling at full speed.
  function chaseInput(unit, playerPos) {
    const dx = playerPos.x - unit.position.x;
    const dz = playerPos.z - unit.position.z;
    const dist = Math.hypot(dx, dz);
    const desired = Math.atan2(dx, dz);
    const diff = wrapAngle(desired - unit.car.heading);
    const keys = {};
    if (dist >= 10) keys.KeyW = true; // ease off the gas up close
    if (Math.abs(diff) > 2.4) {
      keys.KeyS = true; // brake, turn, then re-engage
    } else if (diff > 0.08) {
      keys.KeyA = true;
    } else if (diff < -0.08) {
      keys.KeyD = true;
    }
    return { input: { isDown: (code) => !!keys[code] }, dist, dx, dz };
  }

  function update(dt, cityArg, playerPos, player, wanted) {
    if (!(dt > 0)) return 0;
    time += dt;
    const level = wanted && typeof wanted.level === 'number' ? wanted.level : 0;
    const cityRef = cityArg || city;
    let damage = 0;

    if (level <= 0) {
      // Wanted cleared: the response stands down after a few seconds.
      // Units still on the scene idle meanwhile — cars coast to a stop,
      // officers hold position, nobody shoots.
      clearTimer += dt;
      if (clearTimer >= DESPAWN_DELAY) {
        removeAll();
        clearTimer = 0;
      } else {
        for (const unit of cars) {
          unit.car.update(dt, IDLE_INPUT, cityRef);
          flashLights(unit);
        }
      }
      return 0;
    }
    clearTimer = 0;
    syncSpawns(level, playerPos);

    // ---- police cars: chase the player, ram on contact ---------------------
    for (const unit of cars) {
      const { input, dist, dx, dz } = chaseInput(unit, playerPos);
      unit.car.update(dt, input, cityRef);
      flashLights(unit);

      unit.ramCooldown = Math.max(0, unit.ramCooldown - dt);
      if (dist < RAM_RANGE && unit.ramCooldown <= 0) {
        damage += RAM_DAMAGE;
        unit.ramCooldown = RAM_COOLDOWN;
        // Shove an on-foot player away from the bumper. In a car the
        // damage alone is the hit (main.js mirrors the car position).
        if (player && !player.isInCar && dist > 0.01) {
          playerPos.x += (dx / dist) * 1.6;
          playerPos.z += (dz / dist) * 1.6;
        }
      }
    }

    // ---- foot officers: chase on foot, shoot inside 20 m -------------------
    for (const officer of officers) {
      if (!officer.alive) continue;
      const dx = playerPos.x - officer.position.x;
      const dz = playerPos.z - officer.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.5) {
        const step = OFFICER_SPEED * dt;
        const nx = officer.position.x + (dx / dist) * step;
        const nz = officer.position.z + (dz / dist) * step;
        // Stay on land; slide along one axis if the other is blocked.
        if (cityRef && cityRef.isWalkable) {
          if (cityRef.isWalkable(nx, officer.position.z)) officer.position.x = nx;
          if (cityRef.isWalkable(officer.position.x, nz)) officer.position.z = nz;
        } else {
          officer.position.x = nx;
          officer.position.z = nz;
        }
        officer.heading = Math.atan2(dx, dz);
        officer.mesh.rotation.y = officer.heading;
        officer.speed = OFFICER_SPEED;
      } else {
        officer.speed = 0;
      }
      officer.position.y = CONFIG.groundY;
      if (dist <= OFFICER_SHOOT_RANGE) damage += OFFICER_DPS * dt;
    }

    // ---- helicopter: orbit the player, shoot at 5 stars ---------------------
    if (api.heli) {
      heliAngle += HELI_ORBIT * dt;
      const hx = playerPos.x + Math.cos(heliAngle) * HELI_RADIUS;
      const hz = playerPos.z + Math.sin(heliAngle) * HELI_RADIUS;
      api.heli.position.set(hx, CONFIG.groundY + HELI_HEIGHT, hz);
      // Face along the orbit tangent.
      api.heli.mesh.rotation.y = Math.atan2(-Math.sin(heliAngle), Math.cos(heliAngle));
      api.heli.rotor.rotation.y += dt * 25;
      if (level >= 5) damage += HELI_DPS * dt;
    }

    return damage;
  }

  return api;
}
