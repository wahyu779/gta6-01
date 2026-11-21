// dialog.js — AZURE BAY dialog box (Lane A, Fase 3)
// A big, readable bottom-of-screen dialog box: speaker name + text,
// optional choice buttons. It creates its own DOM (the page has no
// dialog markup — this lane must not edit index.html), so it works
// from a bare <script type="module"> import.
//
// PAUSING THE GAME: Dialog cannot outrun main.js's own window keydown
// listeners (same-target listeners fire in registration order), so the
// pause contract is a gate, not an event fight — Lane E's main loop
// must skip game input while Dialog.isOpen() is true (skip
// tryEnterExitCar / togglePause / player+car update, and drain the
// queued E/Escape presses), and only resume once it closes. Dialog
// also sets window.__dialogOpen so any other lane can read the state
// without importing it. Clicks on the box never reach the canvas, so
// a click that advances dialog cannot also fire a weapon.
//
// Usage:
//   Dialog.show('ROOK', 'Take this package across BRIDGE RD.', {
//     choices: [{ label: 'Accept the job', cb: () => Missions.start('m1') }],
//     onClose: () => { /* next line, or resume */ },
//   });
//   Dialog.showQueue([{ speaker, text }, ...], done);
//   Dialog.hide(); Dialog.isOpen();

const STYLE_ID = 'azure-dialog-style';
const ROOT_ID = 'azure-dialog';

const CSS = `
#${ROOT_ID} {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  width: min(760px, calc(100vw - 48px));
  box-sizing: border-box; /* Lane D (fase4): without this the 760px
    width was content-box, so padding + border made the box 808px
    wide and its right edge overlapped the minimap's left edge by
    4px in the combat/heli shots. Border-box keeps the whole box
    inside the 760px, clear of the minimap. */
  z-index: 60;
  display: none;
  flex-direction: column;
  gap: 10px;
  background: rgba(8, 12, 20, 0.88);
  border: 2px solid rgba(251, 191, 36, 0.85);
  border-radius: 14px;
  padding: 18px 22px 14px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  color: #f8fafc;
  cursor: pointer;
  user-select: none;
}
#${ROOT_ID} .dlg-speaker {
  font-size: 15px;
  font-weight: 800;
  letter-spacing: 0.14em;
  color: #fbbf24;
  text-transform: uppercase;
}
#${ROOT_ID} .dlg-text {
  font-size: 19px;
  line-height: 1.55;
  color: #f1f5f9;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
  white-space: pre-wrap;
}
#${ROOT_ID} .dlg-choices {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}
#${ROOT_ID} .dlg-choices:empty { display: none; }
#${ROOT_ID} .dlg-choice {
  display: block;
  width: 100%;
  text-align: left;
  font-size: 17px;
  font-weight: 600;
  padding: 10px 14px;
  border-radius: 9px;
  border: 1px solid rgba(251, 191, 36, 0.6);
  background: rgba(251, 191, 36, 0.12);
  color: #fef3c7;
  cursor: pointer;
}
#${ROOT_ID} .dlg-choice:hover,
#${ROOT_ID} .dlg-choice:focus-visible {
  background: rgba(251, 191, 36, 0.3);
  outline: 2px solid #fbbf24;
  outline-offset: 1px;
}
#${ROOT_ID} .dlg-hint {
  font-size: 12px;
  letter-spacing: 0.08em;
  color: rgba(226, 232, 240, 0.65);
  text-align: right;
}
`;

let root = null;
let speakerEl = null;
let textEl = null;
let choicesEl = null;
let hintEl = null;
let open = false;
let onCloseCb = null;
let currentChoices = [];
// Lines shown while a dialog is already open wait here instead of
// overwriting it (Fase 4, Lane A): Dialog.show() used to replace the
// open box AND its onClose chain, so the rest of the open chain never
// showed. A mission whose stage 0 sits on its start marker completes
// in the very frame it starts, and the stage-lines showQueue fired in
// that same frame — the whole intro vanished, and the player only ever
// saw the stage line. Queued lines play in order as each box closes;
// hide() drains the queue.
let queued = [];

