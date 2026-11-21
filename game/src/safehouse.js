// safehouse.js — AZURE BAY safehouse garage (Lane C, Fase 3).
// A garage the player can walk into to heal to full, save the game and
// swap weapons. It is a standalone module: Lane E wires it into main.js
// with bind() (health / cash / combat accessors) and init() (3D marker),
// and calls isNear() / enter() from the E-key interaction path.
// No network, no Node/Deno APIs — browser ES modules only.
//
// Contract:
//   window.Safehouse = {
//     location: { x, z, name },
//     isNear(player),          // player = player api ({position}) or {x, z}
//     enter(),                 // heal + save + open the weapon rack
//     bind(deps), init(scene), update(dt), dots(), prompt(), isOpen(), close(),
//   }
//
// deps (all optional, guarded — the marker renders without them):
//   getHealth() / setHealth(n)   — health lives in main.js, not here
//   getCash() / setCash(n)       — shown on the weapon rack
//   getCombat()                  — combat api ({ selectWeapon, current })
//   clearWanted()                — optional: laying low clears the heat
//   notify(msg)                  — optional toast hook; falls back to a local toast

import * as THREE from 'three';

const NAME = "ODALYS'S GARAGE";
const SUBTITLE = 'SAFEHOUSE';
// On PALM BLVD (north-island cross street, z = -140), west end, on the
// road itself so the player can always walk up to it — no building plot
// is guaranteed free, the verge beside a road always is.
const LOCATION = { x: -45, z: -140, name: `${NAME} — ${SUBTITLE}` };
const NEAR_RADIUS = 6; // metres
const SAVE_KEY = 'azurebay.safehouse.save';

const WEAPONS = [
  { index: 0, id: 'fists', name: 'FISTS', desc: 'Always with you. Quiet, free, personal.' },
  { index: 1, id: 'pistol', name: 'PISTOL', desc: '12-round mag. Mid range, steady.' },
  { index: 2, id: 'smg', name: 'SMG', desc: '30-round mag. Close range, hold to spray.' },
];

let deps = {};
let sceneRef = null;
let beacon = null;
let beaconLight = null;
let rackEl = null;
let toastEl = null;
let rackOpen = false;
let pulse = 0;

function hasShops() {
  return typeof window !== 'undefined' && window.Shops && typeof window.Shops.ownsWeapon === 'function';
}

/** Weapons the player owns: the shop's list when present, else all three
 *  (combat itself has no ownership lock, so an unwired game owns all). */
function ownedWeapons() {
  if (hasShops()) return WEAPONS.filter((w) => window.Shops.ownsWeapon(w.id));
  return WEAPONS.slice();
}

function showToast(msg) {
  if (typeof deps.notify === 'function') {
    deps.notify(msg);
    return;
  }
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'safehouse-toast';
    Object.assign(toastEl.style, {
      position: 'fixed', left: '50%', bottom: '110px', transform: 'translateX(-50%)',
      background: 'rgba(6, 20, 16, 0.92)', color: '#a7f3d0',
      border: '2px solid #22c55e', borderRadius: '10px', padding: '12px 20px',
      font: 'bold 17px system-ui, sans-serif', zIndex: 60, display: 'none',
      boxShadow: '0 4px 24px rgba(0,0,0,0.5)', textAlign: 'center', maxWidth: '90vw',
    });
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.style.display = 'block';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toastEl.style.display = 'none'; }, 3200);
}

