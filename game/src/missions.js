// missions.js — AZURE BAY mission engine + Missions 1-5, rewritten round 2.
// Pure logic, no THREE / DOM dependency: positions are plain {x, z} in
// world metres, so the engine can be unit-checked with plain node.
// main.js wires it in: import + createMissions(), call update(dt,
// player, ctx) every playing frame, feed combat kills through ctx.kills
// (or noteKill), and draw markers() on the 3D scene + minimap. Dialog
// lines are shown through window.Dialog when it exists (dialog.js);
// when it does not, missions still run — the lines are returned by
// start()/update() so the caller can show them another way.
//
// Street map (see config.js roads + props.js signs):
//   OCEAN AVE  — north island, north ring road (z = -190)
//   PALM BLVD  — north island, east-west cross street (z = -140)
//   BRIDGE RD  — the bridge deck (x = 0, z = -60..65)
//   BAY ST     — south island, north ring road (z = 90)
//   CORAL WAY  — south island, east-west cross street (z = 140)
//   MARINA DR  — south island, south ring road (z = 190), by the pier
//
// CH.1 "LOW TIDE" arc: the player washes up in Azure Bay owing Rook a
// favour, and works it off job by job until the ledger job (M5) flips
// the table — the first arc of the game, ending on a hook for CH.2.
//
// CHECKPOINTS, PERSISTED (round-2 fix): the old checkpoint — where the
// player entered the current stage — lived only in memory, so a reload
// mid-mission wiped it and a death after a reload respawned the player
// with nowhere to go back to. Checkpoints now live in localStorage
// (save.js: persistCheckpoint / readCheckpoint / clearCheckpoint, key
// 'azure-bay-checkpoint-v1'). Every stage entry writes one
// { missionId, stage, cash, respect, playerPos, health }; finishing or
// abandoning a mission clears it; respawning falls back to the stored
// record when the in-memory one is gone (after a reload). The cash /
// respect / health numbers come from an economy provider main.js can
// register (setEconomyProvider); without one they persist as safe
// defaults and the mission + stage + position still survive, which is
// the part the respawn actually needs.
//
// STATE-TRANSITION VALIDATION (round-2 fix): the stage index is now
// moved only through guarded paths — forward by exactly one stage
// (advance), backward only to the recorded checkpoint stage (respawn),
// or set once at resume after a range + prerequisite check. A jump of
// two stages, a stage past the end, or a resume into a mission whose
// prerequisites are not met is refused instead of silently corrupting
// the run.

import { persistCheckpoint, readCheckpoint, clearCheckpoint } from './save.js';

const COMPLETED_KEY = 'azurebay.missions.v1';

// ---- mission definitions ---------------------------------------------------
// Stage types:
//   goto    — reach the target (on foot or in a car)
//   drive   — reach the target WHILE DRIVING (player.isInCar must be true)
//   combat  — score stage.kills kills while the stage is active
//   collect — reach the target to pick the item up (stage.count, default 1)
//   deliver — reach the target carrying the item (same check as goto;
//             kept as its own type so the HUD/markers can word it right)
// Every stage carries: { type, text, x, z, radius, kills?, count?,
// lines? } — text is the HUD objective line for that stage, lines are
// the mid-mission dialog shown on stage advance. radius defaults to
// 6 m (drive: 8 m).

