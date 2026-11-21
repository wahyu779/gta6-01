// AZURE BAY — AI traffic (round-2 rewrite by Lane 2).
// Eight AI cars that drive the CONFIG road network on their own. Each car
// reuses createCar (same physics, collisions and road handling as the
// player's car) and is steered through a fake input object
// { isDown(code) } — the AI presses W/S/A/D exactly like a player would.
// Browser ES modules only: no Node/Deno APIs.
//
// ROUND-2 FIX — SPAWN GUARDS. The old code trusted the road network and
// placed cars by segment math alone. That is usually fine (plots keep
// buildings 11 m off road centrelines), but nothing ever VERIFIED the
// spot: a future road/config tweak, a lane offset at a junction mouth,
// or two respawns landing on the same slot could put a car inside a
// building footprint or bumper-to-bumper with another AI car. Now every
// placement goes through one gate — spotIsClear — which requires the
// point to be drivable AND outside every building/rail collider (with
// a 1 m margin), and respawns additionally require 12 m of separation
// from every other AI car. A rejected spot is retried elsewhere; the
// closest-road fallback scans along its road for the first clear slot
// instead of dropping the car on an unchecked point.

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
const SPAWN_CLEAR_MARGIN = 1; // m around a collider a spawn must stay out of
const SPAWN_CAR_GAP = 12; // m of separation from other AI cars on respawn
const SPAWN_MIN_PLAYER_DIST = 15; // m: never pop in right on top of the player

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function randIndex(n) {
  return Math.floor(Math.random() * n);
}

function clampUnit(v) {
  return Math.max(0, Math.min(1, v));
}

