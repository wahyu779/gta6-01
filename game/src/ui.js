// ui.js — AZURE BAY menus (Lane C, Fase 1)
// Controls the three menu overlays defined by the shared contract:
//   #menu-start (button #btn-start) — the game's entry point
//   #menu-pause (button #btn-resume) — toggled by Escape from the main loop
//   #menu-dead  (button #btn-restart) — shown on death (WASTED)
// This module only shows/hides overlays and wires the buttons; the main
// loop owns game state and calls showPause()/showDead()/hideAll().
// Every lookup is guarded: a missing overlay or button is skipped silently.

export function createUI() {
  const el = (id) => document.getElementById(id);

  const menuStart = el('menu-start');
  const menuPause = el('menu-pause');
  const menuDead = el('menu-dead');

  const btnStart = el('btn-start');
  const btnResume = el('btn-resume');
  const btnRestart = el('btn-restart');

  const menus = [menuStart, menuPause, menuDead];

  function show(menu) {
    menus.forEach((m) => {
      if (m) m.style.display = 'none';
    });
    if (menu) menu.style.display = 'flex';
  }

  function showStart() {
    show(menuStart);
  }

  function showPause() {
    show(menuPause);
  }

  function showDead() {
    show(menuDead);
  }

  function hideAll() {
    menus.forEach((m) => {
      if (m) m.style.display = 'none';
    });
  }

  let startCb = null;
  let resumeCb = null;
  let restartCb = null;

  function onStart(cb) {
    startCb = typeof cb === 'function' ? cb : null;
  }

  function onResume(cb) {
    resumeCb = typeof cb === 'function' ? cb : null;
  }

  function onRestart(cb) {
    restartCb = typeof cb === 'function' ? cb : null;
  }

  if (btnStart) {
    btnStart.addEventListener('click', () => {
      if (startCb) startCb();
    });
  }
  if (btnResume) {
    btnResume.addEventListener('click', () => {
      if (resumeCb) resumeCb();
    });
  }
  if (btnRestart) {
    btnRestart.addEventListener('click', () => {
      if (restartCb) restartCb();
    });
  }

  return { showStart, showPause, showDead, hideAll, onStart, onResume, onRestart };
}
