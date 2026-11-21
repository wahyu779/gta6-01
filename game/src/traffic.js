// AZURE BAY — Lane A (Fase 2): AI traffic.
// Eight AI cars that drive the CONFIG road network on their own. Each car
// reuses createCar (same physics, collisions and road handling as the
// player's car) and is steered through a fake input object
// { isDown(code) } — the AI presses W/S/A/D exactly like a player would.
// Browser ES modules only: no Node/Deno APIs.

import * as THREE from 'three';
import { createCar } from './car.js';
import { CONFIG } from './config.js';

const AI_COUNT = 8;
// Player amber (0xf59e0b) is deliberately absent from this list.
const AI_COLORS = [
  0x3b82f6, // blue
  0x22c55e, // green
  0xef4444, // red
  0xe5e7eb, // white
  0x8b5cf6, // violet
  0xec4899, // pink
  0x14b8a6, // teal
  0xf97316, // orange
];

// Body mix (Lane D flawfix): half sedans, a quarter vans, a quarter box
// trucks — the fleet is no longer one sedan body in different colours.
// Trucks are heavier, so they cruise a little slower than sedans.
function pickVariant() {
  const r = Math.random();
  if (r < 0.5) return 'sedan';
  if (r < 0.75) return 'van';
  return 'truck';
}

function variantTargetSpeed(variant) {
  if (variant === 'truck') return rand(7, 11);
  if (variant === 'van') return rand(8, 12);
  return rand(8, 14);
}