// Normalise an angle difference to [-PI, PI].
function wrapAngleDelta(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

function flatDist(ax, az, bx, bz) {
  return Math.hypot(ax - bx, az - bz);
}

// Distance from a point to an axis-aligned road segment (2D, x/z plane).
function segDistance(px, pz, s) {
  const dx = s.x2 - s.x1;
  const dz = s.z2 - s.z1;
  const lenSq = dx * dx + dz * dz;
  const t = lenSq === 0 ? 0 : clampUnit(((px - s.x1) * dx + (pz - s.z1) * dz) / lenSq);
  return flatDist(px, pz, s.x1 + t * dx, s.z1 + t * dz);
}

// True when the point (x, z) at car height overlaps a collider AABB
// (buildings and bridge rails), expanded by the spawn margin.
function pointInsideBox(x, z, box) {
  if (box.max.y < CONFIG.groundY || box.min.y > CONFIG.groundY + 3) return false;
  return x > box.min.x - SPAWN_CLEAR_MARGIN
    && x < box.max.x + SPAWN_CLEAR_MARGIN
    && z > box.min.z - SPAWN_CLEAR_MARGIN
    && z < box.max.z + SPAWN_CLEAR_MARGIN;
}

// The round-2 spawn gate: a spot is usable only when it is drivable
// (on a road or the bridge deck) and clear of every collider. When no
// city data is available the gate passes — the road math alone is the
// best that can be done without it.
function spotIsClear(x, z, world) {
  if (!world) return true;
  if (world.isDrivable && !world.isDrivable(x, z)) return false;
  if (Array.isArray(world.colliders)) {
    for (const box of world.colliders) {
      if (pointInsideBox(x, z, box)) return false;
    }
  }
  return true;
}

// Body mix: half sedans, a quarter vans, a quarter box trucks — the fleet
// is no longer one sedan body in different colours. Trucks are heavier,
// so they cruise a little slower than sedans.
function pickVariant() {
  const r = Math.random();
  if (r < 0.5) return 'sedan';
  if (r < 0.75) return 'van';
  return 'truck';
}

function variantTargetSpeed(variant) {
  if (variant === 'truck') return randRange(7, 11);
  if (variant === 'van') return randRange(8, 12);
  return randRange(8, 14);
}

export function createTraffic(scene, city) {
  const roads = CONFIG.roads;
  const groundY = CONFIG.groundY;

  // Public entries: exactly { car, road, dir, targetSpeed }.
  // Private per-car AI state lives in `brains`, aligned by index, so the
  // public shape other lanes import stays exactly as specified.
  const cars = [];
  const brains = [];

  function segmentPoint(roadIdx, t) {
    const s = roads[roadIdx];
    return {
      x: s.x1 + (s.x2 - s.x1) * t,
      z: s.z1 + (s.z2 - s.z1) * t,
    };
  }

  // Unit vector in the direction of travel along a segment.
  function travelDirFor(roadIdx, dir) {
    const s = roads[roadIdx];
    const dx = s.x2 - s.x1;
    const dz = s.z2 - s.z1;
    const len = Math.hypot(dx, dz) || 1;
    return { x: (dx / len) * dir, z: (dz / len) * dir };
  }

  // Right-hand vector for a forward direction (facing +Z, right is -X).
  function rightOf(dir) {
    return { x: -dir.z, z: dir.x };
  }

  // Where a car driving `dir` along `roadIdx` at parameter `t` sits in
  // its right-hand lane, and which heading it faces there.
  function lanePoint(roadIdx, dir, t) {
    const u = travelDirFor(roadIdx, dir);
    const r = rightOf(u);
    const p = segmentPoint(roadIdx, t);
    return {
      x: p.x + r.x * LANE_OFFSET,
      z: p.z + r.z * LANE_OFFSET,
      heading: Math.atan2(u.x, u.z),
    };
  }

  // Unconditional placement: put the car at its lane point, stopped.
  function setOnRoad(entry, brain, roadIdx, dir, t) {
    entry.road = roadIdx;
    entry.dir = dir;
    const spot = lanePoint(roadIdx, dir, t);
    entry.car.position.set(spot.x, groundY, spot.z);
    entry.car.heading = spot.heading;
    entry.car.mesh.rotation.y = entry.car.heading;
    entry.car.speed = 0;
    entry.car.steerAngle = 0;
    brain.keys.clear();
  }

  // Guarded placement: same as setOnRoad, but refuses the spot when the
  // spawn gate says no (inside a building, off the road). Returns false
  // and leaves the car untouched so the caller can try another spot.
  function tryPlaceOnRoad(entry, brain, roadIdx, dir, t, world) {
    const spot = lanePoint(roadIdx, dir, t);
    if (!spotIsClear(spot.x, spot.z, world)) return false;
    setOnRoad(entry, brain, roadIdx, dir, t);
    return true;
  }

  // The segment endpoint the car is driving toward.
  function endPoint(entry) {
    const s = roads[entry.road];
    return entry.dir > 0 ? { x: s.x2, z: s.z2 } : { x: s.x1, z: s.z1 };
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
      const dA = flatDist(end.x, end.z, s.x1, s.z1);
      const dB = flatDist(end.x, end.z, s.x2, s.z2);
      const onSeg = segDistance(end.x, end.z, s) <= 1.0;
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
    const pick = candidates[randIndex(candidates.length)];
    entry.road = pick.road;
    entry.dir = pick.dir;
    return true;
  }

  function respawnNear(entry, brain, playerPos, world) {
    // Prefer a random road point inside RESPAWN_RADIUS of the player and
    // not right on top of them (so the car never pops in visibly) — and
    // now also clear of buildings and of the other AI cars.
    for (let attempt = 0; attempt < 24; attempt++) {
      const roadIdx = randIndex(roads.length);
      const t = randRange(0.1, 0.9);
      const dir = Math.random() < 0.5 ? 1 : -1;
      const spot = lanePoint(roadIdx, dir, t);
      const d = flatDist(spot.x, spot.z, playerPos.x, playerPos.z);
      if (d > RESPAWN_RADIUS || d < SPAWN_MIN_PLAYER_DIST) continue;
      if (!spotIsClear(spot.x, spot.z, world)) continue;
      let crowded = false;
      for (const other of cars) {
        if (other === entry) continue;
        if (flatDist(spot.x, spot.z, other.car.position.x, other.car.position.z) < SPAWN_CAR_GAP) {
          crowded = true;
          break;
        }
      }
      if (crowded) continue;
      setOnRoad(entry, brain, roadIdx, dir, t);
      return;
    }
    // Fallback: the closest point on any road to the player. If the player
    // is standing far from every road this is the best road point there is.
    // Scan along the closest road for the first clear slot instead of
    // taking the raw closest point unchecked.
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
        : clampUnit(((playerPos.x - s.x1) * dx + (playerPos.z - s.z1) * dz) / lenSq);
      const p = segmentPoint(j, t);
      const d = flatDist(p.x, p.z, playerPos.x, playerPos.z);
      if (d < bestD) {
        bestD = d;
        bestRoad = j;
        bestT = t;
      }
    }
    for (let dt = 0; dt <= 0.4; dt += 0.05) {
      for (const tt of [bestT + dt, bestT - dt]) {
        if (tt < 0.05 || tt > 0.95) continue;
        const dir = Math.random() < 0.5 ? 1 : -1;
        if (tryPlaceOnRoad(entry, brain, bestRoad, dir, tt, world)) return;
      }
    }
    // Last resort (no clear slot found on the closest road): place
    // anyway — a car on the road beats a car left wherever it despawned.
    setOnRoad(entry, brain, bestRoad, Math.random() < 0.5 ? 1 : -1, bestT);
  }

  // ---- spawn the fleet ------------------------------------------------------
  // Spread the cars over different segments so they do not start bumper
  // to bumper, and keep them off the player's spawn point.
  const shuffledRoads = roads.map((_, i) => i);
  for (let i = shuffledRoads.length - 1; i > 0; i--) {
    const j = randIndex(i + 1);
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
    // Pick a slot along the segment, retrying if it lands on the player
    // or fails the spawn gate (inside a building / off the road).
    let placed = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const t = randRange(0.15, 0.85);
      const spot = lanePoint(roadIdx, dir, t);
      if (spawnPoint && flatDist(spot.x, spot.z, spawnPoint.x, spawnPoint.z) < 20) continue;
      if (tryPlaceOnRoad(entry, brain, roadIdx, dir, t, city)) { placed = true; break; }
    }
    if (!placed) setOnRoad(entry, brain, roadIdx, dir, randRange(0.15, 0.85));
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
        const dPlayer = flatDist(
          car.position.x, car.position.z, playerPos.x, playerPos.z,
        );
        if (dPlayer > DESPAWN_DIST) {
          respawnNear(entry, brain, playerPos, world);
        }
      }

      // Aim at the far end of the current segment, offset to the
      // right-hand lane, so the car travels parallel to the centreline.
      const u = travelDirFor(entry.road, entry.dir);
      const r = rightOf(u);
      const end = endPoint(entry);
      const tx = end.x + r.x * LANE_OFFSET;
      const tz = end.z + r.z * LANE_OFFSET;
      const desiredHeading = Math.atan2(
        tx - car.position.x, tz - car.position.z,
      );
      const diff = wrapAngleDelta(desiredHeading, car.heading);
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
      const uAfter = travelDirFor(entry.road, entry.dir);
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
      const d = flatDist(
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
