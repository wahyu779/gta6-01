// AZURE BAY — Lane D integration (Fase 1 + Fase 2).
// Wires the lanes together: engine + city + player + car + camera rig +
// input + HUD + minimap + menus, and owns the game state machine
// (menu / playing / paused / dead) plus the ?shot= staging modes used
// for screenshots. Fase 2 adds traffic, pedestrians, wanted, police and
// combat, plus car stealing (E on a traffic car) and the new shot modes
// traffic / chase / combat. No network, no Node/Deno APIs — browser
// ES modules only.

import * as THREE from 'three';
import { createEngine } from './engine.js';
import { buildCity } from './city.js';
import { createPlayer } from './player.js';
import { createCar } from './car.js';
import { createCameraRig } from './camera.js';
import { createInput } from './input.js';
import { createHUD } from './hud.js';
import { createMinimap } from './minimap.js';
import { createUI } from './ui.js';
import { createTraffic } from './traffic.js';
import { createPedestrians } from './pedestrians.js';
import { createWanted } from './wanted.js';
import { createPolice } from './police.js';
import { createCombat } from './combat.js';
import { buildProps } from './props.js';

// ---- Fase 3 lanes (missions / dialog / story / safehouse / shops / radio / save / HUD) ----
// The lanes expose singletons (window.Missions, window.Dialog, window.Radio,
// window.Save, window.HudFase3) plus factories for safehouse/shops — Lane E
// wires them together here. Import order matters: missions.js first so
// window.Missions exists when story.js auto-registers Missions 6-10.
import { Dialog } from './dialog.js';
import { Missions } from './missions.js';
import { registerAll as registerStoryMissions, NPCS } from './story.js';
import { Radio } from './radio.js';
import { Save } from './save.js';
import { createSafehouse } from './safehouse.js';
import { createShops } from './shops.js';
import { HudFase3 } from './hud-fase3.js';

// ---- staging ---------------------------------------------------------------
// ?shot=onfoot   — player on foot in the city, menu dismissed, camera behind
// ?shot=driving — player already in the car on the bridge, driving forward
// ?shot=city    — high wide view of the city, the bridge and the water
// ?shot=traffic — high view over the spawn road, traffic passing below
// ?shot=chase   — player in the car, wanted level 3, police closing in.
//                 Lane F staging: the camera sits ahead-side of the
//                 player looking BACK at the oncoming chase, and the
//                 police are held every frame in staggered lanes behind
//                 the player car, so both the amber player car and the
//                 pursuing police read in the same frame (see
//                 stageChaseFrame).
// ?shot=combat  — player on foot with the pistol, wanted level 2
// ?shot=heli    — player on foot with the pistol, wanted level 5, the
//                 police helicopter held in a low hover over the road
//                 east of the player, shot from a low camera on the
//                 verge so its sunlit flank, the road and the player
//                 all read in frame
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');

// ---- world -----------------------------------------------------------------
const engine = createEngine();
const { scene, camera, renderer } = engine;
const city = buildCity(scene);
buildProps(scene); // Lane C visual revision: road markings, props, skyline
const player = createPlayer(scene, city.spawnPoint);
const car = createCar(scene, city.carSpawns[0], 0xf59e0b);
// The car the player is currently driving: the Fase 1 car, or a traffic
// car stolen with E. The Fase 1 car stays reachable after a theft.
let currentCar = car;
const cameraRig = createCameraRig(camera);
const input = createInput(renderer.domElement);
const hud = createHUD();
const minimap = createMinimap(document.getElementById('minimap'), city.mapData);
const ui = createUI();
const traffic = createTraffic(scene, city);
const pedestrians = createPedestrians(scene, city);
const wanted = createWanted();
const police = createPolice(scene, city);
const combat = createCombat(scene, camera);

// ---- state -----------------------------------------------------------------
let state = 'menu'; // 'menu' | 'playing' | 'paused' | 'dead'
let health = 100;
let cash = 500;
let respect = 0; // Fase 3: mission rewards add respect (0 ROOKIE … 500 BAY KING)
let frames = 0;
// Gunshots from the previous frame, handed to the pedestrians so they can
// react to them (one frame of delay keeps the call order simple).
let lastShots = [];

// ---- Fase 3 wiring (Lane E) ------------------------------------------------
// Story missions 6-10 register into the Lane A engine (story.js also
// auto-registers on import; this call is idempotent and covers the case
// where the import order ever changes).
registerStoryMissions();

// Mission payout: cash and respect live here, so the reward lands in the
// same frame the outro dialog opens. The auto-save after a mission
// flashes the HUD's SAVED chip (save.js 'azure-save' event).
Missions.setOnReward((done) => {
  cash += done.reward || 0;
  respect += done.respect || 0;
  Save.save();
});

const safehouse = createSafehouse(scene, {
  getHealth: () => health,
  setHealth: (v) => { health = Math.min(100, Math.max(0, Math.round(Number(v) || 0))); },
  getCash: () => cash,
  setCash: (v) => { cash = Math.round(Number(v) || 0); },
  getCombat: () => combat,
  // wanted.js has no clearWanted — reset() is the same "lay low" effect.
  clearWanted: () => wanted.reset(),
});
const shops = createShops(scene, {
  getCash: () => cash,
  setCash: (v) => { cash = Math.round(Number(v) || 0); },
  getHealth: () => health,
  setHealth: (v) => { health = Math.min(100, Math.max(0, Math.round(Number(v) || 0))); },
  getCar: () => currentCar,
  getCombat: () => combat,
});
// Ammo bought before combat grew its addAmmo hook stays banked in the
// shop store; with the hook present it now flows into the gun.
shops.applyAmmoCredits();

// Save provider / applier: main.js owns health / cash / respect /
// missions, so only it can snapshot and restore them. The ammo arrays
// keep the live values for the equipped gun and defaults for the others
// — combat exposes only the current gun's mag/reserve.
Save.setProvider(() => {
  const active = Missions.getActive();
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    missions: {
      completed: Missions.getCompleted(),
      // Fase 4 (Lane A): the stage index AND the progress banked inside
      // the stage (kills / collected) ride in the save record, so the
      // applier can resume the mission mid-stage on load.
      active: active
        ? {
          id: active.id,
          title: `${active.id.toUpperCase()} — ${active.name}`,
          stage: active.stageIndex,
          stages: active.stagesTotal,
          kills: active.kills,
          collected: active.collected,
        }
        : null,
    },
    cash,
    health,
    respect,
    weapons: {
      current: combat.current,
      mag: [null, combat.current === 1 ? combat.mag : 12, combat.current === 2 ? combat.mag : 30],
      reserve: [null, combat.current === 1 ? combat.reserve : 48, combat.current === 2 ? combat.reserve : 120],
    },
    position: { x: player.position.x, z: player.position.z, heading: player.heading, inCar: player.isInCar },
  };
});
Save.setApplier((record) => {
  health = record.health;
  cash = record.cash;
  respect = record.respect;
  if (!record.position.inCar) {
    player.position.set(record.position.x, 1.5, record.position.z);
    player.heading = record.position.heading;
    if (player.mesh) player.mesh.rotation.y = record.position.heading;
  }
  combat.selectWeapon(record.weapons.current);
  // Fase 4 (Lane A): resume the active mission at its saved stage —
  // the engine owns the stage state, the save record carries it
  // (stage index + kills / collected banked inside the stage). A
  // stale or unknown mission id is refused by resume() and the player
  // simply starts from the markers; completed missions still survive
  // (missions.js persists them to its own key on finish).
  if (record.missions && record.missions.active) {
    const a = record.missions.active;
    Missions.resume({
      id: a.id,
      stageIndex: a.stage,
      kills: a.kills || 0,
      collected: a.collected || 0,
    });
  }
});
// Continue a previous session — never in a staged screenshot: a shot must
// start from its known pose, not a stale save.
if (!shot && Save.hasSave()) Save.apply();

