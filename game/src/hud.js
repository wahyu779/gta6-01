// hud.js — AZURE BAY HUD (Lane C, Fase 1)
// Drives the on-screen HUD elements defined by the shared contract:
//   #hud-health > #hud-health-bar > #hud-health-fill
//   #hud-wanted (5 star spans), #hud-cash, #hud-time,
//   #hud-speed, #hud-objective
// Every lookup is guarded: a missing element is skipped silently, never throws.

export function createHUD() {
  const el = (id) => document.getElementById(id);

  const healthFill = el('hud-health-fill');
  const wantedEl = el('hud-wanted');
  const cashEl = el('hud-cash');
  const timeEl = el('hud-time');
  const speedEl = el('hud-speed');
  const objectiveEl = el('hud-objective');
  const ammoEl = el('hud-ammo');

  const stars = wantedEl ? Array.from(wantedEl.querySelectorAll('span')) : [];

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Legibility polish (visual only, no new elements): a thin dark backing
  // behind each text readout so it stays readable over the bright
  // golden-hour sky and sand, plus a stronger drop shadow. The health bar
  // and the objective already have their own backing in the page CSS.
  function addBacking(node, padding) {
    if (!node) return;
    node.style.background = 'rgba(0, 0, 0, 0.45)';
    node.style.padding = padding;
    node.style.borderRadius = '8px';
    node.style.textShadow = '0 1px 3px rgba(0, 0, 0, 0.85)';
    node.style.whiteSpace = 'nowrap';
  }
  addBacking(wantedEl, '2px 8px');
  addBacking(cashEl, '2px 10px');
  addBacking(timeEl, '2px 10px');
  addBacking(speedEl, '2px 10px');
  addBacking(ammoEl, '2px 10px');
  // Lane H: the star row sits over the brightest part of the sky, and
  // the 0.45 backing above was not enough — the unlit stars vanished.
  // Darker pill + a light hairline edge so the row reads as a chip
  // against any sky, bright or dark.
  if (wantedEl) {
    wantedEl.style.background = 'rgba(0, 0, 0, 0.68)';
    wantedEl.style.border = '1px solid rgba(255, 255, 255, 0.35)';
    wantedEl.style.padding = '3px 10px';
  }
  if (objectiveEl) {
    objectiveEl.style.textShadow = '0 1px 3px rgba(0, 0, 0, 0.85)';
  }
  // Lane C (fase4, nit a): while a dialog is open, dialog.js puts the
  // `azure-dialog-open` class + `--azure-dialog-clear` (dialog top edge
  // + gap) on <body>. Lift the objective pill above the dialog box so
  // both read at once — the combat shot had the objective line hidden
  // behind the box. !important beats nothing here (the pill's bottom
  // comes from the page stylesheet) but keeps the rule robust if an
  // inline bottom is ever set.
  if (typeof document !== 'undefined' && !document.getElementById('azure-hud-dialog-shift')) {
    const style = document.createElement('style');
    style.id = 'azure-hud-dialog-shift';
    style.textContent = 'body.azure-dialog-open #hud-objective { bottom: var(--azure-dialog-clear, 200px) !important; }';
    document.head.appendChild(style);
  }

  function setHealth(v) {
    if (!healthFill) return;
    const value = clamp(Number(v) || 0, 0, 100);
    healthFill.style.width = value + '%';
    // Green while healthy, amber when hurt, red when critical — with a
    // glow on critical so a low-health state is unmissable.
    if (value >= 50) {
      healthFill.style.backgroundColor = '#22c55e';
      healthFill.style.boxShadow = 'none';
    } else if (value >= 25) {
      healthFill.style.backgroundColor = '#f59e0b';
      healthFill.style.boxShadow = 'none';
    } else {
      healthFill.style.backgroundColor = '#ef4444';
      healthFill.style.boxShadow = '0 0 10px rgba(239, 68, 68, 0.9)';
    }
  }

  function setCash(v) {
    if (!cashEl) return;
    const amount = Math.round(Number(v) || 0);
    cashEl.textContent = '$' + amount.toLocaleString('en-US');
  }

  function setSpeed(kmh) {
    if (!speedEl) return;
    const speed = Math.max(0, Math.round(Number(kmh) || 0));
    speedEl.textContent = speed + ' km/h';
  }

  function setWanted(n) {
    if (!wantedEl) return;
    const level = clamp(Math.round(Number(n) || 0), 0, 5);
    stars.forEach((star, i) => {
      const filled = i < level;
      star.textContent = filled ? '★' : '☆';
      // Lane H: the old unlit style — rgba(255,255,255,0.25) colour on
      // top of the page CSS `opacity: .35` — multiplied out to ~9%
      // effective alpha, so empty stars were invisible against the
      // bright sky. Unlit stars are now solid pale grey at near-full
      // opacity with a hard dark outline shadow, so all five stars
      // read at a glance; lit stars keep the gold + glow, plus the
      // same dark outline so they hold up over white cloud / sun glare.
      star.style.color = filled ? '#fbbf24' : '#dbe4ee';
      star.style.opacity = filled ? '1' : '0.9';
      // Lit stars glow; unlit ones stay faint. Toggle the page-CSS class
      // too so the stylesheet and the inline style agree.
      star.classList.toggle('lit', filled);
      star.style.textShadow = filled
        ? '0 0 8px rgba(251, 191, 36, 0.9), 0 1px 3px rgba(0, 0, 0, 0.9), 0 0 2px rgba(0, 0, 0, 0.9)'
        : '0 1px 3px rgba(0, 0, 0, 0.9), 0 0 2px rgba(0, 0, 0, 0.9)';
    });
  }

  function setObjective(t) {
    if (!objectiveEl) return;
    objectiveEl.textContent = String(t ?? '');
  }

  function setTime(t) {
    if (!timeEl) return;
    timeEl.textContent = String(t ?? '');
  }

  function setAmmo(weaponName, mag, reserve) {
    if (!ammoEl) return;
    // Lane B2 (polish): a weapon with infinite ammo has no magazine to
    // show — "FISTS —/—" reads as a broken readout while driving (and
    // in the city overview, where the player is unarmed). Hide the
    // whole slot while an infinite-ammo weapon is active, and show it
    // again the moment a firearm is equipped so its magazine reads.
    const magFinite = Number.isFinite(Number(mag));
    const reserveFinite = Number.isFinite(Number(reserve));
    ammoEl.style.display = (!magFinite && !reserveFinite) ? 'none' : '';
    // Fists carry Infinity ammo: show a dash instead of a number.
    const magText = magFinite ? String(mag) : '—';
    const reserveText = reserveFinite ? String(reserve) : '—';
    ammoEl.textContent = String(weaponName ?? '') + ' ' + magText + '/' + reserveText;
    // Empty magazine reads red at a glance; anything else stays white.
    ammoEl.style.color = (magFinite && Number(mag) === 0)
      ? '#ef4444'
      : '';
  }

  return { setHealth, setCash, setSpeed, setWanted, setObjective, setTime, setAmmo };
}
