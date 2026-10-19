import * as THREE from 'three';
import type { Vector3Value } from '../../../shared/types/api';

export interface RobotFocusViewpoint {
  position: Vector3Value;
  target: Vector3Value;
}

export function createRobotFocusViewpoint(target: THREE.Vector3, radius: number): RobotFocusViewpoint {
  // 按相机到目标的真实距离取景，避免 X/Z 两轴分别加距离造成模型过小。
  const distance = Math.max(1.9, radius * 2.75);
  const direction = new THREE.Vector3(1, 0.65, 1).normalize().multiplyScalar(distance);
  const lookAtTarget = {
    x: target.x,
    y: target.y,
    z: target.z,
  };

  return {
    target: lookAtTarget,
    position: {
      x: lookAtTarget.x + direction.x,
      y: lookAtTarget.y + direction.y,
      z: lookAtTarget.z + direction.z,
    },
  };
}
