// AZURE BAY — story arc + Missions 6-10 + NPCs, rewritten round 2.
//
// This file is DATA + REGISTRATION ONLY. It owns no game loop, no
// rendering and no mission runtime: it hands its mission definitions
// to the mission engine (game/src/missions.js) and its lines to the
// dialog system, and main.js wires the load order (import this module
// AFTER missions.js, or call window.Story.registerAll()).
//
// ---- the real contract (missions.js — read, not assumed) -------------------
//   window.Missions.register(def) where def is:
//     { id, chapter: 'CH.2 — RISING TIDE', name, giver, start: {x, z},
//       reward, respect, requires: ['m5'],
//       intro: [{speaker, text}], outro: [{speaker, text}],
//       stages: [{ type: 'goto'|'drive'|'combat'|'collect'|'deliver',
//                  x, z, radius, text, kills?, count? }] }
//   Notes that shaped this file:
//   - register() JSON-clones the def, so defs carry DATA ONLY: no
//     functions. There is no per-mission onStart/onComplete hook in the
//     engine — intro lines play on start(), outro lines on finish.
//   - combat stages need `kills` (default 3); collect stages take
//     `count` (default 1); drive stages only count while in a car.
//   - `start` is the marker the player walks up to and presses E on
//     (tryStartNear, radius 6 m); `requires` gates availability.
//   - Mid-mission lines: the engine shows intro/outro only. Each stage
//     below ALSO carries a `lines` array ([{speaker, text}]) as plain
//     data (it survives the JSON clone) for main.js to show on stage
//     advance — the engine itself will not display them yet.
//   - Dialog: window.Dialog.show(speaker, text, {onClose}) when
//     dialog.js exists; the engine degrades gracefully without it.
//   - Wanted/heat: the engine has no heat hook either. M10's 5-star
//     finale builds from combat kills (main.js already adds heat per
//     kill) plus the police response; if main.js wants the finale to
//     OPEN hot, it can call window.__azure.wanted.addHeat(3, 'story')
//     when starting m10 — that call lives in main.js, not here.
//
// ---- street map (the map in missions.js, matches props.js signs) ----------
//   OCEAN AVE  — north island, NORTH ring road, z = -190
//   PALM BLVD  — north island, east-west cross street, z = -140
//   BRIDGE RD  — the bridge deck, x = 0, z -60..65
//   BAY ST     — south island, north ring road, z = 90
//   CORAL WAY  — south island, east-west cross street, z = 140
//   MARINA DR  — south island, SOUTH ring road, z = 190; the pier office
//                sits at (108, 150), reached off MARINA DR.
//
// ---- story arc (continues Missions 1-5) ------------------------------------
//   CH.1 LOW TIDE (M1-5): the player washes up owing ROOK a favour
//     and works it off — M5 KING TIDE ends with the ledger delivered
//     to Rook on OCEAN AVE, the debt paid, and Rook's "you're not done
//     with Azure Bay yet" hook. The ledger names every dirty cop and
//     every skimmed dollar in town — which is why CH.2 happens.
//   CH.2 RISING TIDE (M6-7): Dante "Kingfish" Moreau, who ran the crew
//     behind the M2 skimming and the M3 bridge shakedown, moves on
//     Rook's patch to get the ledger back. One last quiet run (M6),
//     then the player answers the shakedown in person (M7).
//   CH.3 HIGH WATER (M8-9): open war. A getaway Comet is driven across
//     BRIDGE RD under fire (M8); then Detective Calloway — the one clean
//     cop the ledger names as NOT bought — offers a trade: Kingfish's
//     payoff book for Kingfish's head (M9).
//   CH.4 STORM SURGE (M10): finale at the marina on MARINA DR — take
//     down Kingfish's crew, then outrun the full response (cops + heli)
//     across BRIDGE RD to the OCEAN AVE safehouse.
// Every stage text names its street, so the player navigates by the
// street signs instead of a bare blip.

// ---- streets ----------------------------------------------------------------
export const STREETS = {
  'OCEAN AVE': { x: 30, z: -190 },
  'PALM BLVD': { x: -40, z: -140 },
  'BRIDGE RD': { x: 0, z: 0 },
  'BAY ST': { x: -30, z: 90 },
  'CORAL WAY': { x: 40, z: 140 },
  'MARINA DR': { x: 60, z: 190 },
};

// The marina pier office (M1/M5 ledger spot, M9 payoff-book spot).
export const MARINA_PIER = { x: 108, z: 150 };

// Representative point on a named street (centre of its most-used stretch).
export function streetPoint(street) {
  const p = STREETS[street];
  return p ? { x: p.x, z: p.z } : null;
}

