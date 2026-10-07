import { useEffect } from 'react'
import { useLoader, useThree } from '@react-three/fiber'
import { EquirectangularReflectionMapping, SRGBColorSpace, TextureLoader } from 'three'

/**
 * Use an equirectangular PNG/JPG (e.g. the World Labs pano) as scene.environment so
 * metal reflects the actual world. Never set as background — the splat is the background.
 * drei's <Environment files> only accepts HDR/EXR/cube sets, hence this component.
 */
export function EquirectEnvironment({
  url,
  intensity = 1,
  rotationY = 0,
  rotation,
}: {
  url: string
  intensity?: number
  rotationY?: number
  /** Full environment rotation (overrides rotationY), e.g. from environmentEuler() for a tilted world. */
  rotation?: [number, number, number]
}) {
  const texture = useLoader(TextureLoader, url)
  const scene = useThree((s) => s.scene)

  useEffect(() => {
    texture.mapping = EquirectangularReflectionMapping
    texture.colorSpace = SRGBColorSpace
    texture.needsUpdate = true
    const previous = scene.environment
    scene.environment = texture
    return () => {
      scene.environment = previous
    }
  }, [scene, texture])

  useEffect(() => {
    scene.environmentIntensity = intensity
    if (rotation) scene.environmentRotation.set(rotation[0], rotation[1], rotation[2], 'XYZ')
    else scene.environmentRotation.set(0, rotationY, 0, 'XYZ')
  }, [scene, intensity, rotationY, rotation?.[0], rotation?.[1], rotation?.[2]])

  return null
}
