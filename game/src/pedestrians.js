// AZURE BAY — Lane B: pedestrians (NPC pejalan kaki).
// Twelve walkers stroll the sidewalks beside the roads, step aside when the
// player or a car gets too close, and run away from fast cars and gunshots.
// Dead pedestrians (Lane D sets ped.alive = false) are hidden and respawn
// on a random sidewalk after ~10 seconds. Browser ES modules only — no
// Node/Deno APIs. Every sidewalk point is checked with city.isWalkable so
// no pedestrian ever walks into the water, and building collisions reuse
// the same circle-vs-AABB push-out the player uses.

import * as THREE from 'three';
import { CONFIG } from './config.js';

const PED_COUNT = 12;
const SIDEWALK_OFFSET = 5.5; // roadWidth 8 -> road edge at 4 m; sidewalk at ~5.5 m
const WALK_SPEED_MIN = 1.2;
const WALK_SPEED_MAX = 1.8;
const FLEE_SPEED = 4;
const FLEE_TIME = 3; // seconds of running before calming down
const FLEE_CAR_DIST = 10; // a fast car closer than this triggers flee
const FLEE_CAR_SPEED = 10; // m/s
const GUNSHOT_FLEE_DIST = 15; // a gunshot closer than this triggers flee
const AVOID_DIST = 3; // player/car this close in front -> step aside / pause
const IDLE_PAUSE = 0.7; // seconds spent standing still after stepping aside
const SIDESTEP = 0.6; // metres to shuffle sideways when stepping aside
const RESPAWN_DELAY = 10; // seconds before a dead pedestrian respawns
const PED_RADIUS = 0.35;
const RETURN_DIST = 2.5; // farther than this from the sidewalk line -> walk back to it
// Pedestrian ground datum: walkers stroll ON the sidewalks, and the
// sidewalk slab (props.js) is 0.15 m thick sitting on groundY, so its top
// surface is groundY + 0.15. The ped mesh origin is the sole of the shoe
// (shoe box centre y 0.045, half-height 0.045 -> bottom at local y 0), so
// the mesh must sit at the sidewalk top or the feet sink 0.15 m into it.
const PED_GROUND_Y = CONFIG.groundY + 0.15; // 1.65: sidewalk top surface
// Sidewalk slab geometry (props.js): each slab is centred 5.2 m off its
// road centreline and 2.4 m wide, so the slab band is 4.0–6.4 m from the
// centreline. Inside that band a ped stands on the slab (1.65); anywhere
// else — road, grass, bridge deck — the surface is groundY (1.5). The
// bridge road has no slabs, so it is excluded from the band check.
const SIDEWALK_INNER = 4.0;
const SIDEWALK_OUTER = 6.4;

function distToRoad(x, z) {
  let best = Infinity;
  for (const s of CONFIG.roads) {
    const b = CONFIG.bridge;
    if (s.x1 === b.x && s.x2 === b.x && s.z1 === b.z1 && s.z2 === b.z2) continue;
    const dx = s.x2 - s.x1;
    const dz = s.z2 - s.z1;
    const lenSq = dx * dx + dz * dz;
    let t = lenSq === 0 ? 0 : ((x - s.x1) * dx + (z - s.z1) * dz) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = s.x1 + t * dx;
    const cz = s.z1 + t * dz;
    const d = Math.hypot(x - cx, z - cz);
    if (d < best) best = d;
  }
  return best;
}

const JACKET_COLORS = [
  0xef4444, 0x3b82f6, 0xf59e0b, 0x22c55e,
  0xa855f7, 0xec4899, 0x14b8a6, 0xf97316,
  0xeab308, 0x64748b, 0x0ea5e9, 0x84cc16,
];
const SKIN_COLORS = [0xe8b88a, 0xc98d5f, 0x8d5a3b, 0xf0c8a0];
const PANTS_COLORS = [0x1e293b, 0x334155, 0x3f3f46, 0x44403c];
const HAIR_COLORS = [0x111827, 0x3f2d20, 0x6b7280, 0x78350f, 0x451a03];
const SHOE_COLORS = [0x0f172a, 0x451a03, 0x1f2937, 0x7f1d1d];

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// Closest point on segment (ax,az)-(bx,bz) to (x,z); returns {x, z, t}.
function closestOnSegment(x, z, seg) {
  const dx = seg.bx - seg.ax;
  const dz = seg.bz - seg.az;
  const lenSq = dx * dx + dz * dz;
  let t = lenSq === 0 ? 0 : ((x - seg.ax) * dx + (z - seg.az) * dz) / lenSq;
  t = clamp01(t);
  return { x: seg.ax + t * dx, z: seg.az + t * dz, t };
}