const LANE_OFFSET = 1.8; // m to the right of the centreline (right-hand traffic)
const STOP_DIST = 8; // m ahead: slow to a stop if anything is in this window
const STOP_LATERAL = 2.6; // m sideways: only things roughly in our lane count
const DESPAWN_DIST = 200; // m from the player: teleport the car away
const RESPAWN_RADIUS = 100; // m from the player: respawn target window
const ENDPOINT_ARRIVE = 5; // m from a segment end: pick the next segment
const JUNCTION_REACH = 35; // m: how far a segment end may be from the next
// segment's end and still count as connected (covers the 25-30 m grass
// gaps between the bridge deck ends and the island roads).
const MIN_SPEED_TURN = 3; // m/s floor while turning sharply, so the car can steer
const TURN_SLOW = 5; // m/s cap for a moderate turn
const TURN_SLOW_SHARP = 3; // m/s cap for a sharp turn

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function randInt(n) {
  return Math.floor(Math.random() * n);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// Normalise an angle difference to [-PI, PI].
function angleDiff(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

function dist2D(ax, az, bx, bz) {
  return Math.hypot(ax - bx, az - bz);
}

// Distance from a point to an axis-aligned road segment (2D, x/z plane).
function distToSegment(px, pz, s) {
  const dx = s.x2 - s.x1;
  const dz = s.z2 - s.z1;
  const lenSq = dx * dx + dz * dz;
  let t = lenSq === 0 ? 0 : ((px - s.x1) * dx + (pz - s.z1) * dz) / lenSq;
  t = clamp01(t);
  return dist2D(px, pz, s.x1 + t * dx, s.z1 + t * dz);
}

export function createTraffic(scene, city) {
  const roads = CONFIG.roads;
  const groundY = CONFIG.groundY;

  // Public entries: exactly { car, road, dir, targetSpeed }.
  // Private per-car AI state lives in `brains`, aligned by index, so the
  // public shape Lane D imports stays exactly as specified.
  const cars = [];
  const brains = [];

  function segmentPoint(roadIdx, t) {
    const s = roads[roadIdx];
    return {
      x: s.x1 + (s.x2 - s.x1) * t,
      z: s.z1 + (s.z2 - s.z1) * t,
    };
  }

  // Unit vector in the car's direction of travel along its segment.
  function travelDir(entry) {
    const s = roads[entry.road];
    const dx = s.x2 - s.x1;
    const dz = s.z2 - s.z1;
    const len = Math.hypot(dx, dz) || 1;
    return { x: (dx / len) * entry.dir, z: (dz / len) * entry.dir };
  }

  // The segment endpoint the car is driving toward.
  function endPoint(entry) {
    const s = roads[entry.road];
    return entry.dir > 0 ? { x: s.x2, z: s.z2 } : { x: s.x1, z: s.z1 };
  }

  // Right-hand vector for a forward direction (facing +Z, right is -X).
  function rightOf(dir) {
    return { x: -dir.z, z: dir.x };
  }

  function placeOnRoad(entry, brain, roadIdx, dir, t) {
    entry.road = roadIdx;
    entry.dir = dir;
    const u = travelDir(entry);
    const r = rightOf(u);
    const p = segmentPoint(roadIdx, t);
    const x = p.x + r.x * LANE_OFFSET;
    const z = p.z + r.z * LANE_OFFSET;
    entry.car.position.set(x, groundY, z);
    entry.car.heading = Math.atan2(u.x, u.z);
    entry.car.mesh.rotation.y = entry.car.heading;
    entry.car.speed = 0;
    entry.car.steerAngle = 0;
    brain.keys.clear();
  }

  // Pick the next segment at the current segment's end. A segment counts
  // as connected when the end point lies on it (T-junctions and corners,
  // where the point is interior to the other segment) or when one of its
  // ends is within JUNCTION_REACH (the bridge gaps). Returns true when a
  // new segment was picked; false means the caller should U-turn.
  function chooseNext(entry) {
    const end = endPoint(entry);
    const candidates = [];
    for (let j = 0; j < roads.length; j++) {
      if (j === entry.road) continue;
      const s = roads[j];
      const dA = dist2D(end.x, end.z, s.x1, s.z1);
      const dB = dist2D(end.x, end.z, s.x2, s.z2);
      const onSeg = distToSegment(end.x, end.z, s) <= 1.0;
      const nearA = dA <= JUNCTION_REACH;
      const nearB = dB <= JUNCTION_REACH;
      if (!onSeg && !nearA && !nearB) continue;
      let dir;
      if (nearA && !nearB) dir = 1;
      else if (nearB && !nearA) dir = -1;
      else if (onSeg && !nearA && !nearB) dir = Math.random() < 0.5 ? 1 : -1;
      else dir = dA <= dB ? 1 : -1;
      candidates.push({ road: j, dir });
    }
    if (candidates.length === 0) return false;
    const pick = candidates[randInt(candidates.length)];
    entry.road = pick.road;
    entry.dir = pick.dir;
    return true;
  }

  function respawnNear(entry, brain, playerPos) {
    // Prefer a random road point inside RESPAWN_RADIUS of the player and
    // not right on top of them (so the car never pops in visibly).
    for (let attempt = 0; attempt < 24; attempt++) {
      const roadIdx = randInt(roads.length);
      const t = rand(0.1, 0.9);
      const dir = Math.random() < 0.5 ? 1 : -1;
      const p = segmentPoint(roadIdx, t);
      const d = dist2D(p.x, p.z, playerPos.x, playerPos.z);
      if (d <= RESPAWN_RADIUS && d >= 15) {
        placeOnRoad(entry, brain, roadIdx, dir, t);
        return;
      }
    }
    // Fallback: the closest point on any road to the player. If the player
    // is standing far from every road this is the best road point there is.
    let bestRoad = 0;
    let bestT = 0.5;
    let bestD = Infinity;
    for (let j = 0; j < roads.length; j++) {
      const s = roads[j];
      const dx = s.x2 - s.x1;
      const dz = s.z2 - s.z1;
      const lenSq = dx * dx + dz * dz;
      const t = lenSq === 0
        ? 0
        : clamp01(((playerPos.x - s.x1) * dx + (playerPos.z - s.z1) * dz) / lenSq);
      const p = segmentPoint(j, t);
      const d = dist2D(p.x, p.z, playerPos.x, playerPos.z);
      if (d < bestD) {
        bestD = d;
        bestRoad = j;
        bestT = t;
      }
    }
    placeOnRoad(entry, brain, bestRoad, Math.random() < 0.5 ? 1 : -1, bestT);
  }

  // ---- spawn the fleet ------------------------------------------------------
  // Spread the cars over different segments so they do not start bumper
  // to bumper, and keep them off the player's spawn point.
  const shuffledRoads = roads.map((_, i) => i);
  for (let i = shuffledRoads.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const tmp = shuffledRoads[i];
    shuffledRoads[i] = shuffledRoads[j];
    shuffledRoads[j] = tmp;
  }
  const spawnPoint = city && city.spawnPoint ? city.spawnPoint : null;
  for (let i = 0; i < AI_COUNT; i++) {
    const roadIdx = shuffledRoads[i % shuffledRoads.length];
    const dir = Math.random() < 0.5 ? 1 : -1;
    const color = AI_COLORS[i % AI_COLORS.length];
    const variant = pickVariant();
    const car = createCar(scene, new THREE.Vector3(0, groundY, 0), color, { variant });
    const entry = {
      car,
      road: roadIdx,
      dir,
      targetSpeed: variantTargetSpeed(variant),
    };
    const brain = {
      keys: new Set(),
      input: null,
    };
    brain.input = {
      isDown(code) {
        return brain.keys.has(code);
      },
    };
    cars.push(entry);
    brains.push(brain);
    // Pick a slot along the segment, retrying if it lands on the player.
    let t = rand(0.15, 0.85);
    for (let attempt = 0; attempt < 8 && spawnPoint; attempt++) {
      const p = segmentPoint(roadIdx, t);
      if (dist2D(p.x, p.z, spawnPoint.x, spawnPoint.z) >= 20) break;
      t = rand(0.15, 0.85);
    }
    placeOnRoad(entry, brain, roadIdx, dir, t);
  }

  // ---- per-frame helpers ----------------------------------------------------
  function entityAhead(entry, ex, ez) {
    const fx = Math.sin(entry.car.heading);
    const fz = Math.cos(entry.car.heading);
    const rx = -fz;
    const rz = fx;
    const dx = ex - entry.car.position.x;
    const dz = ez - entry.car.position.z;
    const fwd = dx * fx + dz * fz;
    if (fwd < -2 || fwd > STOP_DIST) return false;
    const lateral = Math.abs(dx * rx + dz * rz);
    return lateral < STOP_LATERAL;
  }

  function isBlocked(index, playerPos, playerCar) {
    const entry = cars[index];
    // Another AI car ahead.
    for (let j = 0; j < cars.length; j++) {
      if (j === index) continue;
      const other = cars[j].car;
      if (entityAhead(entry, other.position.x, other.position.z)) return true;
    }
    // The player's car (parked or driven).
    if (playerCar && playerCar !== entry.car && playerCar.position) {
      if (entityAhead(entry, playerCar.position.x, playerCar.position.z)) return true;
    }
    // The player on foot (playerPos is also the car position while the
    // player is driving, which the check above already covers).
    if (playerPos) {
      if (entityAhead(entry, playerPos.x, playerPos.z)) return true;
    }
    return false;
  }

  function update(dt, cityArg, playerPos, playerCar) {
    if (!dt || dt <= 0) return;
    const world = cityArg || city;
    for (let i = 0; i < cars.length; i++) {
      const entry = cars[i];
      const brain = brains[i];
      const car = entry.car;

      // A car the player has climbed into is driven by the player, not
      // by the AI — leave it entirely alone so the two drivers never
      // fight over the same car in one frame.
      if (car.occupied) {
        brain.keys.clear();
        continue;
      }

      // Despawn / respawn: too far from the player, move to a road point
      // near the player instead of driving across the whole map.
      if (playerPos) {
        const dPlayer = dist2D(
          car.position.x, car.position.z, playerPos.x, playerPos.z,
        );
        if (dPlayer > DESPAWN_DIST) {
          respawnNear(entry, brain, playerPos);
        }
      }

      // Aim at the far end of the current segment, offset to the
      // right-hand lane, so the car travels parallel to the centreline.
      const u = travelDir(entry);
      const r = rightOf(u);
      const end = endPoint(entry);
      const tx = end.x + r.x * LANE_OFFSET;
      const tz = end.z + r.z * LANE_OFFSET;
      const desiredHeading = Math.atan2(
        tx - car.position.x, tz - car.position.z,
      );
      const diff = angleDiff(desiredHeading, car.heading);
      const absDiff = Math.abs(diff);

      // Speed: cruise at targetSpeed, slow down for corners, stop dead
      // for anything in the way ahead.
      let desired = entry.targetSpeed;
      if (absDiff > 1.2) desired = Math.min(desired, TURN_SLOW_SHARP);
      else if (absDiff > 0.6) desired = Math.min(desired, TURN_SLOW);
      if (isBlocked(i, playerPos, playerCar)) desired = 0;
      if (desired > 0 && absDiff > 0.6) {
        desired = Math.max(desired, MIN_SPEED_TURN);
      }

      // Fake input: press W/S for speed, A/D for steering. In car.js
      // A steers toward increasing heading, D toward decreasing heading.
      const keys = brain.keys;
      keys.clear();
      if (desired <= 0) {
        if (car.speed > 0.5) keys.add('KeyS'); // brake
        else if (car.speed < -0.5) keys.add('KeyW'); // stop rolling back
      } else if (car.speed < desired - 0.5) {
        keys.add('KeyW');
      } else if (car.speed > desired + 1.5) {
        keys.add('KeyS'); // over target speed: ease off with a brake tap
      }
      if (diff > 0.08) keys.add('KeyA');
      else if (diff < -0.08) keys.add('KeyD');

      car.update(dt, brain.input, world);

      // Reached (or overshot) the end of the segment: pick the next one.
      const endAfter = endPoint(entry);
      const uAfter = travelDir(entry);
      const dx = car.position.x - endAfter.x;
      const dz = car.position.z - endAfter.z;
      const passed = dx * uAfter.x + dz * uAfter.z > 0;
      const distEnd = Math.hypot(dx, dz);
      if (passed || distEnd < ENDPOINT_ARRIVE) {
        if (!chooseNext(entry)) entry.dir = -entry.dir; // dead end: U-turn
      }
    }
  }

  function nearestStealable(pos, maxDist) {
    if (!pos || maxDist == null) return null;
    let best = null;
    let bestDist = maxDist;
    for (const entry of cars) {
      if (entry.car.occupied) continue;
      const d = dist2D(
        pos.x, pos.z, entry.car.position.x, entry.car.position.z,
      );
      if (d <= bestDist) {
        bestDist = d;
        best = entry.car;
      }
    }
    return best;
  }

  return { cars, update, nearestStealable };
}
