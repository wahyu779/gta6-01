// Third-person camera rig for Azure Bay. The rig owns the yaw: the mouse
// (while pointer-locked) turns it, the player moves relative to it, and the
// car chase cam swings in behind the car's heading. Foot mode follows ~6 m
// back and 3 m up; car mode follows ~9 m back and 4 m up, looking ahead.

import * as THREE from 'three';

const MOUSE_SENS = 0.0025;
const FOOT_DIST = 6;
const FOOT_HEIGHT = 3;
const CAR_DIST = 9;
const CAR_HEIGHT = 4;

function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

export function createCameraRig(camera) {
  let yaw = 0;
  const desired = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();

  const rig = {
    /** Current camera yaw in radians; the player moves relative to this. */
    get yaw() {
      return yaw;
    },

    update(dt, targetPos, targetHeading, mode, mouseDX) {
      // Mouse right turns the view right.
      if (mouseDX) yaw -= mouseDX * MOUSE_SENS;

      const follow = Math.min(1, 1 - Math.exp(-6 * dt));

      if (mode === 'car') {
        // Swing the yaw in behind the car so the chase cam settles on its tail.
        yaw = lerpAngle(yaw, targetHeading + Math.PI, Math.min(1, 1 - Math.exp(-2.5 * dt)));
        desired.set(
          targetPos.x + Math.sin(yaw) * CAR_DIST,
          targetPos.y + CAR_HEIGHT,
          targetPos.z + Math.cos(yaw) * CAR_DIST,
        );
        lookTarget.set(
          targetPos.x + Math.sin(targetHeading) * 4,
          targetPos.y + 1.5,
          targetPos.z + Math.cos(targetHeading) * 4,
        );
      } else {
        // Foot mode: hover behind the target at the current yaw.
        desired.set(
          targetPos.x + Math.sin(yaw) * FOOT_DIST,
          targetPos.y + FOOT_HEIGHT,
          targetPos.z + Math.cos(yaw) * FOOT_DIST,
        );
        lookTarget.set(targetPos.x, targetPos.y + 1.4, targetPos.z);
      }

      camera.position.lerp(desired, follow);
      camera.lookAt(lookTarget);
    },
  };
  return rig;
}
