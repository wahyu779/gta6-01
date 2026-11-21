// shops.js — AZURE BAY weapon shop + garage (Lane C, Fase 3).
// Two street-front shops the player walks up to and opens with E:
//   AZURE ARMORY  — buy the pistol / SMG, ammo and medkits with $
//   BAY CUSTOMS   — repair the car and buy armor / engine upgrades
// Standalone module: Lane E wires it with bind() (cash / health / combat /
// car accessors) and init() (3D markers), and calls nearest() / tryInteract()
// from the E-key path. No network, no Node/Deno APIs — browser ES modules only.
//
// Contract:
//   window.Shops = {
//     weaponShop: { items: [{ id, name, price, desc }] },
//     openWeaponShop(), buy(id),
//     garage: { upgrades: [{ id, name, price, desc }] },
//     openGarage(),
//     ownsWeapon(id), ownedWeapons(), ammoCredits, garageState(car),
//     bind(deps), init(scene), nearest(playerPos), tryInteract(playerPos),
//     dots(), isOpen(), close(), update(dt),
//   }
//
// Economy (start $500, no mission payouts exist yet — see the gap note in
// buy()): pistol $250 is one early purchase, SMG $600 needs mission money.
// Ammo is sold as reserve credits: combat.js has no addAmmo hook yet, so a
// bought pack is banked in ammoCredits and lands in the gun the moment
// Lane E adds a 3-line combat.addAmmo — applyAmmoCredits() does it
// automatically when the hook appears. Garage upgrades are stored on the
// car object itself (car.armorLevel / car.engineLevel / car.condition) so
// police damage and car tuning can read them later.

import * as THREE from 'three';

const NEAR_RADIUS = 6; // metres
const STORE_KEY = 'azurebay.shops.v1';

const WEAPON_SHOP = {
  name: 'AZURE ARMORY',
  subtitle: 'WEAPONS & AMMO',
  // PALM BLVD (north-island cross street, z = -140), east end.
  x: 45, z: -140,
};
const GARAGE = {
  name: 'BAY CUSTOMS',
  subtitle: 'GARAGE — REPAIR & UPGRADES',
  // MARINA DR (south-island cross street, z = 140), west end.
  x: -45, z: 140,
};

export const WEAPON_ITEMS = [
  { id: 'pistol', kind: 'weapon', weapon: 'pistol', name: 'PISTOL', price: 250, desc: '12-round mag. Mid range, steady sidearm.' },
  { id: 'smg', kind: 'weapon', weapon: 'smg', name: 'SMG', price: 600, desc: '30-round mag. Close range, hold to spray.' },
  { id: 'ammo-pistol', kind: 'ammo', weapon: 'pistol', amount: 24, name: 'PISTOL AMMO ×24', price: 60, desc: '+24 reserve rounds for the pistol.' },
  { id: 'ammo-smg', kind: 'ammo', weapon: 'smg', amount: 60, name: 'SMG AMMO ×60', price: 90, desc: '+60 reserve rounds for the SMG.' },
  { id: 'medkit', kind: 'medkit', name: 'MEDKIT', price: 40, desc: 'Field dressing. Restores 50 health, on the spot.' },
];

export const GARAGE_UPGRADES = [
  { id: 'repair', kind: 'repair', name: 'REPAIR', price: 0, desc: 'Full bodywork — restores the car to 100% condition.' },
  { id: 'armor-1', kind: 'armor', level: 1, name: 'ARMOR PLATING I', price: 300, desc: 'Reinforced panels. Shrugs off bumps and bullets better.' },
  { id: 'armor-2', kind: 'armor', level: 2, name: 'ARMOR PLATING II', price: 500, desc: 'Military-grade plates. Needs Plating I.' },
  { id: 'armor-3', kind: 'armor', level: 3, name: 'ARMOR PLATING III', price: 800, desc: 'Full composite shell. Needs Plating II.' },
  { id: 'engine-1', kind: 'engine', level: 1, name: 'ENGINE TUNE I', price: 400, desc: 'Street tune. A livelier throttle.' },
  { id: 'engine-2', kind: 'engine', level: 2, name: 'ENGINE TUNE II', price: 700, desc: 'Sport cam + exhaust. Needs Tune I.' },
  { id: 'engine-3', kind: 'engine', level: 3, name: 'ENGINE TUNE III', price: 1000, desc: 'Race build. Needs Tune II.' },
];

