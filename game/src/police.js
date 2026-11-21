// AZURE BAY — police response, rewritten round 2.
// Spawns and drives the wanted-level response: police cars that chase
// and ram the player, foot officers who chase and shoot, and a
// helicopter that circles overhead and opens fire at 5 stars. update()
// returns the HP damage dealt to the player this frame — main.js
// subtracts it from health. Browser ES modules only; no Node/Deno APIs.
//
// Round-2 robustness:
//   - DEATH: when the player is dead (player.alive === false, set by
//     player.js markDead()), the response stands down at once — no
//     damage, no fresh spawns, units idle — instead of shooting a
//     corpse while the death flow runs. The stand-down also covers
//     the death-in-a-car eject: the abandoned car is never rammed
//     as if the player were still driving it.
//   - SPAWN HYSTERESIS: unit counts are only re-evaluated on a short
//     timer, never every frame, so a one-frame wanted flicker cannot
//     spawn a car and despawn it again in the same second.
//   - Dead officers are pruned before the roster is counted, so a
//     killed officer is replaced while the heat is still on (a combat
//     stage needing 3-4 kills can never soft-lock for lack of targets).

import * as THREE from 'three';
import { createCar } from './car.js';
import { CONFIG } from './config.js';

const UNIFORM_BLUE = 0x1e3a8a;
// The heli body does NOT use UNIFORM_BLUE. Navy 0x1e3a8a under the warm
// orange golden-hour sun (#ff9e45) loses its blue channel and the
// metalness 0.4 (with no env map) starves the diffuse — the flank
// raycast proved sunlit yet rendered dark warm brown (mean RGB
// ~119,92,74). A bright sky blue with metalness 0 / high roughness
// keeps the blue identity while the diffuse stays bright under the
// warm sun. The white stripe still reads against it. Police cars +
// officers keep UNIFORM_BLUE.
const HELI_SKY_BLUE = 0x7dd3fc;
const CAR_CAP = 3;            // 1 car per wanted level, capped at 3
const FOOT_OFFICERS = 2;      // foot officers from level 2 up
const OFFICER_PACE = 5;       // m/s on foot
const OFFICER_FIRE_RANGE = 20; // m — officers open fire inside this
const OFFICER_DPS = 2;        // HP per second per officer in range
const HELI_DPS = 3;           // HP per second from the heli at level 5
const RAM_HIT_DAMAGE = 5;     // HP per police-car ram
const RAM_HIT_RANGE = 3;      // m — ramming distance
const RAM_RECHARGE = 1.5;     // s between rams from the same car
const HELI_ALTITUDE = 35;     // m above the ground
const HELI_CIRCLE = 25;       // m circle around the player
const HELI_ORBIT_SPEED = 0.35; // rad/s around the player
const STAND_DOWN_DELAY = 3;   // s after wanted hits 0 before units leave
const CAR_SPAWN_DIST = 26;    // m from the player when a car spawns
const OFFICER_SPAWN_DIST = 16; // m from the player when an officer spawns
const SYNC_EVERY = 0.4;       // s between spawn-count re-evaluations

// Input object that presses nothing — used while the response stands down.
const NO_INPUT = { isDown: () => false };

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function randomOffset(dist) {
  const a = Math.random() * Math.PI * 2;
  return { x: Math.cos(a) * dist, z: Math.sin(a) * dist };
}

// Small helper: a box mesh placed at (x, y, z) and added to the group.
function part(group, geo, mat, x, y, z) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  group.add(m);
  return m;
}

