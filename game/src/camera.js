// Third-person camera rig for Azure Bay. The rig owns the yaw: the
// mouse (while pointer-locked) turns it, the player moves relative to
// it, and the car chase cam swings in behind the car's heading. On foot
// the camera hangs ~6 m back and 3 m up; in a car it hangs ~9 m back
// and 4 m up, looking ahead down the road.
//
// Small viewports: on a narrow window (800x500 and friends) the same
// distances would crop the player out of the frame, so the follow
// distance stretches as the aspect ratio shrinks — the framing stays
// readable instead of zooming in on the player's back.

import * as THREE from 'three';

const MOUSE_SENSITIVITY = 0.0025;
const ON_FOOT_DISTANCE = 6;
const ON_FOOT_HEIGHT = 3;
const IN_CAR_DISTANCE = 9;
const IN_CAR_HEIGHT = 4;
// Aspect ratios below these get a longer follow distance so the subject
// keeps the same screen size on a narrow window.
const NARROW_ASPECT = 1.2;
const MEDIUM_ASPECT = 1.6;
const NARROW_STRETCH = 1.3;
const MEDIUM_STRETCH = 1.15;

// Shortest-path angle blend: interpolating yaw the naive way would spin
// the camera a full turn whenever the target crosses the +/-PI seam.
function blendAngle(from, to, amount) {
  let gap = to - from;
  while (gap > Math.PI) gap -= Math.PI * 2;
  while (gap < -Math.PI) gap += Math.PI * 2;
  return from + gap * amount;
}

// Frame-rate independent smoothing factor: 1 - exp(-rate * dt) settles
// at the same speed no matter the frame rate.
function settleFactor(rate, dt) {
  return Math.min(1, 1 - Math.exp(-rate * dt));
}

export function createCameraRig(camera) {
  let yaw = 0;
  const wantedPos = new THREE.Vector3();
  const lookPoint = new THREE.Vector3();

  const rig = {
    /** Current camera yaw in radians; the player moves relative to this. */
    get yaw() {
      return yaw;
    },

    update(dt, targetPos, targetHeading, mode, mouseDX) {
      // A missing target or a broken delta means "hold the last frame"
      // instead of throwing the camera to NaN and blacking the screen.
      if (!camera || !targetPos || typeof targetPos.x !== 'number') return;
      if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
      const heading = Number.isFinite(targetHeading) ? targetHeading : 0;

      // Mouse right turns the view right.
      if (mouseDX) yaw -= mouseDX * MOUSE_SENSITIVITY;

      // Stretch the follow distance on narrow viewports so the framing
      // survives an 800x500 window: at 16:10 the rig reads the live
      // camera aspect, at 800x500 (1.6) it pulls back 15%, and below
      // 1.2 it pulls back 30%.
      const aspect = camera.aspect && Number.isFinite(camera.aspect) ? camera.aspect : 16 / 9;
      const stretch = aspect < NARROW_ASPECT ? NARROW_STRETCH
        : aspect < MEDIUM_ASPECT ? MEDIUM_STRETCH : 1;
      const follow = settleFactor(6, dt);

      if (mode === 'car') {
        // Swing the yaw in behind the car so the chase cam settles on
        // its tail instead of snapping.
        yaw = blendAngle(yaw, heading + Math.PI, settleFactor(2.5, dt));
        const dist = IN_CAR_DISTANCE * stretch;
        wantedPos.set(
          targetPos.x + Math.sin(yaw) * dist,
          targetPos.y + IN_CAR_HEIGHT,
          targetPos.z + Math.cos(yaw) * dist,
        );
        lookPoint.set(
          targetPos.x + Math.sin(heading) * 4,
          targetPos.y + 1.5,
          targetPos.z + Math.cos(heading) * 4,
        );
      } else {
        // On foot: hover behind the target at the current yaw.
        const dist = ON_FOOT_DISTANCE * stretch;
        wantedPos.set(
          targetPos.x + Math.sin(yaw) * dist,
          targetPos.y + ON_FOOT_HEIGHT,
          targetPos.z + Math.cos(yaw) * dist,
        );
        lookPoint.set(targetPos.x, targetPos.y + 1.4, targetPos.z);
      }

      camera.position.lerp(wantedPos, follow);
      camera.lookAt(lookPoint);
    },
  };
  return rig;
}
