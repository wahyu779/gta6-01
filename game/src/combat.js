// combat.js — AZURE BAY combat / weapons (Lane D, Fase 2).
// Three weapons, switched with Digit1/2/3, reloaded with KeyR, fired with
// the mouse. Hitscan is computed by hand from the camera ray: the nearest
// target within range and ~3 degrees of the screen-centre ray is hit.
// Pedestrians die, officers lose health, cars only take the hit (plus
// wanted heat, applied by main.js). No network, no Node/Deno APIs —
// browser ES modules only.
//
// Muzzle flash (Flawfix Lane A): every shot shows a hot additive flash
// sprite + a short point-light pop at the gun muzzle and a thin tracer to
// the aim point, so gunfire reads in a still frame. stageFlash() re-arms
// the same effect on demand so the ?shot=combat screenshot always
// catches it lit.

import * as THREE from 'three';

const WEAPONS = [
  // Fists: melee, no ammo, cannot be used from inside a car.
  { name: 'FISTS', range: 2.5, damage: 15, cooldown: 0.4, magSize: Infinity, reserveMax: Infinity, auto: false },
  // Pistol: mid-range hitscan, slow fire.
  { name: 'PISTOL', range: 60, damage: 25, cooldown: 0.35, magSize: 12, reserveMax: 48, auto: false },
  // SMG: short-range hitscan, fast fire, hold the mouse to keep firing.
  { name: 'SMG', range: 40, damage: 12, cooldown: 0.09, magSize: 30, reserveMax: 120, auto: true },
];

const RELOAD_TIME = 1.2; // seconds
const AIM_TAN = Math.tan((3 * Math.PI) / 180); // ~3 degrees off the ray
const CAMERA_OFFSET = 6; // metres the chase camera sits behind the player

