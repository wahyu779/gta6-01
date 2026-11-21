// AZURE BAY — single source of truth for palette, city layout and tuning.
// Every number city.js, engine.js and (later) the gameplay lanes use lives here,
// so the world can be re-tuned without touching geometry code.
//
// GOLDEN HOUR (Lane A revisi): the whole palette is tuned for a low western
// sun — warm orange light, long shadows, golden haze on the horizon. The
// lighting block at the bottom is the single place the sun / fog / sky
// numbers live; engine.js only reads them.

export const CONFIG = {
  // ---- palette ------------------------------------------------------------
  palette: {
    sky: '#f2a45e',        // scene background (behind the sky dome) + fog family
    skyDome: '#f7b267',    // horizon band of the sky gradient
    skyTop: '#33507e',     // zenith: deep blue, still blue at golden hour
    skyBelow: '#c97e4a',   // haze below the horizon line, over the water
    sunDisc: '#fff3c4',    // the sun disc itself, near-white hot core
    fog: '#e9a869',        // warm distance haze, golden tint
    sun: '#ff9e45',        // directional sun light, warm orange-gold
    skyLight: '#ffc98f',   // hemisphere sky bounce, warm
    groundLight: '#8a6242',// hemisphere ground bounce, warm earth
    fillLight: '#8fa3cc',  // cool sky fill from the east, lifts shadow sides
    water: '#2a6f9e',      // deeper teal-blue so the gold glint reads on it
    waterGlint: '#ffb85e', // sun glint colour on the water
    sand: '#e8d5a3',
    grass: '#7cab54',      // sun-warmed green, a touch golden
    road: '#3a3f46',
    roadLine: '#f2d06b',
    bridgeDeck: '#4a4f57',
    bridgeRail: '#c8ccd2',
    pier: '#8a6a4a',
    palmTrunk: '#8a6a4a',
    palmCanopy: '#3f8f3f',
    lampGlow: '#ffd98a',
    boatHull: '#f5f2ea',
    boatCabin: '#d97b4f',
    cloud: '#ffe9c9',      // warm-lit cloud puffs
  },

  // ---- golden-hour lighting ----------------------------------------------
  // Sun sits low in the west-northwest: elevation ~15 deg, so a 40 m
  // tower throws a ~150 m shadow across the city. The vector below is
  // shared by the directional light AND the sky shader's sun disc, so
  // the disc in the sky is exactly where the light comes from.
  lighting: {
    sunPosition: [-560, 165, -240],
    sunIntensity: 3.0,
    hemiIntensity: 0.55,
    fillIntensity: 0.35,   // cool bounce from the east, no shadows
    exposure: 1.15,        // ACES exposure, a touch hot for the glow
    fogNear: 280,
    fogFar: 1000,
    shadowSize: 2048,
    shadowBounds: 280,     // shadow frustum half-size, covers both islands
    shadowNear: 10,
    shadowFar: 1400,
    shadowBias: -0.0004,
    shadowNormalBias: 0.8,
    clouds: { count: 9, minY: 190, maxY: 330, minScale: 120, maxScale: 260, drift: 1.6 },
    // Lane C (fase4, nit d): the sun glint blew a third of the city
    // frame out to white-gold. The glint itself stays — the water must
    // still sparkle — but the knobs are turned down: waveStrength
    // 0.5 -> 0.3 (less normal perturbation, smaller glint patch),
    // glintPower 220 -> 320 (tighter lobe, smaller patch),
    // glintStrength 0.45 -> 0.22 (dimmer). The water material's own
    // roughness is raised in city.js (0.25 -> 0.45) so the broad GGX
    // sun sheen under the glint dims from a blown-out blob to a soft
    // sheen as well.
    water: { waveStrength: 0.3, glintPower: 320, glintStrength: 0.22 },
  },

  // ---- vertical datum ------------------------------------------------------
  // Top of the island grass, the bridge deck and the road surface all sit here.
  groundY: 1.5,
  waterY: 0,
  waterSize: 900,

  // ---- islands -------------------------------------------------------------
  // Ellipses: ((x - cx) / rx) ^ 2 + ((z - cz) / rz) ^ 2 <= 1 is land.
  islands: [
    { name: 'north', cx: 0, cz: -140, rx: 110, rz: 80 }, // ~220 x 160 m
    { name: 'south', cx: 0, cz: 140, rx: 100, rz: 75 },  // ~200 x 150 m
  ],

  // ---- bridge --------------------------------------------------------------
  // Deck runs along x = 0 from the north island's south shore to the south
  // island's north shore. Deck top == groundY so cars walk/drive straight on.
  bridge: { x: 0, z1: -60, z2: 65, width: 14, railHeight: 1.1 },

  // ---- roads ---------------------------------------------------------------
  // Axis-aligned segments {x1, z1, x2, z2}. Ring road + two cross streets per
  // island, plus the bridge road. Ring corners sit inside the island ellipses.
  roadWidth: 8,
  roadLineOffset: 3.6,
  roads: [
    // north island ring
    { x1: -78, z1: -190, x2: 78, z2: -190 },
    { x1: 78, z1: -190, x2: 78, z2: -90 },
    { x1: 78, z1: -90, x2: -78, z2: -90 },
    { x1: -78, z1: -90, x2: -78, z2: -190 },
    // north island cross streets
    { x1: -78, z1: -140, x2: 78, z2: -140 },
    { x1: 0, z1: -190, x2: 0, z2: -90 },
    // south island ring
    { x1: -70, z1: 90, x2: 70, z2: 90 },
    { x1: 70, z1: 90, x2: 70, z2: 190 },
    { x1: 70, z1: 190, x2: -70, z2: 190 },
    { x1: -70, z1: 190, x2: -70, z2: 90 },
    // south island cross streets
    { x1: -70, z1: 140, x2: 70, z2: 140 },
    { x1: 0, z1: 90, x2: 0, z2: 190 },
    // bridge road
    { x1: 0, z1: -60, x2: 0, z2: 65 },
  ],

  // ---- buildings -----------------------------------------------------------
  buildings: {
    targetNorth: 18,
    targetSouth: 16,
    minHeight: 6,
    maxHeight: 40,
    minFoot: 10,
    maxFoot: 16,
    // Warm coastal walls; roofs are darker by contrast.
    colors: ['#f5efe0', '#e8d5a3', '#d97b4f', '#f2b8a0', '#a8c8d8', '#f0d060', '#e89a9a'],
    roofColors: ['#8a5a3a', '#5a5a5a', '#7a4a3a'],
    // Plots must stay this far (m) from any road centreline and from spawns.
    roadClearance: 11,
    spawnClearance: 13,
    // Normalised ellipse radius a plot centre must stay inside.
    ellipseMargin: 0.85,
  },

  // ---- dressing ------------------------------------------------------------
  palms: { count: 36, trunkHeight: 5, canopyRadius: 1.7 },
  streetlights: { spacing: 30, poleHeight: 5.5, sideOffset: 5 },
  marina: { pierX: 108, pierZ: 150, pierLength: 20, boats: 4 },

  // ---- spawns --------------------------------------------------------------
  // Player spawns on foot beside the north island's south ring road.
  spawn: { x: 30, z: -100 },
  // Three parked cars, each on a road.
  carSpawns: [
    { x: -60, z: -140 },
    { x: 0, z: -190 },
    { x: 50, z: 190 },
  ],

  // Deterministic layout seed so every load builds the same city.
  seed: 1337,
};