// Foot officer: the same proportional silhouette as the player, in a
// dark police-blue uniform with a peaked cap, a gold chest badge, a
// duty belt and black shoes. Visual only — chase/shoot logic lives in
// update().
function buildOfficerFigure() {
  const group = new THREE.Group();
  const uniform = new THREE.MeshStandardMaterial({ color: UNIFORM_BLUE, roughness: 0.85 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xe8b88a, roughness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.9 });
  const gold = new THREE.MeshStandardMaterial({
    color: 0xfbbf24, metalness: 0.8, roughness: 0.3, emissive: 0x92600a, emissiveIntensity: 0.3,
  });

  // Legs (hips ~0.83) + black shoes.
  const legGeo = new THREE.CapsuleGeometry(0.095, 0.55, 4, 8);
  part(group, legGeo, dark, -0.13, 0.46, 0);
  part(group, legGeo, dark, 0.13, 0.46, 0);
  const shoeGeo = new THREE.BoxGeometry(0.17, 0.09, 0.32);
  for (const sx of [-0.13, 0.13]) {
    part(group, shoeGeo, dark, sx, 0.045, 0.04);
  }

  // Torso (uniform): hips 0.83 to shoulders ~1.48.
  const torso = part(group, new THREE.CapsuleGeometry(0.22, 0.25, 6, 12), uniform, 0, 1.15, 0);
  torso.castShadow = true;

  // Gold badge on the left chest + a shoulder radio.
  const badge = part(group, new THREE.CylinderGeometry(0.05, 0.05, 0.02, 12), gold, -0.11, 1.32, 0.215);
  badge.rotation.x = Math.PI / 2;
  part(group, new THREE.BoxGeometry(0.09, 0.14, 0.05), dark, 0.14, 1.38, 0.19);

  // Duty belt.
  part(group, new THREE.BoxGeometry(0.46, 0.08, 0.3), dark, 0, 0.86, 0);

  // Neck + head.
  part(group, new THREE.CylinderGeometry(0.06, 0.07, 0.1, 10), skin, 0, 1.52, 0);
  const head = part(group, new THREE.SphereGeometry(0.135, 20, 16), skin, 0, 1.62, 0);
  head.castShadow = true;

  // Peaked cap: flat crown + brim facing forward (+Z) + gold band.
  part(group, new THREE.CylinderGeometry(0.15, 0.155, 0.09, 16), dark, 0, 1.73, 0);
  part(group, new THREE.CylinderGeometry(0.155, 0.155, 0.03, 16), gold, 0, 1.7, 0);
  part(group, new THREE.BoxGeometry(0.2, 0.03, 0.14), dark, 0, 1.69, 0.15);

  // Arms (shoulders ~1.42) ending in hands at ~0.82.
  const armGeo = new THREE.CapsuleGeometry(0.07, 0.45, 4, 8);
  part(group, armGeo, uniform, -0.3, 1.14, 0);
  part(group, armGeo, uniform, 0.3, 1.14, 0);
  const handGeo = new THREE.SphereGeometry(0.075, 12, 10);
  part(group, handGeo, skin, -0.3, 0.82, 0);
  part(group, handGeo, skin, 0.3, 0.82, 0);

  return group;
}

