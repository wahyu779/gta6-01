// On-foot player for Azure Bay: a stylized pedestrian who walks and runs
// relative to the camera yaw, collides with city buildings, and cannot walk
// into the water. Entering a car hides the mesh until the player exits.

import * as THREE from 'three';
import { CONFIG } from './config.js';

const WALK_SPEED = 4;
const RUN_SPEED = 8;
const ACCEL = 24;
const PLAYER_HEIGHT = 1.8;
const PLAYER_RADIUS = 0.35;

function makeBlobShadow() {
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

// Proportional stylised human, ~1.78 m tall: head ~1/7 of height,
// legs ~45%, torso with a zipper + collar, arms ending in hands,
// shoes on the feet. Visual only — movement lives in update() below.
function buildMesh() {
  const group = new THREE.Group();

  const jacket = new THREE.MeshStandardMaterial({ color: 0x14b8a6, roughness: 0.8 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xe8b88a, roughness: 0.7 });
  const pants = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.9 });
  const hair = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.95 });
  const shoeMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.85 });
  const darkTrim = new THREE.MeshStandardMaterial({ color: 0x0f766e, roughness: 0.8 });

  // Legs (hips ~0.83) + shoes.
  const legGeo = new THREE.CapsuleGeometry(0.095, 0.55, 4, 8);
  const legL = new THREE.Mesh(legGeo, pants);
  legL.position.set(-0.13, 0.46, 0);
  group.add(legL);
  const legR = new THREE.Mesh(legGeo, pants);
  legR.position.set(0.13, 0.46, 0);
  group.add(legR);
  const shoeGeo = new THREE.BoxGeometry(0.17, 0.09, 0.32);
  for (const sx of [-0.13, 0.13]) {
    const shoe = new THREE.Mesh(shoeGeo, shoeMat);
    shoe.position.set(sx, 0.045, 0.04);
    group.add(shoe);
  }

  // Torso (jacket): hips 0.83 to shoulders ~1.48.
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.25, 6, 12), jacket);
  body.position.y = 1.15;
  body.castShadow = true;
  group.add(body);
  // Zipper strip + collar down the front of the jacket.
  const zipper = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.02), darkTrim);
  zipper.position.set(0, 1.15, 0.215);
  group.add(zipper);
  const collar = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.07, 0.05), darkTrim);
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
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.14, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.45), hair);
  cap.position.y = 1.65;
  group.add(cap);

  // Arms (shoulders ~1.42) ending in hands at ~0.82.
  const armGeo = new THREE.CapsuleGeometry(0.07, 0.45, 4, 8);
  const armL = new THREE.Mesh(armGeo, jacket);
  armL.position.set(-0.3, 1.14, 0);
  group.add(armL);
  const armR = new THREE.Mesh(armGeo, jacket);
  armR.position.set(0.3, 1.14, 0);
  group.add(armR);
  const handGeo = new THREE.SphereGeometry(0.075, 12, 10);
  const handL = new THREE.Mesh(handGeo, skin);
  handL.position.set(-0.3, 0.82, 0);
  group.add(handL);
  const handR = new THREE.Mesh(handGeo, skin);
  handR.position.set(0.3, 0.82, 0);
  group.add(handR);

  group.add(makeBlobShadow());
  return group;
}

/** Push a circle (x, z, radius) out of every AABB it overlaps. Returns true on a hit. */
function pushOutOfColliders(x, z, radius, colliders) {
  let hit = false;
  for (const box of colliders) {
    if (box.max.y < 0 || box.min.y > PLAYER_HEIGHT) continue;
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
      // Centre is inside the box: shove out along the smallest penetration axis.
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

export function createPlayer(scene, startPos) {
  const mesh = buildMesh();
  mesh.position.copy(startPos);
  scene.add(mesh);

  const velocity = new THREE.Vector3();
  const api = {
    mesh,
    /** The player's world position (the mesh position). */
    position: mesh.position,
    /** Facing angle in radians; 0 faces +Z. */
    heading: 0,
    /** Current ground speed in m/s. */
    speed: 0,
    isInCar: false,

    update(dt, input, city, yaw) {
      if (api.isInCar) {
        velocity.set(0, 0, 0);
        api.speed = 0;
        return;
      }
      // Camera-relative move axes. Forward is where the camera looks.
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      const forward = { x: -sin, z: -cos };
      const right = { x: cos, z: -sin };

      let mx = 0;
      let mz = 0;
      if (input.isDown('KeyW') || input.isDown('ArrowUp')) { mx += forward.x; mz += forward.z; }
      if (input.isDown('KeyS') || input.isDown('ArrowDown')) { mx -= forward.x; mz -= forward.z; }
      if (input.isDown('KeyD') || input.isDown('ArrowRight')) { mx += right.x; mz += right.z; }
      if (input.isDown('KeyA') || input.isDown('ArrowLeft')) { mx -= right.x; mz -= right.z; }

      const moving = mx !== 0 || mz !== 0;
      if (moving) {
        const len = Math.hypot(mx, mz);
        mx /= len;
        mz /= len;
      }
      const targetSpeed = moving
        ? (input.isDown('ShiftLeft') || input.isDown('ShiftRight') ? RUN_SPEED : WALK_SPEED)
        : 0;
      const targetVx = mx * targetSpeed;
      const targetVz = mz * targetSpeed;
      const t = Math.min(1, ACCEL * dt);
      velocity.x += (targetVx - velocity.x) * t;
      velocity.z += (targetVz - velocity.z) * t;
      api.speed = Math.hypot(velocity.x, velocity.z);

      // Step, refusing any axis that would leave walkable land (water).
      let nx = mesh.position.x + velocity.x * dt;
      let nz = mesh.position.z + velocity.z * dt;
      if (city && city.isWalkable) {
        if (!city.isWalkable(nx, mesh.position.z)) nx = mesh.position.x;
        if (!city.isWalkable(nx, nz)) nz = mesh.position.z;
      }
      const pushed = city && city.colliders
        ? pushOutOfColliders(nx, nz, PLAYER_RADIUS, city.colliders)
        : { x: nx, z: nz };
      mesh.position.x = pushed.x;
      mesh.position.z = pushed.z;

      // Face the direction of travel, turning smoothly.
      if (api.speed > 0.4) {
        const targetHeading = Math.atan2(velocity.x, velocity.z);
        let diff = targetHeading - api.heading;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        api.heading += diff * Math.min(1, 12 * dt);
        mesh.rotation.y = api.heading;
      }

      // Simple walk bob, on top of the ground level (island/road/bridge top).
      const bob = api.speed > 0.4 ? Math.sin(performance.now() * 0.012) * 0.03 * (api.speed / RUN_SPEED) : 0;
      mesh.position.y = CONFIG.groundY + bob;
    },

    enterCar() {
      api.isInCar = true;
      mesh.visible = false;
      velocity.set(0, 0, 0);
      api.speed = 0;
    },

    exitCar(car) {
      api.isInCar = false;
      mesh.visible = true;
      if (car) {
        // Step out on the car's left side.
        const rx = Math.cos(car.heading);
        const rz = -Math.sin(car.heading);
        mesh.position.set(
          car.position.x + rx * 2.2,
          CONFIG.groundY,
          car.position.z + rz * 2.2,
        );
        api.heading = car.heading;
        mesh.rotation.y = api.heading;
      }
    },
  };
  return api;
}