// ---- chapters ---------------------------------------------------------------
export const CHAPTERS = [
  {
    id: 'ch1',
    title: 'CH.1 — LOW TIDE',
    tagline: 'Fresh off the boat with empty pockets and a name to make.',
    summary:
      'Missions 1-5: the player washes up owing Rook a favour ' +
      'and works it off job by job — M5 KING TIDE ends with the ledger ' +
      'delivered to Rook on OCEAN AVE, the debt paid, and the hook for CH.2.',
    missions: ['m1', 'm2', 'm3', 'm4', 'm5'],
  },
  {
    id: 'ch2',
    title: 'CH.2 — RISING TIDE',
    tagline: 'The bay pays Kingfish — unless somebody says no.',
    summary:
      'Missions 6-7: Kingfish moves on Rook\'s patch to get the ledger ' +
      'back. The player runs one last quiet job (M6), then answers the ' +
      'shakedown in person (M7) and puts the crew on notice.',
    missions: ['m6', 'm7'],
  },
  {
    id: 'ch3',
    title: 'CH.3 — HIGH WATER',
    tagline: 'A fast car, a stolen payoff book, and a cop with a deal.',
    summary:
      'Missions 8-9: open war with the Kingfish crew. A getaway Comet is ' +
      'driven across BRIDGE RD under fire (M8); then Detective Calloway ' +
      'offers a trade — the payoff book for Kingfish\'s head (M9).',
    missions: ['m8', 'm9'],
  },
  {
    id: 'ch4',
    title: 'CH.4 — STORM SURGE',
    tagline: 'Tonight it ends — at the marina, in front of the whole bay.',
    summary:
      'Mission 10, the finale: confront Kingfish at the marina on MARINA DR, ' +
      'take down his crew, then outrun a full 5-star response — cops and the ' +
      'police heli — across BRIDGE RD to the OCEAN AVE safehouse.',
    missions: ['m10'],
  },
];

// ---- NPCs -------------------------------------------------------------------
// color: the NPC's blip / nameplate colour. location: where they stand
// when idle (just off the asphalt so they are never in the driving lane).
// greeting: the line shown when the player walks up to them outside a
// mission. The giver of each mission below is one of these five.
export const NPCS = [
  {
    id: 'rook',
    name: 'Rook',
    short: 'ROOK',
    role: 'Fixer — the player\'s patron. Runs the north-island jobs from OCEAN AVE; the CH.1 giver, and the man Kingfish wants the ledger back from.',
    color: '#ffd24a',
    street: 'OCEAN AVE',
    location: { x: 30, z: -190 },
    greeting: 'Debt\'s paid, kid. But the bay isn\'t done with you — and neither am I.',
  },
  {
    id: 'eddie-wrench',
    name: 'Eddie "Wrench" Kowalski',
    short: 'EDDIE',
    role: 'Mechanic — runs the garage on CORAL WAY. Supplies getaway cars and keeps them running.',
    color: '#ff8c42',
    street: 'CORAL WAY',
    location: { x: 52, z: 147 },
    greeting: 'You break it, I fix it. You need fast, I build fast. That is the whole menu.',
  },
  {
    id: 'silas-ghost',
    name: 'Silas "Ghost" Marlowe',
    short: 'SILAS',
    role: 'Informant — lives at the marina on MARINA DR and hears everything before it happens.',
    color: '#9b8cff',
    street: 'MARINA DR',
    location: { x: 60, z: 190 },
    greeting: 'Shh. Walls have ears, boats have radios. Ask quick, pay quicker.',
  },
  {
    id: 'dante-kingfish',
    name: 'Dante "Kingfish" Moreau',
    short: 'KINGFISH',
    role: 'Gang boss — runs the BAY ST docks and taxes every hustle on the south island. The arc villain; his crew ran the M2 skimming and the M3 bridge shakedown.',
    color: '#e74c3c',
    street: 'BAY ST',
    location: { x: -52, z: 97 },
    greeting: 'The bay pays ME, kid. You are either paying, or you are in my way.',
  },
  {
    id: 'det-calloway',
    name: 'Detective Ray Calloway',
    short: 'CALLOWAY',
    role: 'ABPD detective — the one clean cop the ledger names as NOT bought. Willing to deal with a criminal to bury a bigger one.',
    color: '#4aa3ff',
    street: 'BAY ST',
    location: { x: -48, z: 90 },
    greeting: 'Off the record, kid. I am not your friend — but Kingfish is both our problem.',
  },
];

export function getNPC(id) {
  return NPCS.find((n) => n.id === id) || null;
}

