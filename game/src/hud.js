// hud.js — AZURE BAY HUD (rewrite round 2).
// Drives the on-screen readouts defined by the shared contract:
//   #hud-health > #hud-health-bar > #hud-health-fill
//   #hud-wanted (5 star spans), #hud-cash, #hud-time,
//   #hud-speed, #hud-objective, #hud-ammo
// Every lookup is guarded: a missing element is skipped silently, never
// throws. All setters are safe to call before the DOM is ready — they
// simply do nothing until their element exists.
//
// Responsive layout (round-2 fix): the old HUD used fixed pixel sizes
// and fixed corners, so at 800x500 the clock, cash, wanted stars and the
// objective pill collided. This module now measures the viewport and
// picks a compact or roomy arrangement on load and on every resize:
// a --hud-scale factor shrinks fonts / the health bar / paddings, the
// clock drops to a smaller size, and the objective pill narrows so it
// can never run into the speed readout or the minimap. The CSS in
// index.html carries the same breakpoints; the two agree on the numbers.

export function createHUD() {
  const byId = (id) => document.getElementById(id);

  const fillNode = byId('hud-health-fill');
  const barNode = byId('hud-health-bar');
  const wantedNode = byId('hud-wanted');
  const cashNode = byId('hud-cash');
  const clockNode = byId('hud-time');
  const speedNode = byId('hud-speed');
  const goalNode = byId('hud-objective');
  const ammoNode = byId('hud-ammo');
  const hudRoot = byId('hud');

  const starNodes = wantedNode ? Array.from(wantedNode.querySelectorAll('span')) : [];

  const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // --- responsive layout ---------------------------------------------------
  // Compact when the window is small in either dimension (800x500 is the
  // case that used to overlap). Scale is continuous, so a 1024x600 window
  // gets a gentle shrink rather than a jump. The factor is written to a
  // CSS variable the page stylesheet also reads, so JS-set inline styles
  // and the stylesheet never fight over the same property.
  function fitLayout() {
    if (typeof window === 'undefined' || !hudRoot) return;
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const compact = vw < 960 || vh < 620;
    const scale = Math.min(1, vw / 1150, vh / 720);
    hudRoot.style.setProperty('--hud-scale', String(Math.max(0.72, scale)));
    hudRoot.classList.toggle('hud-compact', compact);
    // In compact mode the ammo readout sits higher so it clears the
    // minimap, which also shrinks via the page stylesheet.
    if (ammoNode) ammoNode.style.bottom = compact ? '196px' : '';
    if (barNode) barNode.style.width = compact ? '150px' : '';
  }

  // Legibility polish (visual only, no new elements): a thin dark pill
  // behind each text readout so it stays readable over the bright
  // golden-hour sky and sand, plus a hard drop shadow. The health bar
  // and the objective already carry their own backing in the page CSS.
  function backChip(node, pad) {
    if (!node) return;
    node.style.background = 'rgba(0, 0, 0, 0.45)';
    node.style.padding = pad;
    node.style.borderRadius = '8px';
    node.style.textShadow = '0 1px 3px rgba(0, 0, 0, 0.85)';
    node.style.whiteSpace = 'nowrap';
  }
  backChip(wantedNode, '2px 8px');
  backChip(cashNode, '2px 10px');
  backChip(clockNode, '2px 10px');
  backChip(speedNode, '2px 10px');
  backChip(ammoNode, '2px 10px');
  // The star row sits over the brightest part of the sky, so it gets a
  // darker pill + a light hairline edge and reads as a chip on any sky.
  if (wantedNode) {
    wantedNode.style.background = 'rgba(0, 0, 0, 0.68)';
    wantedNode.style.border = '1px solid rgba(255, 255, 255, 0.35)';
    wantedNode.style.padding = '3px 10px';
  }
  if (goalNode) {
    goalNode.style.textShadow = '0 1px 3px rgba(0, 0, 0, 0.85)';
  }
  // While a dialog is open, dialog.js puts the `azure-dialog-open`
  // class + `--azure-dialog-clear` (dialog top edge + gap) on <body>.
  // Lift the objective pill above the dialog box so both read at once —
  // the combat shot used to hide the objective line behind the box.
  if (typeof document !== 'undefined' && !document.getElementById('azure-hud-dialog-shift')) {
    const rule = document.createElement('style');
    rule.id = 'azure-hud-dialog-shift';
    rule.textContent = 'body.azure-dialog-open #hud-objective { bottom: var(--azure-dialog-clear, 200px) !important; }';
    document.head.appendChild(rule);
  }

  fitLayout();
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', fitLayout);
  }

  // --- setters -------------------------------------------------------------
  function setHealth(v) {
    if (!fillNode) return;
    const value = clampNum(Number(v) || 0, 0, 100);
    fillNode.style.width = value + '%';
    // Green while healthy, amber when hurt, red + glow when critical so a
    // low-health state is unmissable at a glance.
    if (value >= 50) {
      fillNode.style.backgroundColor = '#22c55e';
      fillNode.style.boxShadow = 'none';
    } else if (value >= 25) {
      fillNode.style.backgroundColor = '#f59e0b';
      fillNode.style.boxShadow = 'none';
    } else {
      fillNode.style.backgroundColor = '#ef4444';
      fillNode.style.boxShadow = '0 0 10px rgba(239, 68, 68, 0.9)';
    }
  }

  function setCash(v) {
    if (!cashNode) return;
    cashNode.textContent = '$' + Math.round(Number(v) || 0).toLocaleString('en-US');
  }

  function setSpeed(kmh) {
    if (!speedNode) return;
    speedNode.textContent = Math.max(0, Math.round(Number(kmh) || 0)) + ' km/h';
  }

  function setWanted(n) {
    if (!wantedNode) return;
    const level = clampNum(Math.round(Number(n) || 0), 0, 5);
    starNodes.forEach((star, i) => {
      const lit = i < level;
      star.textContent = lit ? '★' : '☆';
      // Unlit stars are solid pale grey at near-full opacity with a hard
      // dark outline, so all five read at a glance; lit stars keep the
      // gold + glow plus the same outline so they hold up over white
      // cloud and sun glare.
      star.style.color = lit ? '#fbbf24' : '#dbe4ee';
      star.style.opacity = lit ? '1' : '0.9';
      star.classList.toggle('lit', lit);
      star.style.textShadow = lit
        ? '0 0 8px rgba(251, 191, 36, 0.9), 0 1px 3px rgba(0, 0, 0, 0.9), 0 0 2px rgba(0, 0, 0, 0.9)'
        : '0 1px 3px rgba(0, 0, 0, 0.9), 0 0 2px rgba(0, 0, 0, 0.9)';
    });
  }

  function setObjective(t) {
    if (!goalNode) return;
    goalNode.textContent = String(t ?? '');
  }

  function setTime(t) {
    if (!clockNode) return;
    clockNode.textContent = String(t ?? '');
  }

  function setAmmo(weaponName, mag, reserve) {
    if (!ammoNode) return;
    // A weapon with infinite ammo has no magazine to show — "FISTS —/—"
    // reads as a broken readout while driving. Hide the whole slot while
    // an infinite-ammo weapon is active; show it again the moment a
    // firearm is equipped so its magazine reads.
    const magOk = Number.isFinite(Number(mag));
    const reserveOk = Number.isFinite(Number(reserve));
    ammoNode.style.display = (!magOk && !reserveOk) ? 'none' : '';
    const magText = magOk ? String(mag) : '—';
    const reserveText = reserveOk ? String(reserve) : '—';
    ammoNode.textContent = String(weaponName ?? '') + ' ' + magText + '/' + reserveText;
    // An empty magazine reads red at a glance; anything else stays white.
    ammoNode.style.color = (magOk && Number(mag) === 0) ? '#ef4444' : '';
  }

  return { setHealth, setCash, setSpeed, setWanted, setObjective, setTime, setAmmo, fitLayout };
}
