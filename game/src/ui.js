// ui.js — AZURE BAY menus (rewrite round 2).
// Controls the three menu overlays defined by the shared contract:
//   #menu-start (button #btn-start) — the game's entry point
//   #menu-pause (button #btn-resume) — toggled by Escape from the main loop
//   #menu-dead  (button #btn-restart) — shown on death (WASTED)
// This module only shows/hides overlays and wires the buttons; the main
// loop owns game state and calls showPause() / showDead() / hideAll().
// Every lookup is guarded: a missing overlay or button is skipped silently.
//
// Round-2 fix — one menu at a time, always: the old code hid the other
// menus on every show() but never tracked which one was open, so a
// double Escape or a death landing on the same frame as a pause could
// leave two overlays visible (or a button firing twice). This version
// keeps a single `activeMenu` record: show() is a no-op when the requested
// menu is already the open one, hideAll() clears the record, and button
// clicks are ignored while their menu is not the active one. The Escape
// key is handled by the main loop, not here, so there is exactly one
// owner of that decision.

export function createUI() {
  const byId = (id) => document.getElementById(id);

  const startMenu = byId('menu-start');
  const pauseMenu = byId('menu-pause');
  const deadMenu = byId('menu-dead');

  const startBtn = byId('btn-start');
  const resumeBtn = byId('btn-resume');
  const restartBtn = byId('btn-restart');

  const allMenus = [startMenu, pauseMenu, deadMenu];
  let activeMenu = null; // the one menu currently visible, or null
  // The start menu ships visible in index.html (no .hidden class), so
  // seed the record from the DOM: whichever menu is actually showing
  // when this module loads is the active one, even before showStart()
  // is ever called.
  for (const m of allMenus) {
    if (m && m.style.display !== 'none' && !m.classList.contains('hidden')) {
      activeMenu = m;
      break;
    }
  }
  let startHandler = null;
  let resumeHandler = null;
  let restartHandler = null;

  function reveal(menu) {
    // Already showing this exact menu: do nothing (no flicker, no
    // double-fire of anything listening to visibility changes).
    if (menu && activeMenu === menu) return;
    for (const m of allMenus) {
      if (m) m.style.display = 'none';
    }
    activeMenu = null;
    if (menu) {
      menu.style.display = 'flex';
      activeMenu = menu;
    }
  }

  function showStart() { reveal(startMenu); }
  function showPause() { reveal(pauseMenu); }
  function showDead() { reveal(deadMenu); }

  function hideAll() {
    for (const m of allMenus) {
      if (m) m.style.display = 'none';
    }
    activeMenu = null;
  }

  /** Which menu is open right now ('start' | 'pause' | 'dead' | null). */
  function current() {
    if (activeMenu === startMenu) return 'start';
    if (activeMenu === pauseMenu) return 'pause';
    if (activeMenu === deadMenu) return 'dead';
    return null;
  }

  function isOpen() { return activeMenu !== null; }

  function onStart(cb) { startHandler = typeof cb === 'function' ? cb : null; }
  function onResume(cb) { resumeHandler = typeof cb === 'function' ? cb : null; }
  function onRestart(cb) { restartHandler = typeof cb === 'function' ? cb : null; }

  // A button only fires while its own menu is the active one — a stray
  // click (or a synthetic one) on a hidden menu can never start, resume
  // or restart the game out from under the visible one.
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      if (activeMenu === startMenu && startHandler) startHandler();
    });
  }
  if (resumeBtn) {
    resumeBtn.addEventListener('click', () => {
      if (activeMenu === pauseMenu && resumeHandler) resumeHandler();
    });
  }
  if (restartBtn) {
    restartBtn.addEventListener('click', () => {
      if (activeMenu === deadMenu && restartHandler) restartHandler();
    });
  }

  return { showStart, showPause, showDead, hideAll, onStart, onResume, onRestart, current, isOpen };
}