// ---- dialog -----------------------------------------------------------------
// Thin wrapper over the dialog system: a no-op when Dialog is not loaded
// yet, so story code can never crash the game. Signature matches the
// engine's own showLines(): show(speaker, text, opts?) with opts.onClose.
export function say(speaker, text, opts) {
  if (typeof window !== 'undefined' && window.Dialog && typeof window.Dialog.show === 'function') {
    window.Dialog.show(speaker, text, opts);
  }
}

// ---- missions 6-10 ----------------------------------------------------------
// Reward curve (M1 $400/+10, M2 $650/+15, M3 $900/+20, M4 $1200/+25,
// M5 $2000/+40): M6 $400/+15, M7 $650/+25, M8 $900/+35, M9 $1200/+40,
// M10 $2500/+60. Requires chains the arc: m6 needs m5, then each
// mission needs the one before it, so the story can only be played in
// order. Stage text always names its street; stage `lines` are
// mid-mission dialog data for main.js (see header — the engine shows
// intro/outro only).
export const MISSIONS = [
  {
    id: 'm6',
    chapter: 'CH.2 — RISING TIDE',
    name: "RUNNER'S TAB",
    giver: 'Rook',
    start: { x: 30, z: -190 },
    reward: 400,
    respect: 15,
    requires: ['m5'],
    intro: [
      { speaker: 'ROOK', text: 'That ledger you brought me? It names Kingfish — every dollar he skimmed, every cop he bought. Now he wants it back.' },
      { speaker: 'ROOK', text: 'One last quiet run before this gets loud. Package to Eddie, then check with Silas at the marina. No questions, no shortcuts.' },
    ],
    outro: [
      { speaker: 'ROOK', text: 'Clean run. The bay\'s starting to know your name.' },
      { speaker: 'SILAS', text: 'Word travels fast on this bay. Kingfish is asking about Rook\'s new runner. That is you, kid.' },
    ],
    stages: [
      {
        type: 'goto', text: 'Meet Rook on OCEAN AVE', x: 30, z: -190, radius: 6,
        lines: [
          { speaker: 'ROOK', text: 'You want work, kid? Start small. A package, a drive, no questions.' },
        ],
      },
      {
        type: 'collect', text: 'Pick up the package on PALM BLVD', x: -40, z: -140, radius: 6,
        lines: [
          { speaker: 'ROOK', text: 'Palm Blvd, blue dumpster by the palms. Do not let anyone see you take it.' },
        ],
      },
      {
        type: 'deliver', text: "Deliver the package to Eddie's garage on CORAL WAY", x: 52, z: 147, radius: 6,
        lines: [
          { speaker: 'EDDIE', text: "Rook sends his runners, I fix their rides. This one's clean, kid." },
        ],
      },
      {
        type: 'goto', text: 'Check in with Silas on MARINA DR', x: 60, z: 190, radius: 6,
        lines: [
          { speaker: 'SILAS', text: "Kingfish's boys are asking questions at every bar on the south island. Keep your head down — for now." },
        ],
      },
    ],
  },
  {
    id: 'm7',
    chapter: 'CH.2 — RISING TIDE',
    name: 'KINGFISH TAX',
    giver: 'Rook',
    start: { x: 30, z: -190 },
    reward: 650,
    respect: 25,
    requires: ['m6'],
    intro: [
      { speaker: 'ROOK', text: 'Kingfish\'s boys are shaking down my bar\'s suppliers on BAY ST. Same crew that skimmed my drops in M2 — time they learned whose street this is.' },
      { speaker: 'ROOK', text: 'Go remind them. Then bring me what they collected — consider it a refund.' },
    ],
    outro: [
      { speaker: 'ROOK', text: 'The docks are quiet tonight. Kingfish will not forget this — neither will I.' },
      { speaker: 'KINGFISH', text: 'You took my boys and my money, kid. The bay pays ME — and now YOU owe me.' },
    ],
    stages: [
      {
        type: 'goto', text: 'Go to the docks on BAY ST', x: -52, z: 97, radius: 8,
        lines: [
          { speaker: 'KINGFISH', text: "So Rook's got himself a new errand boy. The bay pays ME, kid. Remember that." },
        ],
      },
      {
        type: 'combat', text: "Deal with Kingfish's collectors on BAY ST (0/3)", x: -40, z: 90, radius: 12, kills: 3,
        lines: [
          { speaker: 'KINGFISH', text: 'You think a pistol makes you somebody? My boys collect — or they bury.' },
        ],
      },
      {
        type: 'collect', text: 'Collect the skimmed cash on BAY ST', x: -30, z: 90, radius: 6,
        lines: [
          { speaker: 'ROOK', text: 'Every dollar they skimmed off my suppliers — pick it up, all of it. Do not leave a cent on that street.' },
        ],
      },
      {
        type: 'deliver', text: 'Bring the cash back to Rook on OCEAN AVE', x: 30, z: -190, radius: 6,
        lines: [
          { speaker: 'ROOK', text: 'Every dollar back. Kingfish just paid for his own lesson.' },
        ],
      },
    ],
  },
  {
    id: 'm8',
    chapter: 'CH.3 — HIGH WATER',
    name: 'WRENCH TIME',
    giver: 'Eddie',
    start: { x: 52, z: 147 },
    reward: 900,
    respect: 35,
    requires: ['m7'],
    intro: [
      { speaker: 'EDDIE', text: 'Kingfish torched my cousin\'s shop last night. Tonight we answer — with horsepower.' },
      { speaker: 'EDDIE', text: 'Take the Comet across BRIDGE RD, hold the marina while Silas loads the boat, then bring her home to PALM BLVD. Do not scratch her.' },
    ],
    outro: [
      { speaker: 'EDDIE', text: "She's in one piece. You're learning, kid. The bay is yours to take." },
      { speaker: 'SILAS', text: 'The Comet made it. The whole marina saw it, kid. The whole bay will hear it.' },
    ],
    stages: [
      {
        type: 'goto', text: "Meet Eddie at his garage on CORAL WAY", x: 52, z: 147, radius: 6,
        lines: [
          { speaker: 'EDDIE', text: "Kingfish wants my shop? Then we give him a car he won't forget. Take the Comet — she's fast and she's loud." },
        ],
      },
      {
        type: 'drive', text: 'Drive the getaway Comet across BRIDGE RD to the north island', x: 0, z: -90, radius: 8,
        lines: [
          { speaker: 'EDDIE', text: 'Bridge is the only way over. Do not stop for anyone — not even the law.' },
        ],
      },
      {
        type: 'combat', text: "Hold off Kingfish's crew on MARINA DR (0/3)", x: 60, z: 190, radius: 12, kills: 3,
        lines: [
          { speaker: 'SILAS', text: "They're coming in from the pier! Hold the line, kid — the boat's almost loaded!" },
        ],
      },
      {
        type: 'deliver', text: 'Deliver the Comet to the safehouse on PALM BLVD', x: -40, z: -140, radius: 6,
        lines: [
          { speaker: 'EDDIE', text: 'Bring her home to Palm Blvd in one piece — she is the fastest thing I ever built, and she is yours to keep safe.' },
        ],
      },
    ],
  },
  {
    id: 'm9',
    chapter: 'CH.3 — HIGH WATER',
    name: "THE DETECTIVE'S DEAL",
    giver: 'Calloway',
    start: { x: -48, z: 90 },
    reward: 1200,
    respect: 40,
    requires: ['m8'],
    intro: [
      { speaker: 'CALLOWAY', text: 'Off the record, kid. That ledger you gave Rook names me as the one cop Kingfish could NOT buy. So now he wants me gone too.' },
      { speaker: 'CALLOWAY', text: 'His payoff book is in the marina office — same pier where you grabbed the ledger. Bring it to me and I bury him with his own numbers.' },
    ],
    outro: [
      { speaker: 'CALLOWAY', text: "This book buries him. You did the bay a favour tonight — don't expect a medal, expect a target on your back." },
      { speaker: 'ROOK', text: 'A cop, kid? Careful. The bay remembers who it owes — and who it owns.' },
    ],
    stages: [
      {
        type: 'goto', text: 'Meet Detective Calloway on BAY ST', x: -48, z: 90, radius: 6,
        lines: [
          { speaker: 'CALLOWAY', text: "I want Kingfish's payoff book — and you're the only one who can get close to it." },
        ],
      },
      {
        type: 'collect', text: 'Steal the payoff book from the marina office on MARINA DR', x: 108, z: 150, radius: 6,
        lines: [
          { speaker: 'SILAS', text: "Book's in the office by the pier. In and out, quiet — Kingfish's boys are everywhere tonight." },
        ],
      },
      {
        type: 'combat', text: 'Survive the ambush on CORAL WAY (0/3)', x: 40, z: 140, radius: 12, kills: 3,
        lines: [
          { speaker: 'KINGFISH', text: 'You brought the LAW to my docks?! Nobody crosses Kingfish and walks away!' },
        ],
      },
      {
        type: 'deliver', text: 'Deliver the payoff book to Calloway on BAY ST', x: -48, z: 90, radius: 6,
        lines: [
          { speaker: 'CALLOWAY', text: "Bring the book to me on Bay St — and do not let Kingfish's boys see you carry it." },
        ],
      },
    ],
  },
  {
    id: 'm10',
    chapter: 'CH.4 — STORM SURGE',
    name: 'STORM SURGE',
    giver: 'Rook',
    start: { x: 30, z: -190 },
    reward: 2500,
    respect: 60,
    requires: ['m9'],
    intro: [
      { speaker: 'ROOK', text: 'Tonight it ends. Kingfish, his crew, all of it — at the marina. The payoff book gave Calloway the warrants; we give him the arrest.' },
      { speaker: 'ROOK', text: 'No running after this. Go finish it — then get across that bridge alive.' },
    ],
    outro: [
      { speaker: 'ROOK', text: 'CH.4 — STORM SURGE complete. Kingfish is finished, the ledger is ours, and the bay has a new name on it. Yours.' },
      { speaker: 'ROOK', text: 'Azure Bay is yours now, kid. CH.1 to CH.4 — the whole arc, done.' },
    ],
    stages: [
      {
        type: 'goto', text: 'Confront Kingfish at the marina on MARINA DR', x: 60, z: 190, radius: 8,
        lines: [
          { speaker: 'KINGFISH', text: 'The whole bay is mine, kid — the docks, the bridge, the streets. You should have stayed a runner.' },
        ],
      },
      {
        type: 'combat', text: "Take down Kingfish's crew on MARINA DR (0/4)", x: 60, z: 190, radius: 14, kills: 4,
        lines: [
          { speaker: 'KINGFISH', text: 'FINE. You want the bay? Come and TAKE it!' },
        ],
      },
      {
        type: 'drive', text: 'Escape across BRIDGE RD — lose the cops, lose the heli', x: 0, z: -140, radius: 8,
        lines: [
          { speaker: 'CALLOWAY', text: "Every unit in the bay is on you — five stars, air support. Get across that bridge and DON'T stop!" },
        ],
      },
      {
        type: 'goto', text: 'Reach the safehouse on OCEAN AVE', x: 30, z: -190, radius: 6,
        lines: [
          { speaker: 'ROOK', text: 'You did it, kid. Kingfish is finished — the bay is YOURS now.' },
        ],
      },
    ],
  },
];