const MISSION_DEFS = [
  {
    id: 'm1',
    chapter: 'CH.1 — LOW TIDE',
    name: 'HOOK AND CHAIN',
    giver: 'Rook',
    start: { x: 30, z: -90 },
    reward: 400,
    respect: 10,
    requires: [],
    intro: [
      { speaker: 'ROOK', text: 'You washed up on my shore owing me a favour, kid. Time to pay it off — one small job, no questions.' },
      { speaker: 'ROOK', text: 'Take this package across BRIDGE RD to the marina pier on MARINA DR. Walk it, drive it — just don\'t drop it in the bay.' },
    ],
    outro: [
      { speaker: 'ROOK', text: 'Clean delivery. Maybe you\'re not useless after all.' },
      { speaker: 'ROOK', text: 'There\'s more work where that came from. Come see me when you\'re ready.' },
    ],
    stages: [
      {
        type: 'goto', text: 'Meet Rook on PALM BLVD', x: 30, z: -90, radius: 6,
        lines: [
          { speaker: 'ROOK', text: 'That is the package. Do not drop it in the bay — the last runner did, and he is still paying for it.' },
        ],
      },
      {
        type: 'drive', text: 'Drive the package across BRIDGE RD', x: 0, z: 0, radius: 8,
        lines: [
          { speaker: 'ROOK', text: 'Bridge is the only way over. Keep it steady — the package does not swim.' },
        ],
      },
      {
        type: 'deliver', text: 'Drop the package at the MARINA DR pier', x: 108, z: 150, radius: 6,
        lines: [
          { speaker: 'ROOK', text: 'Pier office, south end. Hand it to the man in the blue jacket — no small talk.' },
        ],
      },
    ],
  },
  {
    id: 'm2',
    chapter: 'CH.1 — LOW TIDE',
    name: 'SALT IN THE WOUND',
    giver: 'Rook',
    start: { x: 60, z: 140 },
    reward: 650,
    respect: 15,
    requires: ['m1'],
    intro: [
      { speaker: 'ROOK', text: 'Three drops went missing on CORAL WAY. Somebody\'s skimming my product and I want it back before sunset.' },
      { speaker: 'ROOK', text: 'Pick up all three stashes, then bring them to my man on OCEAN AVE. And kid — if the skimmer shows his face, don\'t be polite.' },
    ],
    outro: [
      { speaker: 'ROOK', text: 'All three, untouched. Whoever was skimming just lost his supplier.' },
      { speaker: 'ROOK', text: 'You\'re earning that debt off faster than I figured.' },
    ],
    stages: [
      {
        type: 'collect', text: 'Pick up the stash on CORAL WAY (east)', x: 60, z: 140, radius: 6,
        lines: [
          { speaker: 'ROOK', text: 'First stash, east end of Coral Way. Blue dumpster — quick and quiet.' },
        ],
      },
      {
        type: 'collect', text: 'Pick up the stash on CORAL WAY (west)', x: -60, z: 140, radius: 6,
        lines: [
          { speaker: 'ROOK', text: 'Second one is on the west end. Same deal — do not let anyone see you take it.' },
        ],
      },
      {
        type: 'collect', text: 'Pick up the stash on MARINA DR', x: 0, z: 190, radius: 6,
        lines: [
          { speaker: 'ROOK', text: 'Last stash is down by the marina. Then bring them all to my man up north.' },
        ],
      },
      {
        type: 'deliver', text: 'Deliver the stashes to OCEAN AVE', x: 30, z: -190, radius: 6,
        lines: [
          { speaker: 'ROOK', text: 'Ocean Ave, my man in the grey coat. Every stash — or do not bother coming back.' },
        ],
      },
    ],
  },
  {
    id: 'm3',
    chapter: 'CH.1 — LOW TIDE',
    name: 'CROSS CURRENT',
    giver: 'Rook',
    start: { x: 0, z: -60 },
    reward: 900,
    respect: 20,
    requires: ['m2'],
    intro: [
      { speaker: 'ROOK', text: 'The crew that hit my drops is squatting on BRIDGE RD, shaking down every car that crosses. That bridge is MY road.' },
      { speaker: 'ROOK', text: 'Clear them off it — all three — then drive the getaway car down CORAL WAY like you own the place.' },
    ],
    outro: [
      { speaker: 'ROOK', text: 'Bridge is open again. The boys saw you do it — word travels fast in this town.' },
      { speaker: 'ROOK', text: 'One of their runners talked before he ran. We know who\'s behind this now.' },
    ],
    stages: [
      {
        type: 'goto', text: 'Reach the north end of BRIDGE RD', x: 0, z: -60, radius: 8,
        lines: [
          { speaker: 'ROOK', text: 'They are on the bridge, shaking down my drivers. End of the line for them.' },
        ],
      },
      {
        type: 'combat', text: 'Clear the bridge crew on BRIDGE RD (0/3)', x: 0, z: 0, radius: 12, kills: 3,
        lines: [
          { speaker: 'ROOK', text: 'Three of them, at least. Clear the bridge — make it loud, I want the town to hear it.' },
        ],
      },
      {
        type: 'drive', text: 'Drive the getaway car down CORAL WAY', x: 0, z: 140, radius: 8,
        lines: [
          { speaker: 'ROOK', text: 'Bridge is yours. Now take the getaway car down Coral Way — nice and slow, let them see you.' },
        ],
      },
    ],
  },
  {
    id: 'm4',
    chapter: 'CH.1 — LOW TIDE',
    name: 'HIGH WATER MARK',
    giver: 'Rook',
    start: { x: 78, z: -140 },
    reward: 1200,
    respect: 25,
    requires: ['m3'],
    intro: [
      { speaker: 'ROOK', text: 'The cops are sniffing around my PALM BLVD route. I need a driver who can run the whole boulevard, east to west, without getting boxed in.' },
      { speaker: 'ROOK', text: 'Run it end to end, then lay low at the BAY ST safehouse till the heat dies down. Don\'t stop for anybody.' },
    ],
    outro: [
      { speaker: 'ROOK', text: 'You drove the whole boulevard and the cops never laid a hand on you. Beautiful.' },
      { speaker: 'ROOK', text: 'The safehouse is yours whenever you need it. One more job, kid — the big one.' },
    ],
    stages: [
      {
        type: 'drive', text: 'Start the run at the east end of PALM BLVD', x: 78, z: -140, radius: 8,
        lines: [
          { speaker: 'ROOK', text: 'Start at the east end of Palm Blvd. The cops are watching — do not give them a reason.' },
        ],
      },
      {
        type: 'drive', text: 'Run PALM BLVD end to end (west)', x: -78, z: -140, radius: 8,
        lines: [
          { speaker: 'ROOK', text: 'All the way west, kid. Do not stop for anybody — not even a red light.' },
        ],
      },
      {
        type: 'goto', text: 'Lay low at the BAY ST safehouse', x: 0, z: 90, radius: 6,
        lines: [
          { speaker: 'ROOK', text: 'Now lay low at the Bay St safehouse till the heat dies down. You did good.' },
        ],
      },
    ],
  },
  {
    id: 'm5',
    chapter: 'CH.1 — LOW TIDE',
    name: 'KING TIDE',
    giver: 'Rook',
    start: { x: 70, z: 90 },
    reward: 2000,
    respect: 40,
    requires: ['m4'],
    intro: [
      { speaker: 'ROOK', text: 'This is it. The ledger that names every dirty cop and every skimmed dollar in Azure Bay is sitting in a lockbox on the MARINA DR pier.' },
      { speaker: 'ROOK', text: 'A corner crew is guarding BAY ST. Take them down, grab the ledger, and bring it to me on OCEAN AVE. After tonight, your debt is paid — and this town owes YOU.' },
    ],
    outro: [
      { speaker: 'ROOK', text: 'The ledger. Every name, every number. With this, we own this town.' },
      { speaker: 'ROOK', text: 'Your debt is paid, kid. But something tells me you\'re not done with Azure Bay yet. CH.1 complete.' },
    ],
    stages: [
      {
        type: 'combat', text: 'Take the corner crew on BAY ST (0/4)', x: 70, z: 90, radius: 12, kills: 4,
        lines: [
          { speaker: 'ROOK', text: 'The corner crew guards that ledger with their lives. Take them down — all four.' },
        ],
      },
      {
        type: 'collect', text: 'Grab the ledger at the MARINA DR pier', x: 108, z: 150, radius: 6,
        lines: [
          { speaker: 'ROOK', text: 'The ledger is in the lockbox on the pier. Grab it and do not stop to count it.' },
        ],
      },
      {
        type: 'deliver', text: 'Bring the ledger to Rook on OCEAN AVE', x: 30, z: -190, radius: 6,
        lines: [
          { speaker: 'ROOK', text: 'Bring it to me on Ocean Ave. After tonight, your debt is paid — and this town owes you.' },
        ],
      },
    ],
  },
];