const WEAPON_INDEX = { fists: 0, pistol: 1, smg: 2 };

let deps = {};
let sceneRef = null;
let overlayEl = null;
let overlayKind = null; // 'weapon' | 'garage' | null
let toastEl = null;
let pulse = 0;
const beacons = [];

// ---- persisted state ----------------------------------------------------------
// Owned guns, banked ammo credits and per-car garage levels survive reload.
const store = {
  owned: { fists: true, pistol: false, smg: false },
  ammoCredits: { pistol: 0, smg: 0 },
  garage: { armor: 0, engine: 0, condition: 100 },
};

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.owned) store.owned = { ...store.owned, ...data.owned };
    if (data.ammoCredits) store.ammoCredits = { ...store.ammoCredits, ...data.ammoCredits };
    if (data.garage) store.garage = { ...store.garage, ...data.garage };
  } catch (err) { /* a corrupt save just means a fresh shop state */ }
}

function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (err) { /* storage may be unavailable */ }
}

loadStore();

function showToast(msg) {
  if (typeof deps.notify === 'function') {
    deps.notify(msg);
    return;
  }
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'shops-toast';
    Object.assign(toastEl.style, {
      position: 'fixed', left: '50%', bottom: '110px', transform: 'translateX(-50%)',
      background: 'rgba(20, 12, 4, 0.92)', color: '#fde68a',
      border: '2px solid #f59e0b', borderRadius: '10px', padding: '12px 20px',
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

function getCash() {
  return typeof deps.getCash === 'function' ? deps.getCash() : null;
}

function getCar() {
  if (typeof deps.getCar === 'function') return deps.getCar();
  return deps.car || null;
}

/** Push the stored garage levels onto the live car object so other systems
 *  (police damage, tuning) can read them without knowing about this module. */
function syncCarFields(car) {
  if (!car) return;
  car.armorLevel = store.garage.armor;
  car.engineLevel = store.garage.engine;
  car.condition = store.garage.condition;
}

/** Garage levels for a car ({ armor, engine, condition }). */
function garageStateFor(car) {
  const c = car || getCar();
  if (c) syncCarFields(c);
  return { ...store.garage };
}

function repairPrice() {
  const missing = Math.max(0, 100 - store.garage.condition);
  if (missing <= 0) return 0;
  return Math.min(150, 30 + missing * 2);
}

// ---- 3D markers -----------------------------------------------------------------
function makeLabelSprite(lines, accent) {
  const fontPx = 64;
  const pad = 26;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
  const widths = lines.map((l) => ctx.measureText(l.text).width);
  canvas.width = Math.ceil(Math.max(...widths)) + pad * 2;
  canvas.height = lines.length * (fontPx + 14) + pad * 2;
  ctx.fillStyle = 'rgba(4, 12, 10, 0.88)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => {
    ctx.font = l.small ? `bold ${Math.round(fontPx * 0.62)}px system-ui, sans-serif` : `bold ${fontPx}px system-ui, sans-serif`;
    ctx.fillStyle = l.color || '#ffffff';
    ctx.fillText(l.text, canvas.width / 2, pad + (fontPx + 14) * i + fontPx / 2);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(11 * (canvas.width / canvas.height), 11, 1);
  return sprite;
}

/** Street-front shop box: coloured walls, a lit sign band, a beacon column. */
function buildShopMarker(shop, wallColor, accentColor) {
  const group = new THREE.Group();
  const groundY = 1.5;
  const wall = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.85 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.9 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0e7490, roughness: 0.25, metalness: 0.5 });
  const signMat = new THREE.MeshStandardMaterial({
    color: accentColor, roughness: 0.5,
    emissive: accentColor, emissiveIntensity: 0.55,
  });

  const body = new THREE.Mesh(new THREE.BoxGeometry(10, 4.6, 7), wall);
  body.position.y = groundY + 2.3;
  body.castShadow = true;
  group.add(body);
  const roofSlab = new THREE.Mesh(new THREE.BoxGeometry(10.6, 0.35, 7.6), roof);
  roofSlab.position.y = groundY + 4.75;
  roofSlab.castShadow = true;
  group.add(roofSlab);
  // Shopfront window on the road face (+z for the armory, -z for customs:
  // both face their street; the group is rotated below when needed).
  const windowPane = new THREE.Mesh(new THREE.BoxGeometry(6.5, 2.2, 0.15), glass);
  windowPane.position.set(0, groundY + 1.7, 3.55);
  group.add(windowPane);
  const sign = new THREE.Mesh(new THREE.BoxGeometry(7.5, 1.1, 0.15), signMat);
  sign.position.set(0, groundY + 4.0, 3.55);
  group.add(sign);

  const beamMat = new THREE.MeshBasicMaterial({
    color: accentColor, transparent: true, opacity: 0.2,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, 16, 12, 1, true), beamMat);
  beam.position.set(0, groundY + 8, 0);
  group.add(beam);
  const light = new THREE.PointLight(accentColor, 30, 26, 1.6);
  light.position.set(0, groundY + 5, 0);
  group.add(light);
  beacons.push({ beam, light });

  const label = makeLabelSprite([
    { text: shop.name },
    { text: `— ${shop.subtitle} —`, small: true, color: '#fde68a' },
  ], `#${accentColor.toString(16).padStart(6, '0')}`);
  label.position.set(0, groundY + 9.2, 0);
  group.add(label);

  group.position.set(shop.x, 0, shop.z);
  return group;
}

// ---- shop overlay -----------------------------------------------------------------
function buildOverlay() {
  overlayEl = document.createElement('div');
  overlayEl.id = 'shops-overlay';
  Object.assign(overlayEl.style, {
    position: 'fixed', inset: '0', display: 'none', alignItems: 'center',
    justifyContent: 'center', background: 'rgba(8, 6, 2, 0.72)', zIndex: 55,
  });
  overlayEl.innerHTML = `
    <div style="width:min(600px,94vw);max-height:88vh;overflow:auto;background:#1c1206;
      border:3px solid #f59e0b;border-radius:14px;padding:22px 24px;color:#fef3c7;
      font-family:system-ui,sans-serif;box-shadow:0 12px 48px rgba(0,0,0,0.65)">
      <div id="shops-title" style="font-size:24px;font-weight:900;letter-spacing:1px"></div>
      <div id="shops-sub" style="font-size:14px;color:#fcd34d;margin:2px 0 4px"></div>
      <div id="shops-cash" style="font-size:18px;font-weight:800;color:#fff;margin-bottom:12px"></div>
      <div id="shops-list" style="display:flex;flex-direction:column;gap:10px"></div>
      <div style="display:flex;gap:10px;margin-top:18px">
        <button id="shops-close" type="button"
          style="flex:1;padding:12px;font-size:16px;font-weight:800;border-radius:9px;border:0;
          background:#f59e0b;color:#451a03;cursor:pointer">LEAVE [Esc]</button>
      </div>
      <div id="shops-hint" style="font-size:12px;color:#fcd34d;margin-top:10px"></div>
    </div>`;
  document.body.appendChild(overlayEl);
  overlayEl.querySelector('#shops-close').addEventListener('click', closeOverlay);
  overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) closeOverlay(); });
  document.addEventListener('keydown', (e) => {
    if (!overlayKind) return;
    if (e.code === 'Escape') { closeOverlay(); return; }
    const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7'].indexOf(e.code);
    if (n >= 0) {
      const rows = overlayEl.querySelectorAll('#shops-list button');
      if (rows[n]) rows[n].click();
    }
  });
}