/** Floating text sprite: big bold label on a dark plate, readable at range. */
function makeLabelSprite(lines, opts = {}) {
  const { fontPx = 64, pad = 26, fg = '#ffffff', bg = 'rgba(4, 12, 10, 0.88)', accent = '#22c55e' } = opts;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `bold ${fontPx}px system-ui, sans-serif`;
  ctx.font = font;
  const widths = lines.map((l) => ctx.measureText(l.text).width);
  canvas.width = Math.ceil(Math.max(...widths)) + pad * 2;
  canvas.height = lines.length * (fontPx + 14) + pad * 2;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => {
    ctx.font = l.small ? `bold ${Math.round(fontPx * 0.62)}px system-ui, sans-serif` : font;
    ctx.fillStyle = l.color || fg;
    ctx.fillText(l.text, canvas.width / 2, pad + (fontPx + 14) * i + fontPx / 2);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(11 * aspect, 11, 1);
  return sprite;
}

/** Small garage: teal walls, dark roller door facing the road, flat roof,
 *  plus a green beacon column so it reads at night and from the bridge. */
function buildMarker() {
  const group = new THREE.Group();
  const groundY = 1.5;
  const wall = new THREE.MeshStandardMaterial({ color: 0x0f766e, roughness: 0.85 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xf5efe0, roughness: 0.8 });
  const door = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.6, metalness: 0.4 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x134e4a, roughness: 0.9 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(9, 4.2, 6.5), wall);
  body.position.y = groundY + 2.1;
  body.castShadow = true;
  group.add(body);
  const roofSlab = new THREE.Mesh(new THREE.BoxGeometry(9.6, 0.35, 7.1), roof);
  roofSlab.position.y = groundY + 4.35;
  roofSlab.castShadow = true;
  group.add(roofSlab);
  // Roller door on the road (+z) face.
  const roller = new THREE.Mesh(new THREE.BoxGeometry(5.4, 3.2, 0.18), door);
  roller.position.set(0, groundY + 1.6, 3.3);
  group.add(roller);
  for (let i = 0; i < 4; i++) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.08, 0.05), trim);
    slat.position.set(0, groundY + 0.7 + i * 0.8, 3.42);
    group.add(slat);
  }
  // "H" sign plate above the door.
  const sign = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.0, 0.15),
    new THREE.MeshStandardMaterial({ color: 0x22c55e, roughness: 0.5, emissive: 0x14532d, emissiveIntensity: 0.7 }));
  sign.position.set(0, groundY + 3.7, 3.3);
  group.add(sign);

  // Green beacon: light column + point light, pulsed in update().
  const beamGeo = new THREE.CylinderGeometry(0.5, 0.9, 16, 12, 1, true);
  const beamMat = new THREE.MeshBasicMaterial({
    color: 0x22c55e, transparent: true, opacity: 0.22,
    side: THREE.DoubleSide, depthWrite: false,
  });
  beacon = new THREE.Mesh(beamGeo, beamMat);
  beacon.position.set(0, groundY + 8, 0);
  group.add(beacon);
  beaconLight = new THREE.PointLight(0x22c55e, 30, 26, 1.6);
  beaconLight.position.set(0, groundY + 5, 0);
  group.add(beaconLight);

  const label = makeLabelSprite([
    { text: NAME },
    { text: '— SAFEHOUSE —', small: true, color: '#a7f3d0' },
  ]);
  label.position.set(0, groundY + 8.6, 0);
  group.add(label);

  group.position.set(LOCATION.x, 0, LOCATION.z - 7.5);
  return group;
}

// ---- weapon rack overlay ----------------------------------------------------
function buildRack() {
  rackEl = document.createElement('div');
  rackEl.id = 'safehouse-rack';
  Object.assign(rackEl.style, {
    position: 'fixed', inset: '0', display: 'none', alignItems: 'center',
    justifyContent: 'center', background: 'rgba(2, 10, 8, 0.72)', zIndex: 55,
  });
  rackEl.innerHTML = `
    <div style="width:min(560px,92vw);background:#0b1f1a;border:3px solid #22c55e;border-radius:14px;
      padding:22px 24px;color:#f0fdf4;font-family:system-ui,sans-serif;
      box-shadow:0 12px 48px rgba(0,0,0,0.65)">
      <div style="font-size:24px;font-weight:900;letter-spacing:1px">${NAME}</div>
      <div style="font-size:14px;color:#a7f3d0;margin:2px 0 4px">SAFEHOUSE — health restored &amp; game saved</div>
      <div id="safehouse-rack-status" style="font-size:15px;color:#fde68a;margin-bottom:12px"></div>
      <div id="safehouse-rack-list" style="display:flex;flex-direction:column;gap:10px"></div>
      <div style="display:flex;gap:10px;margin-top:18px">
        <button id="safehouse-rack-close" type="button"
          style="flex:1;padding:12px;font-size:16px;font-weight:800;border-radius:9px;border:0;
          background:#22c55e;color:#052e16;cursor:pointer">LEAVE [Esc]</button>
      </div>
      <div style="font-size:12px;color:#86efac;margin-top:10px">
        Keys 1–3 equip a weapon you own. Pistol &amp; SMG are sold at AZURE ARMORY on Palm Blvd.</div>
    </div>`;
  document.body.appendChild(rackEl);
  rackEl.querySelector('#safehouse-rack-close').addEventListener('click', closeRack);
  rackEl.addEventListener('click', (e) => { if (e.target === rackEl) closeRack(); });
  document.addEventListener('keydown', (e) => {
    if (!rackOpen) return;
    if (e.code === 'Escape') { closeRack(); return; }
    const n = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
    if (n >= 0) equipWeapon(n);
  });
}

function renderRack() {
  if (!rackEl) buildRack();
  const owned = ownedWeapons();
  const combat = typeof deps.getCombat === 'function' ? deps.getCombat() : null;
  const current = combat ? combat.current : -1;
  const cash = typeof deps.getCash === 'function' ? deps.getCash() : null;
  const health = typeof deps.getHealth === 'function' ? deps.getHealth() : null;
  const status = rackEl.querySelector('#safehouse-rack-status');
  status.textContent = `Health ${health ?? '—'} / 100` + (cash !== null ? `   •   Cash $${Number(cash).toLocaleString('en-US')}` : '');
  const list = rackEl.querySelector('#safehouse-rack-list');
  list.innerHTML = '';
  WEAPONS.forEach((w) => {
    const isOwned = owned.some((o) => o.id === w.id);
    const isCurrent = current === w.index;
    const row = document.createElement('button');
    row.type = 'button';
    Object.assign(row.style, {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px',
      padding: '12px 14px', borderRadius: '9px', cursor: isOwned ? 'pointer' : 'not-allowed',
      border: isCurrent ? '2px solid #fbbf24' : '2px solid #14532d',
      background: isCurrent ? '#3f3005' : '#10291f', color: '#f0fdf4',
      font: '16px system-ui, sans-serif', textAlign: 'left', width: '100%',
    });
    row.innerHTML = `<span><b>[${w.index + 1}] ${w.name}</b> — <span style="color:#a7f3d0">${w.desc}</span></span>
      <span style="font-weight:800;color:${isCurrent ? '#fbbf24' : isOwned ? '#4ade80' : '#f87171'}">
      ${isCurrent ? 'EQUIPPED' : isOwned ? 'EQUIP' : 'NOT OWNED'}</span>`;
    if (isOwned) row.addEventListener('click', () => equipWeapon(w.index));
    list.appendChild(row);
  });
}

