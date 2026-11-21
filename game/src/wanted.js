// AZURE BAY — wanted heat, rewritten round 2.
// How hot the player is, as a slow-moving number instead of a twitchy
// one: crimes push heat up, heat cools off on a timer once the player
// goes quiet, and the star level is the floor of the heat (capped at
// five). The level is deliberately sticky on the way DOWN — it can jump
// up the instant a crime lands, but it only steps down one star at a
// time and only after holding for a few seconds. That stops the old
// flicker where heat wobbling across an integer boundary (2.9 <-> 3.1)
// made the HUD stars and the whole police response stutter between
// two levels every other frame.
//
// Readers of this module: the HUD (level), police.js (level drives
// spawns), main.js (addHeat on crimes, update every frame, reset on
// laying low / respawn). Nothing here touches the DOM or THREE.

export const HEAT = {
  STEAL_CAR: 1,        // stealing a car
  HIT_PEDESTRIAN: 1,   // running a pedestrian over
  SHOOT: 0.5,          // one shot fired
  KILL_COP: 2,         // killing a police officer
};

const TOP_STARS = 5;
// No cooling at all this long after the latest crime, so a spree does
// not decay while it is still happening.
const QUIET_GRACE = 5;
// Once the level rises it cannot fall again for this long, and after
// that it drops at most one star per STEP_DOWN seconds. A level earned
// by a fresh crime is never yanked away by one quiet second.
const LEVEL_HOLD = 8;
const STEP_DOWN = 10;

export function createWanted() {
  let heatPoints = 0;
  let stars = 0;
  // performance.now() clock, seconds, of the most recent crime.
  let latestCrimeSec = 0;
  let latestReason = null;
  // Seconds banked toward shedding the next single point of heat.
  let coolBank = 0;
  // performance.now() clock, seconds: the earliest moment the star
  // level is allowed to step down again.
  let levelHoldUntil = 0;

  // One point of heat takes longer to burn off the hotter things are.
  function secondsPerPoint() {
    if (stars >= 5) return 60;
    if (stars >= 3) return 40;
    return 20;
  }

  function settleStars(nowSec) {
    const target = Math.max(0, Math.min(TOP_STARS, Math.floor(heatPoints)));
    if (target > stars) {
      // Rising is instant — a fresh crime is felt right away — and it
      // re-arms the hold so the new level cannot immediately fall.
      stars = target;
      levelHoldUntil = nowSec + LEVEL_HOLD;
      return;
    }
    if (target < stars && nowSec >= levelHoldUntil) {
      // Falling is one careful step at a time, never a plunge, and
      // each step re-arms a shorter hold before the next one.
      stars -= 1;
      levelHoldUntil = nowSec + STEP_DOWN;
    }
  }

  function addHeat(amount, reason) {
    if (!(amount > 0)) return;
    heatPoints += amount;
    latestCrimeSec = performance.now() / 1000;
    latestReason = reason ?? null;
    coolBank = 0;
    settleStars(latestCrimeSec);
  }

  function update(dt) {
    if (!(dt > 0)) return;
    if (stars <= 0 && heatPoints <= 0) return;
    const nowSec = performance.now() / 1000;
    // Inside the grace window after the latest crime: nothing cools.
    if (nowSec - latestCrimeSec < QUIET_GRACE) {
      coolBank = 0;
      return;
    }
    coolBank += dt;
    let interval = secondsPerPoint();
    while (coolBank >= interval && heatPoints > 0) {
      coolBank -= interval;
      heatPoints = Math.max(0, heatPoints - 1);
      interval = secondsPerPoint();
    }
    if (heatPoints <= 0) {
      heatPoints = 0;
      coolBank = 0;
    }
    settleStars(nowSec);
    if (heatPoints <= 0 && stars <= 0) {
      stars = 0;
      coolBank = 0;
    }
  }

  function reset() {
    heatPoints = 0;
    stars = 0;
    latestCrimeSec = 0;
    latestReason = null;
    coolBank = 0;
    levelHoldUntil = 0;
  }

  return {
    /** Current wanted level, integer 0-5. Sticky downwards by design. */
    get level() { return stars; },
    /** Raw heat; the level tracks min(5, floor(heat)) with a hold. */
    get heat() { return heatPoints; },
    /** Seconds (performance.now() clock) of the latest crime, 0 if none. */
    get lastCrimeAt() { return latestCrimeSec; },
    /** Reason string passed to the latest addHeat(), or null. */
    get lastReason() { return latestReason; },
    addHeat,
    update,
    reset,
  };
}