function garageRows() {
  const car = getCar();
  const state = garageStateFor(car);
  return GARAGE_UPGRADES.map((u) => {
    if (u.kind === 'repair') {
      const price = repairPrice();
      return { ...u, price, stateText: state.condition >= 100 ? 'CONDITION 100%' : `CONDITION ${state.condition}%`, disabled: state.condition >= 100 };
    }
    if (u.kind === 'armor' || u.kind === 'engine') {
      const current = u.kind === 'armor' ? state.armor : state.engine;
      return {
        ...u,
        stateText: current >= u.level ? 'INSTALLED' : (current === u.level - 1 ? 'BUY' : `NEEDS ${u.kind === 'armor' ? 'PLATING' : 'TUNE'} ${u.level - 1}`),
        disabled: current >= u.level || current !== u.level - 1,
      };
    }
    return { ...u, stateText: 'BUY', disabled: false };
  });
}

function renderOverlay() {
  if (!overlayEl) buildOverlay();
  const isWeapon = overlayKind === 'weapon';
  const title = overlayEl.querySelector('#shops-title');
  const sub = overlayEl.querySelector('#shops-sub');
  const cashEl = overlayEl.querySelector('#shops-cash');
  const hint = overlayEl.querySelector('#shops-hint');
  const list = overlayEl.querySelector('#shops-list');
  const cash = getCash();
  cashEl.textContent = cash === null ? 'Cash: — (not wired yet)' : `Your cash: $${Number(cash).toLocaleString('en-US')}`;
  list.innerHTML = '';

  if (isWeapon) {
    title.textContent = WEAPON_SHOP.name;
    sub.textContent = WEAPON_SHOP.subtitle;
    hint.textContent = 'Keys 1–5 buy. Ammo is banked as reserve credit and loads into the gun automatically. Medkit heals 50 on the spot.';
    WEAPON_ITEMS.forEach((item) => {
      const owned = item.kind === 'weapon' && store.owned[item.weapon];
      const credits = item.kind === 'ammo' ? store.ammoCredits[item.weapon] : 0;
      const afford = cash === null || cash >= item.price;
      const row = document.createElement('button');
      row.type = 'button';
      Object.assign(row.style, {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px',
        padding: '12px 14px', borderRadius: '9px', cursor: owned ? 'not-allowed' : 'pointer',
        border: '2px solid #78350f', background: '#2a1a05', color: '#fef3c7',
        font: '16px system-ui, sans-serif', textAlign: 'left', width: '100%',
        opacity: (!afford && !owned) ? 0.55 : 1,
      });
      const extra = owned ? 'OWNED' : (item.kind === 'ammo' && credits > 0 ? `BANKED ×${credits}` : '');
      row.innerHTML = `<span><b>${item.name}</b> — <span style="color:#fcd34d">${item.desc}</span>
          ${extra ? `<span style="color:#4ade80"> [${extra}]</span>` : ''}</span>
        <span style="font-weight:800;white-space:nowrap">$${item.price.toLocaleString('en-US')}</span>`;
      if (!owned) row.addEventListener('click', () => { buyItem(item.id); });
      list.appendChild(row);
    });
  } else {
    title.textContent = GARAGE.name;
    sub.textContent = GARAGE.subtitle;
    const car = getCar();
    const state = garageStateFor(car);
    hint.textContent = car
      ? `Your car: armor ${state.armor}/3 • engine ${state.engine}/3 • condition ${state.condition}%. Upgrades install in order — no skipping levels.`
      : 'No car linked yet (Lane E wires getCar) — upgrades still save and apply to the next car you drive.';
    garageRows().forEach((u) => {
      const afford = cash === null || cash >= u.price;
      const row = document.createElement('button');
      row.type = 'button';
      Object.assign(row.style, {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px',
        padding: '12px 14px', borderRadius: '9px', cursor: u.disabled ? 'not-allowed' : 'pointer',
        border: '2px solid #78350f', background: '#2a1a05', color: '#fef3c7',
        font: '16px system-ui, sans-serif', textAlign: 'left', width: '100%',
        opacity: (!afford && !u.disabled) || u.disabled ? 0.55 : 1,
      });
      row.innerHTML = `<span><b>${u.name}</b> — <span style="color:#fcd34d">${u.desc}</span></span>
        <span style="font-weight:800;white-space:nowrap">${u.disabled ? u.stateText : '$' + u.price.toLocaleString('en-US')}</span>`;
      if (!u.disabled) row.addEventListener('click', () => { buyItem(u.id); });
      list.appendChild(row);
    });
  }
}