// ---- Fase 3 3D dressing: NPC figures + mission objective beacon -----------
// Canvas label sprite shared by NPC nameplates and the mission beacon.
function makeTextSprite(text, opts = {}) {
  const { fontPx = 56, fg = '#ffffff', accent = '#fbbf24', height = 9 } = opts;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `bold ${fontPx}px system-ui, sans-serif`;
  ctx.font = font;
  canvas.width = Math.ceil(ctx.measureText(text).width) + 48;
  canvas.height = fontPx + 40;
  ctx.fillStyle = 'rgba(4, 12, 10, 0.88)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 5;
  ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
  ctx.font = font;
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(height * (canvas.width / canvas.height), height, 1);
  return sprite;
}

// One standing figure per story NPC (Lane B data), coloured per NPC with
// a nameplate overhead, parked just off the asphalt at their idle spot.
const SKIN = new THREE.MeshStandardMaterial({ color: 0xd9a066, roughness: 0.8 });
for (const npc of NPCS) {
  const figure = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ color: new THREE.Color(npc.color), roughness: 0.85 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.42, 1.35, 10), cloth);
  body.position.y = 1.5 + 0.68;
  body.castShadow = true;
  figure.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 12, 10), SKIN);
  head.position.y = 1.5 + 1.62;
  figure.add(head);
  const plate = makeTextSprite(npc.name.toUpperCase(), { fontPx: 44, accent: npc.color, height: 3.2 });
  plate.position.y = 1.5 + 2.6;
  figure.add(plate);
  figure.position.set(npc.location.x, 0, npc.location.z);
  scene.add(figure);
}

// Gold objective beacon over the active mission's current stage target
// (hidden in ?shot= modes — the staged compositions already frame their
// own subject, and a beam through the player would wreck them).
const missionBeacon = new THREE.Group();
const beaconBeam = new THREE.Mesh(
  new THREE.CylinderGeometry(0.7, 0.7, 34, 12, 1, true),
  new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }),
);
beaconBeam.position.y = 1.5 + 17;
missionBeacon.add(beaconBeam);
const beaconLabel = makeTextSprite('OBJECTIVE', { fontPx: 48, accent: '#fbbf24', height: 5 });
beaconLabel.position.y = 1.5 + 9;
missionBeacon.add(beaconLabel);
missionBeacon.visible = false;
scene.add(missionBeacon);
let beaconLabelText = '';
let beaconPulse = 0;
function updateMissionBeacon(dt) {
  beaconPulse += dt || 0;
  beaconBeam.material.opacity = 0.18 + Math.sin(beaconPulse * 2.2) * 0.06;
  const active = Missions.getActive();
  if (!active || !active.stage || shot) { missionBeacon.visible = false; return; }
  const label = active.stage.text || active.name;
  missionBeacon.position.set(active.stage.x, 0, active.stage.z);
  if (label !== beaconLabelText) {
    beaconLabelText = label;
    const fresh = makeTextSprite(label, { fontPx: 44, accent: '#fbbf24', height: 5 });
    beaconLabel.material.map = fresh.material.map;
    beaconLabel.scale.copy(fresh.scale);
  }
  missionBeacon.visible = true;
}

const ENTER_RANGE = 4; // metres from the car to climb in
const EXIT_SPEED = 1; // m/s — the car must be near-stopped to step out

// Edge detection for keys that act on press, not while held. These are
// queued by a keydown listener (not polled per frame) so a quick tap is
// never lost between two slow frames.
let eQueued = false;
let escQueued = false;
let mQueued = false;

// ---- mission menu (M) ------------------------------------------------------
// A GTA-style job list: the active mission, every available mission
// (numbered — press 1-9 to start it), and the completed ones. Built
// here, not in index.html, like dialog.js builds its own DOM.
let missionMenuOpen = false;
let missionMenuEl = null;
function buildMissionMenu() {
  if (missionMenuEl) return;
  missionMenuEl = document.createElement('div');
  missionMenuEl.id = 'mission-menu';
  Object.assign(missionMenuEl.style, {
    position: 'fixed', inset: '0', display: 'none', alignItems: 'center',
    justifyContent: 'center', background: 'rgba(5, 12, 20, 0.72)', zIndex: 56,
  });
  missionMenuEl.innerHTML = `
    <div style="width:min(620px,94vw);max-height:88vh;overflow:auto;background:rgba(10,20,32,.95);
      border:3px solid #fbbf24;border-radius:14px;padding:22px 26px;color:#f1f5f9;
      font-family:system-ui,sans-serif;box-shadow:0 12px 48px rgba(0,0,0,.65)">
      <div style="font-size:24px;font-weight:900;letter-spacing:2px;color:#fbbf24">MISSIONS — AZURE BAY</div>
      <div id="mission-menu-body" style="margin-top:12px"></div>
      <div style="display:flex;gap:10px;margin-top:18px">
        <button id="mission-menu-close" type="button"
          style="flex:1;padding:12px;font-size:16px;font-weight:800;border-radius:9px;border:0;
          background:#fbbf24;color:#451a03;cursor:pointer">CLOSE [M / Esc]</button>
      </div>
      <div style="font-size:12px;color:#c8d2dc;margin-top:10px">
        Keys 1–9 start a mission. Walk up to a gold $ marker and press E to start it in the world.</div>
    </div>`;
  document.body.appendChild(missionMenuEl);
  missionMenuEl.querySelector('#mission-menu-close').addEventListener('click', closeMissionMenu);
  missionMenuEl.addEventListener('click', (e) => { if (e.target === missionMenuEl) closeMissionMenu(); });
}
function renderMissionMenu(note) {
  if (!missionMenuEl) buildMissionMenu();
  const body = missionMenuEl.querySelector('#mission-menu-body');
  const active = Missions.getActive();
  const available = Missions.getAvailable();
  const completed = Missions.getCompleted();
  let html = '';
  if (note) html += `<div style="color:#f87171;font-weight:700;margin-bottom:10px">${note}</div>`;
  html += '<div style="font-size:15px;font-weight:800;color:#fbbf24;margin-bottom:6px">ACTIVE</div>';
  if (active) {
    html += `<div style="background:#3f3005;border:1px solid #fbbf24;border-radius:9px;padding:10px 12px;margin-bottom:12px">
      <b>${active.id.toUpperCase()} — ${active.name}</b> <span style="color:#fcd34d">${active.chapter}</span><br>
      <span style="color:#e2e8f0">Stage ${active.stageIndex + 1}/${active.stagesTotal}: ${active.stage ? active.stage.text : ''}</span><br>
      <span style="color:#a7f3d0">Reward $${active.reward} • +${active.respect} respect</span></div>`;
  } else {
    html += '<div style="color:#94a3b8;margin-bottom:12px">No active mission — pick a job below.</div>';
  }
  html += '<div style="font-size:15px;font-weight:800;color:#fbbf24;margin-bottom:6px">AVAILABLE</div>';
  if (available.length === 0) {
    html += '<div style="color:#94a3b8;margin-bottom:12px">Nothing available — finish the active job first.</div>';
  }
  available.forEach((def, i) => {
    html += `<button type="button" data-mission-index="${i}" style="display:block;width:100%;text-align:left;
      padding:10px 12px;margin-bottom:8px;border-radius:9px;cursor:pointer;border:2px solid #334155;
      background:#12233a;color:#f1f5f9;font:15px system-ui,sans-serif">
      <b>[${i + 1}] ${def.id.toUpperCase()} — ${def.name}</b> <span style="color:#fcd34d">${def.chapter}</span><br>
      <span style="color:#c8d2dc">From ${def.giver} • $${def.reward} • +${def.respect} respect • ${def.stages.length} stages</span></button>`;
  });
  html += `<div style="font-size:15px;font-weight:800;color:#fbbf24;margin:10px 0 6px">COMPLETED (${completed.length})</div>`;
  html += completed.length
    ? `<div style="color:#a7f3d0">${completed.map((id) => id.toUpperCase()).join(' • ')}</div>`
    : '<div style="color:#94a3b8">None yet.</div>';
  body.innerHTML = html;
  body.querySelectorAll('[data-mission-index]').forEach((btn) => {
    btn.addEventListener('click', () => missionMenuPick(Number(btn.dataset.missionIndex)));
  });
}
function openMissionMenu() {
  if (state !== 'playing') return;
  buildMissionMenu();
  renderMissionMenu();
  missionMenuEl.style.display = 'flex';
  missionMenuOpen = true;
}
function closeMissionMenu() {
  if (missionMenuEl) missionMenuEl.style.display = 'none';
  missionMenuOpen = false;
}
function missionMenuPick(index) {
  const available = Missions.getAvailable();
  const def = available[index];
  if (!def) return;
  const res = Missions.start(def.id);
  if (res.ok) {
    if (def.id === 'm10') wanted.addHeat(3, 'story'); // finale opens hot
    closeMissionMenu();
  } else {
    renderMissionMenu(`Cannot start ${def.id.toUpperCase()}: ${res.reason}.`);
  }
}
function toggleMissionMenu() {
  if (!mQueued) return;
  mQueued = false;
  if (state !== 'playing') return;
  if (Dialog.isOpen() || shops.isOpen() || safehouse.isOpen()) return;
  if (missionMenuOpen) closeMissionMenu();
  else openMissionMenu();
}