// Helicopter: box body with a white stripe, glass cockpit, cabin side
// windows + panel seams, engine deck, boom stripe and tail stabiliser,
// skids on struts, tail boom + fin + tail rotor, a searchlight under
// the nose, red/green navigation lights, and a 4-blade main rotor on a
// mast. Returns { group, rotor }.
function buildHeliFigure() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: HELI_SKY_BLUE, metalness: 0.0, roughness: 0.85,
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
  const seamMat = new THREE.MeshStandardMaterial({
    color: 0x5b7a99, metalness: 0.0, roughness: 0.8,
  });

  const body = part(group, new THREE.BoxGeometry(2.2, 1.4, 4.6), bodyMat, 0, 0, 0);
  body.castShadow = true;
  // White stripe along both flanks.
  for (const sx of [-1.12, 1.12]) {
    part(group, new THREE.BoxGeometry(0.06, 0.3, 4.0), white, sx, 0.1, 0);
  }
  // Cabin side windows (glass, above the white stripe so nothing
  // z-fights it) + a smaller rear-cabin window, vertical panel seams
  // and a low horizontal seam in mid slate-blue. All sit just proud
  // of the body face (x = +/-1.1).
  for (const sx of [-1, 1]) {
    part(group, new THREE.BoxGeometry(0.05, 0.42, 1.0), glass, sx * 1.12, 0.48, 1.45);
    part(group, new THREE.BoxGeometry(0.05, 0.4, 0.9), glass, sx * 1.12, 0.45, -0.9);
    for (const sz of [0.3, -1.7]) {
      part(group, new THREE.BoxGeometry(0.04, 1.1, 0.08), seamMat, sx * 1.16, 0, sz);
    }
    part(group, new THREE.BoxGeometry(0.04, 0.07, 4.3), seamMat, sx * 1.16, -0.45, 0);
  }
  // Engine deck on the roof behind the mast + two rear exhaust stubs.
  part(group, new THREE.BoxGeometry(1.5, 0.3, 1.8), steel, 0, 0.85, -0.4);
  const exhaustGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.5, 10);
  for (const sx of [-0.45, 0.45]) {
    const exhaust = part(group, exhaustGeo, steel, sx, 0.85, -1.45);
    exhaust.rotation.x = Math.PI / 2;
  }
  part(group, new THREE.BoxGeometry(2.0, 0.9, 1.4), glass, 0, 0.2, 1.8);
  // Searchlight under the nose.
  part(group, new THREE.SphereGeometry(0.22, 12, 10), lampMat, 0, -0.75, 2.0);

  // Skids on four short struts.
  const skidGeo = new THREE.BoxGeometry(0.18, 0.18, 4.0);
  const strutGeo = new THREE.BoxGeometry(0.12, 0.5, 0.12);
  for (const sx of [-0.9, 0.9]) {
    part(group, skidGeo, steel, sx, -0.95, 0);
    for (const sz of [-1.2, 1.2]) {
      part(group, strutGeo, steel, sx, -0.7, sz);
    }
  }
  // Navigation lights on the skid tips: red port, green starboard.
  const navGeo = new THREE.SphereGeometry(0.09, 8, 8);
  part(group, navGeo, navRed, -0.9, -0.95, 2.0);
  part(group, navGeo, navGreen, 0.9, -0.95, 2.0);

  // Tail boom + white stripe along its flanks + horizontal stabiliser.
  part(group, new THREE.BoxGeometry(0.7, 0.7, 3.4), bodyMat, 0, 0.2, -3.8);
  for (const sx of [-0.37, 0.37]) {
    part(group, new THREE.BoxGeometry(0.04, 0.18, 3.0), white, sx, 0.2, -3.8);
  }
  part(group, new THREE.BoxGeometry(2.2, 0.08, 0.6), bodyMat, 0, 0.35, -4.9);
  part(group, new THREE.BoxGeometry(0.2, 1.4, 0.9), bodyMat, 0, 0.8, -5.3);
  // Tail rotor: small hub + two blades on the fin's left side.
  const tailHub = part(group, new THREE.CylinderGeometry(0.08, 0.08, 0.16, 8), steel, -0.16, 0.8, -5.3);
  tailHub.rotation.z = Math.PI / 2;
  part(group, new THREE.BoxGeometry(0.06, 1.1, 0.12), steel, -0.26, 0.8, -5.3);

  const rotor = new THREE.Group();
  part(rotor, new THREE.CylinderGeometry(0.12, 0.12, 0.7, 8), steel, 0, 0.9, 0);
  // Two crossed blades = a 4-blade rotor disc.
  const bladeGeo = new THREE.BoxGeometry(9, 0.08, 0.5);
  part(rotor, bladeGeo, steel, 0, 1.25, 0);
  const bladeB = part(rotor, bladeGeo, steel, 0, 1.25, 0);
  bladeB.rotation.y = Math.PI / 2;
  group.add(rotor);

  return { group, rotor };
}

