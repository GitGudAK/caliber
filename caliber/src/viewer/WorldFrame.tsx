import type { ReactNode } from 'react'
import type { Placement, Vec3 } from '../../shared/types'

/** The world-space frame of a splat world (and its collider), taken from a Placement. */
export type WorldTransform = Pick<
  Placement,
  'worldScale' | 'worldOffset' | 'worldRotationY' | 'worldRotationX' | 'worldRotationZ' | 'flipY'
>

/**
 * Applies a world transform to its children in this order:
 * flipY (PI about X) -> uniform scale -> rotate X -> rotate Z -> rotate Y -> translate.
 * i.e. M = T(offset) * Ry * Rz * Rx * S(scale) * Rx(flipY ? PI : 0)
 * (three's Euler order 'YZX' builds Ry * Rz * Rx; uniform scale commutes with rotation).
 * The splat and the collider both use this component so they stay aligned.
 */
export function WorldFrame({ transform, children }: { transform: WorldTransform; children: ReactNode }) {
  const offset: Vec3 = transform.worldOffset
  return (
    <group
      position={offset}
      rotation={[transform.worldRotationX ?? 0, transform.worldRotationY, transform.worldRotationZ ?? 0, 'YZX']}
      scale={transform.worldScale}
    >
      <group rotation={[transform.flipY ? Math.PI : 0, 0, 0]}>{children}</group>
    </group>
  )
}