// The keydown listener runs in the CAPTURE phase (third argument true),
// on purpose: the modal listeners (dialog / shops / safehouse rack)
// live on `document` in the bubble phase, so they run AFTER a window
// bubble listener. In bubble phase this handler would see a modal that
// was JUST closed by its own listener and queue the key anyway — an
// Escape that closed the rack would also pause the game, and an E that
// advanced a dialog would also enter a car. In capture phase the modal
// is still open when this runs, so the swallow below is correct.
// Digit1-3 / R presses that arrive while a modal is open are recorded
// in suppressedPresses instead of drained here: input.js queues them in
// the bubble phase, AFTER this listener runs, so a drain here would be
// a no-op — update() drains the set before combat can see them.
const suppressedPresses = new Set();
window.addEventListener('keydown', (event) => {
  if (missionMenuOpen) {
    if (event.code === 'Escape' || event.code === 'KeyM') closeMissionMenu();
    else if (/^Digit[1-9]$/.test(event.code)) {
      missionMenuPick(Number(event.code.slice(5)) - 1);
      suppressedPresses.add(event.code);
    }
    return;
  }
  if (Dialog.isOpen() || shops.isOpen() || safehouse.isOpen()) {
    if (event.code === 'Digit1' || event.code === 'Digit2' || event.code === 'Digit3' || event.code === 'KeyR') {
      suppressedPresses.add(event.code);
    }
    return;
  }
  if (event.code === 'KeyE') eQueued = true;
  if (event.code === 'Escape') escQueued = true;
  if (event.code === 'KeyM') mQueued = true;
}, true);

function setPlaying() {
  state = 'playing';
  // Drop a click queued while the menu was up so it cannot fire a stray
  // shot on the first playing frame.
  if (typeof input.consumeClick === 'function') input.consumeClick();
  ui.hideAll();
}

function setPaused() {
  if (state !== 'playing') return;
  state = 'paused';
  ui.showPause();
}

function setDead() {
  state = 'dead';
  ui.showDead();
}

// Fase 4 (Lane B) checkpoint respawn: dying mid-mission puts the player
// back where they entered the CURRENT stage — on foot, full health, heat
// cleared (the police stand down once wanted hits 0, see police.js) —
// instead of wiping the whole mission. Finished stages stay finished
// (respawnToCheckpoint never moves the stage index back) and banked
// rewards stay banked. Returns false when there is no mission
// checkpoint to respawn to, so the caller falls through to the WASTED
// screen. The dialog freezes the world until dismissed (the modal gate
// above), so the player reads where they are before play resumes.
function respawnAtCheckpoint() {
  const spot = Missions.respawnToCheckpoint();
  if (!spot) return false;
  if (player.isInCar) {
    player.exitCar(currentCar);
    currentCar.exit();
  }
  player.position.set(spot.x, 1.5, spot.z);
  player.heading = 0;
  if (player.mesh) player.mesh.rotation.y = 0;
  health = 100;
  wanted.reset();
  lastShots = [];
  Dialog.show('AZURE BAY', `You got wasted — back to the start of stage ${spot.stageIndex + 1}. The stages you already finished stay finished.`);
  return true;
}

ui.onStart(setPlaying);
ui.onResume(setPlaying);
ui.onRestart(() => window.location.reload());

// ---- car entry / exit -------------------------------------------------------
function nearCar(targetCar) {
  if (!targetCar || !targetCar.position) return false;
  const dx = player.position.x - targetCar.position.x;
  const dz = player.position.z - targetCar.position.z;
  return Math.hypot(dx, dz) <= ENTER_RANGE;
}

function tryEnterExitCar() {
  if (!player.isInCar) {
    // 1) The Fase 1 car (always enterable).
    if (nearCar(car)) {
      currentCar = car;
      player.enterCar();
      currentCar.enter();
      return;
    }
    // 2) The stolen car, if the player already stole one and walked back.
    if (currentCar !== car && nearCar(currentCar)) {
      player.enterCar();
      currentCar.enter();
      return;
    }
    // 3) Steal the nearest traffic car in range.
    const stolen = traffic.nearestStealable
      ? traffic.nearestStealable(player.position, ENTER_RANGE)
      : null;
    if (stolen) {
      // nearestStealable may return the car api or a traffic wrapper
      // ({car: <api>, ...}); both are handled.
      const stolenCar = stolen.car || stolen;
      if (stolenCar && stolenCar.enter) {
        currentCar = stolenCar;
        stolenCar.enter(); // marks it occupied so traffic stops driving it
        if (stolen !== stolenCar) stolen.occupied = true;
        player.enterCar();
        wanted.addHeat(1, 'steal');
      }
    }
  } else if (Math.abs(currentCar.speed) <= EXIT_SPEED) {
    player.exitCar(currentCar);
    currentCar.exit();
    // currentCar stays the stolen car: the player can steal another one.
  }
}

function nearestNPC(pos, radius) {
  let best = null;
  let bestD = Infinity;
  for (const npc of NPCS) {
    const d = Math.hypot(pos.x - npc.location.x, pos.z - npc.location.z);
    if (d <= radius && d < bestD) { best = npc; bestD = d; }
  }
  return best;
}

// E key, Fase 3 priority: safehouse > shop > mission marker > NPC
// greeting > car. The first four are on-foot only — in a car E is just
// "step out". A mission start that opens its intro dialog leaves the
// dialog open; the main keydown handler swallows the next E taps while
// it is open, so advancing the dialog cannot leak into a car entry.
function tryInteract() {
  if (!eQueued) return;
  eQueued = false;
  if (state !== 'playing') return;
  if (player.isInCar) { tryEnterExitCar(); return; }
  if (safehouse.isNear(player)) { safehouse.enter(); return; }
  if (shops.tryInteract(player.position)) return;
  const started = Missions.tryStartNear(player, 6);
  if (started.ok) {
    if (started.mission && started.mission.id === 'm10') wanted.addHeat(3, 'story');
    return;
  }
  // Drive stage: the getaway car is the objective, and the mission
  // giver stands ON the start marker — their greeting would eat the E
  // press and the player could never climb in (Fase 4, Lane A: M8,
  // Eddie at (52,147); the drive E showed his greeting instead of
  // entering the Comet, and the stage could not be completed from the
  // marker). While a drive stage is active, try the car first; if no
  // car is in range, fall through to the NPC greeting as usual.
  const active = Missions.getActive();
  if (active && active.stage && active.stage.type === 'drive') {
    const wasInCar = player.isInCar;
    tryEnterExitCar();
    if (player.isInCar !== wasInCar) return;
  }
  const npc = nearestNPC(player.position, 4);
  if (npc) { Dialog.show(npc.short, npc.greeting); return; }
  tryEnterExitCar();
}

function togglePause() {
  if (!escQueued) return;
  escQueued = false;
  if (state === 'playing') setPaused();
  else if (state === 'paused') setPlaying();
}

