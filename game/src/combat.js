// combat.js — AZURE BAY combat / weapons, rewritten round 2.
// Three weapons, switched with Digit1/2/3, reloaded with KeyR, fired
// with the mouse. Hitscan is computed by hand from the camera ray: the
// nearest target within range and a small cone around the screen-centre
// ray is hit. Pedestrians die, officers lose health, cars only take
// the hit (plus wanted heat, applied by main.js). No network, no
// Node/Deno APIs — browser ES modules only.
//
// CONSISTENT HIT DETECTION (round-2 fix): the old resolver used one
// flat tolerance for every kind of target and trusted the caller's
// alive flags alone, so a wide car at range was as hard to hit as a
// person, and a target whose mesh was already hidden could still be
// "hit" again. Now every shot goes through one canonical resolver:
// candidates are filtered first (finite position, alive, mesh actually
// visible), then scored by distance along the ray, and the hit test
// uses a per-kind aim allowance — people get a tight cone, cars get a
// wider one that matches their bulk. The same resolver answers every
// shot, so the same aim always gives the same result.
//
// Muzzle flash: every shot shows a hot additive flash sprite + a short
// point-light pop at the gun muzzle and a thin tracer stub to the aim
// point, so gunfire reads in a still frame. stageFlash() re-arms the
// same effect on demand so the ?shot=combat screenshot always catches
// it lit.

import * as THREE from 'three';

// Weapon table: fists are melee with no ammo and cannot be swung from
// inside a car; the pistol is mid-range and slow; the SMG is short
// range, fast, and fires while the mouse is held.
const WEAPON_ORDER = ['FISTS', 'PISTOL', 'SMG'];
const WEAPONS = {
  FISTS: { name: 'FISTS', range: 2.5, damage: 15, cooldown: 0.4, magSize: Infinity, reserveMax: Infinity, auto: false },
  PISTOL: { name: 'PISTOL', range: 60, damage: 25, cooldown: 0.35, magSize: 12, reserveMax: 48, auto: false },
  SMG: { name: 'SMG', range: 40, damage: 12, cooldown: 0.09, magSize: 30, reserveMax: 120, auto: true },
};

const RELOAD_SECONDS = 1.2;
const AIM_SPREAD = Math.tan((3 * Math.PI) / 180); // ~3 degrees off the ray
const CAMERA_BEHIND = 6; // metres the chase camera sits behind the player
// Minimum aim allowance at point-blank range, per target kind: a
// person is a narrow target, a car is a wide one.
const AIM_ALLOWANCE = { person: 0.6, car: 1.0 };

