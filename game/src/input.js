// Keyboard + pointer-lock mouse input for Azure Bay.
// Tracks every held key by its KeyboardEvent.code, accumulates pointer-lock
// mouse movement, and requests pointer lock when the player clicks the canvas.

const GAME_KEYS = new Set([
  'Space', 'Tab',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'KeyE', 'KeyF', 'ShiftLeft', 'ShiftRight',
  'Digit1', 'Digit2', 'Digit3', 'KeyR',
]);

export function createInput(canvas) {
  const target = canvas || document.querySelector('canvas');
  const keys = new Set();
  let mouseDX = 0;
  // Mouse fire state: mouseDown stays true while the left button is held
  // (SMG keeps firing), clickQueued is true once per click for single-shot
  // weapons and is drained by consumeClick().
  let mouseDown = false;
  let clickQueued = false;

  // Press queue for weapon switch / reload keys: a short tap can fall
  // between two slow frames (SwiftShader ~1fps), so polling isDown() per
  // frame would miss it. keydown queues the code here and combat drains
  // it once per press with consumePressed().
  const PRESS_KEYS = new Set(['Digit1', 'Digit2', 'Digit3', 'KeyR']);
  const pressed = new Set();

  window.addEventListener('keydown', (event) => {
    if (GAME_KEYS.has(event.code)) event.preventDefault();
    keys.add(event.code);
    if (PRESS_KEYS.has(event.code)) pressed.add(event.code);
  });
  window.addEventListener('keyup', (event) => {
    keys.delete(event.code);
  });
  // A key released while the tab is hidden never sends keyup: drop everything.
  window.addEventListener('blur', () => {
    keys.clear();
    pressed.clear();
    mouseDown = false;
  });
  document.addEventListener('mousemove', (event) => {
    if (document.pointerLockElement) mouseDX += event.movementX || 0;
  });
  // Left-button tracking for combat. Listened on the canvas so a click that
  // also requests pointer lock still registers as one shot.
  const mouseTarget = target || window;
  mouseTarget.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    mouseDown = true;
    clickQueued = true;
  });
  window.addEventListener('mouseup', (event) => {
    if (event.button !== 0) return;
    mouseDown = false;
  });
  if (target) {
    target.addEventListener('click', () => {
      if (!document.pointerLockElement && target.requestPointerLock) {
        target.requestPointerLock();
      }
    });
  }

  return {
    /** Codes currently held down. */
    keys,
    /** Horizontal mouse travel since the last consumeMouseDX() call. */
    get mouseDX() {
      return mouseDX;
    },
    /** Returns the accumulated mouse travel and resets it to zero. */
    consumeMouseDX() {
      const dx = mouseDX;
      mouseDX = 0;
      return dx;
    },
    /** True while the given KeyboardEvent.code is held down. */
    isDown(code) {
      return keys.has(code);
    },
    /** True while the pointer is locked to the canvas. */
    get pointerLocked() {
      return document.pointerLockElement === target;
    },
    /** True while the left mouse button is held down. */
    get mouseDown() {
      return mouseDown;
    },
    /** True once per queued press of the given code, then resets. */
    consumePressed(code) {
      const wasPressed = pressed.has(code);
      pressed.delete(code);
      return wasPressed;
    },
    /** True once per left click, then resets to false until the next click. */
    consumeClick() {
      const clicked = clickQueued;
      clickQueued = false;
      return clicked;
    },
  };
}