function ensureDOM() {
  if (root) return;
  if (typeof document === 'undefined') return;
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  root = document.createElement('div');
  root.id = ROOT_ID;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-live', 'polite');

  speakerEl = document.createElement('div');
  speakerEl.className = 'dlg-speaker';
  textEl = document.createElement('div');
  textEl.className = 'dlg-text';
  choicesEl = document.createElement('div');
  choicesEl.className = 'dlg-choices';
  hintEl = document.createElement('div');
  hintEl.className = 'dlg-hint';
  hintEl.textContent = 'ENTER / KLIK — LANJUT';

  root.appendChild(speakerEl);
  root.appendChild(textEl);
  root.appendChild(choicesEl);
  root.appendChild(hintEl);
  document.body.appendChild(root);

  // Clicking the box advances (or does nothing when a choice is
  // required); clicks on a choice button pick that choice instead.
  root.addEventListener('click', (event) => {
    if (event.target && event.target.closest('.dlg-choice')) return;
    advance();
  });
  root.addEventListener('mousedown', (event) => {
    // The box sits over the canvas: swallow the mousedown so it can
    // never also queue a combat shot on the canvas underneath.
    event.stopPropagation();
  });

  // A resize changes the box width, so a two-line dialog can reflow to
  // three lines: re-measure the clear line while it is open.
  window.addEventListener('resize', () => {
    if (open) measureDialogClear();
  });

  // Belt and braces for the same reflow: a ResizeObserver on the box
  // itself fires whenever its size changes for any reason (viewport
  // resize, a longer line, a choice row appearing). A live probe
  // (fase4) caught the window-resize listener missing one reflow —
  // the clear line went stale and the mission pill sat ~90 px too
  // low — so the clear line is now re-measured from the box itself,
  // not from the resize event alone.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (open) measureDialogClear();
    }).observe(root);
  }

  window.addEventListener('keydown', (event) => {
    if (!open) return;
    if (currentChoices.length > 0) {
      // Number keys 1-9 pick a choice; Enter does nothing until one
      // is picked, so the player cannot skip past a decision.
      const n = Number(event.key);
      if (Number.isInteger(n) && n >= 1 && n <= currentChoices.length) {
        event.preventDefault();
        pickChoice(n - 1);
      }
      return;
    }
    if (event.code === 'Enter' || event.code === 'Space' || event.code === 'KeyE') {
      event.preventDefault();
      advance();
    } else if (event.code === 'Escape') {
      event.preventDefault();
      hide();
    }
  });
}

function setOpen(value) {
  open = value;
  if (typeof window !== 'undefined') window.__dialogOpen = value;
  if (typeof document === 'undefined' || !document.body) return;
  // Lane C (fase4, nit a): while a dialog is open, the bottom-centre HUD
  // pills (mission tracker + objective) must lift clear of the dialog
  // box instead of sitting underneath it — the combat shot had the
  // "M1 — HOOK AND CHAIN — 1/3" pill and the objective line half-hidden
  // behind the box. The HUD rules live in hud.js / hud-fase3.js and read
  // this class + custom property; the height is measured from the live
  // box so a longer line or a choice row still clears.
  document.body.classList.toggle('azure-dialog-open', value);
  if (value) measureDialogClear();
  else document.body.style.removeProperty('--azure-dialog-clear');
}

// Distance from the viewport bottom to the top of the dialog box, plus a
// 14 px gap: the clear line the HUD pills must sit above.
function measureDialogClear() {
  if (!root || !document.body) return;
  const height = root.offsetHeight || 0;
  document.body.style.setProperty('--azure-dialog-clear', (28 + height + 14) + 'px');
}

function advance() {
  if (currentChoices.length > 0) return; // a choice must be picked
  hide();
}

function pickChoice(index) {
  const choice = currentChoices[index];
  if (!choice) return;
  const cb = typeof choice.cb === 'function' ? choice.cb : null;
  hide();
  if (cb) cb();
}

function show(speaker, text, opts) {
  ensureDOM();
  if (!root) return false;
  const options = opts || {};
  // A dialog is already open: queue behind it instead of overwriting
  // it (see `queued` above). The open box keeps its onClose chain, and
  // this line plays when the open chain finishes.
  if (open) {
    queued.push({ speaker, text, opts: options });
    return true;
  }
  const choices = Array.isArray(options.choices) ? options.choices : [];
  currentChoices = choices;
  onCloseCb = typeof options.onClose === 'function' ? options.onClose : null;

  speakerEl.textContent = String(speaker || '');
  speakerEl.style.display = speaker ? '' : 'none';
  textEl.textContent = String(text || '');

  choicesEl.innerHTML = '';
  choices.forEach((choice, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dlg-choice';
    btn.textContent = `${i + 1}. ${choice && choice.label ? choice.label : 'Continue'}`;
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      pickChoice(i);
    });
    choicesEl.appendChild(btn);
  });

  hintEl.textContent = choices.length > 0
    ? 'PILIH JAWABAN — KLIK ATAU TEKAN 1-' + choices.length
    : 'ENTER / KLIK — LANJUT';

  root.style.display = 'flex';
  setOpen(true);
  return true;
}

function hide() {
  if (!open) return;
  if (root) root.style.display = 'none';
  currentChoices = [];
  setOpen(false);
  const cb = onCloseCb;
  onCloseCb = null;
  if (cb) cb();
  // The onClose callback may itself have opened a dialog (the intro
  // chain's next line): only drain the queue when nothing is open now.
  if (!open && queued.length > 0) {
    const next = queued.shift();
    show(next.speaker, next.text, next.opts);
  }
}

function isOpen() {
  return open;
}

// Show lines one after another: each box closes into the next, and
// `done` runs after the last one closes. A no-op when lines is empty.
function showQueue(lines, done) {
  if (!Array.isArray(lines) || lines.length === 0) {
    if (typeof done === 'function') done();
    return;
  }
  let i = 0;
  const next = () => {
    if (i >= lines.length) {
      if (typeof done === 'function') done();
      return;
    }
    const line = lines[i];
    i += 1;
    show(line.speaker || '', line.text || '', { onClose: next });
  };
  next();
}

export const Dialog = { show, showQueue, hide, isOpen };
if (typeof window !== 'undefined') {
  window.Dialog = Dialog;
}