function equipWeapon(index) {
  const combat = typeof deps.getCombat === 'function' ? deps.getCombat() : null;
  if (!combat || typeof combat.selectWeapon !== 'function') {
    showToast('Weapon rack is not wired to combat yet (Lane E).');
    return;
  }
  const w = WEAPONS[index];
  if (!w) return;
  if (!ownedWeapons().some((o) => o.id === w.id)) {
    showToast(`${w.name} not owned — buy it at AZURE ARMORY.`);
    return;
  }
  combat.selectWeapon(index);
  showToast(`${w.name} equipped.`);
  renderRack();
}

function openRack() {
  if (!rackEl) buildRack();
  renderRack();
  rackEl.style.display = 'flex';
  rackOpen = true;
}

function closeRack() {
  if (rackEl) rackEl.style.display = 'none';
  rackOpen = false;
}

// ---- public API ---------------------------------------------------------------
export function createSafehouse(scene, bindDeps = {}) {
  deps = { ...bindDeps };

  const api = {
    location: { ...LOCATION },

    bind(nextDeps) {
      deps = { ...deps, ...nextDeps };
      return api;
    },

    init(targetScene) {
      const s = targetScene || scene;
      if (!s || sceneRef) return api;
      sceneRef = s;
      s.add(buildMarker());
      return api;
    },

    /** True when the player stands within interaction range. Accepts the
     *  player api ({position}) or a plain {x, z}. */
    isNear(player) {
      const p = player && player.position ? player.position : player;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return false;
      return Math.hypot(p.x - LOCATION.x, p.z - LOCATION.z) <= NEAR_RADIUS;
    },

    /** Walk in: heal to full, save, lay low, then open the weapon rack. */
    enter() {
      let healed = false;
      if (typeof deps.getHealth === 'function' && typeof deps.setHealth === 'function') {
        deps.setHealth(100);
        healed = true;
      }
      // Save point: the real Save system when Lane E adds it, plus a
      // localStorage checkpoint so the save is real even before that.
      let saved = false;
      try {
        if (typeof window !== 'undefined' && window.Save && typeof window.Save.save === 'function') {
          window.Save.save();
          saved = true;
        }
        const checkpoint = {
          savedAt: new Date().toISOString(),
          x: LOCATION.x, z: LOCATION.z,
          health: typeof deps.getHealth === 'function' ? deps.getHealth() : null,
          cash: typeof deps.getCash === 'function' ? deps.getCash() : null,
        };
        localStorage.setItem(SAVE_KEY, JSON.stringify(checkpoint));
        saved = true;
      } catch (err) {
        saved = false;
      }
      if (typeof deps.clearWanted === 'function') {
        try { deps.clearWanted(); } catch (err) { /* laying low is best-effort */ }
      }
      showToast(
        healed
          ? (saved ? 'Health restored — game saved at the safehouse.' : 'Health restored. (Save did not stick — check storage.)')
          : (saved ? 'Safehouse reached — game saved. (Heal not wired yet — Lane E.)' : 'Safehouse reached.'),
      );
      openRack();
      return { healed, saved };
    },

    /** Minimap dot for Lane E to merge into minimapExtras(). */
    dots() {
      return [{ x: LOCATION.x, z: LOCATION.z, color: '#22c55e', label: NAME }];
    },

    /** Prompt line for the HUD when the player is near. */
    prompt() {
      return `Press E — Enter ${NAME} (safehouse)`;
    },

    isOpen() { return rackOpen; },
    close() { closeRack(); },
    update(dt) {
      pulse += dt || 0;
      if (beacon) {
        const s = 1 + Math.sin(pulse * 2.2) * 0.12;
        beacon.scale.set(s, 1, s);
        beacon.material.opacity = 0.18 + Math.sin(pulse * 2.2) * 0.06;
      }
      if (beaconLight) beaconLight.intensity = 26 + Math.sin(pulse * 2.2) * 8;
    },
  };

  if (scene) api.init(scene);
  return api;
}

// Default singleton: Lane E wires it with
//   window.Safehouse.bind({ getHealth, setHealth, getCash, getCombat }).init(scene)
// and calls window.Safehouse.isNear(player) / .enter() from the E-key path.
if (typeof window !== 'undefined') {
  window.Safehouse = createSafehouse(null);
}

export const Safehouse = {
  create: createSafehouse,
  location: { ...LOCATION },
};