export function createPolice(scene, city) {
  const cars = [];
  const officers = [];
  const api = { cars, officers, heli: null, update };

  let clearTimer = 0; // s since wanted hit 0 (despawn grace)
  let clock = 0;      // s, drives the light-bar flash
  let heliAngle = 0;  // rad, heli position on its orbit circle
  let syncTimer = 0;  // s since the spawn roster was last re-evaluated

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
    const p = spawnPointNear(playerPos, CAR_SPAWN_DIST);
    // Police livery + roof light bar come from car.js ({ police: true });
    // the bar materials are flashed by flashLights() below. The response
    // is no longer all sedans: mostly patrol sedans, sometimes a police
    // van or a box truck.
    const r = Math.random();
    const variant = r < 0.6 ? 'sedan' : r < 0.8 ? 'van' : 'truck';
    const car = createCar(scene, new THREE.Vector3(p.x, CONFIG.groundY, p.z), UNIFORM_BLUE, { police: true, variant });
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
    const p = spawnPointNear(playerPos, OFFICER_SPAWN_DIST);
    const mesh = buildOfficerFigure();
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
    const { group, rotor } = buildHeliFigure();
    group.position.set(
      playerPos.x + HELI_CIRCLE, CONFIG.groundY + HELI_ALTITUDE, playerPos.z,
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

  // Match the live unit counts to the wanted level. Only called from
  // the sync timer, never every frame, so a one-frame level flicker
  // cannot spawn and despawn a unit in the same second.
  function syncSpawns(level, playerPos) {
    const wantCars = level >= 1 ? Math.min(level, CAR_CAP) : 0;
    const wantOfficers = level >= 2 ? FOOT_OFFICERS : 0;
    const wantHeli = level >= 4 ? 1 : 0;
    // A killed officer leaves the roster, so a fresh one spawns while
    // the heat is still on. Without this the two officers from level 2
    // were the only ones a wanted episode ever produced — combat.js
    // hides a dead officer but leaves it in the array, so
    // `officers.length` never dropped below wantOfficers and no
    // replacement ever spawned. A combat stage needing 3-4 kills could
    // then only be finished by shooting pedestrians, and a player who
    // fought only the crew soft-locked the mission.
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
    const redOn = Math.floor(clock * 4) % 2 === 0;
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
    clock += dt;
    const level = wanted && typeof wanted.level === 'number' ? wanted.level : 0;
    const cityRef = cityArg || city;
    let damage = 0;

    // The player is dead (player.js markDead()): the response stands
    // down at once. No damage, no fresh spawns, no ramming the
    // abandoned car as if the player were still driving it — the
    // units already out just idle until the death flow finishes.
    if (player && player.alive === false) {
      for (const unit of cars) {
        unit.car.update(dt, NO_INPUT, cityRef);
        flashLights(unit);
      }
      return 0;
    }

    if (level <= 0) {
      // Wanted cleared: the response stands down after a few seconds.
      // Units still on the scene idle meanwhile — cars coast to a stop,
      // officers hold position, nobody shoots.
      clearTimer += dt;
      if (clearTimer >= STAND_DOWN_DELAY) {
        removeAll();
        clearTimer = 0;
      } else {
        for (const unit of cars) {
          unit.car.update(dt, NO_INPUT, cityRef);
          flashLights(unit);
        }
      }
      return 0;
    }
    clearTimer = 0;
    syncTimer += dt;
    if (syncTimer >= SYNC_EVERY) {
      syncTimer = 0;
      syncSpawns(level, playerPos);
    }

    // ---- police cars: chase the player, ram on contact ---------------------
    for (const unit of cars) {
      const { input, dist, dx, dz } = chaseInput(unit, playerPos);
      unit.car.update(dt, input, cityRef);
      flashLights(unit);

      unit.ramCooldown = Math.max(0, unit.ramCooldown - dt);
      if (dist < RAM_HIT_RANGE && unit.ramCooldown <= 0) {
        damage += RAM_HIT_DAMAGE;
        unit.ramCooldown = RAM_RECHARGE;
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
        const step = OFFICER_PACE * dt;
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
        officer.speed = OFFICER_PACE;
      } else {
        officer.speed = 0;
      }
      officer.position.y = CONFIG.groundY;
      if (dist <= OFFICER_FIRE_RANGE) damage += OFFICER_DPS * dt;
    }

    // ---- helicopter: orbit the player, shoot at 5 stars ---------------------
    if (api.heli) {
      heliAngle += HELI_ORBIT_SPEED * dt;
      const hx = playerPos.x + Math.cos(heliAngle) * HELI_CIRCLE;
      const hz = playerPos.z + Math.sin(heliAngle) * HELI_CIRCLE;
      api.heli.position.set(hx, CONFIG.groundY + HELI_ALTITUDE, hz);
      // Face along the orbit tangent.
      api.heli.mesh.rotation.y = Math.atan2(-Math.sin(heliAngle), Math.cos(heliAngle));
      api.heli.rotor.rotation.y += dt * 25;
      if (level >= 5) damage += HELI_DPS * dt;
    }

    return damage;
  }

  return api;
}