// ---- HUD --------------------------------------------------------------------
function refreshHUD() {
  const speedMs = player.isInCar ? currentCar.speed : player.speed;
  hud.setHealth(health);
  hud.setCash(cash);
  hud.setSpeed(Math.abs(speedMs) * 3.6);
  hud.setWanted(wanted.level);
  hud.setAmmo(combat.weaponName, combat.mag, combat.reserve);
  hud.setObjective(Missions.getHUDText() || 'Explore Azure Bay');
  hud.setTime('17:40');
  // Fase 3 HUD: mission tracker (title + stage x/y), respect rank, radio
  // station. The SAVED flash is event-driven (save.js 'azure-save'),
  // the radio readout also updates on 'azure-radio' — this per-frame
  // refresh keeps all three honest even if an event was missed.
  const active = Missions.getActive();
  HudFase3.update({
    mission: active
      ? { title: `${active.id.toUpperCase()} — ${active.name}`, stage: active.stageIndex + 1, stages: active.stagesTotal }
      : null,
    respect,
    radio: Radio.current(),
  });
}

// ---- minimap extras ----------------------------------------------------------
// Positions for the minimap blips. A traffic/police entry may be the car api
// itself or a wrapper ({car: <api>}); both are resolved here.
function minimapExtras() {
  const policePositions = [];
  for (const entry of police.cars || []) {
    const c = entry && entry.car ? entry.car : entry;
    if (c && c.position) policePositions.push(c.position);
  }
  for (const officer of police.officers || []) {
    if (officer && officer.alive !== false && officer.position) {
      policePositions.push(officer.position);
    }
  }
  const trafficPositions = [];
  for (const entry of traffic.cars || []) {
    const c = entry && entry.car ? entry.car : entry;
    if (c && c.position) trafficPositions.push(c.position);
  }
  const pedPositions = [];
  for (const ped of pedestrians.peds || []) {
    if (ped && ped.alive !== false && ped.position) pedPositions.push(ped.position);
  }
  // Fase 3 places: safehouse + shops + NPCs as coloured dots, mission
  // starts as gold dots, and the active objective as its own diamond.
  const places = [];
  for (const d of safehouse.dots()) places.push(d);
  for (const d of shops.dots()) places.push(d);
  for (const npc of NPCS) places.push({ x: npc.location.x, z: npc.location.z, color: npc.color });
  let objective = null;
  for (const m of Missions.markers()) {
    if (m.kind === 'objective' || m.kind === 'deliver') objective = { x: m.x, z: m.z };
    else places.push({ x: m.x, z: m.z, color: '#ffd24a' });
  }
  return { police: policePositions, traffic: trafficPositions, peds: pedPositions, places, objective };
}

// ---- shot staging ------------------------------------------------------------
// In driving shots the car holds its speed on its own so the screenshot
// shows motion without a held key.
const autoDriveInput = {
  keys: input.keys,
  get mouseDX() { return 0; },
  consumeMouseDX() { return 0; },
  isDown(code) { return code === 'KeyW' ? true : input.isDown(code); },
  get pointerLocked() { return false; },
};

// Raise the wanted level to a target by adding heat one point at a time.
// One addHeat(10) call would jump straight to the 5-star cap (level is
// floor(heat)), so chase/combat would both show 5 stars. Capped so a
// lane whose thresholds differ cannot loop forever.
function raiseWanted(targetLevel) {
  for (let i = 0; i < 50 && wanted.level < targetLevel; i++) {
    wanted.addHeat(1, 'stage');
  }
}

// Heli shot staging (Flawfix Lane A retake): the old shot put the
// camera 10 m from the player and 14 m up, looking UP at the orbiting
// heli at ~56 deg — the frame was ~85% empty sky and the camera saw
// mostly the heli's UNDERSIDE, which faces away from the low (15 deg)
// western sun and gets only weak hemisphere bounce: a near-black slab.
// The retake stages the heli LOW over the road instead — hovering 8 m
// up, just east of the player — and shoots it from a low camera on the
// verge (~2.8 m up, ~15 m away), so the view is a shallow ~19 deg up:
// the camera sees the heli's broad WEST flank side-on, which the
// western sun lights almost head-on, the rotor disc reads as an
// ellipse, and the road, the player and a police car fill the lower
// half of the frame. The pose is held every frame (stageHeliFrame), so
// the orbit never carries the heli out of the staged composition.
// Hover x = 35, y = 9.5 is not arbitrary: the first retake hovered at
// x = 44 and the body still came out dark — a collider raycast toward
// the sun showed x = 44 sits on a building-shadow edge (centre/top
// shaded), while x = 34..38 at y = 9.5 is fully sunlit on every
// flank/belly/top sample. Lowering the hover is NOT an option: the
// same raycast shows the shadow cliff between y = 8.5 and 9.5 (at
// y = 8.0 the west flank is 0/15 sunlit). Lane C (fase4, nit b): the
// first fix moved the hover 35 -> 40 on a centre-point-only probe
// (x = 38/40/42 sunlit, x = 44+ shadowed by the 38 m tower at
// x -27..-15, z -132..-120) — WRONG: a 14-point body-box probe showed
// at x = 40 only 9/14 body points are sunlit (the shadow edge cuts
// diagonally across the 4.6 m body) and only 9/14 have a clear
// background (the brown 27 m tower at (54..65, -111..-99) still
// blocks the north half). The retake came out dark with the tower
// still behind the heli. The real fix moves the CAMERA, not the
// hover: hover stays at 35 (14/14 sunlit) and the camera swings
// west to (12, 5.1, -88) — 14/14 sunlit AND 14/14 clear, the tower
// falls ~24 deg off the view axis so the heli reads against open
// sky. The camera now sits on the road (was the south verge), so a
// traffic photobomb in the foreground is possible — check the
// retake. The camera is ~20 deg off the sun's specular-reflection
// ray off the west flank, so the warm sheen weakens; the flank
// stays diffuse-bright (roughness 0.85, fully sunlit). The lookAt
// tracks the hover (hover.x - 1) so the heli stays centred while
// the player stays in the lower frame (11.7 deg off-axis).
const HELI_HOVER = { x: 35, y: 9.5, z: -90 };
const HELI_HEADING = 0; // nose south: the west flank faces camera + sun
const HELI_CAM_POS = { x: 12, y: 5.1, z: -88 };
const HELI_LOOK = { x: 34, y: 5.5, z: -90 };
const HELI_CAR_POS = { x: 47, y: 1.5, z: -88.5 };
// NIT-POLISH Lane C2: the main rotor is FROZEN at this phase while
// ?shot=heli (see stageHeliFrame). A free-spinning rotor puts a blade
// across the 17:40 clock pill at the top of the frame. The camera sits
// west of the hover point (Lane C fase4 moved it to x = 12, so the heli
// is only ~10 deg above the view axis and the rotor top ~21 deg vs the
// pill at ~29 deg — more clearance than the old ~17 deg pose), and the
// pill is still almost straight above the rotor centre in screen space
// and a blade pointing at/away from the camera projects nearly
// vertically through it. At -1.99 rad both
// blade pairs sit ~45 deg off the camera axis, so they project as
// shallow diagonals and the pill sits in the gap between them.
// (Rotor geometry repeats every 90 deg, so -1.99 == 1.15 mod PI/2.)
const HELI_ROTOR_PHASE = -1.99;
// NIT-POLISH Lane C2: formation for EVERY police car (level 5 spawns
// 3). The old code staged only the first car; the others kept chasing
// and one (a van) ended up parked on the grass north of the road. All
// three slots sit on the asphalt of the south ring road (z = -90,
// roadWidth 8 -> asphalt z in [-94, -86], cars face west nose-in,
// staggered across the two lanes so they read as a cordon, not a blob.
const HELI_CAR_FORMATION = [
  { x: 47, z: -88.5 },
  { x: 53, z: -92.0 },
  { x: 59, z: -88.5 },
];

