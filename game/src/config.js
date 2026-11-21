// AZURE BAY — one place for every tunable number in the world.
// Palette, golden-hour light, islands, roads, buildings, dressing and
// spawn points all live here, so re-tuning the city never means digging
// through the geometry or gameplay code that consumes these values.
//
// GOLDEN HOUR: the entire look is built around a low sun in the west —
// warm orange key light, long shadows, a golden haze band on the
// horizon. The lighting numbers at the bottom are the only place the
// sun, fog and sky values exist; engine.js just reads them.

export const CONFIG = {
  // ---- colours -------------------------------------------------------------
  palette: {
    sky: '#f2a45e',        // backdrop colour behind the sky dome + fog family
    skyDome: '#f7b267',    // horizon band of the sky gradient
    skyTop: '#33507e',     // zenith: deep blue even at golden hour
    skyBelow: '#c97e4a',   // haze under the horizon line, above the water
    sunDisc: '#fff3c4',    // the sun disc itself, a near-white hot core
    fog: '#e9a869',        // warm distance haze with a golden tint
    sun: '#ff9e45',        // directional sun light, warm orange-gold
    skyLight: '#ffc98f',   // hemisphere bounce from the sky, warm
    groundLight: '#8a6242',// hemisphere bounce from the ground, warm earth
    fillLight: '#8fa3cc',  // cool fill from the east, lifts shadow sides
    water: '#2a6f9e',      // deeper teal-blue so the gold glint reads on it
    waterGlint: '#ffb85e', // sun glint colour on the water surface
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

  // ---- golden-hour light ---------------------------------------------------
  // The sun sits low in the west-northwest, about 15 degrees up, so a
  // 40 m tower throws roughly a 150 m shadow across the city. The vector
  // below is shared by the directional light AND the sky shader's sun
  // disc, so the disc in the sky sits exactly where the light comes from.
  lighting: {
    sunPosition: [-560, 165, -240],
    sunIntensity: 3.0,
    hemiIntensity: 0.55,
    fillIntensity: 0.35,   // cool bounce from the east, casts no shadows
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
    // The sun glint used to blow a third of the city frame out to
    // white-gold, so the knobs were turned down: waveStrength 0.5 -> 0.3
    // (less normal perturbation, a smaller glint patch), glintPower
    // 220 -> 320 (a tighter lobe, a smaller patch), glintStrength
    // 0.45 -> 0.22 (dimmer). The water material's own roughness was
    // raised in city.js (0.25 -> 0.45) so the broad GGX sun sheen under
    // the glint dims from a blown-out blob to a soft sheen as well. The
    // glint itself stays — the water still has to sparkle.
    water: { waveStrength: 0.3, glintPower: 320, glintStrength: 0.22 },
  },

  // ---- vertical datum ------------------------------------------------------
  // The top of the island grass, the bridge deck and the road surface
  // all sit at this height.
  groundY: 1.5,
  waterY: 0,
  waterSize: 900,

  // ---- islands -------------------------------------------------------------
  // Ellipses: ((x - cx) / rx) ^ 2 + ((z - cz) / rz) ^ 2 <= 1 counts as land.
  islands: [
    { name: 'north', cx: 0, cz: -140, rx: 110, rz: 80 }, // ~220 x 160 m
    { name: 'south', cx: 0, cz: 140, rx: 100, rz: 75 },  // ~200 x 150 m
  ],

  // ---- bridge --------------------------------------------------------------
  // The deck runs along x = 0 from the north island's south shore to the
  // south island's north shore. Deck top == groundY, so cars and feet
  // roll straight on without a step.
  bridge: { x: 0, z1: -60, z2: 65, width: 14, railHeight: 1.1 },

  // ---- roads ---------------------------------------------------------------
  // Axis-aligned segments {x1, z1, x2, z2}: a ring road plus two cross
  // streets per island, plus the bridge road. Ring corners sit inside
  // the island ellipses.
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
    // Warm coastal walls; roofs read darker by contrast.
    colors: ['#f5efe0', '#e8d5a3', '#d97b4f', '#f2b8a0', '#a8c8d8', '#f0d060', '#e89a9a'],
    roofColors: ['#8a5a3a', '#5a5a5a', '#7a4a3a'],
    // How far (m) a plot centre must stay from any road centreline and
    // from the spawn points.
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
  // The player starts on foot beside the north island's south ring road.
  spawn: { x: 30, z: -100 },
  // Three parked cars, each sitting on a road.
  carSpawns: [
    { x: -60, z: -140 },
    { x: 0, z: -190 },
    { x: 50, z: 190 },
  ],

  // Fixed layout seed, so every load builds the same city.
  seed: 1337,
};