/** Push a circle (x, z, radius) out of every AABB it overlaps. */
function pushOutOfColliders(x, z, radius, colliders) {
  for (const box of colliders) {
    if (box.max.y < 0 || box.min.y > 1.8) continue;
    const cx = Math.max(box.min.x, Math.min(x, box.max.x));
    const cz = Math.max(box.min.z, Math.min(z, box.max.z));
    const dx = x - cx;
    const dz = z - cz;
    const distSq = dx * dx + dz * dz;
    if (distSq >= radius * radius) continue;
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
  return { x, z };
}

// Build one sidewalk segment per side of every road: a line parallel to the
// road centreline, SIDEWALK_OFFSET metres out. Only the longest walkable
// run of each line is kept, so corners that fall off the island (into the
// water) are trimmed instead of dropping the whole sidewalk.
function buildSidewalks(city) {
  const segments = [];
  const SAMPLES = 24;
  for (const road of CONFIG.roads) {
    const len = Math.hypot(road.x2 - road.x1, road.z2 - road.z1);
    if (len < 10) continue;
    const dx = (road.x2 - road.x1) / len;
    const dz = (road.z2 - road.z1) / len;
    // Unit normal (sideways from the centreline).
    const nx = -dz;
    const nz = dx;
    for (const side of [-1, 1]) {
      const ox = nx * side * SIDEWALK_OFFSET;
      const oz = nz * side * SIDEWALK_OFFSET;
      // Longest contiguous run of walkable samples.
      let bestStart = -1;
      let bestEnd = -1;
      let runStart = -1;
      for (let i = 0; i <= SAMPLES; i++) {
        const t = i / SAMPLES;
        const x = road.x1 + dx * len * t + ox;
        const z = road.z1 + dz * len * t + oz;
        const ok = city.isWalkable ? city.isWalkable(x, z) : true;
        if (ok && runStart < 0) runStart = i;
        if (!ok || i === SAMPLES) {
          const runEnd = ok ? i : i - 1;
          if (runStart >= 0 && runEnd - runStart > bestEnd - bestStart) {
            bestStart = runStart;
            bestEnd = runEnd;
          }
          runStart = -1;
        }
      }
      if (bestStart < 0) continue;
      const t0 = bestStart / SAMPLES;
      const t1 = bestEnd / SAMPLES;
      const ax = road.x1 + dx * len * t0 + ox;
      const az = road.z1 + dz * len * t0 + oz;
      const bx = road.x1 + dx * len * t1 + ox;
      const bz = road.z1 + dz * len * t1 + oz;
      const segLen = Math.hypot(bx - ax, bz - az);
      if (segLen < 15) continue; // too short to stroll on
      segments.push({
        ax, az, bx, bz,
        len: segLen,
        dx: (bx - ax) / segLen,
        dz: (bz - az) / segLen,
      });
    }
  }
  return segments;
}

function makeBlobShadow() {
  const geo = new THREE.CircleGeometry(0.5, 24);
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

// Proportional stylised walker, ~1.7-1.85 m: every NPC gets a random
// shirt/skin/pants/hair/shoe colour, a random height (0.94-1.06x) and,
// one in three, a beanie instead of a hair cap — so the crowd reads as
// individuals, not clones. Visual only; walk/flee/idle live in update().
function buildPedMesh() {
  const group = new THREE.Group();

  const jacket = new THREE.MeshStandardMaterial({ color: pick(JACKET_COLORS), roughness: 0.8 });
  const skin = new THREE.MeshStandardMaterial({ color: pick(SKIN_COLORS), roughness: 0.7 });
  const pants = new THREE.MeshStandardMaterial({ color: pick(PANTS_COLORS), roughness: 0.9 });
  const hair = new THREE.MeshStandardMaterial({ color: pick(HAIR_COLORS), roughness: 0.95 });
  const shoeMat = new THREE.MeshStandardMaterial({ color: pick(SHOE_COLORS), roughness: 0.85 });

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

  // Torso (shirt/jacket): hips 0.83 to shoulders ~1.48.
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.25, 6, 12), jacket);
  body.position.y = 1.15;
  body.castShadow = true;
  group.add(body);

  // Neck + head.
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.1, 10), skin);
  neck.position.y = 1.52;
  group.add(neck);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.135, 20, 16), skin);
  head.position.y = 1.62;
  head.castShadow = true;
  group.add(head);
  // Hair: a cap for most, a beanie for one in three.
  if (Math.random() < 0.33) {
    const beanie = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.15, 0.12, 16), hair);
    beanie.position.y = 1.72;
    group.add(beanie);
  } else {
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.45),
      hair,
    );
    cap.position.y = 1.65;
    group.add(cap);
  }

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

  // Random height so the crowd is not a row of identical clones.
  group.scale.setScalar(rand(0.94, 1.06));

  group.add(makeBlobShadow());
  return group;
}