function stageShot(name) {
  ui.hideAll();
  state = 'playing';
  if (name === 'driving') {
    // On the bridge deck, facing south toward the second island.
    currentCar.position.set(0, 1.5, -30);
    currentCar.heading = 0;
    currentCar.mesh.rotation.y = 0;
    currentCar.speed = 10;
    player.enterCar();
    currentCar.enter();
  } else if (name === 'city') {
    // Wide establishing view; the loop holds this camera pose.
    // Lane H: the old pose (140, 170, 250) looked 31 deg down with the
    // 62 deg FOV, so verticals converged hard — skyline towers at the
    // frame edges leaned outward ~10-15 deg and read as falling over.
    // This pose looks only ~17 deg down through a 50 deg (telephoto)
    // lens from further back, so the towers read vertical while both
    // islands, the bridge and the skyline ring still fill the frame.
    // Lane D2 (polish): pulled 1.3x further back along the same view
    // axis (195, 138.5, 344.5) and pitched down to ~22 deg, lookAt
    // (-38, -30, 0), FOV kept at 50. A projection probe over the real
    // scene geometry shows this fixes all three city nits at once:
    // the four marina boats fit whole (NDC y -0.58..-0.38, was clipped
    // to -1.25); the sun disc clears the top edge (its apparent NDC is
    // (-0.64, 1.17) — the sky shader measures direction from the dome
    // centre, so the disc is parallax-shifted toward the view axis and
    // only a pitch-down moves it out); and both frame edges fall in
    // gaps of the skyline ring, so no tower straddles either edge —
    // lookAt x = -38 parks the left edge in a gap (left severity 0.00)
    // while the right tower #47 stays 76% visible, the same mostly-
    // whole edge tower the original shot had. A yaw sweep showed the
    // edges see-saw: yawing right to clear the left edge cuts the
    // right tower to ~40% visible, yawing left clears the left edge
    // while keeping #47 mostly whole — this yaw is that sweet spot.
    // Pitch stays well under the old 31 deg, so the towers keep
    // reading near-vertical.
    // Lane C (fase4, nit e): the "mostly-whole" #47 was still 24%
    // cut at the right edge in the final shot. Pulled a further 1.12x
    // back along the same view axis — (223, 158.7, 385.8) — and #47
    // came fully into frame, but a sliver of the NEXT tower then
    // showed at the extreme right edge (~35 px of ~65 px). Pulled to
    // 1.20x back — (241.6, 172.2, 413.4), same lookAt, same FOV,
    // same view direction, so the sun disc stays out, the boats stay
    // whole and the left edge stays in its gap — the sliver tower's
    // centre sits ~35.9 deg off-axis against a ~36.7 deg half-FOV,
    // so 1.20x (factor ~1.19 needed) brings its outer edge inside
    // while the next tower (~40 deg at 1.20x) stays out.
    camera.position.set(241.6, 172.2, 413.4);
    camera.lookAt(-38, -30, 0);
    camera.fov = 50;
    camera.updateProjectionMatrix();
  } else if (name === 'traffic') {
    // The player waits by the spawn road; the loop holds a high camera
    // over it so the passing traffic reads in the shot.
  } else if (name === 'chase') {
    // On the bridge deck like 'driving': heading south (+Z) along the
    // bridge road, so the chase runs down a straight road instead of
    // across the grass from the Fase 1 spawn (which faces +Z off-road
    // and gets the camera blocked by a building). The police lane spawns
    // units near the player from the wanted level. Auto-drive cruises
    // slowly so the shot shows motion. The per-frame formation + camera
    // are held by stageChaseFrame in the update loop (Lane F).
    // Lane B2 (polish): highway pace (20 m/s, 72 km/h on the HUD) from
    // near the north end of the bridge so the car is still mid-bridge
    // when the shot fires, and the pistol equipped so the HUD weapon
    // slot reads PISTOL instead of FISTS —/—.
    currentCar.position.set(0, 1.5, CHASE_START_Z);
    currentCar.heading = 0;
    currentCar.mesh.rotation.y = 0;
    currentCar.speed = CHASE_SPEED;
    player.enterCar();
    currentCar.enter();
    combat.selectWeapon(1);
    raiseWanted(3);
    // Fase 3 (Lane E): the chase runs with a job on the board — M1
    // active (intro dialog dismissed: the chase frame must stay clean)
    // — and the radio switched to BAY BEATS 88.3 FM, so the HUD shows
    // the mission tracker and the switched station in the shot.
    Missions.start('m1');
    Dialog.hide();
    Dialog.hide();
    Radio.next();
    Radio.next();
  } else if (name === 'combat') {
    // On foot ON the south ring road (z = -90), standing in the road
    // facing WEST down its length, into the low golden-hour sun, pistol
    // drawn, wanted level 2. The update loop holds a close low camera
    // behind the player and stages the confrontation (officer + police
    // car + muzzle flash) in front of them, so the frame is full of
    // characters instead of empty black road. One pedestrian is pulled
    // onto the road ahead as a second bystander.
    player.position.set(30, 1.5, -90);
    player.heading = -Math.PI / 2;
    player.mesh.rotation.y = player.heading;
    combat.selectWeapon(1);
    raiseWanted(2);
    const peds = pedestrians.peds || [];
    const bystander = peds.find((p) => p && p.alive !== false && p.position);
    if (bystander) {
      bystander.position.set(22, 1.5, -88.5);
      bystander.heading = Math.PI / 2;
      if (bystander.mesh) bystander.mesh.rotation.y = bystander.heading;
    }
    // Fase 3 (Lane E): M1 starts here — but NOT at load: Rook's intro
    // opens at frame 85 of 90 (see update()). Opening it at load would
    // freeze police.update from frame 1 and the officers would never
    // spawn, leaving the frame empty of the confrontation.
  } else if (name === 'heli') {
    // On foot ON the south ring road (z = -90) like 'combat', standing
    // just west of the staged hover point (see HELI_HOVER), facing EAST
    // toward the heli, pistol drawn, wanted level 5: the helicopter
    // spawns at level 4 and opens fire at level 5, so the shot proves
    // the heli live — flying, rotor spinning, shooting — instead of
    // only existing in code. The loop holds the staged heli pose and
    // camera every frame (see stageHeliFrame).
    player.position.set(31, 1.5, -90);
    player.heading = Math.PI / 2;
    player.mesh.rotation.y = player.heading;
    combat.selectWeapon(1);
    raiseWanted(5);
    // Fase 3 (Lane E): M1 active (intro dialog dismissed — the heli
    // frame must stay clean) and the radio on AZURE FM 104.7, so the
    // mission tracker + the switched station read in the shot.
    Missions.start('m1');
    Dialog.hide();
    Dialog.hide();
    Radio.next();
  }
  // 'onfoot' needs nothing extra: the player already stands at spawnPoint
  // and the camera rig settles in behind them.
}

