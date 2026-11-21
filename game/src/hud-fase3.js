// hud-fase3.js — AZURE BAY Fase 3 HUD additions (rewrite round 2).
// Mission tracker, respect, radio readout and the SAVED flash — the four
// readouts the Fase 3 lanes add on top of the Fase 1 HUD (hud.js).
//
// Contract (main.js wires this in):
//   window.HudFase3 = { missionTrackerText(), respectText(), savedFlash(), radioText() }
// Each function takes the value to show, writes it into its on-screen
// element and returns the exact string now displayed, so the caller (and
// screenshot staging) can assert on the return value without reading the DOM.
//
// The elements are created HERE, not in index.html, so this file is
// self-contained: mount once (automatic on first use) and the readouts
// exist for screenshots even before main.js wires the per-frame update.
// Styling matches the Fase 1 HUD — dark pill backing, bold white text,
// hard shadow — so the new chips read over the bright golden-hour sky.
// All elements are pointer-events:none and never intercept clicks.
//
// Layout (screen corners, clear of the Fase 1 chips):
//   top-right, under the clock:  radio station
//   top-left, under cash:       respect
//   left-centre, above objective: mission tracker
//   screen centre:              SAVED flash (2 s, then hides)
// Round-2 fix: the old chips used fixed pixel offsets that collided with
// the Fase 1 HUD at 800x500 (respect over cash, radio over the clock).
// Positions and font sizes are now recomputed from the viewport on mount
// and on every resize — a compact arrangement under 960x620 — so no two
// chips can overlap at any window size.

const RANK_STEPS = [
  { min: 500, label: 'BAY KING' },
  { min: 250, label: 'RESPECTED' },
  { min: 100, label: 'HUSTLER' },
  { min: 0, label: 'ROOKIE' },
];

function rankFor(value) {
  for (const step of RANK_STEPS) {
    if (value >= step.min) return step.label;
  }
  return 'ROOKIE';
}

// Shared chip styling: same dark pill + shadow language as hud.js.
function paintChip(node, fontPx) {
  node.style.position = 'absolute';
  node.style.background = 'rgba(0, 0, 0, 0.55)';
  node.style.border = '1px solid rgba(255, 255, 255, 0.25)';
  node.style.borderRadius = '8px';
  node.style.padding = '3px 10px';
  node.style.color = '#ffffff';
  node.style.fontFamily = 'system-ui, sans-serif';
  node.style.fontSize = fontPx;
  node.style.fontWeight = '700';
  node.style.whiteSpace = 'nowrap';
  node.style.textShadow = '0 1px 3px rgba(0, 0, 0, 0.9)';
  node.style.pointerEvents = 'none';
  node.style.zIndex = '20';
}