function openOverlay(kind) {
  if (!overlayEl) buildOverlay();
  overlayKind = kind;
  renderOverlay();
  overlayEl.style.display = 'flex';
}

function closeOverlay() {
  if (overlayEl) overlayEl.style.display = 'none';
  overlayKind = null;
}

// ---- buying ---------------------------------------------------------------------
// Module-level buy(): the shop-row click handlers call bare buyItem(id),
// and the api method delegates to it. (Lane E fix: the handlers called a
// bare `buy(...)` that only existed as an api method, so every row click
// threw `ReferenceError: buy is not defined` and no shop purchase could
// ever succeed — the whole shop economy was dead on arrival.)
function buyItem(id) {
  const weaponItem = WEAPON_ITEMS.find((i) => i.id === id);
  if (weaponItem) {
    const ok = weaponItem.kind === 'weapon' ? buyWeapon(weaponItem)
      : weaponItem.kind === 'ammo' ? buyAmmo(weaponItem)
      : buyMedkit(weaponItem);
    if (ok && overlayKind) renderOverlay();
    return ok;
  }
  const garageItem = GARAGE_UPGRADES.find((u) => u.id === id);
  if (garageItem) {
    const ok = buyGarage(garageItem);
    if (ok && overlayKind) renderOverlay();
    return ok;
  }
  showToast(`No item '${id}' in the shops.`);
  return false;
}