// Normalise one entry of the `cars` array to {x, z, vx, vz, speed}.
// Accepts car objects ({position: Vector3, speed, heading}), plain
// {x, z, speed} / {x, z, vx, vz} points, and bare Vector3s.
function normaliseCar(entry) {
  if (!entry) return null;
  let x;
  let z;
  if (entry.position) {
    x = entry.position.x;
    z = entry.position.z;
  } else if (typeof entry.x === 'number' && typeof entry.z === 'number') {
    x = entry.x;
    z = entry.z;
  } else {
    return null;
  }
  const speed = typeof entry.speed === 'number' ? entry.speed : 0;
  let vx = 0;
  let vz = 0;
  if (typeof entry.heading === 'number') {
    vx = Math.sin(entry.heading) * speed;
    vz = Math.cos(entry.heading) * speed;
  } else if (entry.velocity) {
    vx = entry.velocity.x || 0;
    vz = entry.velocity.z || 0;
  } else if (typeof entry.vx === 'number' || typeof entry.vz === 'number') {
    vx = entry.vx || 0;
    vz = entry.vz || 0;
  }
  return { x, z, vx, vz, speed: Math.abs(speed) };
}

function normaliseGunshot(g) {
  if (!g) return null;
  if (g.position) return { x: g.position.x, z: g.position.z };
  if (typeof g.x === 'number' && typeof g.z === 'number') return { x: g.x, z: g.z };
  return null;
}

