// save.js — AZURE BAY save / load (Lane D, Fase 3).
// Persists progress to localStorage so a session survives a reload.
// No network, no file writes — the browser's localStorage only.
//
// Schema (v1), key 'azure-bay-save-v1':
//   {
//     version: 1,
//     savedAt: '<ISO timestamp>',
//     missions: {
//       completed: ['<mission id>', ...],          // finished mission ids
//       active: { id, title, stage, stages,       // in-progress mission
//                 kills, collected } | null        // progress banked in the stage
//     },
//     cash: <number>, health: <number 0-100>, respect: <number>,
//     weapons: {
//       current: <index 0 fists | 1 pistol | 2 SMG>,
//       mag: [null, <pistol mag>, <smg mag>],      // null = infinite (fists)
//       reserve: [null, <pistol reserve>, <smg reserve>]
//     },
//     position: { x, z, heading, inCar: <bool> }
//   }
//
// Contract (Lane E wires this into main.js):
//   window.Save = { save(), load(), hasSave(), clear() }
//   save() with no argument snapshots the live game. The snapshot source is
//   a provider Lane E registers with Save.setProvider(fn): main.js owns
//   health / cash / missions / respect as module locals, so only it can hand
//   them over. Without a provider, save() reads what is reachable — the
//   player position + weapon state off window.__azure — and fills the rest
//   with fresh-game defaults. Save.setApplier(fn) is the matching hook for
//   load(): without it, apply() restores position + weapon index directly
//   and returns the full record so Lane E can apply the rest (health, cash,
//   ammo counts — combat.js exposes mag/reserve as getters only, so ammo
//   restore needs a combat setter or the Lane E applier).
//
// After every successful save, a 'azure-save' CustomEvent fires on window
// (detail: the saved record) so the HUD can flash its SAVED indicator —
// HudFase3.savedFlash() listens for it.

export const SAVE_KEY = 'azure-bay-save-v1';
export const SAVE_VERSION = 1;

function defaultSnapshot() {
  return {
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    missions: { completed: [], active: null },
    cash: 500,
    health: 100,
    respect: 0,
    weapons: { current: 0, mag: [null, 12, 30], reserve: [null, 48, 120] },
    position: { x: 30, z: -100, heading: 0, inCar: false },
  };
}

// Best-effort snapshot from what the game exposes publicly. Position and
// weapon state come from window.__azure; everything else keeps defaults.
function snapshotFromGame() {
  const snap = defaultSnapshot();
  const azure = typeof window !== 'undefined' ? window.__azure : null;
  if (!azure) return snap;
  const player = azure.player;
  if (player && player.position) {
    snap.position = {
      x: Number(player.position.x) || 0,
      z: Number(player.position.z) || 0,
      heading: Number(player.heading) || 0,
      inCar: Boolean(player.isInCar),
    };
  }
  const combat = azure.combat;
  if (combat) {
    if (Number.isInteger(combat.current)) snap.weapons.current = combat.current;
    const mag = Number(combat.mag);
    const reserve = Number(combat.reserve);
    const idx = snap.weapons.current;
    if (Number.isFinite(mag)) snap.weapons.mag[idx] = mag;
    if (Number.isFinite(reserve)) snap.weapons.reserve[idx] = reserve;
  }
  return snap;
}