// ---- combat shot staging (Flawfix Lane A) ---------------------------------
// The old combat frame was shot from 6 m back and 3 m up, so the player
// read tiny and the bottom half of the frame was empty black road. This
// holds, every frame, a close low over-the-shoulder camera (~3.4 m back,
// ~0.6 m above the ground, looking slightly UP at the player's head
// height) and stages the confrontation in front of the player: the
// nearest officer held ~4.2 m ahead facing the player, the nearest
// police car held ~13 m down the road nose-in with its light bar
// flashing, and the muzzle flash kept lit. Screenshot-only: it runs
// only while ?shot=combat, and touches no gameplay state besides the
// staged poses (the officers/cars keep chasing/shooting normally).
function stageCombatFrame() {
  const fwd = { x: Math.sin(player.heading), z: Math.cos(player.heading) };
  const right = { x: Math.cos(player.heading), z: -Math.sin(player.heading) };
  const px = player.position.x;
  const py = player.position.y;
  const pz = player.position.z;

  // Stage EVERY live officer, every frame — wanted 2 spawns TWO
  // officers, and staging only the first let the second chase right up
  // behind the player, where the close camera reads the pair as one
  // two-headed figure. The first officer is held ~2.5 m ahead of the
  // player and ~3.5 m to the player's left, facing back at the player.
  // The wide sideways offset is what separates them in the frame:
  // straight ahead of the player they line up behind them from the
  // close camera behind. Any extra officer is parked ~6 m BEHIND the
  // player — behind the camera plane, so it can never enter the frame
  // — instead of chasing up the player's back.
  let officer = null;
  let extra = 0;
  for (const o of police.officers || []) {
    if (!o || o.alive === false || !o.position) continue;
    if (!officer) {
      officer = o;
      officer.position.set(
        px + fwd.x * 2.5 - right.x * 3.5,
        py,
        pz + fwd.z * 2.5 - right.z * 3.5,
      );
      officer.heading = player.heading + Math.PI;
      if (officer.mesh) officer.mesh.rotation.y = officer.heading;
    } else {
      extra += 1;
      o.position.set(
        px - fwd.x * 6 - right.x * (2 + extra),
        py,
        pz - fwd.z * 6 - right.z * (2 + extra),
      );
      o.heading = player.heading;
      if (o.mesh) o.mesh.rotation.y = o.heading;
    }
  }

  // Police cars: hold EVERY one, every frame — wanted 2 spawns TWO cars,
  // and staging only the first let the second chase right up to the
  // camera, where its dark unlit flank filled half the frame (found by
  // a probe at __shotReady: second car 3.3 m from the camera). The
  // first car sits ~8 m down the road ahead, in the near lane (~1.8 m
  // to the player's right), nose toward the player, light bar flashing
  // (police.update keeps flashing it). Any extra car is parked ~8 m
  // BEHIND the player — behind the camera plane, so it can never enter
  // the frame — the same treatment the extra officers already get.
  let carIndex = 0;
  for (const u of police.cars || []) {
    const c = u && u.car ? u.car : u;
    if (!c || !c.position) continue;
    if (carIndex === 0) {
      c.position.set(px + fwd.x * 8 + right.x * 1.8, py, pz + fwd.z * 8 + right.z * 1.8);
      c.heading = player.heading + Math.PI;
    } else {
      c.position.set(
        px - fwd.x * (8 + carIndex * 5) - right.x * (2 + carIndex),
        py,
        pz - fwd.z * (8 + carIndex * 5) - right.z * (2 + carIndex),
      );
      c.heading = player.heading;
    }
    if (c.mesh) c.mesh.rotation.y = c.heading;
    c.speed = 0;
    carIndex += 1;
  }

  // Muzzle flash at the player's gun hand, on the CAMERA side so it
  // sits in open air beside the player's torso instead of behind it,
  // aimed at the officer (or down the road when no officer is staged
  // yet).
  const muzzle = new THREE.Vector3(
    px + fwd.x * 0.6 + right.x * 0.45,
    py + 1.25,
    pz + fwd.z * 0.6 + right.z * 0.45,
  );
  const aim = officer
    ? new THREE.Vector3(officer.position.x, py + 1.2, officer.position.z)
    : new THREE.Vector3(px + fwd.x * 10, py + 1.2, pz + fwd.z * 10);
  combat.stageFlash(muzzle, aim);

  // Close low camera: ~2.7 m behind the player, ~0.6 m above the ground,
  // offset ~1.1 m to the player's right so the player sits left of
  // centre and the officer reads on the right. Looking further UP
  // (~13 deg: +1.65 m at 7.2 m ahead) keeps the lit facades and the
  // low sun in the frame and pushes the near road out of the bottom
  // of it. The player fills ~55% of the frame height at this distance.
  camera.position.set(
    px - fwd.x * 2.7 + right.x * 1.1,
    py + 0.6,
    pz - fwd.z * 2.7 + right.z * 1.1,
  );
  camera.lookAt(px + fwd.x * 4.5, py + 2.25, pz + fwd.z * 4.5);
}

// ---- heli shot staging (Flawfix Lane A retake) ---------------------------
// Holds, every frame, the staged low hover + low camera described at
// HELI_HOVER / HELI_CAM_POS above, plus the nearest police car parked on
// the road east of the heli, nose west toward the player, light bar
// flashing. Screenshot-only: it runs only while ?shot=heli, and touches
// no gameplay state besides the staged poses (the heli keeps shooting
// at 5 stars and its rotor keeps spinning in police.update, which runs
// first — only the group position/heading are overridden here).
// NIT-POLISH Lane C2: (a) the rotor is FROZEN at HELI_ROTOR_PHASE —
// police.update spins it every frame, so the freeze must be re-applied
// here after update runs; (b) ALL police cars are staged into
// HELI_CAR_FORMATION on the asphalt, not just the first one, so no
// police vehicle is left chasing onto the grass.
function stageHeliFrame() {
  if (police.heli) {
    police.heli.position.set(HELI_HOVER.x, HELI_HOVER.y, HELI_HOVER.z);
    police.heli.mesh.rotation.y = HELI_HEADING;
    // Freeze the rotor phase: blades ~45 deg off the camera axis, so
    // no blade crosses the 17:40 clock pill at the top of the frame.
    // (The tail rotor is static mesh, not spun by police.update.)
    if (police.heli.rotor) police.heli.rotor.rotation.y = HELI_ROTOR_PHASE;
  }

  // Every police car: hold in formation on the road east of the heli,
  // nose toward the player, light bars flashing (police.update keeps
  // flashing them). Staging all of them — not just the first — is what
  // keeps the van off the grass: at 5 stars there are 3 cars and the
  // unstaged ones kept chasing the player across the verge.
  let ci = 0;
  for (const u of police.cars || []) {
    const c = u && u.car ? u.car : u;
    if (!c || !c.position) continue;
    const slot = HELI_CAR_FORMATION[ci % HELI_CAR_FORMATION.length];
    c.position.set(slot.x, HELI_CAR_POS.y, slot.z);
    c.heading = -Math.PI / 2;
    if (c.mesh) c.mesh.rotation.y = c.heading;
    c.speed = 0;
    ci++;
  }

  // Low camera on the verge south of the road, looking east and slightly
  // up at the hover point: the heli sits right of centre with its
  // sunlit west flank to the camera, the player stands on the road at
  // the lower left, and the road + north-side buildings fill the bottom
  // of the frame instead of empty sky.
  camera.position.set(HELI_CAM_POS.x, HELI_CAM_POS.y, HELI_CAM_POS.z);
  camera.lookAt(HELI_LOOK.x, HELI_LOOK.y, HELI_LOOK.z);
}

// ---- chase shot staging (Flawfix Lane F) ----------------------------------
// The old chase frame used the default rear chase cam: the camera sat
// directly behind the player car on its centre line, and the police
// chase AI steers straight at the player, so the nearest police car
// (a tall van here) ended up exactly on the camera-to-player line and
// filled the lower-centre frame — the amber player car was fully
// occluded and the shot read as "police car on a bridge", not a chase.
// This holds, every frame, a front-side camera and a staggered police
// formation instead. The camera sits ahead of the player (16 m down
// the road, 7 m to the east side — off the driving lanes, above the
// rail — looking back north-west at the oncoming chase), so the player
// car is the NEAREST car to the camera and can never be hidden by a
// pursuer. The three police cars are held behind the player at 9 /
// 14 / 19 m, alternating lanes (west / east / west, +/-3.2 m off the
// centre line, inside the 14 m bridge deck), all facing the same way
// as the player, so each one is laterally clear of the player car and
// of the car ahead of it: from the front-side camera they read as a
// staggered convoy closing in behind the amber car, light bars and
// headlights toward the camera, with the north-island skyline behind
// them. Screenshot-only: it runs only while ?shot=chase, and touches
// no gameplay state besides the staged poses (the cars keep flashing
// their light bars in police.update, which runs first — only their
// position/heading/speed are overridden here, and the gap to the
// player stays well outside ram range).
const CHASE_FORMATION = [
  { back: 6, side: -3.2 }, // nearest pursuer, west lane
  { back: 10, side: 3.2 }, // second, east lane
  { back: 14, side: -3.2 }, // third, west lane, furthest back
];
// Lane B2 (polish): the old 8/12/16 m gaps + 29 km/h read as a crawl,
// not a pursuit. The formation is tightened to 6/10/14 m — still well
// outside the 3 m ram range, and the nearest unit's roof (2.94 m on a
// sedan) still clears the sightline over the player car's roof from the
// front-side camera (camera 5.5 m up, 13 m ahead: the sightline over
// the player roof passes ~2.3 m at the nearest unit's distance).
const CHASE_SPEED = 20; // m/s — 72 km/h on the HUD, highway pace
const CHASE_START_Z = -55; // start near the north end of the bridge so
// the car is still mid-bridge (z ~35) when the shot fires at frame 90
const CHASE_SHOULDER_X = 5.8; // bridge-deck shoulder: road edge at 4 m,
// rail at 7 m — the strip a walker reads as "off the road" on the deck
const CHASE_ROAD_HALF = 4.6; // |x| below this is still in the driving lanes
const CHASE_OFFICER_BACKS = [24, 28]; // foot officers held behind the
// player, outside their 20 m shooting range, so staging costs no health
const CHASE_CAM_AHEAD = 13; // m ahead of the player car, down the road
const CHASE_CAM_SIDE = 6; // m east of the centre line (off the lanes)
const CHASE_CAM_HEIGHT = 4.0; // m above the player car
const CHASE_LOOK_BACK = 8; // m behind the player the camera looks toward