function spend(price) {
  const cash = getCash();
  if (cash === null) {
    showToast('Shop is not wired to your cash yet (Lane E).');
    return false;
  }
  if (cash < price) {
    showToast(`Not enough cash — you have $${Number(cash).toLocaleString('en-US')}.`);
    return false;
  }
  if (typeof deps.setCash === 'function') deps.setCash(cash - price);
  return true;
}

function buyWeapon(item) {
  if (store.owned[item.weapon]) {
    showToast(`You already own the ${item.name}.`);
    return false;
  }
  if (!spend(item.price)) return false;
  store.owned[item.weapon] = true;
  saveStore();
  showToast(`${item.name} purchased — switch to it at the safehouse or with keys 1–3.`);
  return true;
}

function buyAmmo(item) {
  if (!spend(item.price)) return false;
  store.ammoCredits[item.weapon] += item.amount;
  saveStore();
  // Hand the credits to combat the moment it can take them.
  applyAmmoCredits();
  showToast(`${item.name} purchased — reserve +${item.amount} rounds.`);
  return true;
}

function buyMedkit(item) {
  if (typeof deps.getHealth !== 'function' || typeof deps.setHealth !== 'function') {
    showToast('Medkit is not wired to health yet (Lane E).');
    return false;
  }
  const health = deps.getHealth();
  if (health >= 100) {
    showToast('Already at full health — save the medkit.');
    return false;
  }
  if (!spend(item.price)) return false;
  deps.setHealth(Math.min(100, health + 50));
  showToast('Medkit used — +50 health.');
  return true;
}

function buyGarage(item) {
  const car = getCar();
  if (item.kind === 'repair') {
    const price = repairPrice();
    if (store.garage.condition >= 100) {
      showToast('Car is already at 100% condition.');
      return false;
    }
    if (!spend(price)) return false;
    store.garage.condition = 100;
    saveStore();
    syncCarFields(car);
    showToast('Car repaired to 100% condition.');
    return true;
  }
  const key = item.kind; // 'armor' | 'engine'
  const current = store.garage[key];
  if (current >= item.level) {
    showToast(`${item.name} is already installed.`);
    return false;
  }
  if (current !== item.level - 1) {
    showToast(`Install ${key === 'armor' ? 'Plating' : 'Tune'} ${item.level - 1} first.`);
    return false;
  }
  if (!spend(item.price)) return false;
  store.garage[key] = item.level;
  saveStore();
  syncCarFields(car);
  showToast(`${item.name} installed on your car.`);
  return true;
}