// Validate + normalise a parsed record. Returns the record, or null when it
// is not a save we recognise (wrong version, wrong shape, corrupt JSON).
export function validateSave(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.version !== SAVE_VERSION) return null;
  if (typeof data.savedAt !== 'string') return null;
  const snap = defaultSnapshot();
  snap.savedAt = data.savedAt;
  if (data.missions && typeof data.missions === 'object') {
    if (Array.isArray(data.missions.completed)) {
      snap.missions.completed = data.missions.completed.filter((id) => typeof id === 'string');
    }
    const active = data.missions.active;
    if (active && typeof active === 'object' && typeof active.id === 'string') {
      snap.missions.active = {
        id: active.id,
        title: typeof active.title === 'string' ? active.title : active.id,
        stage: Math.max(0, Math.round(Number(active.stage) || 0)),
        stages: Math.max(1, Math.round(Number(active.stages) || 1)),
        // Fase 4 (Lane A): progress inside the current stage, so a
        // reload resumes the mission mid-stage instead of restarting
        // it — combat kills and collected items already banked.
        kills: Math.max(0, Math.round(Number(active.kills) || 0)),
        collected: Math.max(0, Math.round(Number(active.collected) || 0)),
      };
    }
  }
  if (Number.isFinite(Number(data.cash))) snap.cash = Math.round(Number(data.cash));
  if (Number.isFinite(Number(data.health))) {
    snap.health = Math.min(100, Math.max(0, Math.round(Number(data.health))));
  }
  if (Number.isFinite(Number(data.respect))) snap.respect = Math.round(Number(data.respect));
  if (data.weapons && typeof data.weapons === 'object') {
    if (Number.isInteger(data.weapons.current)
      && data.weapons.current >= 0 && data.weapons.current <= 2) {
      snap.weapons.current = data.weapons.current;
    }
    for (const field of ['mag', 'reserve']) {
      if (Array.isArray(data.weapons[field]) && data.weapons[field].length === 3) {
        snap.weapons[field] = data.weapons[field].map((v) => (
          v === null ? null : (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null)
        ));
      }
    }
  }
  if (data.position && typeof data.position === 'object') {
    const p = data.position;
    if (Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.z))) {
      snap.position = {
        x: Number(p.x),
        z: Number(p.z),
        heading: Number.isFinite(Number(p.heading)) ? Number(p.heading) : 0,
        inCar: Boolean(p.inCar),
      };
    }
  }
  return snap;
}

export function createSave() {
  let provider = null; // () => snapshot object (Lane E: main.js locals)
  let applier = null;  // (record) => void (Lane E: apply health/cash/ammo)
  let lastSavedAt = null;

  function readRaw() {
    try {
      return window.localStorage.getItem(SAVE_KEY);
    } catch (err) {
      return null; // storage blocked (private mode): behave as no save
    }
  }

  function save(explicit) {
    const base = explicit && typeof explicit === 'object'
      ? explicit
      : (typeof provider === 'function' ? provider() : snapshotFromGame());
    const record = validateSave({ ...defaultSnapshot(), ...base, version: SAVE_VERSION });
    if (!record) return false;
    record.savedAt = new Date().toISOString();
    let raw;
    try {
      raw = JSON.stringify(record);
      window.localStorage.setItem(SAVE_KEY, raw);
    } catch (err) {
      return false; // quota / blocked storage: report failure, never throw
    }
    lastSavedAt = record.savedAt;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('azure-save', { detail: record }));
    }
    return true;
  }

  function load() {
    const raw = readRaw();
    if (!raw) return null;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return null; // corrupt JSON: treat as no save, never throw
    }
    return validateSave(parsed);
  }

  function hasSave() {
    return load() !== null;
  }

  function clear() {
    try {
      window.localStorage.removeItem(SAVE_KEY);
    } catch (err) {
      return false;
    }
    lastSavedAt = null;
    return true;
  }

  // Apply a loaded record to the live game. Without an applier only the
  // parts reachable from here are restored (position + weapon index);
  // returns the record either way so the caller can finish the job.
  function apply(record) {
    const data = record || load();
    if (!data) return null;
    if (typeof applier === 'function') {
      applier(data);
      return data;
    }
    const azure = typeof window !== 'undefined' ? window.__azure : null;
    if (azure) {
      const player = azure.player;
      if (player && player.position && !data.position.inCar) {
        player.position.set(data.position.x, 1.5, data.position.z);
        if (typeof player.heading === 'number') player.heading = data.position.heading;
        if (player.mesh) player.mesh.rotation.y = data.position.heading;
      }
      if (azure.combat && typeof azure.combat.selectWeapon === 'function') {
        azure.combat.selectWeapon(data.weapons.current);
      }
    }
    return data;
  }

  const api = {
    save,
    load,
    hasSave,
    clear,
    apply,
    validateSave,
    /** Lane E: register () => snapshot — the only way to capture health/cash/missions/respect. */
    setProvider(fn) {
      if (typeof fn === 'function') provider = fn;
    },
    /** Lane E: register (record) => void — applies health/cash/ammo on load. */
    setApplier(fn) {
      if (typeof fn === 'function') applier = fn;
    },
    get lastSavedAt() { return lastSavedAt; },
    get key() { return SAVE_KEY; },
  };
  return api;
}

export const Save = createSave();
if (typeof window !== 'undefined') window.Save = Save;