export function createCombat(scene, camera) {
  // ---- muzzle flash (Lane G: tuned DOWN from Lane B's blowout) ----------
  // Lane B's sprites (core 2.2 / glow 3.8 / star 3.0 m, light 60) filled
  // ~25% of the frame with white and hid the officer behind the player.
  // Lane G scales everything to ~40% of that: still a clear hot flash
  // and starburst in a still frame, but contained to the gun hand so
  // the officer staged ahead stays visible. Light and beam tuned down
  // in step so the flash no longer whites out the player's torso.
  let flashSprite = null;   // hot core
  let glowSprite = null;    // wide soft halo
  let starSprite = null;    // spiky starburst
  let flashLight = null;
  let tracer = null;        // fat beam cylinder, not a 1 px line
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

  function flashSpriteWith(tex, scale) {
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
    flashSprite = flashSpriteWith(radialTexture(128, [
      [0, 'rgba(255,255,240,1)'],
      [0.25, 'rgba(255,210,110,0.95)'],
      [0.6, 'rgba(255,140,40,0.45)'],
      [1, 'rgba(255,120,20,0)'],
    ]), 0.9);
    glowSprite = flashSpriteWith(radialTexture(256, [
      [0, 'rgba(255,190,90,0.25)'],
      [0.4, 'rgba(255,140,40,0.13)'],
      [1, 'rgba(255,120,20,0)'],
    ]), 1.5);
    starSprite = flashSpriteWith(starTexture(), 1.2);

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
    if (!flashSprite) buildFlash();
    FLASH_POS.copy(origin);
    FLASH_AIM.copy(aim);
    for (const s of [flashSprite, glowSprite, starSprite]) {
      s.position.copy(FLASH_POS);
      s.visible = true;
    }
    // Fresh starburst angle every shot so the spikes never sit in the
    // same place twice.
    starSprite.material.rotation = Math.random() * Math.PI;
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
    if (!flashSprite) return;
    flashSprite.visible = false;
    glowSprite.visible = false;
    starSprite.visible = false;
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
      camera.position.x + dir.x * (CAMERA_OFFSET + 0.5),
      camera.position.y + dir.y * (CAMERA_OFFSET + 0.5) - 1.4,
      camera.position.z + dir.z * (CAMERA_OFFSET + 0.5),
    );
  }

  let current = 0;
  const mags = WEAPONS.map((w) => w.magSize);
  const reserves = WEAPONS.map((w) => w.reserveMax);
  let cooldown = 0;
  let reloadTimer = 0;

  const weapon = () => WEAPONS[current];

  function selectWeapon(index) {
    if (!Number.isInteger(index) || index < 0 || index >= WEAPONS.length) return;
    if (index === current) return;
    current = index;
    reloadTimer = 0; // switching cancels a reload in progress
    cooldown = 0;
  }

  // ---- Fase 3 (Lane E): banked ammo credits from the weapon shop land
  // here. weaponId is 'pistol' | 'smg' (fists take no ammo); reserves
  // grow without cap — the shop, not combat, owns the economy.
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
    if (mags[current] >= w.magSize || reserves[current] <= 0) return;
    reloadTimer = RELOAD_TIME;
  }

  function finishReload() {
    const w = weapon();
    if (!Number.isFinite(w.magSize)) return;
    const need = w.magSize - mags[current];
    const take = Math.min(need, reserves[current]);
    mags[current] += take;
    reserves[current] -= take;
  }

  // Resolve a car entry to its world position. Traffic / police entries may
  // be the car api itself ({position}) or a wrapper ({car: <api>}).
  function carPosition(entry) {
    if (!entry) return null;
    const car = entry.car || entry;
    return car.position || null;
  }

  // Find the nearest hittable target on the camera ray. Returns
  // { kind, ref, x, z } or null on a miss.
  function findHit(w, targets) {
    const origin = camera.position;
    const dir = camera.getWorldDirection(new THREE.Vector3()).normalize();
    const maxT = w.range + CAMERA_OFFSET;

    const candidates = [];
    const peds = (targets && targets.peds) || [];
    for (const ped of peds) {
      if (!ped || !ped.position || ped.alive === false) continue;
      candidates.push({ kind: 'ped', ref: ped, pos: ped.position, aimY: 1.2 });
    }
    const officers = (targets && targets.officers) || [];
    for (const officer of officers) {
      if (!officer || !officer.position || officer.alive === false) continue;
      candidates.push({ kind: 'officer', ref: officer, pos: officer.position, aimY: 1.2 });
    }
    const policeCars = (targets && targets.policeCars) || [];
    for (const entry of policeCars) {
      const pos = carPosition(entry);
      if (!pos) continue;
      candidates.push({ kind: 'policeCar', ref: entry, pos, aimY: 0.8 });
    }
    const trafficCars = (targets && targets.trafficCars) || [];
    for (const entry of trafficCars) {
      const pos = carPosition(entry);
      if (!pos) continue;
      candidates.push({ kind: 'trafficCar', ref: entry, pos, aimY: 0.8 });
    }

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
      // ~3 degrees of slack, at least 0.6 m so close targets stay hittable.
      const tolerance = Math.max(0.6, t * AIM_TAN);
      if (perp > tolerance) continue;
      best = cand;
      bestT = t;
    }
    if (!best) return null;
    return { kind: best.kind, ref: best.ref, x: best.pos.x, z: best.pos.z };
  }

  function update(dt, input, cam, targets) {
    const result = { shots: [], kills: [] };

    // The flash decays on its own clock, even on frames that return early
    // (reloading, no fire) — otherwise a staged flash would never fade.
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
    if (Number.isFinite(w.magSize) && mags[current] <= 0) {
      if (reserves[current] > 0) startReload();
      return result;
    }

    cooldown = w.cooldown;
    if (Number.isFinite(mags[current])) mags[current] -= 1;

    const hit = findHit(w, targets);
    // The aim point for the flash + tracer: the hit, or the ray point
    // ahead of the camera on a miss (the same point reported as a shot).
    let aimPoint;
    if (hit) {
      aimPoint = new THREE.Vector3(hit.x, (hit.ref && hit.ref.position ? hit.ref.position.y : 1.5) + 1.2, hit.z);
    } else {
      const dir = camera.getWorldDirection(new THREE.Vector3()).normalize();
      const dist = Math.min(w.range, 20);
      aimPoint = new THREE.Vector3(
        camera.position.x + dir.x * dist,
        camera.position.y + dir.y * dist,
        camera.position.z + dir.z * dist,
      );
    }
    showFlashFor(muzzlePosition(targets), aimPoint, 0.15);
    if (hit) {
      result.shots.push({ x: hit.x, z: hit.z });
      // Fase 4 (Lane B): kill events carry an explicit `isTarget` flag
      // so the mission engine can tell a mission target from a
      // bystander. Officers (police / crew — the bridge crew, the
      // corner crew, Kingfish's collectors) ARE the combat-stage
      // targets; an ordinary pedestrian is a civilian and never counts
      // toward a combat objective (missions.js counts only isTarget
      // kills, and tracks civilian kills separately as pedKills).
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
      // Cars (police / traffic) are not damaged by bullets: the hit only
      // counts as a shot, and main.js adds wanted heat for it.
    } else {
      // A miss still makes a gunshot: report the impact point ahead of the
      // camera so nearby pedestrians can react to it.
      const dir = camera.getWorldDirection(new THREE.Vector3()).normalize();
      const dist = Math.min(w.range, 20);
      result.shots.push({
        x: camera.position.x + dir.x * dist,
        z: camera.position.z + dir.z * dist,
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
     * Light the muzzle flash at `origin`, aimed at `aim`, and keep it lit
     * for about a second. Screenshot staging calls this every frame so
     * the flash is guaranteed lit when the shot is taken.
     */
    stageFlash(origin, aim) {
      showFlashFor(origin, aim, 1);
    },
    /** Index of the currently equipped weapon. */
    get current() {
      return current;
    },
    /** Display name of the currently equipped weapon. */
    get weaponName() {
      return weapon().name;
    },
    /** Rounds left in the current magazine (Infinity for fists). */
    get mag() {
      return mags[current];
    },
    /** Reserve rounds for the current weapon (Infinity for fists). */
    get reserve() {
      return reserves[current];
    },
    /** True while a reload is in progress. */
    get reloading() {
      return reloadTimer > 0;
    },
  };
}