// ---- public API -------------------------------------------------------------------
export function createShops(scene, bindDeps = {}) {
  deps = { ...bindDeps };

  const api = {
    weaponShop: { name: WEAPON_SHOP.name, items: WEAPON_ITEMS },
    garage: { name: GARAGE.name, upgrades: GARAGE_UPGRADES },

    bind(nextDeps) {
      deps = { ...deps, ...nextDeps };
      return api;
    },

    init(targetScene) {
      const s = targetScene || scene;
      if (!s || sceneRef) return api;
      sceneRef = s;
      const armory = buildShopMarker(WEAPON_SHOP, 0x7c2d12, 0xf59e0b);
      armory.position.z = WEAPON_SHOP.z - 8; // shopfront faces the road
      s.add(armory);
      const customs = buildShopMarker(GARAGE, 0x1e3a5f, 0x38bdf8);
      customs.rotation.y = Math.PI; // face MARINA DR from the south side
      customs.position.z = GARAGE.z + 8;
      s.add(customs);
      return api;
    },

    openWeaponShop() { openOverlay('weapon'); return true; },
    openGarage() { openOverlay('garage'); return true; },

    /** Buy by item id (weapon-shop ids and garage ids share one namespace). */
    buy(id) {
      return buyItem(id);
    },

    ownsWeapon(id) {
      if (id === 'fists') return true;
      return !!store.owned[id];
    },

    ownedWeapons() {
      return Object.keys(store.owned).filter((k) => store.owned[k]);
    },

    /** Banked reserve rounds, per gun. combat.js cannot take them yet —
     *  see applyAmmoCredits(). */
    get ammoCredits() {
      return { ...store.ammoCredits };
    },

    /** If combat ever exposes addAmmo(weaponId, rounds), banked credits
     *  flow into the gun here. Returns the credits actually applied. */
    applyAmmoCredits() {
      return applyAmmoCredits();
    },

    /** Garage levels for a car ({ armor, engine, condition }); the live
     *  car object is synced onto the same values when available. */
    garageState(car) {
      const c = car || getCar();
      if (c) syncCarFields(c);
      return { ...store.garage };
    },

    /** Nearest shop within E range of a player position, else null.
     *  Accepts the player api ({position}) or a plain {x, z}. */
    nearest(playerPos) {
      const p = playerPos && playerPos.position ? playerPos.position : playerPos;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
      const dShop = Math.hypot(p.x - WEAPON_SHOP.x, p.z - WEAPON_SHOP.z);
      const dGarage = Math.hypot(p.x - GARAGE.x, p.z - GARAGE.z);
      if (dShop <= NEAR_RADIUS && dShop <= dGarage) {
        return { kind: 'weapon', name: WEAPON_SHOP.name, dist: dShop, label: `Press E — ${WEAPON_SHOP.name}` };
      }
      if (dGarage <= NEAR_RADIUS) {
        return { kind: 'garage', name: GARAGE.name, dist: dGarage, label: `Press E — ${GARAGE.name}` };
      }
      return null;
    },

    /** Open whichever shop the player stands at. Returns its kind or null. */
    tryInteract(playerPos) {
      const near = api.nearest(playerPos);
      if (!near) return null;
      if (near.kind === 'weapon') api.openWeaponShop();
      else api.openGarage();
      return near.kind;
    },

    /** Minimap dots for Lane E to merge into minimapExtras(). */
    dots() {
      return [
        { x: WEAPON_SHOP.x, z: WEAPON_SHOP.z, color: '#f59e0b', label: WEAPON_SHOP.name },
        { x: GARAGE.x, z: GARAGE.z, color: '#38bdf8', label: GARAGE.name },
      ];
    },

    isOpen() { return overlayKind !== null; },
    close() { closeOverlay(); },
    update(dt) {
      pulse += dt || 0;
      for (const b of beacons) {
        b.beam.material.opacity = 0.16 + Math.sin(pulse * 2.0) * 0.06;
        b.light.intensity = 26 + Math.sin(pulse * 2.0) * 8;
      }
    },
  };

  if (scene) api.init(scene);
  return api;
}

/** Move banked ammo credits into combat when it supports it. Safe to call
 *  any time: without the hook it is a no-op and the credits stay banked. */
function applyAmmoCredits() {
  const combat = typeof deps.getCombat === 'function' ? deps.getCombat() : null;
  if (!combat || typeof combat.addAmmo !== 'function') return { pistol: 0, smg: 0 };
  const applied = { pistol: 0, smg: 0 };
  for (const weapon of ['pistol', 'smg']) {
    const n = store.ammoCredits[weapon];
    if (n > 0) {
      try {
        combat.addAmmo(weapon, n);
        applied[weapon] = n;
        store.ammoCredits[weapon] = 0;
      } catch (err) { /* keep the credit banked if the hook balks */ }
    }
  }
  if (applied.pistol || applied.smg) saveStore();
  return applied;
}

// Default singleton: Lane E wires it with
//   window.Shops.bind({ getCash, setCash, getHealth, setHealth, getCar, getCombat }).init(scene)
if (typeof window !== 'undefined') {
  window.Shops = createShops(null);
}

export const Shops = {
  create: createShops,
  weaponShop: { name: WEAPON_SHOP.name, items: WEAPON_ITEMS },
  garage: { name: GARAGE.name, upgrades: GARAGE_UPGRADES },
};
