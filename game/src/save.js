// save.js — AZURE BAY persistence (rewrite round 2).
// Everything the game remembers across a reload lives in localStorage:
// one full-game record under SAVE_KEY, plus one lightweight mission
// checkpoint under CHECKPOINT_KEY that missions.js reads back after a
// death mid-mission. No network, no file writes, browser storage only.
//
// Full-save record (v1):
//   { version, savedAt, missions: { completed: [id…], active: {…} | null },
//     cash, health, respect,
//     weapons: { current, mag: [null, n, n], reserve: [null, n, n] },
//     position: { x, z, heading, inCar } }
//
// Checkpoint record (v1, key 'azure-bay-checkpoint-v1'):
//   { missionId, stage, cash, respect, playerPos: { x, z }, health }
// A checkpoint is written whenever a mission stage advances and cleared
// when the mission ends, so a respawn never lands the player in a mission
// that already finished.
//
// Wiring (main.js): Save.setProvider(() => snapshot) supplies the live
// numbers main.js owns (health / cash / respect / missions); without a
// provider, save() snapshots whatever window.__azure exposes and fills
// the rest with fresh-game defaults. Save.setApplier(fn) is the matching
// load hook; without it, apply() restores position + weapon directly and
// hands the record back so the caller can finish the job.
// Every successful save fires 'azure-save' on window (detail: the record)
// so the HUD can flash its SAVED indicator.

export const SAVE_KEY = 'azure-bay-save-v1';
export const SAVE_VERSION = 1;
export const CHECKPOINT_KEY = 'azure-bay-checkpoint-v1';

// ---------------------------------------------------------------------------
// Checkpoints — the small record missions.js imports.
// ---------------------------------------------------------------------------

function storageOrNull() {
  try {
    return window.localStorage;
  } catch (err) {
    return null;
  }
}

/** Store a mission checkpoint. `cp` is { missionId, stage, cash, respect,
 *  playerPos: { x, z }, health }. Returns true when it stuck. */
export function persistCheckpoint(cp) {
  const store = storageOrNull();
  if (!store || !cp || typeof cp !== 'object') return false;
  const record = {
    missionId: typeof cp.missionId === 'string' ? cp.missionId : '',
    stage: Math.max(0, Math.round(Number(cp.stage) || 0)),
    cash: Math.round(Number(cp.cash) || 0),
    respect: Math.round(Number(cp.respect) || 0),
    playerPos: {
      x: Number(cp.playerPos && cp.playerPos.x) || 0,
      z: Number(cp.playerPos && cp.playerPos.z) || 0,
    },
    health: Math.min(100, Math.max(0, Math.round(Number(cp.health) || 0))),
  };
  try {
    store.setItem(CHECKPOINT_KEY, JSON.stringify(record));
    return true;
  } catch (err) {
    return false;
  }
}

/** Read the stored checkpoint back, or null when there is none / it is
 *  corrupt. Never throws. */
export function readCheckpoint() {
  const store = storageOrNull();
  if (!store) return null;
  let raw = null;
  try {
    raw = store.getItem(CHECKPOINT_KEY);
  } catch (err) {
    return null;
  }
  if (!raw) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.missionId !== 'string') return null;
  return {
    missionId: parsed.missionId,
    stage: Math.max(0, Math.round(Number(parsed.stage) || 0)),
    cash: Math.round(Number(parsed.cash) || 0),
    respect: Math.round(Number(parsed.respect) || 0),
    playerPos: {
      x: Number(parsed.playerPos && parsed.playerPos.x) || 0,
      z: Number(parsed.playerPos && parsed.playerPos.z) || 0,
    },
    health: Math.min(100, Math.max(0, Math.round(Number(parsed.health) || 0))),
  };
}

/** Drop the stored checkpoint (mission finished / abandoned). */
export function clearCheckpoint() {
  const store = storageOrNull();
  if (!store) return false;
  try {
    store.removeItem(CHECKPOINT_KEY);
    return true;
  } catch (err) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Full save — snapshot, validation, read/write.
// ---------------------------------------------------------------------------

function freshRecord() {
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

// Snapshot from the public game surface when no provider is registered:
// position + weapon state off window.__azure, defaults for the rest.
function snapshotFromLiveGame() {
  const snap = freshRecord();
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
    const slot = snap.weapons.current;
    const mag = Number(combat.mag);
    const reserve = Number(combat.reserve);
    if (Number.isFinite(mag)) snap.weapons.mag[slot] = mag;
    if (Number.isFinite(reserve)) snap.weapons.reserve[slot] = reserve;
  }
  return snap;
}

// Validate + normalise a parsed record. Returns a clean record, or null
// when it is not a save we recognise (wrong version, wrong shape, corrupt).
export function validateSave(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.version !== SAVE_VERSION) return null;
  if (typeof data.savedAt !== 'string') return null;
  const snap = freshRecord();
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
        // Progress banked inside the current stage, so a reload resumes
        // mid-stage instead of restarting it: kills + collected items.
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
    const current = data.weapons.current;
    if (Number.isInteger(current) && current >= 0 && current <= 2) {
      snap.weapons.current = current;
    }
    for (const field of ['mag', 'reserve']) {
      const arr = data.weapons[field];
      if (Array.isArray(arr) && arr.length === 3) {
        snap.weapons[field] = arr.map((v) => (
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
  let snapshotFn = null; // () => snapshot object (main.js locals)
  let applyFn = null;    // (record) => void (main.js: health/cash/ammo)
  let savedAtStamp = null;

  function fetchRaw() {
    try {
      return window.localStorage.getItem(SAVE_KEY);
    } catch (err) {
      return null; // storage blocked (private mode): behave as no save
    }
  }

  function save(explicit) {
    const base = explicit && typeof explicit === 'object'
      ? explicit
      : (typeof snapshotFn === 'function' ? snapshotFn() : snapshotFromLiveGame());
    const record = validateSave({ ...freshRecord(), ...base, version: SAVE_VERSION });
    if (!record) return false;
    record.savedAt = new Date().toISOString();
    try {
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(record));
    } catch (err) {
      return false; // quota / blocked storage: report failure, never throw
    }
    savedAtStamp = record.savedAt;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('azure-save', { detail: record }));
    }
    return true;
  }

  function load() {
    const raw = fetchRaw();
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
    savedAtStamp = null;
    return true;
  }

  // Apply a loaded record to the live game. With an applier registered,
  // it does the whole job; without one, only the parts reachable from
  // here are restored (position + weapon index) and the record is
  // returned so the caller can finish it.
  function apply(record) {
    const data = record || load();
    if (!data) return null;
    if (typeof applyFn === 'function') {
      applyFn(data);
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
    persistCheckpoint,
    readCheckpoint,
    clearCheckpoint,
    /** main.js: register () => snapshot — the only way to capture health/cash/missions/respect. */
    setProvider(fn) {
      if (typeof fn === 'function') snapshotFn = fn;
    },
    /** main.js: register (record) => void — applies health/cash/ammo on load. */
    setApplier(fn) {
      if (typeof fn === 'function') applyFn = fn;
    },
    get lastSavedAt() { return savedAtStamp; },
    get key() { return SAVE_KEY; },
    get checkpointKey() { return CHECKPOINT_KEY; },
  };
  return api;
}

export const Save = createSave();
if (typeof window !== 'undefined') window.Save = Save;
