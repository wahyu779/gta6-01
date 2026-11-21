// AZURE BAY — wanted level / heat (Lane C, Fase 2).
// Tracks how hot the player is: crimes add heat, the level is the floor
// of the heat (capped at 5 stars), and heat slowly cools off once the
// player stops committing crimes. Lane D reads `level` every frame for
// the HUD and feeds it to the police; the crime lanes call addHeat().

export const HEAT = {
  STEAL_CAR: 1,       // stealing a car
  HIT_PEDESTRIAN: 1,  // running a pedestrian over
  SHOOT: 0.5,         // one shot fired
  KILL_COP: 2,        // killing a police officer
};

const MAX_LEVEL = 5;
// Heat only starts cooling a few seconds after the last crime, so a fresh
// crime spree does not decay while it is still happening.
const GRACE_SECONDS = 5;

export function createWanted() {
  let heat = 0;
  let level = 0;
  // Seconds (performance.now() clock) of the most recent crime.
  let lastCrimeAt = 0;
  let lastReason = null;
  // Seconds accumulated toward the next -1 heat tick.
  let coolTimer = 0;

  // One heat point takes longer to cool off the hotter the player is.
  function decayInterval() {
    if (level >= 5) return 60;
    if (level >= 3) return 40;
    return 20;
  }

  function recomputeLevel() {
    level = Math.min(MAX_LEVEL, Math.floor(heat));
    if (level < 0) level = 0;
  }

  function addHeat(amount, reason) {
    if (!(amount > 0)) return;
    heat += amount;
    lastCrimeAt = performance.now() / 1000;
    lastReason = reason ?? null;
    coolTimer = 0;
    recomputeLevel();
  }

  function update(dt) {
    if (level <= 0 || !(dt > 0)) return;
    const now = performance.now() / 1000;
    // Still inside the grace window after the last crime: no cooling yet.
    if (now - lastCrimeAt < GRACE_SECONDS) {
      coolTimer = 0;
      return;
    }
    coolTimer += dt;
    let interval = decayInterval();
    while (coolTimer >= interval && heat > 0) {
      coolTimer -= interval;
      heat = Math.max(0, heat - 1);
      recomputeLevel();
      interval = decayInterval();
    }
    if (heat <= 0) {
      heat = 0;
      level = 0;
      coolTimer = 0;
    }
  }

  function reset() {
    heat = 0;
    level = 0;
    lastCrimeAt = 0;
    lastReason = null;
    coolTimer = 0;
  }

  return {
    /** Current wanted level, integer 0-5. */
    get level() { return level; },
    /** Raw heat; level is min(5, floor(heat)). */
    get heat() { return heat; },
    /** Seconds (performance.now() clock) of the last crime, 0 if none yet. */
    get lastCrimeAt() { return lastCrimeAt; },
    /** Reason string passed to the last addHeat(), or null. */
    get lastReason() { return lastReason; },
    addHeat,
    update,
    reset,
  };
}