function stageChaseFrame() {
  const fwd = { x: Math.sin(currentCar.heading), z: Math.cos(currentCar.heading) };
  const right = { x: Math.cos(currentCar.heading), z: -Math.sin(currentCar.heading) };
  const px = currentCar.position.x;
  const py = currentCar.position.y;
  const pz = currentCar.position.z;

  // Hold every police car in the staggered formation behind the player.
  // police.cars is in spawn order, so the formation slots are stable
  // from frame to frame; a unit that has not spawned yet is skipped.
  const units = police.cars || [];
  for (let i = 0; i < units.length && i < CHASE_FORMATION.length; i++) {
    const unit = units[i];
    const c = unit && unit.car ? unit.car : unit;
    if (!c || !c.position) continue;
    const slot = CHASE_FORMATION[i];
    c.position.set(
      px - fwd.x * slot.back + right.x * slot.side,
      py,
      pz - fwd.z * slot.back + right.z * slot.side,
    );
    c.heading = currentCar.heading;
    if (c.mesh) c.mesh.rotation.y = c.heading;
    c.speed = 0;
    // Lane C (fase4, nit c): the FURTHEST unit's shadow is the dark
    // ellipse on the asphalt behind the player car. Probed, not
    // guessed: the low western sun throws every west-lane car's shadow
    // ~3.4 m east per metre of height, so the slot-2 unit (back 14,
    // west lane — this run a van, roof 1.83 m) lands its shadow
    // centre-frame on open asphalt, detached from the car, where it
    // reads as a stray blob; the nearer units' shadows merge with the
    // player car's own shadow and the road edge instead. The staged
    // furthest unit casts no shadow, so the blob is gone while all
    // three pursuers stay visible. Staging-only: it runs only while
    // ?shot=chase, and the flag is per-mesh, so normal play is
    // untouched.
    if (i === CHASE_FORMATION.length - 1 && c.mesh) {
      c.mesh.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    }
  }

  // Lane B2 (polish): pedestrians and foot officers off the road band.
  // The chase runs at 20 m/s, well above the pedestrians' 10 m/s flee
  // threshold, so a walker near the road flees ACROSS the bridge deck —
  // the deck has no sidewalks, so they end up standing in the driving
  // lanes (the red shirt in the old shot). Foot officers spawned at
  // wanted 3 chase at 5 m/s, fall behind the cars and are left standing
  // in the road the same way. Every frame, anyone still in the driving
  // lanes within the chase corridor is moved onto the deck shoulder
  // (|x| = 5.8), where the staged camera reads them as bystanders on
  // the verge instead of figures in the traffic. Officers are held at
  // fixed spots 24/28 m behind the player on the shoulder — outside
  // their 20 m shooting range, so the staging drains no health while
  // the shot settles. The corridor is anchored on the player car, so
  // it follows the chase down the bridge without touching any other
  // shot's staging.
  for (const ped of pedestrians.peds || []) {
    if (!ped || ped.alive === false || !ped.position) continue;
    const p = ped.position;
    if (Math.abs(p.z - pz) > 45 || Math.abs(p.x) >= CHASE_ROAD_HALF) continue;
    p.x = (p.x >= 0 ? 1 : -1) * CHASE_SHOULDER_X;
  }
  const officers = police.officers || [];
  for (let i = 0; i < officers.length; i++) {
    const officer = officers[i];
    if (!officer || officer.alive === false || !officer.position) continue;
    const back = CHASE_OFFICER_BACKS[i % CHASE_OFFICER_BACKS.length];
    const side = i % 2 === 0 ? 1 : -1;
    officer.position.set(
      px + right.x * (side * CHASE_SHOULDER_X) - fwd.x * back,
      py,
      pz + right.z * (side * CHASE_SHOULDER_X) - fwd.z * back,
    );
    officer.heading = currentCar.heading;
    if (officer.mesh) officer.mesh.rotation.y = officer.heading;
    officer.speed = 0;
  }

  // Front-side camera ahead of the player, looking back at the chase:
  // the player car sits nearest the lens, the police behind it.
  camera.position.set(
    px + fwd.x * CHASE_CAM_AHEAD + right.x * CHASE_CAM_SIDE,
    py + CHASE_CAM_HEIGHT,
    pz + fwd.z * CHASE_CAM_AHEAD + right.z * CHASE_CAM_SIDE,
  );
  camera.lookAt(
    px - fwd.x * CHASE_LOOK_BACK,
    py + 0.5,
    pz - fwd.z * CHASE_LOOK_BACK,
  );
}