export function createCombat(scene, camera) {
  // ---- muzzle flash -------------------------------------------------------
  // Tuned to ~40% of the original blowout (core 2.2 / glow 3.8 / star
  // 3.0 m, light 60 filled ~25% of the frame with white and hid the
  // officer behind the player): still a clear hot flash and starburst
  // in a still frame, but contained to the gun hand so the officer
  // staged ahead stays visible. Light and beam tuned down in step so
  // the flash no longer whites out the player's torso.
  let coreSprite = null;   // hot core
  let haloSprite = null;   // wide soft halo
  let burstSprite = null;  // spiky starburst
  let flashLight = null;
  let tracer = null;       // fat beam cylinder, not a 1 px line
  let flashTimer = 0;
  const FLASH_POS = new THREE.Vector3();
  const FLASH_AIM = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const BEAM_DIR = new THREE.Vector3();

  function radialTexture(size, stops) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [at, color] of stops) g.addColorStop(at, color);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // Classic muzzle-flash star: four long spikes out of a hot centre,
  // drawn with a gradient per spike so each tip fades to transparent.
  function starTexture() {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const c = size / 2;
    // Hot centre blob first.
    const g = ctx.createRadialGradient(c, c, 0, c, c, c * 0.32);
    g.addColorStop(0, 'rgba(255,255,240,1)');
    g.addColorStop(0.6, 'rgba(255,200,90,0.9)');
    g.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    // Four spikes: up / right / down / left, long and narrow.
    const spikeLen = c * 0.98;
    const spikeHalfW = c * 0.13;
    for (let i = 0; i < 4; i++) {
      const ang = (i * Math.PI) / 2;
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      const px = -dy; // perpendicular, for the spike's width
      const py = dx;
      const grad = ctx.createLinearGradient(c, c, c + dx * spikeLen, c + dy * spikeLen);
      grad.addColorStop(0, 'rgba(255,240,180,0.95)');
      grad.addColorStop(0.5, 'rgba(255,170,60,0.55)');
      grad.addColorStop(1, 'rgba(255,120,20,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(c + px * spikeHalfW, c + py * spikeHalfW);
      ctx.lineTo(c + dx * spikeLen, c + dy * spikeLen);
      ctx.lineTo(c - px * spikeHalfW, c - py * spikeHalfW);
      ctx.closePath();
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function makeFlashSprite(tex, scale) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // A muzzle flash blooms over whatever is behind it; drawing it
      // without a depth test keeps it readable even when the gun hand
      // sits half behind the player's own arm from the camera.
      depthTest: false,
      transparent: true,
    }));
    s.scale.set(scale, scale, 1);
    s.visible = false;
    scene.add(s);
    return s;
  }

  function buildFlash() {
    coreSprite = makeFlashSprite(radialTexture(128, [
      [0, 'rgba(255,255,240,1)'],
      [0.25, 'rgba(255,210,110,0.95)'],
      [0.6, 'rgba(255,140,40,0.45)'],
      [1, 'rgba(255,120,20,0)'],
    ]), 0.9);
    haloSprite = makeFlashSprite(radialTexture(256, [
      [0, 'rgba(255,190,90,0.25)'],
      [0.4, 'rgba(255,140,40,0.13)'],
      [1, 'rgba(255,120,20,0)'],
    ]), 1.5);
    burstSprite = makeFlashSprite(starTexture(), 1.2);

    flashLight = new THREE.PointLight(0xffb347, 0, 8, 2);
    scene.add(flashLight);

    // Beam: a SHORT THICK STUB (radius 0.05 m, ~0.6 m long) from the
    // muzzle only — never a full muzzle-to-target line. The old beam
    // stretched the whole way to the aim point with the depth test off,
    // so when the target sat hidden behind a passing police van the
    // line drew straight through the van and across the frame like a
    // scratch. A stub can't cross the frame, and with the depth test
    // on it is occluded by anything in front of it like a real object.
    const beamGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 8, 1, true);
    tracer = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
      color: 0xffe9a8,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    }));
    tracer.frustumCulled = false;
    tracer.visible = false;
    scene.add(tracer);
  }

  // Light the flash at `origin`, aimed at `aim`, for `seconds`.
  function showFlashFor(origin, aim, seconds) {
    if (!coreSprite) buildFlash();
    FLASH_POS.copy(origin);
    FLASH_AIM.copy(aim);
    for (const s of [coreSprite, haloSprite, burstSprite]) {
      s.position.copy(FLASH_POS);
      s.visible = true;
    }
    // Fresh starburst angle every shot so the spikes never sit in the
    // same place twice.
    burstSprite.material.rotation = Math.random() * Math.PI;
    flashLight.position.copy(FLASH_POS);
    flashLight.intensity = 18;
    // Short stub from the muzzle toward the aim point: fixed 0.6 m,
    // never the full muzzle-to-target distance. The starburst flash
    // sprite is the main effect; the beam is only its hot core.
    BEAM_DIR.subVectors(FLASH_AIM, FLASH_POS);
    const len = Math.min(BEAM_DIR.length(), 0.6);
    tracer.position.copy(FLASH_POS).addScaledVector(BEAM_DIR.normalize(), len / 2);
    tracer.quaternion.setFromUnitVectors(UP, BEAM_DIR);
    tracer.scale.set(1, len, 1);
    tracer.material.opacity = 0.45;
    tracer.visible = true;
    flashTimer = seconds;
  }

  function hideFlash() {
    if (!coreSprite) return;
    coreSprite.visible = false;
    haloSprite.visible = false;
    burstSprite.visible = false;
    flashLight.intensity = 0;
    tracer.material.opacity = 0;
    tracer.visible = false;
    flashTimer = 0;
  }

  // Muzzle world position from the player's pose (the gun hand, just
  // ahead of the chest and slightly to the right). Falls back to a point
  // on the camera ray when the caller did not pass the player pose.
  function muzzlePosition(targets) {
    if (targets && targets.playerPos && Number.isFinite(targets.playerHeading)) {
      const p = targets.playerPos;
      const h = targets.playerHeading;
      const fx = Math.sin(h);
      const fz = Math.cos(h);
      const rx = Math.cos(h);
      const rz = -Math.sin(h);
      return new THREE.Vector3(p.x + fx * 0.55 + rx * 0.28, p.y + 1.3, p.z + fz * 0.55 + rz * 0.28);
    }
    const dir = camera.getWorldDirection(new THREE.Vector3()).normalize();
    return new THREE.Vector3(
      camera.position.x + dir.x * (CAMERA_BEHIND + 0.5),
      camera.position.y + dir.y * (CAMERA_BEHIND + 0.5) - 1.4,
      camera.position.z + dir.z * (CAMERA_BEHIND + 0.5),
    );
  }

  // ---- weapon state ---------------------------------------------------------
  let currentIdx = 0;
  const mags = WEAPON_ORDER.map((name) => WEAPONS[name].magSize);
  const reserves = WEAPON_ORDER.map((name) => WEAPONS[name].reserveMax);
  let cooldown = 0;
  let reloadTimer = 0;

  const weapon = () => WEAPONS[WEAPON_ORDER[currentIdx]];

  function selectWeapon(index) {
    if (!Number.isInteger(index) || index < 0 || index >= WEAPON_ORDER.length) return;
    if (index === currentIdx) return;
    currentIdx = index;
    reloadTimer = 0; // switching cancels a reload in progress
    cooldown = 0;
  }

  // Banked ammo credits from the weapon shop land here. weaponId is
  // 'pistol' | 'smg' (fists take no ammo); reserves grow without cap —
  // the shop, not combat, owns the economy.
  function addAmmo(weaponId, rounds) {
    const index = weaponId === 'pistol' ? 1 : weaponId === 'smg' ? 2 : -1;
    if (index < 0 || !(rounds > 0)) return false;
    reserves[index] += Math.round(rounds);
    return true;
  }

  function startReload() {
    const w = weapon();
    if (reloadTimer > 0) return;
    if (!Number.isFinite(w.magSize)) return; // fists never reload
    if (mags[currentIdx] >= w.magSize || reserves[currentIdx] <= 0) return;
    reloadTimer = RELOAD_SECONDS;
  }

  function finishReload() {
    const w = weapon();
    if (!Number.isFinite(w.magSize)) return;
    const need = w.magSize - mags[currentIdx];
    const take = Math.min(need, reserves[currentIdx]);
    mags[currentIdx] += take;
    reserves[currentIdx] -= take;
  }

  // ---- hit resolution (one canonical path for every shot) -------------------
  // A candidate is only hittable when its position is finite, it is
  // alive, and its mesh is actually visible — a hidden mesh is a dead
  // target the game already removed from play, and it must never be
  // "hit" a second time.
  function isHittable(entry) {
    if (!entry || !entry.position) return false;
    if (entry.alive === false) return false;
    if (entry.mesh && entry.mesh.visible === false) return false;
    return Number.isFinite(entry.position.x)
      && Number.isFinite(entry.position.y)
      && Number.isFinite(entry.position.z);
  }

  // Resolve a car entry to its world position. Traffic / police entries
  // may be the car api itself ({position}) or a wrapper ({car: <api>}).
  function carPosition(entry) {
    if (!entry) return null;
    const car = entry.car || entry;
    return car.position || null;
  }

  function gatherCandidates(targets) {
    const out = [];
    const people = (targets && targets.peds) || [];
    for (const ped of people) {
      if (isHittable(ped)) {
        out.push({ kind: 'ped', ref: ped, pos: ped.position, aimY: 1.2, allowance: AIM_ALLOWANCE.person });
      }
    }
    const officers = (targets && targets.officers) || [];
    for (const officer of officers) {
      if (isHittable(officer)) {
        out.push({ kind: 'officer', ref: officer, pos: officer.position, aimY: 1.2, allowance: AIM_ALLOWANCE.person });
      }
    }
    const policeCars = (targets && targets.policeCars) || [];
    for (const entry of policeCars) {
      const pos = carPosition(entry);
      if (pos) out.push({ kind: 'policeCar', ref: entry, pos, aimY: 0.8, allowance: AIM_ALLOWANCE.car });
    }
    const trafficCars = (targets && targets.trafficCars) || [];
    for (const entry of trafficCars) {
      const pos = carPosition(entry);
      if (pos) out.push({ kind: 'trafficCar', ref: entry, pos, aimY: 0.8, allowance: AIM_ALLOWANCE.car });
    }
    return out;
  }

  // Find the nearest hittable target on the camera ray. Returns
  // { kind, ref, x, z } or null on a miss. Deterministic: candidates
  // are scored by distance along the ray, nearest first, and the first
  // one inside its own aim allowance wins — the same aim always gives
  // the same hit.
  function resolveShot(w, targets) {
    const origin = camera.position;
    const dir = camera.getWorldDirection(new THREE.Vector3()).normalize();
    const maxT = w.range + CAMERA_BEHIND;
    const candidates = gatherCandidates(targets);

    let best = null;
    let bestT = Infinity;
    const to = new THREE.Vector3();
    const closest = new THREE.Vector3();
    for (const cand of candidates) {
      to.set(cand.pos.x - origin.x, cand.pos.y + cand.aimY - origin.y, cand.pos.z - origin.z);
      const t = to.x * dir.x + to.y * dir.y + to.z * dir.z;
      if (t < 0.5 || t > maxT || t >= bestT) continue;
      closest.set(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
      const px = cand.pos.x - closest.x;
      const py = cand.pos.y + cand.aimY - closest.y;
      const pz = cand.pos.z - closest.z;
      const perp = Math.sqrt(px * px + py * py + pz * pz);
      // ~3 degrees of slack, at least the kind's minimum so close
      // targets stay hittable and wide cars stay hittable at range.
      const tolerance = Math.max(cand.allowance, t * AIM_SPREAD);
      if (perp > tolerance) continue;
      best = cand;
      bestT = t;
    }
    if (!best) return null;
    return { kind: best.kind, ref: best.ref, x: best.pos.x, z: best.pos.z };
  }

  function update(dt, input, cam, targets) {
    const result = { shots: [], kills: [] };

    // The flash decays on its own clock, even on frames that return
    // early (reloading, no fire) — otherwise a staged flash would
    // never fade.
    if (flashTimer > 0) {
      flashTimer -= dt;
      if (flashTimer <= 0) hideFlash();
    }

    if (!input || !cam) return result;

    cooldown = Math.max(0, cooldown - dt);

    // Weapon switching / reload via the input press queue: a short tap
    // can fall between two slow frames, so polling isDown() per frame
    // would miss it. One queued press = one switch / one reload.
    const consumePressed = typeof input.consumePressed === 'function'
      ? (code) => input.consumePressed(code)
      : () => false;
    if (consumePressed('Digit1')) selectWeapon(0);
    if (consumePressed('Digit2')) selectWeapon(1);
    if (consumePressed('Digit3')) selectWeapon(2);
    if (consumePressed('KeyR')) startReload();

    // Reloading blocks firing until the magazine is topped up.
    if (reloadTimer > 0) {
      reloadTimer -= dt;
      if (reloadTimer <= 0) {
        reloadTimer = 0;
        finishReload();
      }
      return result;
    }

    const w = weapon();
    const clicked = typeof input.consumeClick === 'function' ? input.consumeClick() : false;
    const held = !!input.mouseDown;
    const wantFire = clicked || (w.auto && held);
    if (!wantFire || cooldown > 0) return result;

    // Fists cannot be swung from inside a car; guns can.
    if (w.name === 'FISTS' && targets && targets.inCar) return result;

    // Empty magazine: start a reload if there is reserve ammo, else dry.
    if (Number.isFinite(w.magSize) && mags[currentIdx] <= 0) {
      if (reserves[currentIdx] > 0) startReload();
      return result;
    }

    cooldown = w.cooldown;
    if (Number.isFinite(mags[currentIdx])) mags[currentIdx] -= 1;

    const hit = resolveShot(w, targets);
    const rayDir = camera.getWorldDirection(new THREE.Vector3()).normalize();
    const missDist = Math.min(w.range, 20);
    // The aim point for the flash + tracer: the hit, or the ray point
    // ahead of the camera on a miss (the same point reported as a shot).
    let aimPoint;
    if (hit) {
      const refY = hit.ref && hit.ref.position ? hit.ref.position.y : 1.5;
      aimPoint = new THREE.Vector3(hit.x, refY + 1.2, hit.z);
    } else {
      aimPoint = new THREE.Vector3(
        camera.position.x + rayDir.x * missDist,
        camera.position.y + rayDir.y * missDist,
        camera.position.z + rayDir.z * missDist,
      );
    }
    showFlashFor(muzzlePosition(targets), aimPoint, 0.15);
    if (hit) {
      result.shots.push({ x: hit.x, z: hit.z });
      // Kill events carry an explicit `isTarget` flag so the mission
      // engine can tell a mission target from a bystander. Officers
      // (police / crew — the bridge crew, the corner crew, Kingfish's
      // collectors) ARE the combat-stage targets; an ordinary
      // pedestrian is a civilian and never counts toward a combat
      // objective (missions.js counts only isTarget kills, and tracks
      // civilian kills separately as pedKills).
      if (hit.kind === 'ped') {
        hit.ref.alive = false;
        if (hit.ref.mesh) hit.ref.mesh.visible = false;
        result.kills.push({ type: 'ped', isTarget: false, target: hit.ref });
      } else if (hit.kind === 'officer') {
        hit.ref.health = (Number(hit.ref.health) || 100) - w.damage;
        if (hit.ref.health <= 0) {
          hit.ref.alive = false;
          if (hit.ref.mesh) hit.ref.mesh.visible = false;
          result.kills.push({ type: 'officer', isTarget: true, target: hit.ref });
        }
      }
      // Cars (police / traffic) are not damaged by bullets: the hit
      // only counts as a shot, and main.js adds wanted heat for it.
    } else {
      // A miss still makes a gunshot: report the impact point ahead of
      // the camera so nearby pedestrians can react to it.
      result.shots.push({
        x: camera.position.x + rayDir.x * missDist,
        z: camera.position.z + rayDir.z * missDist,
      });
    }
    return result;
  }

  return {
    update,
    /** Switch to a weapon by index (0 fists, 1 pistol, 2 SMG). */
    selectWeapon,
    /** Add reserve rounds for a gun by id ('pistol' | 'smg'). */
    addAmmo,
    /**
     * Light the muzzle flash at `origin`, aimed at `aim`, and keep it
     * lit for about a second. Screenshot staging calls this every
     * frame so the flash is guaranteed lit when the shot is taken.
     */
    stageFlash(origin, aim) {
      showFlashFor(origin, aim, 1);
    },
    /** Index of the currently equipped weapon. */
    get current() {
      return currentIdx;
    },
    /** Display name of the currently equipped weapon. */
    get weaponName() {
      return weapon().name;
    },
    /** Rounds left in the current magazine (Infinity for fists). */
    get mag() {
      return mags[currentIdx];
    },
    /** Reserve rounds for the current weapon (Infinity for fists). */
    get reserve() {
      return reserves[currentIdx];
    },
    /** True while a reload is in progress. */
    get reloading() {
      return reloadTimer > 0;
    },
  };
}
