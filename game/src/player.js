// On-foot player for Azure Bay, rewritten round 2.
// A stylised pedestrian who walks and runs relative to the camera yaw,
// slides out of building colliders, and cannot walk into the water.
// Climbing into a car hides the mesh until the player steps out again.
//
// DEATH IN A CAR (round-2 fix): the old exit path assumed the player
// always stepped out calmly at low speed through main.js, so a death
// while driving could leave the driving state half-torn-down — the
// player mesh hidden, isInCar still true, and the car still marked
// occupied with nobody in it (a "ghost driver"). This rewrite makes
// the car state single-sourced and idempotent:
//   - enterCar() / exitCar() are safe to call twice; exitCar() always
//     restores the mesh, zeroes the velocity and clears isInCar, and
//     falls back to the remembered car when the caller passes none.
//   - ejectFromCar() is the dedicated death path: it ejects the player
//     to the kerb beside the car on foot and tells the car to abandon
//     itself (car.js: occupied=false, speed zeroed, parked in place),
//     so no ghost state can survive a death while driving.
//   - respawnOnFoot() is the respawn path: it forces every on-foot
//     invariant at once (visible, on foot, still, facing a heading).
//   - alive / markDead() / revive() let the police response stand down
//     the moment the player dies instead of shooting a corpse.

import * as THREE from 'three';
import { CONFIG } from './config.js';

const PACE_WALK = 4;
const PACE_RUN = 8;
const ACCEL_RATE = 24;
const BODY_HEIGHT = 1.8;
const BODY_RADIUS = 0.35;
const EXIT_SIDE_METRES = 2.2;

function blobShadow() {
  const geo = new THREE.CircleGeometry(0.55, 24);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });
  const shadow = new THREE.Mesh(geo, mat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  return shadow;
}

// One capsule limb (leg / arm) at a fixed offset, sharing one geometry
// and material across the left/right pair.
function pairedLimbs(group, geo, mat, y, xOffsets) {
  for (const offX of xOffsets) {
    const limb = new THREE.Mesh(geo, mat);
    limb.position.set(offX, y, 0);
    group.add(limb);
  }
}

// Proportional stylised human, ~1.78 m tall: head ~1/7 of height, legs
// ~45%, a zippered jacket torso, arms ending in hands, shoes on the
// feet. Visual only — movement lives in update() below.
function buildFigure() {
  const group = new THREE.Group();

  const jacket = new THREE.MeshStandardMaterial({ color: 0x14b8a6, roughness: 0.8 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xe8b88a, roughness: 0.7 });
  const trousers = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.9 });
  const hairMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.95 });
  const shoeMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.85 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x0f766e, roughness: 0.8 });

  // Legs (hips ~0.83) + shoes.
  pairedLimbs(group, new THREE.CapsuleGeometry(0.095, 0.55, 4, 8), trousers, 0.46, [-0.13, 0.13]);
  const shoeGeo = new THREE.BoxGeometry(0.17, 0.09, 0.32);
  for (const sx of [-0.13, 0.13]) {
    const shoe = new THREE.Mesh(shoeGeo, shoeMat);
    shoe.position.set(sx, 0.045, 0.04);
    group.add(shoe);
  }

  // Torso (jacket): hips 0.83 to shoulders ~1.48.
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.25, 6, 12), jacket);
  torso.position.y = 1.15;
  torso.castShadow = true;
  group.add(torso);
  // Zipper strip + collar down the front of the jacket.
  const zip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.02), trimMat);
  zip.position.set(0, 1.15, 0.215);
  group.add(zip);
  const collar = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.07, 0.05), trimMat);
  collar.position.set(0, 1.47, 0.16);
  group.add(collar);

  // Neck + head + hair cap.
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.1, 10), skin);
  neck.position.y = 1.52;
  group.add(neck);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.135, 20, 16), skin);
  head.position.y = 1.62;
  head.castShadow = true;
  group.add(head);
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.14, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.45), hairMat);
  hair.position.y = 1.65;
  group.add(hair);

  // Arms (shoulders ~1.42) ending in hands at ~0.82.
  pairedLimbs(group, new THREE.CapsuleGeometry(0.07, 0.45, 4, 8), jacket, 1.14, [-0.3, 0.3]);
  const handGeo = new THREE.SphereGeometry(0.075, 12, 10);
  for (const sx of [-0.3, 0.3]) {
    const hand = new THREE.Mesh(handGeo, skin);
    hand.position.set(sx, 0.82, 0);
    group.add(hand);
  }

  group.add(blobShadow());
  return group;
}