// ---- main loop ---------------------------------------------------------------
function update(dt) {
  frames += 1;

  if (state === 'menu') {
    // The city idles behind the start menu: traffic and pedestrians keep
    // moving so the menu does not sit over a dead city. No wanted, police
    // or combat here — those need active play.
    traffic.update(dt, city, player.position, null);
    pedestrians.update(dt, city, player, [currentCar], []);
    cameraRig.update(dt, player.position, player.heading, 'foot', 0);
    refreshHUD();
    minimap.update(player.position, player.heading, currentCar.position, minimapExtras());
  } else if (state === 'playing') {
    togglePause();
    if (state === 'paused') return;
    toggleMissionMenu();

    // Combat shot (Fase 3): open Rook's M1 intro dialog LATE, at frame
    // 85 of 90 — the line stays open in the frame (dialog box + mission
    // tracker + objective banner in one shot), but the police get frames
    // 1-84 to spawn their officers first: the modal freeze below would
    // otherwise leave the confrontation empty.
    if (shot === 'combat' && frames === 85 && !Missions.getActive()) Missions.start('m1');

    // Presses recorded while a modal was open (see the capture-phase
    // keydown listener): a Digit1 tap that picked a dialog choice or
    // bought a shop item must never also switch weapons. The set only
    // ever holds codes recorded while a modal was open, so a legitimate
    // weapon switch is never drained.
    for (const code of suppressedPresses) input.consumePressed(code);
    suppressedPresses.clear();

    // ---- Fase 3 modal gate -------------------------------------------------
    // While a dialog, the mission menu, a shop or the safehouse rack is
    // open, the world freezes (GTA-style): no movement, no traffic /
    // police / combat ticks, no mission progress, no damage — and the
    // press queues are drained so a tap that closed the modal cannot
    // leak into a car entry, a pause toggle or a weapon switch. The
    // shot staging + HUD below still run, so a staged screenshot with
    // an open dialog keeps its camera and its readouts.
    const blocked = Dialog.isOpen() || missionMenuOpen || shops.isOpen() || safehouse.isOpen();
    if (blocked) {
      eQueued = false;
      escQueued = false;
      mQueued = false;
      input.consumePressed('Digit1');
      input.consumePressed('Digit2');
      input.consumePressed('Digit3');
      input.consumePressed('KeyR');
      input.consumeClick();
      input.consumeMouseDX();
    }

    if (!blocked) {
      const mouseDX = input.consumeMouseDX();
      tryInteract();
      // Fase 4 (Lane A): snapshot the mission/stage AFTER tryInteract()
      // runs. A mission started by this frame's E press opens its intro
      // dialog — and the player is standing on the stage-0 marker, so
      // Missions.update() below completes stage 0 in the SAME frame.
      // That transition must still register as an advance: its stage
      // lines queue BEHIND the intro (dialog.js queues a show() while
      // a dialog is open instead of overwriting it) and the checkpoint
      // save below records the new stage. Snapshotting BEFORE
      // tryInteract — the earlier shape — hid the transition entirely:
      // the stage-1 lines never showed and the save never recorded
      // stage 1, for every mission whose stage 0 sits on its start
      // marker (m1, m2, m3, m6, m8, m9).
      const missionBefore = Missions.getActive();
      const prevMissionId = missionBefore ? missionBefore.id : null;
      const prevStageIndex = missionBefore ? missionBefore.stageIndex : -1;
      // Fase 4 (Lane A): progress banked inside the stage (kills /
      // collected) is captured by value here — getActive() returns the
      // live object, so reading it after update() would see the new
      // values, not the old ones.
      const prevKills = missionBefore ? missionBefore.kills : 0;
      const prevCollected = missionBefore ? missionBefore.collected : 0;

      if (shot === 'city') {
      // Hold the wide establishing shot; nothing moves.
      // Lane D2 pose: 1.3x back + ~22 deg pitch + 50 deg FOV so the
      // marina boats fit whole, the sun disc clears the top edge and
      // the edge skyline towers sit whole (see stageShot). fov is
      // re-applied here because the engine's resize handler only
      // touches aspect, never fov. Lane C (fase4, nit e): a further
      // 1.20x back along the same axis — (241.6, 172.2, 413.4) — so
      // the right edge tower #47 is fully in frame, not 24% cut, and
      // the next tower's sliver stays out too.
      camera.position.set(241.6, 172.2, 413.4);
      camera.lookAt(-38, -30, 0);
      if (camera.fov !== 50) {
        camera.fov = 50;
        camera.updateProjectionMatrix();
      }
    } else if (shot === 'traffic') {
      // Hold a high view over the spawn road so traffic reads in shot.
      camera.position.set(player.position.x, 55, player.position.z + 45);
      camera.lookAt(player.position.x, 0, player.position.z);
    } else if (player.isInCar) {
      currentCar.update(dt, shot === 'driving' || shot === 'chase' ? autoDriveInput : input, city);
      // The driving screenshot cruises slowly so the car is still on the
      // bridge when the shot is taken, not off the far end of it. The
      // chase screenshot runs at highway pace instead (Lane B2): 20 m/s
      // so the HUD speedo reads 72 km/h and the pursuit reads as a
      // chase, not a crawl.
      if (shot === 'chase' && currentCar.speed > CHASE_SPEED) currentCar.speed = CHASE_SPEED;
      else if (shot === 'driving' && currentCar.speed > 8) currentCar.speed = 8;
      // The minimap arrow follows the car while the player rides in it.
      player.position.copy(currentCar.position);
      player.heading = currentCar.heading;
      cameraRig.update(dt, currentCar.position, currentCar.heading, 'car', mouseDX);
    } else {
      player.update(dt, input, city, cameraRig.yaw);
      cameraRig.update(dt, player.position, player.heading, 'foot', mouseDX);
    }

    // ---- Fase 2 lanes (after movement, before the HUD) ----
    const playerCar = player.isInCar ? currentCar : null;
    traffic.update(dt, city, player.position, playerCar);
    const playerAndTrafficCars = [currentCar];
    for (const entry of traffic.cars || []) {
      const c = entry && entry.car ? entry.car : entry;
      if (c && c !== currentCar) playerAndTrafficCars.push(c);
    }
    pedestrians.update(dt, city, player, playerAndTrafficCars, lastShots);
    wanted.update(dt);
    const damage = police.update(dt, city, player.position, player, wanted);
    if (typeof damage === 'number' && Number.isFinite(damage)) health -= damage;
    const combatResult = combat.update(dt, input, camera, {
      peds: pedestrians.peds,
      officers: police.officers,
      policeCars: police.cars,
      trafficCars: traffic.cars,
      inCar: player.isInCar,
      playerPos: player.position,
      playerHeading: player.heading,
    });
    lastShots = combatResult.shots || [];
    for (const s of lastShots) wanted.addHeat(0.5, 'shoot');
    for (const kill of combatResult.kills || []) {
      wanted.addHeat(kill.type === 'officer' ? 2 : 1, 'kill');
    }

    // ---- Fase 3 lanes (after combat, before the HUD) ----
    // Mission progress: kills feed the combat stages, the driving check
    // reads the live in-car state. The return value carries a mission
    // that finished this frame (its reward already landed via onReward).
    // missionBefore / prevMissionId / prevStageIndex were snapshotted at
    // the top of this block, after tryInteract() — see the comment
    // there for why the snapshot must postdate a same-frame mission
    // start (the stage-0 completion in the start frame is a real
    // advance: its lines queue behind the intro, and the save below
    // records the new stage).
    Missions.update(dt, player, { kills: combatResult.kills, inCar: player.isInCar });
    // Mid-mission stage lines (Lane B `lines` data — the engine shows
    // intro/outro only, so the loop shows the NEW stage's lines on
    // advance). The first stage's lines are never shown here: the
    // mission intro already covered them.
    const act = Missions.getActive();
    if (act && act.id === prevMissionId) {
      const advanced = act.stageIndex !== prevStageIndex;
      if (advanced) {
        const st = act.stage;
        if (st && Array.isArray(st.lines) && st.lines.length) Dialog.showQueue(st.lines);
      }
      // Fase 4 (Lane A): checkpoint — a stage advance auto-saves, AND
      // so does any mid-stage progress (a banked kill / collected
      // item), so a reload resumes the mission at THIS stage with its
      // progress instead of at 0. Without the progress save, a kill
      // banked mid-stage was never written to localStorage and was
      // lost on reload (resume test: m3 1 kill -> 0 after reload).
      // Never in a staged screenshot: a shot must not write a save
      // that a later normal load would resume from.
      if (!shot && (advanced || act.kills !== prevKills || act.collected !== prevCollected)) {
        Save.save();
      }
    }
    safehouse.update(dt);
    shops.update(dt);
    }

    // Mission objective beacon (position/label follow the active stage;
    // hidden with no mission or in a staged shot).
    updateMissionBeacon(dt);

    // Combat screenshot staging: close low camera + staged confrontation.
    if (shot === 'combat') stageCombatFrame();

    // Heli screenshot staging: low hover + low camera + parked police car.
    if (shot === 'heli') stageHeliFrame();

    // Chase screenshot staging: front-side camera + staggered police.
    if (shot === 'chase') stageChaseFrame();

    refreshHUD();
    minimap.update(player.position, player.heading, currentCar.position, minimapExtras());

    if (health <= 0) {
      // Fase 4 (Lane B): death mid-mission respawns at the current
      // stage's checkpoint; only a death with no active mission (or no
      // checkpoint) shows the WASTED screen and its reload path.
      if (!respawnAtCheckpoint()) setDead();
    }
  } else if (state === 'paused') {
    // Escape resumes; the world stays frozen otherwise.
    togglePause();
  }
  // 'dead' freezes the world; the loop keeps rendering.

  // Signal the screenshot driver once the scene has settled.
  // The heli shot fires earlier (frame 30): its staged hover pose and
  // camera are held from frame 1, so nothing needs to settle except the
  // spawns and the first rotor spin.
  if (shot && frames === (shot === 'heli' ? 30 : 90)) window.__shotReady = true;
}

// Pause when the tab is hidden mid-game instead of running unseen.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'playing') setPaused();
});

if (shot) stageShot(shot);
else ui.showStart();

engine.startLoop(update);

// Exposed for playtest drivers and the console.
window.__azure = {
  player, car, cameraRig, city, hud, camera,
  traffic, pedestrians, wanted, police, combat,
  // Fase 3 (Lane E): the wired systems + the owned economy state, so a
  // driver can assert on them (and set health/cash/respect for tests).
  missions: Missions, dialog: Dialog, radio: Radio, save: Save,
  shops, safehouse, hudFase3: HudFase3, npcs: NPCS,
  get currentCar() { return currentCar; },
  get health() { return health; },
  set health(v) { health = Math.min(100, Math.max(0, Math.round(Number(v) || 0))); },
  get cash() { return cash; },
  set cash(v) { cash = Math.round(Number(v) || 0); },
  get respect() { return respect; },
  set respect(v) { respect = Math.max(0, Math.round(Number(v) || 0)); },
};
