// hud-fase3.js — AZURE BAY Fase 3 HUD additions (Lane D, Fase 3).
// Mission tracker, respect, radio readout and the SAVED flash — the four
// readouts the Fase 3 lanes add on top of the Fase 1 HUD (hud.js).
//
// Contract (Lane E wires this into main.js):
//   window.HudFase3 = { missionTrackerText(), respectText(), savedFlash(), radioText() }
// Each function takes the value to show, writes it into its on-screen
// element and returns the exact string now displayed, so Lane E (and the
// screenshot staging) can assert on the return value without reading the DOM.
//
// The elements are created HERE, not in index.html, so this file is
// self-contained: mount once (automatic on first use) and the readouts exist
// for screenshots even before Lane E wires the per-frame update. Styling
// matches the Fase 1 HUD — dark pill backing, bold white text, hard shadow
// — so the new chips read over the bright golden-hour sky. All elements
// are pointer-events:none and never intercept clicks.
//
// Layout (screen corners, clear of the Fase 1 chips):
//   top-right, under the clock:  radio station
//   top-left, under cash:       respect
//   left, above the objective:  mission tracker
//   screen centre:              SAVED flash (2 s, then hides)

const RESPECT_RANKS = [
  { min: 500, label: 'BAY KING' },
  { min: 250, label: 'RESPECTED' },
  { min: 100, label: 'HUSTLER' },
  { min: 0, label: 'ROOKIE' },
];

function respectRank(value) {
  for (const rank of RESPECT_RANKS) {
    if (value >= rank.min) return rank.label;
  }
  return 'ROOKIE';
}

// Shared chip styling: same dark pill + shadow language as hud.js.
function styleChip(node, fontSize) {
  node.style.position = 'absolute';
  node.style.background = 'rgba(0, 0, 0, 0.55)';
  node.style.border = '1px solid rgba(255, 255, 255, 0.25)';
  node.style.borderRadius = '8px';
  node.style.padding = '3px 10px';
  node.style.color = '#ffffff';
  node.style.fontFamily = 'system-ui, sans-serif';
  node.style.fontSize = fontSize;
  node.style.fontWeight = '700';
  node.style.whiteSpace = 'nowrap';
  node.style.textShadow = '0 1px 3px rgba(0, 0, 0, 0.9)';
  node.style.pointerEvents = 'none';
  node.style.zIndex = '20';
}

export function createHudFase3() {
  let mounted = false;
  let radioEl = null;
  let respectEl = null;
  let missionEl = null;
  let savedEl = null;
  let savedTimer = null;

  function mount() {
    if (mounted) return true;
    if (typeof document === 'undefined') return false;
    const root = document.body || document.documentElement;
    if (!root) return false;

    radioEl = document.createElement('div');
    radioEl.id = 'hud-fase3-radio';
    styleChip(radioEl, '18px');
    radioEl.style.top = '56px';
    radioEl.style.right = '16px';
    radioEl.textContent = '♪ RADIO NARANJA 99.1 FM';
    root.appendChild(radioEl);

    respectEl = document.createElement('div');
    respectEl.id = 'hud-fase3-respect';
    styleChip(respectEl, '18px');
    respectEl.style.top = '132px';
    respectEl.style.left = '16px';
    respectEl.textContent = 'RESPECT 0 · ROOKIE';
    root.appendChild(respectEl);

    missionEl = document.createElement('div');
    missionEl.id = 'hud-fase3-mission';
    styleChip(missionEl, '18px');
    missionEl.style.top = 'auto';
    missionEl.style.bottom = '56px';
    missionEl.style.left = '50%';
    missionEl.style.transform = 'translateX(-50%)';
    missionEl.textContent = 'No active mission';
    root.appendChild(missionEl);

    savedEl = document.createElement('div');
    savedEl.id = 'hud-fase3-saved';
    styleChip(savedEl, '28px');
    savedEl.style.top = '38%';
    savedEl.style.left = '50%';
    savedEl.style.transform = 'translate(-50%, -50%)';
    savedEl.style.color = '#4ade80';
    savedEl.style.display = 'none';
    savedEl.textContent = '✓ SAVED';
    root.appendChild(savedEl);

    // Lane C (fase4, nit a): while a dialog is open, dialog.js puts the
    // `azure-dialog-open` class + `--azure-dialog-clear` (dialog top
    // edge + gap) on <body>. Lift the mission tracker above the dialog
    // box — and above the objective pill, which hud.js lifts to the
    // clear line itself — so the "M1 — HOOK AND CHAIN — 1/3" pill and
    // the dialog both read at once. !important is required: the pill's
    // bottom is set inline in mount() above.
    if (!document.getElementById('azure-hudf3-dialog-shift')) {
      const style = document.createElement('style');
      style.id = 'azure-hudf3-dialog-shift';
      style.textContent = 'body.azure-dialog-open #hud-fase3-mission { bottom: calc(var(--azure-dialog-clear, 200px) + 48px) !important; }';
      document.head.appendChild(style);
    }

    mounted = true;
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
    if (missionEl) missionEl.textContent = text;
    return text;
  }

  // Respect readout with a rank label so the number means something at a
  // glance: 0 ROOKIE, 100 HUSTLER, 250 RESPECTED, 500 BAY KING.
  function respectText(value) {
    mount();
    const amount = Math.max(0, Math.round(Number(value) || 0));
    const text = 'RESPECT ' + amount + ' · ' + respectRank(amount);
    if (respectEl) respectEl.textContent = text;
    return text;
  }

  // Centre-screen SAVED flash, visible for 2 s. Calling it again while it
  // is showing restarts the timer instead of stacking flashes.
  function savedFlash() {
    mount();
    if (!savedEl) return false;
    savedEl.style.display = '';
    if (savedTimer !== null) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      savedEl.style.display = 'none';
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
      text = radioEl ? radioEl.textContent : '';
    } else if (typeof station === 'string') {
      text = station;
    } else {
      text = '♪ ' + (station.name || 'RADIO') + ' ' + (station.freq || '');
      text = text.trim();
    }
    if (radioEl) radioEl.textContent = text;
    return text;
  }

  // Convenience for Lane E: refresh all four readouts from one state
  // snapshot { mission, respect, radio }. The SAVED flash is NOT part of
  // update() — it only fires on an actual save (see below).
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

  return { missionTrackerText, respectText, savedFlash, radioText, update, mount };
}

export const HudFase3 = createHudFase3();
if (typeof window !== 'undefined') window.HudFase3 = HudFase3;