export function createPedestrians(scene, city) {
  let sidewalks = buildSidewalks(city);
  if (sidewalks.length === 0) {
    // Fallback so the game still has walkers even if no road offset is
    // walkable: a short stroll line beside the player spawn, if it is land.
    const s = CONFIG.spawn;
    if (!city.isWalkable || city.isWalkable(s.x, s.z)) {
      sidewalks = [{ ax: s.x - 20, az: s.z, bx: s.x + 20, bz: s.z, len: 40, dx: 1, dz: 0 }];
    }
  }

  const peds = [];

  function spawnPed(ped) {
    const seg = pick(sidewalks);
    const t = rand(0.05, 0.95);
    const px = seg.ax + (seg.bx - seg.ax) * t;
    const pz = seg.az + (seg.bz - seg.az) * t;
    ped.seg = seg;
    ped.dirSign = Math.random() < 0.5 ? 1 : -1;
    ped.walkSpeed = rand(WALK_SPEED_MIN, WALK_SPEED_MAX);
    ped.state = 'walk';
    ped.speed = ped.walkSpeed;
    ped.alive = true;
    ped.fleeTimer = 0;
    ped.pauseTimer = 0;
    ped.deadTimer = 0;
    ped.fleeDx = 0;
    ped.fleeDz = 0;
    ped.bobPhase = rand(0, Math.PI * 2);
    ped.groundY = PED_GROUND_Y; // surface under the ped; eases down on roads
    ped.heading = Math.atan2(seg.dx * ped.dirSign, seg.dz * ped.dirSign);
    ped.mesh.position.set(px, PED_GROUND_Y, pz);
    ped.mesh.rotation.y = ped.heading;
    ped.mesh.visible = true;
  }

  for (let i = 0; i < PED_COUNT; i++) {
    const mesh = buildPedMesh();
    scene.add(mesh);
    const ped = {
      position: mesh.position,
      heading: 0,
      speed: 0,
      mesh,
      state: 'walk',
      alive: true,
      // Internal fields (Lane D only touches `alive`).
      seg: null,
      dirSign: 1,
      walkSpeed: 1.5,
      fleeTimer: 0,
      pauseTimer: 0,
      deadTimer: 0,
      fleeDx: 0,
      fleeDz: 0,
      bobPhase: 0,
      groundY: PED_GROUND_Y,
    };
    if (sidewalks.length > 0) spawnPed(ped);
    peds.push(ped);
  }

  // Step (x, z) toward (tx, tz) by at most `step` metres, refusing any
  // axis that would leave walkable land, then pushing out of buildings.
  // Returns the new point.
  function stepChecked(x, z, tx, tz, step, cityNow) {
    let nx = x;
    let nz = z;
    const dx = tx - x;
    const dz = tz - z;
    const dist = Math.hypot(dx, dz);
    if (dist > 1e-6) {
      const s = Math.min(step, dist);
      nx = x + (dx / dist) * s;
      nz = z + (dz / dist) * s;
    }
    if (cityNow && cityNow.isWalkable) {
      if (!cityNow.isWalkable(nx, z)) nx = x;
      if (!cityNow.isWalkable(nx, nz)) nz = z;
    }
    if (cityNow && cityNow.colliders) {
      const pushed = pushOutOfColliders(nx, nz, PED_RADIUS, cityNow.colliders);
      nx = pushed.x;
      nz = pushed.z;
    }
    return { x: nx, z: nz };
  }

  function faceMovement(ped, mx, mz, dt) {
    if (Math.hypot(mx, mz) < 1e-6) return;
    const target = Math.atan2(mx, mz);
    let diff = target - ped.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    ped.heading += diff * Math.min(1, 12 * dt);
    ped.mesh.rotation.y = ped.heading;
  }

  function update(dt, cityArg, player, cars, gunshots) {
    const cityNow = cityArg || city;
    const clampedDt = Math.max(0, Math.min(dt || 0, 0.05));
    if (clampedDt === 0 || sidewalks.length === 0) return;

    // Normalise threats once per frame.
    const carThreats = [];
    if (Array.isArray(cars)) {
      for (const entry of cars) {
        const c = normaliseCar(entry);
        if (c) carThreats.push(c);
      }
    }
    // The player on foot is an avoid-threat too (never a flee-threat:
    // on foot they top out at 8 m/s). In a car they come through `cars`.
    let playerThreat = null;
    if (player && player.position && !player.isInCar) {
      playerThreat = {
        x: player.position.x,
        z: player.position.z,
        vx: 0,
        vz: 0,
        speed: typeof player.speed === 'number' ? Math.abs(player.speed) : 0,
      };
    }
    const shots = [];
    if (Array.isArray(gunshots)) {
      for (const g of gunshots) {
        const s = normaliseGunshot(g);
        if (s) shots.push(s);
      }
    }

    for (const ped of peds) {
      const pos = ped.mesh.position;

      // ---- dead: hidden, then respawn on a random sidewalk ---------------
      if (!ped.alive) {
        if (ped.mesh.visible) {
          ped.mesh.visible = false;
          ped.deadTimer = RESPAWN_DELAY;
          ped.speed = 0;
        } else {
          ped.deadTimer -= clampedDt;
          if (ped.deadTimer <= 0) spawnPed(ped);
        }
        continue;
      }

      // ---- flee triggers --------------------------------------------------
      if (ped.state !== 'flee') {
        let fleeX = 0;
        let fleeZ = 0;
        let fleeing = false;
        // Nearest gunshot.
        let bestShot = null;
        let bestShotDist = Infinity;
        for (const s of shots) {
          const d = Math.hypot(s.x - pos.x, s.z - pos.z);
          if (d < bestShotDist) {
            bestShotDist = d;
            bestShot = s;
          }
        }
        if (bestShot && bestShotDist < GUNSHOT_FLEE_DIST) {
          fleeX = bestShot.x;
          fleeZ = bestShot.z;
          fleeing = true;
        } else {
          // Fast car closing in.
          for (const c of carThreats) {
            const dx = pos.x - c.x;
            const dz = pos.z - c.z;
            const d = Math.hypot(dx, dz);
            if (d >= FLEE_CAR_DIST || c.speed <= FLEE_CAR_SPEED) continue;
            // Only flee from a car actually moving toward the pedestrian.
            const closing = (c.vx * dx + c.vz * dz) / (d || 1);
            if (closing <= 0.2) continue;
            fleeX = c.x;
            fleeZ = c.z;
            fleeing = true;
            break;
          }
        }
        if (fleeing) {
          const dx = pos.x - fleeX;
          const dz = pos.z - fleeZ;
          const d = Math.hypot(dx, dz) || 1;
          ped.fleeDx = dx / d;
          ped.fleeDz = dz / d;
          ped.state = 'flee';
          ped.fleeTimer = FLEE_TIME;
        }
      }

      // ---- flee: run away from the threat ---------------------------------
      if (ped.state === 'flee') {
        ped.fleeTimer -= clampedDt;
        const step = FLEE_SPEED * clampedDt;
        const before = { x: pos.x, z: pos.z };
        const next = stepChecked(
          pos.x, pos.z,
          pos.x + ped.fleeDx, pos.z + ped.fleeDz,
          step, cityNow,
        );
        let movedX = next.x - before.x;
        let movedZ = next.z - before.z;
        if (Math.hypot(movedX, movedZ) < step * 0.25) {
          // Blocked (water edge / building): veer 60 degrees and try again
          // next frame instead of running in place against the obstacle.
          const cos = Math.cos(Math.PI / 3);
          const sin = Math.sin(Math.PI / 3);
          const ndx = ped.fleeDx * cos - ped.fleeDz * sin;
          const ndz = ped.fleeDx * sin + ped.fleeDz * cos;
          ped.fleeDx = ndx;
          ped.fleeDz = ndz;
        } else {
          pos.x = next.x;
          pos.z = next.z;
        }
        movedX = pos.x - before.x;
        movedZ = pos.z - before.z;
        ped.speed = Math.hypot(movedX, movedZ) / clampedDt;
        faceMovement(ped, movedX, movedZ, clampedDt);
        if (ped.fleeTimer <= 0) ped.state = 'walk';
      } else if (ped.state === 'idle') {
        // ---- idle: standing still after stepping aside --------------------
        ped.pauseTimer -= clampedDt;
        ped.speed = 0;
        if (ped.pauseTimer <= 0) ped.state = 'walk';
      } else {
        // ---- walk: stroll along the sidewalk segment ----------------------
        // Avoid: someone/something close in front -> step aside + pause.
        let avoid = null;
        let avoidDist = Infinity;
        const hx = Math.sin(ped.heading);
        const hz = Math.cos(ped.heading);
        const threats = playerThreat ? [...carThreats, playerThreat] : carThreats;
        for (const t of threats) {
          const dx = t.x - pos.x;
          const dz = t.z - pos.z;
          const d = Math.hypot(dx, dz);
          if (d >= AVOID_DIST || d >= avoidDist) continue;
          // Only react to what is in front of the pedestrian.
          if ((dx * hx + dz * hz) / (d || 1) < 0.2) continue;
          avoid = t;
          avoidDist = d;
        }
        if (avoid) {
          // Shuffle sideways, away from the threat, if that spot is land.
          const px = -hz;
          const pz = hx;
          const away = (avoid.x - pos.x) * px + (avoid.z - pos.z) * pz >= 0 ? -1 : 1;
          const sx = pos.x + px * away * SIDESTEP;
          const sz = pos.z + pz * away * SIDESTEP;
          if (!cityNow.isWalkable || cityNow.isWalkable(sx, sz)) {
            const pushed = cityNow.colliders
              ? pushOutOfColliders(sx, sz, PED_RADIUS, cityNow.colliders)
              : { x: sx, z: sz };
            pos.x = pushed.x;
            pos.z = pushed.z;
          }
          ped.state = 'idle';
          ped.pauseTimer = IDLE_PAUSE;
          ped.speed = 0;
        } else {
          const seg = ped.seg;
          const closest = closestOnSegment(pos.x, pos.z, seg);
          const offLine = Math.hypot(pos.x - closest.x, pos.z - closest.z);
          const before = { x: pos.x, z: pos.z };
          if (offLine > RETURN_DIST) {
            // Pushed off the sidewalk (e.g. after fleeing): walk back to it.
            const next = stepChecked(
              pos.x, pos.z, closest.x, closest.z,
              ped.walkSpeed * clampedDt, cityNow,
            );
            pos.x = next.x;
            pos.z = next.z;
          } else {
            // Stroll along the segment; turn around at either end.
            let nx = pos.x + seg.dx * ped.dirSign * ped.walkSpeed * clampedDt;
            let nz = pos.z + seg.dz * ped.dirSign * ped.walkSpeed * clampedDt;
            if (cityNow && cityNow.isWalkable) {
              if (!cityNow.isWalkable(nx, pos.z)) nx = pos.x;
              if (!cityNow.isWalkable(nx, nz)) nz = pos.z;
            }
            if (cityNow && cityNow.colliders) {
              const pushed = pushOutOfColliders(nx, nz, PED_RADIUS, cityNow.colliders);
              nx = pushed.x;
              nz = pushed.z;
            }
            pos.x = nx;
            pos.z = nz;
            // Turn around at the segment ends.
            const proj = closestOnSegment(pos.x, pos.z, seg);
            if (proj.t <= 0.001 || proj.t >= 0.999) {
              ped.dirSign *= -1;
              pos.x = seg.ax + (seg.bx - seg.ax) * Math.max(0.001, Math.min(0.999, proj.t));
              pos.z = seg.az + (seg.bz - seg.az) * Math.max(0.001, Math.min(0.999, proj.t));
            }
          }
          const movedX = pos.x - before.x;
          const movedZ = pos.z - before.z;
          ped.speed = Math.hypot(movedX, movedZ) / clampedDt;
          faceMovement(ped, movedX, movedZ, clampedDt);
        }
      }

      // Walk bob, on top of the surface actually under the ped. A ped
      // strolling the sidewalk stands on the slab (1.65); one that flees
      // onto the road or grass must drop to groundY (1.5) instead of
      // floating 0.15 m in the air. The height eases toward the target
      // so crossing the curb is a smooth step down, not a pop.
      const dRoad = distToRoad(pos.x, pos.z);
      const surfaceY = (dRoad >= SIDEWALK_INNER && dRoad <= SIDEWALK_OUTER)
        ? PED_GROUND_Y
        : CONFIG.groundY;
      ped.groundY += (surfaceY - ped.groundY) * Math.min(1, 12 * clampedDt);
      if (ped.speed > 0.4) {
        ped.bobPhase += clampedDt * ped.speed * 4;
        pos.y = ped.groundY + Math.sin(ped.bobPhase) * 0.03;
      } else {
        pos.y = ped.groundY;
      }
    }

    // Light separation so walkers never stack on top of each other.
    for (let i = 0; i < peds.length; i++) {
      const a = peds[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < peds.length; j++) {
        const b = peds[j];
        if (!b.alive) continue;
        const dx = b.mesh.position.x - a.mesh.position.x;
        const dz = b.mesh.position.z - a.mesh.position.z;
        const d = Math.hypot(dx, dz);
        if (d >= 0.8 || d < 1e-6) continue;
        const push = (0.8 - d) / 2;
        const ux = dx / d;
        const uz = dz / d;
        const ax = a.mesh.position.x - ux * push;
        const az = a.mesh.position.z - uz * push;
        const bx = b.mesh.position.x + ux * push;
        const bz = b.mesh.position.z + uz * push;
        if (!cityNow.isWalkable || cityNow.isWalkable(ax, az)) {
          a.mesh.position.x = ax;
          a.mesh.position.z = az;
        }
        if (!cityNow.isWalkable || cityNow.isWalkable(bx, bz)) {
          b.mesh.position.x = bx;
          b.mesh.position.z = bz;
        }
      }
    }
  }

  return { peds, update };
}