// ---- engine ------------------------------------------------------------------

export function createMissions(opts) {
  const options = opts || {};
  const defs = new Map();
  for (const def of MISSION_DEFS) defs.set(def.id, def);

  // Completed mission ids. Persisted to localStorage (guarded — a
  // denied store must never break the game).
  const completed = new Set();
  try {
    const saved = typeof localStorage !== 'undefined'
      ? JSON.parse(localStorage.getItem(COMPLETED_KEY) || 'null')
      : null;
    if (saved && Array.isArray(saved.completed)) {
      for (const id of saved.completed) if (defs.has(id)) completed.add(id);
    }
  } catch (err) { /* corrupt / denied storage: start fresh */ }

  let active = null; // { def, stageIndex, kills, pedKills, collected, startedAt }
  // Checkpoint: where the player was when the CURRENT stage began
  // ({ stageIndex, x, z }). Recorded on the first update after a
  // mission starts and again every time a stage advances, so a death
  // mid-mission respawns the player at the start of the stage they
  // died in — finished stages stay finished. Mirrored to localStorage
  // (save.js) on every write, so it survives a reload too.
  let checkpoint = null;
  // Last player position seen by update(), so a checkpoint can be
  // written even when the caller never hands us a position directly.
  let lastSeenPos = null;
  let onComplete = typeof options.onComplete === 'function' ? options.onComplete : null;
  let onReward = typeof options.onReward === 'function' ? options.onReward : null;
  // () => { cash, respect, health } — main.js owns those numbers, so
  // only it can hand them over for the checkpoint record. Without a
  // provider the checkpoint still persists (mission + stage +
  // position), with safe defaults for the economy numbers.
  let economyProvider = typeof options.economy === 'function' ? options.economy : null;

  function saveCompleted() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(COMPLETED_KEY, JSON.stringify({ completed: [...completed] }));
      }
    } catch (err) { /* storage denied: progress still lives in memory */ }
  }

  function cloneDef(def) {
    return JSON.parse(JSON.stringify(def));
  }

  function economySnapshot() {
    let snap = { cash: 0, respect: 0, health: 100 };
    if (typeof economyProvider === 'function') {
      try {
        const got = economyProvider() || {};
        if (Number.isFinite(Number(got.cash))) snap.cash = Math.round(Number(got.cash));
        if (Number.isFinite(Number(got.respect))) snap.respect = Math.round(Number(got.respect));
        if (Number.isFinite(Number(got.health))) {
          snap.health = Math.min(100, Math.max(0, Math.round(Number(got.health))));
        }
      } catch (err) { /* a throwing provider must never break missions */ }
    }
    return snap;
  }

  // Write the current stage entry as the persisted checkpoint. The
  // spot is the in-memory checkpoint when one exists (the stage-entry
  // position), otherwise the last seen player position, otherwise the
  // current stage's own target as a last resort. Never throws.
  function writeCheckpoint() {
    if (!active) return false;
    const econ = economySnapshot();
    const spot = checkpoint || (lastSeenPos ? { x: lastSeenPos.x, z: lastSeenPos.z } : null);
    const stage = active.def.stages[active.stageIndex];
    const pos = spot || (stage ? { x: stage.x, z: stage.z } : { x: 0, z: 0 });
    try {
      return persistCheckpoint({
        missionId: active.def.id,
        stage: active.stageIndex,
        cash: econ.cash,
        respect: econ.respect,
        playerPos: { x: pos.x, z: pos.z },
        health: econ.health,
      });
    } catch (err) {
      return false;
    }
  }

  // Guarded stage moves. The index may only ever:
  //   - step forward by exactly one (a stage completing), or
  //   - rewind to the recorded checkpoint stage (a death respawn), or
  //   - be set once at resume after the range + prerequisite checks.
  // Anything else — a jump of two stages, a stage past the end, a
  // rewind to a stage the player never reached — is refused.
  function isLegalMove(from, to, totalStages) {
    if (!Number.isInteger(to) || to < 0 || to > totalStages) return false;
    if (to === from + 1) return true; // advance
    if (checkpoint && to === checkpoint.stageIndex && to <= from) return true; // respawn rewind
    return false;
  }

  function register(def) {
    if (!def || typeof def.id !== 'string' || !def.id) return false;
    if (!Array.isArray(def.stages) || def.stages.length === 0) return false;
    if (defs.has(def.id)) return false; // never silently overwrite a mission
    defs.set(def.id, cloneDef(def));
    return true;
  }

  function getActive() {
    if (!active) return null;
    return {
      id: active.def.id,
      chapter: active.def.chapter,
      name: active.def.name,
      giver: active.def.giver,
      stageIndex: active.stageIndex,
      stage: active.stageIndex < active.def.stages.length
        ? { ...active.def.stages[active.stageIndex] }
        : null,
      stagesTotal: active.def.stages.length,
      kills: active.kills,
      // Ordinary pedestrians killed during this stage — tracked
      // separately, never counted toward the objective.
      pedKills: active.pedKills,
      collected: active.collected,
      reward: active.def.reward,
      respect: active.def.respect,
    };
  }

  function getCompleted() {
    return [...completed];
  }

  function getAvailable() {
    const out = [];
    for (const def of defs.values()) {
      if (completed.has(def.id)) continue;
      if (active && active.def.id === def.id) continue;
      const requires = Array.isArray(def.requires) ? def.requires : [];
      if (requires.every((id) => completed.has(id))) out.push(cloneDef(def));
    }
    return out;
  }

  // Alias the M menu can call either name.
  function listAvailable() {
    return getAvailable();
  }

  function getById(id) {
    const def = defs.get(id);
    return def ? cloneDef(def) : null;
  }

  function showLines(lines, done) {
    if (!Array.isArray(lines) || lines.length === 0) {
      if (typeof done === 'function') done();
      return;
    }
    const Dialog = typeof window !== 'undefined' ? window.Dialog : null;
    if (!Dialog || typeof Dialog.show !== 'function') {
      if (typeof done === 'function') done();
      return;
    }
    // Chain the lines: each box closes into the next one.
    let i = 0;
    const next = () => {
      if (i >= lines.length) {
        if (typeof done === 'function') done();
        return;
      }
      const line = lines[i];
      i += 1;
      Dialog.show(line.speaker || '', line.text || '', { onClose: next });
    };
    next();
  }

  // Start a mission by id. Returns { ok, mission, reason } — reason is
  // 'not-found' | 'already-active' | 'already-done' | 'locked' when ok
  // is false, so the caller can word the refusal instead of guessing.
  function start(id) {
    const def = defs.get(id);
    if (!def) return { ok: false, reason: 'not-found', mission: null };
    if (active) return { ok: false, reason: 'already-active', mission: null };
    if (completed.has(id)) return { ok: false, reason: 'already-done', mission: null };
    const requires = Array.isArray(def.requires) ? def.requires : [];
    if (!requires.every((r) => completed.has(r))) {
      return { ok: false, reason: 'locked', mission: null };
    }
    active = {
      def: cloneDef(def),
      stageIndex: 0,
      kills: 0,
      pedKills: 0,
      collected: 0,
      startedAt: Date.now(),
    };
    checkpoint = null; // recorded + persisted on the first update(), at the start spot
    try { clearCheckpoint(); } catch (err) { /* storage denied: ignore */ }
    const mission = getActive();
    showLines(def.intro);
    return { ok: true, reason: null, mission };
  }

  // Start the nearest available mission whose start marker is within
  // `radius` metres of the player (default 6 m). Used by the E key at a
  // mission marker and by the M menu. Returns the start() result, or
  // { ok: false, reason: 'none-nearby' } when nothing is in range.
  function tryStartNear(player, radius) {
    const range = Number.isFinite(radius) ? radius : 6;
    if (!player || !player.position) return { ok: false, reason: 'none-nearby', mission: null };
    if (active) return { ok: false, reason: 'already-active', mission: null };
    let best = null;
    let bestDist = Infinity;
    for (const def of getAvailable()) {
      const s = def.start || (def.stages && def.stages[0]);
      if (!s) continue;
      const d = Math.hypot(player.position.x - s.x, player.position.z - s.z);
      if (d <= range && d < bestDist) {
        best = def;
        bestDist = d;
      }
    }
    if (!best) return { ok: false, reason: 'none-nearby', mission: null };
    return start(best.id);
  }

  function abort() {
    if (!active) return false;
    active = null;
    checkpoint = null;
    try { clearCheckpoint(); } catch (err) { /* storage denied: ignore */ }
    return true;
  }

  // Shared activation checks for resume() and resumeFromCheckpoint():
  // the mission must exist, not be done, its prerequisites met, and
  // the stage inside its range. Returns a failure result or null when
  // the activation may proceed.
  function checkActivation(id, stageIndex) {
    if (active) return { ok: false, reason: 'already-active', mission: null };
    const def = defs.get(id);
    if (!def) return { ok: false, reason: 'not-found', mission: null };
    if (completed.has(id)) return { ok: false, reason: 'already-done', mission: null };
    const stage = Math.floor(Number(stageIndex));
    if (!Number.isFinite(stage) || stage < 0 || stage >= def.stages.length) {
      return { ok: false, reason: 'bad-stage', mission: null };
    }
    // A mission whose prerequisites are not met is never legitimately
    // active, so it cannot be resumed (a resume probe once activated
    // M2 on a fresh save and wrongly blocked M1 from starting at all).
    // Checked after the stage range so a bad stage reports bad-stage.
    const requires = Array.isArray(def.requires) ? def.requires : [];
    if (!requires.every((r) => completed.has(r))) {
      return { ok: false, reason: 'locked', mission: null };
    }
    return null;
  }

  function activateAt(def, stageIndex, kills, collected) {
    const stage = def.stages[stageIndex];
    const clamp = (v, max) => Math.max(0, Math.min(Math.floor(Number(v) || 0), max));
    active = {
      def: cloneDef(def),
      stageIndex,
      kills: stage.type === 'combat'
        ? clamp(kills, Number.isFinite(stage.kills) ? stage.kills : 3)
        : 0,
      pedKills: 0,
      collected: stage.type === 'collect'
        ? clamp(collected, Number.isFinite(stage.count) ? stage.count : 1)
        : 0,
      startedAt: Date.now(),
    };
    checkpoint = null; // re-recorded + persisted on the next update(), at the load spot
    writeCheckpoint();
    return { ok: true, reason: null, mission: getActive() };
  }

  // Resume a saved in-progress mission at its stage: the save record
  // (save.js, key 'azure-bay-save-v1') carries { id, stageIndex,
  // kills, collected } and main.js hands it here on load. The intro is
  // NOT replayed — the player already saw it — and the HUD objective +
  // beacon pick up from the resumed stage. The checkpoint is
  // re-recorded on the next update() tick, at the restored position.
  // Returns { ok, mission, reason } like start(); reason is
  // 'not-found' | 'already-active' | 'already-done' | 'bad-stage' |
  // 'locked' when ok is false.
  function resume(state) {
    if (!state || typeof state.id !== 'string') {
      return { ok: false, reason: 'not-found', mission: null };
    }
    const refusal = checkActivation(state.id, state.stageIndex);
    if (refusal) return refusal;
    const def = defs.get(state.id);
    return activateAt(def, Math.floor(Number(state.stageIndex)), state.kills, state.collected);
  }

  // Resume from the persisted checkpoint alone (no full save needed):
  // reads 'azure-bay-checkpoint-v1' and continues the mission at the
  // stage it records, with that stage's progress reset — the path a
  // reload-after-death takes when the full save is older than the
  // checkpoint. Same failure reasons as resume(), plus
  // 'no-checkpoint' when nothing is stored.
  function resumeFromCheckpoint() {
    let stored = null;
    try {
      stored = readCheckpoint();
    } catch (err) {
      stored = null;
    }
    if (!stored || typeof stored.missionId !== 'string' || !stored.missionId) {
      return { ok: false, reason: 'no-checkpoint', mission: null };
    }
    const refusal = checkActivation(stored.missionId, stored.stage);
    if (refusal) return refusal;
    const def = defs.get(stored.missionId);
    lastSeenPos = stored.playerPos ? { x: stored.playerPos.x, z: stored.playerPos.z } : null;
    return activateAt(def, Math.floor(Number(stored.stage)), 0, 0);
  }

  // Checkpoint: where the player entered the current stage, or null
  // when no mission is active. The copy keeps callers from mutating
  // the stored checkpoint.
  function getCheckpoint() {
    if (!active || !checkpoint) return null;
    return { missionId: active.def.id, stageIndex: checkpoint.stageIndex, x: checkpoint.x, z: checkpoint.z };
  }

  // Respawn: rewind the active mission to the start of the stage the
  // player died in. The stage index does NOT move back past the
  // checkpoint — stages already finished stay finished, and rewards
  // already banked (paid only on mission completion) are untouched —
  // only the current stage's progress (target kills, civilian kills,
  // collected items) resets to zero. When the in-memory checkpoint is
  // gone (a reload happened after the death), the persisted checkpoint
  // is read back and used instead. Returns the respawn spot, or null
  // when there is no active mission / checkpoint to respawn to.
  function respawnToCheckpoint() {
    if (!active) return null;
    let spot = checkpoint;
    if (!spot) {
      let stored = null;
      try {
        stored = readCheckpoint();
      } catch (err) {
        stored = null;
      }
      if (stored && stored.missionId === active.def.id
        && Number.isInteger(stored.stage)
        && stored.stage >= 0 && stored.stage < active.def.stages.length
        && stored.playerPos) {
        spot = { stageIndex: stored.stage, x: stored.playerPos.x, z: stored.playerPos.z };
      }
    }
    if (!spot) return null;
    // Guarded rewind only: the checkpoint stage must be at or behind
    // the current stage — a stored record can never push the player
    // forward past a stage they have not finished.
    if (!isLegalMove(active.stageIndex, spot.stageIndex, active.def.stages.length)) {
      return null;
    }
    active.stageIndex = spot.stageIndex;
    active.kills = 0;
    active.pedKills = 0;
    active.collected = 0;
    checkpoint = { stageIndex: spot.stageIndex, x: spot.x, z: spot.z };
    writeCheckpoint();
    return { missionId: active.def.id, stageIndex: checkpoint.stageIndex, x: checkpoint.x, z: checkpoint.z };
  }

  function reset() {
    active = null;
    checkpoint = null;
    lastSeenPos = null;
    completed.clear();
    saveCompleted();
    try { clearCheckpoint(); } catch (err) { /* storage denied: ignore */ }
  }

  function currentStage() {
    if (!active) return null;
    return active.def.stages[active.stageIndex] || null;
  }

  function advanceStage() {
    const next = active.stageIndex + 1;
    // Guarded +1 step only: the next index must be a real stage or
    // exactly the end (mission complete). Anything else is a bug, and
    // refusing it beats silently landing on an undefined stage.
    if (!isLegalMove(active.stageIndex, next, active.def.stages.length)) {
      return null;
    }
    active.stageIndex = next;
    active.kills = 0;
    active.pedKills = 0;
    active.collected = 0;
    if (active.stageIndex >= active.def.stages.length) {
      return finishMission(); // the completed mission, or null
    }
    return null;
  }

  function finishMission() {
    const def = active.def;
    completed.add(def.id);
    saveCompleted();
    const done = {
      id: def.id,
      chapter: def.chapter,
      name: def.name,
      reward: def.reward,
      respect: def.respect,
    };
    active = null;
    checkpoint = null;
    try { clearCheckpoint(); } catch (err) { /* storage denied: ignore */ }
    if (typeof onReward === 'function') onReward(done);
    if (typeof onComplete === 'function') onComplete(done);
    showLines(def.outro);
    return done;
  }

  // Feed one kill into the active combat stage (main.js calls this from
  // combatResult.kills, or passes the same kills through update's ctx).
  // Only MISSION TARGETS count toward the objective. An explicit
  // `isTarget` flag on the kill event wins (combat.js tags officer
  // kills true, ordinary-ped kills false); without the flag,
  // `type === 'officer'` counts and anything else does not. A civilian
  // kill is tracked separately in pedKills — visible in getActive() —
  // and never advances the objective. Returns true when the kill
  // counted toward the objective.
  function noteKill(kill) {
    if (!active) return false;
    const stage = currentStage();
    if (!stage || stage.type !== 'combat') return false;
    if (!kill || typeof kill !== 'object') return false;
    const isTarget = kill.isTarget !== undefined
      ? !!kill.isTarget
      : kill.type === 'officer';
    if (isTarget) {
      active.kills += 1;
      return true;
    }
    if (kill.type === 'ped') active.pedKills += 1;
    return false;
  }

  // Per-frame tick. ctx is optional and main.js supplied:
  //   ctx.kills   — array of kill events this frame (combatResult.kills)
  //   ctx.inCar   — override for the driving check (default: player.isInCar)
  // Returns { completed: <mission|null> } so main.js can apply the
  // reward the same frame the outro dialog opens.
  function update(dt, player, ctx) {
    void dt;
    if (!active || !player || !player.position) return { completed: null };
    const context = ctx || {};
    if (Number.isFinite(player.position.x) && Number.isFinite(player.position.z)) {
      lastSeenPos = { x: player.position.x, z: player.position.z };
    }
    // Checkpoint: the spot where the player entered the current stage.
    // Recorded on the first tick of a fresh mission (the start spot)
    // and refreshed below every time a stage advances — and persisted
    // to localStorage each time, so a reload keeps it.
    if (!checkpoint) {
      checkpoint = { stageIndex: active.stageIndex, x: player.position.x, z: player.position.z };
      writeCheckpoint();
    }
    if (Array.isArray(context.kills)) {
      for (const kill of context.kills) noteKill(kill);
    }
    const stage = currentStage();
    if (!stage) return { completed: null };
    const px = player.position.x;
    const pz = player.position.z;
    const dist = Math.hypot(px - stage.x, pz - stage.z);
    const radius = Number.isFinite(stage.radius) ? stage.radius : 6;
    const inCar = context.inCar !== undefined ? !!context.inCar : !!player.isInCar;

    let done = false;
    if (stage.type === 'goto' || stage.type === 'deliver') {
      done = dist <= radius;
    } else if (stage.type === 'drive') {
      // A drive stage only counts while actually driving: walking the
      // route on foot does not complete it.
      done = inCar && dist <= radius;
    } else if (stage.type === 'collect') {
      if (dist <= radius) {
        active.collected += 1;
        const need = Number.isFinite(stage.count) ? stage.count : 1;
        done = active.collected >= need;
      }
    } else if (stage.type === 'combat') {
      const need = Number.isFinite(stage.kills) ? stage.kills : 3;
      done = active.kills >= need;
    }

    if (!done) return { completed: null };
    const finished = advanceStage();
    // A new stage just began where the player stands now — that spot
    // is the checkpoint a death in this stage returns to, and it is
    // persisted immediately. (When the mission finished, active is
    // null and there is no checkpoint to record — finishMission already
    // cleared the stored one.)
    if (!finished && active) {
      checkpoint = { stageIndex: active.stageIndex, x: px, z: pz };
      writeCheckpoint();
    }
    return { completed: finished };
  }

  // HUD objective line for the active mission, with live progress for
  // combat/collect stages ("(2/3)"). Null when no mission is active,
  // so main.js can fall back to its default objective text.
  function getHUDText() {
    if (!active) return null;
    const stage = currentStage();
    if (!stage) return null;
    let text = stage.text || '';
    if (stage.type === 'combat') {
      const need = Number.isFinite(stage.kills) ? stage.kills : 3;
      const have = Math.min(active.kills, need);
      text = text.replace(/\(\d+\/\d+\)\s*$/, '').trim() + ` (${have}/${need})`;
    } else if (stage.type === 'collect' && Number.isFinite(stage.count) && stage.count > 1) {
      const have = Math.min(active.collected, stage.count);
      text = text.replace(/\(\d+\/\d+\)\s*$/, '').trim() + ` (${have}/${stage.count})`;
    }
    return `${active.def.id.toUpperCase()} — ${active.def.name}: ${text}`;
  }

  // Markers for the 3D scene and the minimap:
  //   active mission  → current stage target { kind: 'objective' }
  //   available ones  → start marker at def.start { kind: 'mission' }
  // kind 'deliver' marks deliver/collect targets so the renderer can
  // colour them differently from plain goto targets.
  function markers() {
    const out = [];
    if (active) {
      const stage = currentStage();
      if (stage) {
        out.push({
          x: stage.x,
          z: stage.z,
          label: stage.text || active.def.name,
          kind: stage.type === 'deliver' || stage.type === 'collect' ? 'deliver' : 'objective',
          missionId: active.def.id,
        });
      }
    }
    for (const def of getAvailable()) {
      const s = def.start || (def.stages && def.stages[0]);
      if (!s) continue;
      out.push({
        x: s.x,
        z: s.z,
        label: `${def.id.toUpperCase()} — ${def.name}`,
        kind: 'mission',
        missionId: def.id,
      });
    }
    return out;
  }

  const api = {
    register,
    start,
    getActive,
    getCompleted,
    getAvailable,
    listAvailable,
    getById,
    tryStartNear,
    update,
    noteKill,
    resume,
    resumeFromCheckpoint,
    getCheckpoint,
    respawnToCheckpoint,
    getHUDText,
    markers,
    abort,
    reset,
    setOnComplete(cb) { onComplete = typeof cb === 'function' ? cb : null; },
    setOnReward(cb) { onReward = typeof cb === 'function' ? cb : null; },
    /** Register () => { cash, respect, health } so checkpoints persist live economy numbers. */
    setEconomyProvider(fn) { economyProvider = typeof fn === 'function' ? fn : null; },
  };
  return api;
}

// Default singleton, exposed for the other lanes and the console.
export const Missions = createMissions();
if (typeof window !== 'undefined') {
  window.Missions = Missions;
}
