// missions.js — AZURE BAY mission engine + Misi 1-5 (Lane A, Fase 3)
// Pure logic, no THREE / DOM dependency: positions are plain {x, z} in
// world metres, so the engine can be unit-checked with plain node.
// Lane E wires it into main.js: import + createMissions(), call
// Missions.update(dt, player, ctx) every playing frame, feed combat
// kills through ctx.kills (or noteKill), and draw markers() on the 3D
// scene + minimap. Dialog lines are shown through window.Dialog when
// it exists (dialog.js); when it does not, missions still run — the
// lines are returned by start()/update() so Lane E can show them
// another way.
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

const SAVE_KEY = 'azurebay.missions.v1';

// ---- mission definitions ---------------------------------------------------
// Stage types:
//   goto    — reach the target (on foot or in a car)
//   drive   — reach the target WHILE DRIVING (player.isInCar must be true)
//   combat  — score stage.kills kills while the stage is active
//   collect — reach the target to pick the item up (stage.count, default 1)
//   deliver — reach the target carrying the item (same check as goto;
//             kept as its own type so the HUD/markers can word it right)
// Every stage: { type, x, z, radius, text } — text is the HUD objective
// line for that stage. radius defaults to 6 m (drive: 8 m).

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
        type: 'goto', x: 30, z: -90, radius: 6, text: 'Meet Rook on PALM BLVD',
        lines: [
          { speaker: 'ROOK', text: 'That is the package. Do not drop it in the bay — the last runner did, and he is still paying for it.' },
        ],
      },
      {
        type: 'drive', x: 0, z: 0, radius: 8, text: 'Drive the package across BRIDGE RD',
        lines: [
          { speaker: 'ROOK', text: 'Bridge is the only way over. Keep it steady — the package does not swim.' },
        ],
      },
      {
        type: 'deliver', x: 108, z: 150, radius: 6, text: 'Drop the package at the MARINA DR pier',
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
        type: 'collect', x: 60, z: 140, radius: 6, text: 'Pick up the stash on CORAL WAY (east)',
        lines: [
          { speaker: 'ROOK', text: 'First stash, east end of Coral Way. Blue dumpster — quick and quiet.' },
        ],
      },
      {
        type: 'collect', x: -60, z: 140, radius: 6, text: 'Pick up the stash on CORAL WAY (west)',
        lines: [
          { speaker: 'ROOK', text: 'Second one is on the west end. Same deal — do not let anyone see you take it.' },
        ],
      },
      {
        type: 'collect', x: 0, z: 190, radius: 6, text: 'Pick up the stash on MARINA DR',
        lines: [
          { speaker: 'ROOK', text: 'Last stash is down by the marina. Then bring them all to my man up north.' },
        ],
      },
      {
        type: 'deliver', x: 30, z: -190, radius: 6, text: 'Deliver the stashes to OCEAN AVE',
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
        type: 'goto', x: 0, z: -60, radius: 8, text: 'Reach the north end of BRIDGE RD',
        lines: [
          { speaker: 'ROOK', text: 'They are on the bridge, shaking down my drivers. End of the line for them.' },
        ],
      },
      {
        type: 'combat', x: 0, z: 0, radius: 12, kills: 3, text: 'Clear the bridge crew on BRIDGE RD (0/3)',
        lines: [
          { speaker: 'ROOK', text: 'Three of them, at least. Clear the bridge — make it loud, I want the town to hear it.' },
        ],
      },
      {
        type: 'drive', x: 0, z: 140, radius: 8, text: 'Drive the getaway car down CORAL WAY',
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
        type: 'drive', x: 78, z: -140, radius: 8, text: 'Start the run at the east end of PALM BLVD',
        lines: [
          { speaker: 'ROOK', text: 'Start at the east end of Palm Blvd. The cops are watching — do not give them a reason.' },
        ],
      },
      {
        type: 'drive', x: -78, z: -140, radius: 8, text: 'Run PALM BLVD end to end (west)',
        lines: [
          { speaker: 'ROOK', text: 'All the way west, kid. Do not stop for anybody — not even a red light.' },
        ],
      },
      {
        type: 'goto', x: 0, z: 90, radius: 6, text: 'Lay low at the BAY ST safehouse',
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
        type: 'combat', x: 70, z: 90, radius: 12, kills: 4, text: 'Take the corner crew on BAY ST (0/4)',
        lines: [
          { speaker: 'ROOK', text: 'The corner crew guards that ledger with their lives. Take them down — all four.' },
        ],
      },
      {
        type: 'collect', x: 108, z: 150, radius: 6, text: 'Grab the ledger at the MARINA DR pier',
        lines: [
          { speaker: 'ROOK', text: 'The ledger is in the lockbox on the pier. Grab it and do not stop to count it.' },
        ],
      },
      {
        type: 'deliver', x: 30, z: -190, radius: 6, text: 'Bring the ledger to Rook on OCEAN AVE',
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
  // denied store must never break the game); Lane E can also drive
  // this with loadState()/saveState() if it owns persistence instead.
  const completed = new Set();
  try {
    const saved = typeof localStorage !== 'undefined'
      ? JSON.parse(localStorage.getItem(SAVE_KEY) || 'null')
      : null;
    if (saved && Array.isArray(saved.completed)) {
      for (const id of saved.completed) if (defs.has(id)) completed.add(id);
    }
  } catch (err) { /* corrupt / denied storage: start fresh */ }

  let active = null; // { def, stageIndex, kills, pedKills, collected, startedAt }
  // Fase 4 (Lane B) checkpoint: where the player was when the CURRENT
  // stage began ({ stageIndex, x, z }). Recorded on the first update
  // after a mission starts and again every time a stage advances, so a
  // death mid-mission respawns the player at the start of the stage
  // they died in — finished stages stay finished. In-memory only.
  // (Fase 4, Lane A: the mission + stage + stage progress themselves
  // DO survive a reload now — resume() above restores them from the
  // save record; only this checkpoint spot is re-recorded at the load
  // position instead of being persisted.)
  let checkpoint = null;
  let onComplete = typeof options.onComplete === 'function' ? options.onComplete : null;
  let onReward = typeof options.onReward === 'function' ? options.onReward : null;

  function save() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(SAVE_KEY, JSON.stringify({ completed: [...completed] }));
      }
    } catch (err) { /* storage denied: progress still lives in memory */ }
  }

  function cloneDef(def) {
    return JSON.parse(JSON.stringify(def));
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
      // Fase 4 (Lane B): ordinary pedestrians killed during this stage
      // — tracked separately, never counted toward the objective.
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

  // Alias Lane E / the M menu can call either name.
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
    checkpoint = null; // recorded on the first update(), at the start spot
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
    return true;
  }

  // Resume a saved in-progress mission at its stage (Fase 4, Lane A):
  // the save record (save.js, key 'azure-bay-save-v1') carries
  // { id, stageIndex, kills, collected } and main.js hands it here on
  // load. The intro is NOT replayed — the player already saw it — and
  // the HUD objective + beacon pick up from the resumed stage. The
  // checkpoint is re-recorded on the next update() tick, at the
  // restored position. Returns { ok, mission, reason } like start();
  // reason is 'not-found' | 'already-active' | 'already-done' |
  // 'bad-stage' when ok is false.
  function resume(state) {
    if (!state || typeof state.id !== 'string') {
      return { ok: false, reason: 'not-found', mission: null };
    }
    if (active) return { ok: false, reason: 'already-active', mission: null };
    const def = defs.get(state.id);
    if (!def) return { ok: false, reason: 'not-found', mission: null };
    if (completed.has(state.id)) return { ok: false, reason: 'already-done', mission: null };
    const stageIndex = Math.floor(Number(state.stageIndex));
    if (!Number.isFinite(stageIndex) || stageIndex < 0 || stageIndex >= def.stages.length) {
      return { ok: false, reason: 'bad-stage', mission: null };
    }
    // A mission whose prerequisites are not met is never legitimately
    // active, so it cannot be resumed (Fase 4, Lane A: the resume
    // probes called resume({id:'m2'}) on a fresh save and it WRONGLY
    // activated M2, which then blocked M1 from starting at all).
    // Checked after the stage range so a bad stage reports bad-stage.
    const requires = Array.isArray(def.requires) ? def.requires : [];
    if (!requires.every((id) => completed.has(id))) {
      return { ok: false, reason: 'locked', mission: null };
    }
    const stage = def.stages[stageIndex];
    const clamp = (v, max) => Math.max(0, Math.min(Math.floor(Number(v) || 0), max));
    active = {
      def: cloneDef(def),
      stageIndex,
      kills: stage.type === 'combat'
        ? clamp(state.kills, Number.isFinite(stage.kills) ? stage.kills : 3)
        : 0,
      pedKills: 0,
      collected: stage.type === 'collect'
        ? clamp(state.collected, Number.isFinite(stage.count) ? stage.count : 1)
        : 0,
      startedAt: Date.now(),
    };
    checkpoint = null; // re-recorded on the next update(), at the load spot
    return { ok: true, reason: null, mission: getActive() };
  }

  // Fase 4 (Lane B) checkpoint: where the player entered the current
  // stage, or null when no mission is active. The copy keeps callers
  // from mutating the stored checkpoint.
  function getCheckpoint() {
    if (!active || !checkpoint) return null;
    return { missionId: active.def.id, stageIndex: checkpoint.stageIndex, x: checkpoint.x, z: checkpoint.z };
  }

  // Fase 4 (Lane B) respawn: rewind the active mission to the start of
  // the stage the player died in. The stage index does NOT move back —
  // stages already finished stay finished, and rewards already banked
  // (paid only on mission completion) are untouched — only the current
  // stage's progress (target kills, civilian kills, collected items)
  // resets to zero. Returns the respawn spot, or null when there is no
  // active mission / checkpoint to respawn to.
  function respawnToCheckpoint() {
    if (!active || !checkpoint) return null;
    active.stageIndex = checkpoint.stageIndex;
    active.kills = 0;
    active.pedKills = 0;
    active.collected = 0;
    return { missionId: active.def.id, stageIndex: checkpoint.stageIndex, x: checkpoint.x, z: checkpoint.z };
  }

  function reset() {
    active = null;
    checkpoint = null;
    completed.clear();
    save();
  }

  function currentStage() {
    if (!active) return null;
    return active.def.stages[active.stageIndex] || null;
  }

  function advanceStage() {
    active.stageIndex += 1;
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
    save();
    const done = {
      id: def.id,
      chapter: def.chapter,
      name: def.name,
      reward: def.reward,
      respect: def.respect,
    };
    active = null;
    checkpoint = null;
    if (typeof onReward === 'function') onReward(done);
    if (typeof onComplete === 'function') onComplete(done);
    showLines(def.outro);
    return done;
  }

  // Feed one kill into the active combat stage (Lane E calls this from
  // combatResult.kills, or passes the same kills through update's ctx).
  // Fase 4 (Lane B): only MISSION TARGETS count toward the objective.
  // An explicit `isTarget` flag on the kill event wins (combat.js tags
  // officer kills true, ordinary-ped kills false); without the flag,
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

  // Per-frame tick. ctx is optional and Lane-E supplied:
  //   ctx.kills   — array of kill events this frame (combatResult.kills)
  //   ctx.inCar   — override for the driving check (default: player.isInCar)
  // Returns { completed: <mission|null> } so Lane E can apply the reward
  // the same frame the outro dialog opens.
  function update(dt, player, ctx) {
    void dt;
    if (!active || !player || !player.position) return { completed: null };
    const context = ctx || {};
    // Fase 4 (Lane B) checkpoint: the spot where the player entered the
    // current stage. Recorded on the first tick of a fresh mission (the
    // start spot) and refreshed below every time a stage advances.
    if (!checkpoint) {
      checkpoint = { stageIndex: active.stageIndex, x: player.position.x, z: player.position.z };
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
    // Fase 4 (Lane B): a new stage just began where the player stands
    // now — that spot is the checkpoint a death in this stage returns
    // to. (When the mission finished, active is null and there is no
    // checkpoint to record.)
    if (!finished && active) {
      checkpoint = { stageIndex: active.stageIndex, x: px, z: pz };
    }
    return { completed: finished };
  }

  // HUD objective line for the active mission, with live progress for
  // combat/collect stages ("(2/3)"). Null when no mission is active,
  // so Lane E can fall back to its default objective text.
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

  // Markers for the 3D scene (Lane C) and the minimap (Lane E):
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
    getCheckpoint,
    respawnToCheckpoint,
    getHUDText,
    markers,
    abort,
    reset,
    setOnComplete(cb) { onComplete = typeof cb === 'function' ? cb : null; },
    setOnReward(cb) { onReward = typeof cb === 'function' ? cb : null; },
  };
  return api;
}

// Default singleton, exposed for Lane B/C/D/E and the console.
export const Missions = createMissions();
if (typeof window !== 'undefined') {
  window.Missions = Missions;
}
