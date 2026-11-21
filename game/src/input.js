// Keyboard + pointer-lock mouse input for Azure Bay.
// Tracks every held key by its KeyboardEvent.code, accumulates
// pointer-lock mouse movement, and requests pointer lock when the
// player clicks the canvas.
//
// Every listener is registered through a named handler and torn down by
// dispose(), so a re-created input layer can never leave a stale
// listener behind double-firing keys.

const HANDLED_CODES = new Set([
  'Space', 'Tab',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'KeyE', 'KeyF', 'ShiftLeft', 'ShiftRight',
  'Digit1', 'Digit2', 'Digit3', 'KeyR',
]);

export function createInput(canvas) {
  const target = canvas || document.querySelector('canvas');
  const heldKeys = new Set();
  let pointerDX = 0;
  // Mouse fire state: mouseDown stays true while the left button is held
  // (an SMG keeps firing), clickQueued is true once per click for
  // single-shot weapons and is drained by consumeClick().
  let mouseDown = false;
  let clickQueued = false;

  // Press queue for the weapon-switch / reload keys: a short tap can fall
  // between two slow frames (SwiftShader runs near 1 fps), so polling
  // isDown() once per frame would miss it. keydown queues the code here
  // and combat drains it once per press with consumePressed().
  const QUEUED_CODES = new Set(['Digit1', 'Digit2', 'Digit3', 'KeyR']);
  const pressQueue = new Set();

  function onKeyDown(event) {
    if (!event || typeof event.code !== 'string') return;
    if (HANDLED_CODES.has(event.code)) event.preventDefault();
    heldKeys.add(event.code);
    if (QUEUED_CODES.has(event.code)) pressQueue.add(event.code);
  }
  function onKeyUp(event) {
    if (!event || typeof event.code !== 'string') return;
    heldKeys.delete(event.code);
  }
  // A key released while the tab is hidden never sends keyup: drop
  // everything so the player never keeps walking after tabbing back.
  function onBlur() {
    heldKeys.clear();
    pressQueue.clear();
    mouseDown = false;
  }
  function onMouseMove(event) {
    if (document.pointerLockElement) pointerDX += event.movementX || 0;
  }
  // Left-button tracking for combat. Listened on the canvas so a click
  // that also requests pointer lock still registers as one shot.
  function onMouseDown(event) {
    if (!event || event.button !== 0) return;
    mouseDown = true;
    clickQueued = true;
  }
  function onMouseUp(event) {
    if (!event || event.button !== 0) return;
    mouseDown = false;
  }
  function onCanvasClick() {
    if (!document.pointerLockElement && target && target.requestPointerLock) {
      target.requestPointerLock();
    }
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('mousemove', onMouseMove);
  const mouseTarget = target || window;
  mouseTarget.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  if (target) target.addEventListener('click', onCanvasClick);

  return {
    /** Codes currently held down. */
    keys: heldKeys,
    /** Horizontal mouse travel since the last consumeMouseDX() call. */
    get mouseDX() {
      return pointerDX;
    },
    /** Returns the accumulated mouse travel and resets it to zero. */
    consumeMouseDX() {
      const dx = pointerDX;
      pointerDX = 0;
      return dx;
    },
    /** True while the given KeyboardEvent.code is held down. */
    isDown(code) {
      return heldKeys.has(code);
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
      const wasPressed = pressQueue.has(code);
      pressQueue.delete(code);
      return wasPressed;
    },
    /** True once per left click, then resets to false until the next click. */
    consumeClick() {
      const clicked = clickQueued;
      clickQueued = false;
      return clicked;
    },
    /** Removes every listener this input layer registered, so a fresh
     *  createInput() can never double-fire keys or clicks. */
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('mousemove', onMouseMove);
      mouseTarget.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      if (target) target.removeEventListener('click', onCanvasClick);
      heldKeys.clear();
      pressQueue.clear();
      pointerDX = 0;
      mouseDown = false;
      clickQueued = false;
    },
  };
}