// ---- registration -----------------------------------------------------------
// Idempotent: each mission id registers at most once per page load, even
// if registerAll() is called twice (import + 'missions-ready' event, or
// main.js calling it explicitly after importing missions.js). The engine
// itself also refuses duplicate ids, so a second call is harmless either
// way — this set just keeps window.Story.registered truthful.
const registeredIds = new Set();

// A def is only handed to the engine when it is shaped like a mission
// (string id, at least one stage, every stage with a known type and
// finite coordinates). A malformed def is skipped and reported instead
// of registering half-broken and failing mid-mission.
const KNOWN_STAGE_TYPES = new Set(['goto', 'drive', 'combat', 'collect', 'deliver']);

function isWellFormed(def) {
  if (!def || typeof def.id !== 'string' || !def.id) return false;
  if (!Array.isArray(def.stages) || def.stages.length === 0) return false;
  for (const stage of def.stages) {
    if (!stage || !KNOWN_STAGE_TYPES.has(stage.type)) return false;
    if (!Number.isFinite(stage.x) || !Number.isFinite(stage.z)) return false;
  }
  return true;
}

export function registerAll() {
  if (typeof window === 'undefined') return [];
  if (!window.Missions || typeof window.Missions.register !== 'function') return [];
  const done = [];
  for (const def of MISSIONS) {
    if (registeredIds.has(def.id)) continue;
    if (!isWellFormed(def)) continue;
    if (window.Missions.register(def)) {
      registeredIds.add(def.id);
      done.push(def.id);
    }
  }
  return done;
}

// Auto-register on load when the mission engine is already present;
// otherwise wait for main.js to announce itself. The listener is
// registered once.
if (typeof window !== 'undefined') {
  registerAll();
  if (!registeredIds.size && typeof window.addEventListener === 'function') {
    window.addEventListener(
      'missions-ready',
      () => registerAll(),
      { once: true },
    );
  }
}

// Public surface for main.js / the console.
if (typeof window !== 'undefined') {
  window.Story = {
    CHAPTERS,
    NPCS,
    MISSIONS,
    STREETS,
    MARINA_PIER,
    streetPoint,
    getNPC,
    say,
    registerAll,
    get registered() {
      return [...registeredIds];
    },
  };
}