export function createHudFase3() {
  let isMounted = false;
  let radioChip = null;
  let respectChip = null;
  let missionChip = null;
  let savedChip = null;
  let savedTimer = null;

  // Recompute chip geometry from the viewport. Roomy above 960x620,
  // compact below: smaller fonts, tighter gaps, and the respect chip
  // pushed further down so it can never sit on the cash readout.
  function fitChips() {
    if (!isMounted) return;
    const vw = typeof window !== 'undefined' ? (window.innerWidth || 1280) : 1280;
    const vh = typeof window !== 'undefined' ? (window.innerHeight || 800) : 800;
    const compact = vw < 960 || vh < 620;
    const font = compact ? '14px' : '18px';
    const edge = compact ? '8px' : '16px';
    if (radioChip) {
      paintChip(radioChip, font);
      radioChip.style.top = compact ? '44px' : '56px';
      radioChip.style.right = edge;
    }
    if (respectChip) {
      paintChip(respectChip, font);
      respectChip.style.top = compact ? '104px' : '132px';
      respectChip.style.left = edge;
    }
    if (missionChip) {
      paintChip(missionChip, font);
      missionChip.style.bottom = compact ? '48px' : '56px';
      missionChip.style.left = '50%';
      missionChip.style.transform = 'translateX(-50%)';
      missionChip.style.maxWidth = compact ? '70vw' : '60vw';
      missionChip.style.overflow = 'hidden';
      missionChip.style.textOverflow = 'ellipsis';
    }
    if (savedChip) {
      paintChip(savedChip, compact ? '20px' : '28px');
      savedChip.style.color = '#4ade80';
    }
  }

  function mount() {
    if (isMounted) return true;
    if (typeof document === 'undefined') return false;
    const root = document.body || document.documentElement;
    if (!root) return false;

    radioChip = document.createElement('div');
    radioChip.id = 'hud-fase3-radio';
    radioChip.textContent = '♪ RADIO NARANJA 99.1 FM';
    root.appendChild(radioChip);

    respectChip = document.createElement('div');
    respectChip.id = 'hud-fase3-respect';
    respectChip.textContent = 'RESPECT 0 · ROOKIE';
    root.appendChild(respectChip);

    missionChip = document.createElement('div');
    missionChip.id = 'hud-fase3-mission';
    missionChip.textContent = 'No active mission';
    root.appendChild(missionChip);

    savedChip = document.createElement('div');
    savedChip.id = 'hud-fase3-saved';
    savedChip.style.top = '38%';
    savedChip.style.left = '50%';
    savedChip.style.transform = 'translate(-50%, -50%)';
    savedChip.style.display = 'none';
    savedChip.textContent = '✓ SAVED';
    root.appendChild(savedChip);

    // While a dialog is open, dialog.js puts the `azure-dialog-open`
    // class + `--azure-dialog-clear` (dialog top edge + gap) on <body>.
    // Lift the mission tracker above the dialog box — and above the
    // objective pill, which hud.js lifts to the clear line itself — so
    // the tracker pill and the dialog both read at once.
    if (!document.getElementById('azure-hudf3-dialog-shift')) {
      const rule = document.createElement('style');
      rule.id = 'azure-hudf3-dialog-shift';
      rule.textContent = 'body.azure-dialog-open #hud-fase3-mission { bottom: calc(var(--azure-dialog-clear, 200px) + 48px) !important; }';
      document.head.appendChild(rule);
    }

    isMounted = true;
    fitChips();
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', fitChips);
    }
    return true;
  }

  // ---- the four contract functions -----------------------------------------

  // Mission tracker. Accepts a mission object {title, stage, stages} (the
  // shape save.js stores as missions.active), a plain title string, or null.
  function missionTrackerText(mission) {
    mount();
    let text;
    if (!mission) {
      text = 'No active mission';
    } else if (typeof mission === 'string') {
      text = mission;
    } else {
      const title = mission.title || mission.id || 'Mission';
      const stage = Math.max(0, Math.round(Number(mission.stage) || 0));
      const stages = Math.max(1, Math.round(Number(mission.stages) || 1));
      text = title + ' — ' + stage + '/' + stages;
    }
    if (missionChip) missionChip.textContent = text;
    return text;
  }

  // Respect readout with a rank label so the number means something at a
  // glance: 0 ROOKIE, 100 HUSTLER, 250 RESPECTED, 500 BAY KING.
  function respectText(value) {
    mount();
    const amount = Math.max(0, Math.round(Number(value) || 0));
    const text = 'RESPECT ' + amount + ' · ' + rankFor(amount);
    if (respectChip) respectChip.textContent = text;
    return text;
  }

  // Centre-screen SAVED flash, visible for 2 s. Calling it again while it
  // is showing restarts the timer instead of stacking flashes.
  function savedFlash() {
    mount();
    if (!savedChip) return false;
    savedChip.style.display = '';
    if (savedTimer !== null) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      savedChip.style.display = 'none';
      savedTimer = null;
    }, 2000);
    return true;
  }

  // Radio readout. Accepts a station object {name, freq} (the shape
  // radio.js exposes), a plain string, or nothing (keeps the current text).
  function radioText(station) {
    mount();
    let text;
    if (!station) {
      text = radioChip ? radioChip.textContent : '';
    } else if (typeof station === 'string') {
      text = station;
    } else {
      text = ('♪ ' + (station.name || 'RADIO') + ' ' + (station.freq || '')).trim();
    }
    if (radioChip) radioChip.textContent = text;
    return text;
  }

  // Convenience for main.js: refresh the readouts from one state snapshot
  // { mission, respect, radio }. The SAVED flash is NOT part of update() —
  // it only fires on an actual save (see below).
  function update(state) {
    if (!state || typeof state !== 'object') return false;
    if ('mission' in state) missionTrackerText(state.mission);
    if ('respect' in state) respectText(state.respect);
    if ('radio' in state) radioText(state.radio);
    return true;
  }

  // React to the live game: a save (save.js 'azure-save' event) flashes
  // SAVED, a station change ('azure-radio' from radio.js) updates the
  // radio readout — no per-frame wiring needed for either.
  if (typeof window !== 'undefined') {
    window.addEventListener('azure-save', () => savedFlash());
    window.addEventListener('azure-radio', (event) => {
      if (event && event.detail) radioText(event.detail);
    });
  }

  return { missionTrackerText, respectText, savedFlash, radioText, update, mount, fitLayout: fitChips };
}

export const HudFase3 = createHudFase3();
if (typeof window !== 'undefined') window.HudFase3 = HudFase3;