/** Push a circle (x, z, radius) out of every AABB it overlaps. Returns the corrected point + whether it hit. */
function pushOutOfBoxes(x, z, radius, boxes) {
  let hit = false;
  for (const box of boxes) {
    if (box.max.y < 0 || box.min.y > BODY_HEIGHT) continue;
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
      // Centre is inside the box: shove out along the shallowest axis.
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

export function createPlayer(scene, startPos) {
  const mesh = buildFigure();
  mesh.position.copy(startPos);
  scene.add(mesh);

  const velocity = new THREE.Vector3();
  // The car the player is currently riding in (null on foot). The
  // single source of truth for "which car am I in": exit paths fall
  // back to it when the caller passes no car, so a death-eject can
  // never lose track of the car and leave it occupied by a ghost.
  let drivingCar = null;
  let alive = true;

  const api = {
    mesh,
    /** The player's world position (the mesh position). */
    position: mesh.position,
    /** Facing angle in radians; 0 faces +Z. */
    heading: 0,
    /** Current ground speed in m/s. */
    speed: 0,
    isInCar: false,
    /** False once the player dies, until revive(). Police stand down on it. */
    get alive() { return alive; },
    /** The car being driven right now, or null on foot. */
    get drivingCar() { return drivingCar; },

    update(dt, input, city, yaw) {
      if (api.isInCar || !alive) {
        velocity.set(0, 0, 0);
        api.speed = 0;
        return;
      }
      // Camera-relative move axes. Forward is where the camera looks.
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      const fwd = { x: -sin, z: -cos };
      const side = { x: cos, z: -sin };

      let mx = 0;
      let mz = 0;
      if (input.isDown('KeyW') || input.isDown('ArrowUp')) { mx += fwd.x; mz += fwd.z; }
      if (input.isDown('KeyS') || input.isDown('ArrowDown')) { mx -= fwd.x; mz -= fwd.z; }
      if (input.isDown('KeyD') || input.isDown('ArrowRight')) { mx += side.x; mz += side.z; }
      if (input.isDown('KeyA') || input.isDown('ArrowLeft')) { mx -= side.x; mz -= side.z; }

      const moving = mx !== 0 || mz !== 0;
      if (moving) {
        const len = Math.hypot(mx, mz);
        mx /= len;
        mz /= len;
      }
      const sprinting = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
      const targetSpeed = moving ? (sprinting ? PACE_RUN : PACE_WALK) : 0;
      const t = Math.min(1, ACCEL_RATE * dt);
      velocity.x += (mx * targetSpeed - velocity.x) * t;
      velocity.z += (mz * targetSpeed - velocity.z) * t;
      api.speed = Math.hypot(velocity.x, velocity.z);

      // Step, refusing any axis that would leave walkable land (water).
      let nx = mesh.position.x + velocity.x * dt;
      let nz = mesh.position.z + velocity.z * dt;
      if (city && city.isWalkable) {
        if (!city.isWalkable(nx, mesh.position.z)) nx = mesh.position.x;
        if (!city.isWalkable(nx, nz)) nz = mesh.position.z;
      }
      const pushed = city && city.colliders
        ? pushOutOfBoxes(nx, nz, BODY_RADIUS, city.colliders)
        : { x: nx, z: nz };
      mesh.position.x = pushed.x;
      mesh.position.z = pushed.z;

      // Face the direction of travel, turning smoothly.
      if (api.speed > 0.4) {
        const wantHeading = Math.atan2(velocity.x, velocity.z);
        let diff = wantHeading - api.heading;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        api.heading += diff * Math.min(1, 12 * dt);
        mesh.rotation.y = api.heading;
      }

      // Simple walk bob, on top of the ground level (island/road/bridge top).
      const bob = api.speed > 0.4
        ? Math.sin(performance.now() * 0.012) * 0.03 * (api.speed / PACE_RUN)
        : 0;
      mesh.position.y = CONFIG.groundY + bob;
    },

    enterCar(car) {
      if (api.isInCar) return;
      api.isInCar = true;
      drivingCar = car || null;
      mesh.visible = false;
      velocity.set(0, 0, 0);
      api.speed = 0;
    },

    exitCar(car) {
      // Idempotent: stepping out twice, or stepping out after a death
      // eject already did it, is a no-op instead of a teleport.
      if (!api.isInCar && !drivingCar) return;
      const ride = car || drivingCar;
      api.isInCar = false;
      drivingCar = null;
      mesh.visible = true;
      velocity.set(0, 0, 0);
      api.speed = 0;
      if (ride && ride.position && Number.isFinite(ride.heading)) {
        // Step out on the car's left side.
        const rx = Math.cos(ride.heading);
        const rz = -Math.sin(ride.heading);
        mesh.position.set(
          ride.position.x + rx * EXIT_SIDE_METRES,
          CONFIG.groundY,
          ride.position.z + rz * EXIT_SIDE_METRES,
        );
        api.heading = ride.heading;
        mesh.rotation.y = api.heading;
      } else {
        // No car to step out of (already ejected by another path):
        // just stand up where we are instead of teleporting nowhere.
        mesh.position.y = CONFIG.groundY;
      }
    },

    // Death while driving: eject the player to the kerb beside the car
    // and park the car in place. The car is told to abandon itself
    // (car.js: occupied=false, speed zeroed) so it can never keep
    // rolling with a dead driver, and the player is guaranteed on foot
    // afterwards — no hidden mesh, no stale isInCar, no ghost driver.
    // Returns the spot the player lands on, or null when not in a car.
    ejectFromCar(car) {
      const ride = car || drivingCar;
      if (!api.isInCar && !ride) return null;
      api.exitCar(ride);
      if (ride && typeof ride.abandon === 'function') ride.abandon();
      return { x: mesh.position.x, z: mesh.position.z };
    },

    // Respawn helper: force every on-foot invariant at once at (x, z).
    // Used by the death flow so a respawn can never leave the player
    // hidden inside a car they no longer drive.
    respawnOnFoot(x, z, heading) {
      api.isInCar = false;
      drivingCar = null;
      mesh.visible = true;
      velocity.set(0, 0, 0);
      api.speed = 0;
      mesh.position.set(x, CONFIG.groundY, z);
      api.heading = Number.isFinite(heading) ? heading : 0;
      mesh.rotation.y = api.heading;
    },

    markDead() {
      alive = false;
      velocity.set(0, 0, 0);
      api.speed = 0;
    },

    revive() {
      alive = true;
    },
  };
  return api;
}
