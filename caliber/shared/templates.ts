// Watch ad templates. Pure data: the server reads the prompts, the editor reads
// the set/light/camera definitions, the exporter reads duration + shots.
//
// Units are meters. The watch rests on the prop's top surface at the origin,
// case centered, dial facing +Y. A real watch case is ~0.038 m across.
// The splat world is a soft backdrop behind a crisp 3D prop (World Labs worlds
// are room-scale, so splat detail is blurry at watch distance; DOF leans into it).

export type Vec3 = [number, number, number]

export interface CameraKey {
  /** Seconds from the start of the shot. */
  t: number
  position: Vec3
  target: Vec3
  fov: number
  /** Focus distance from camera, meters. Omit to focus on target. */
  focus?: number
}

export interface Shot {
  id: string
  label: string
  keys: CameraKey[]
  easing: 'linear' | 'easeInOut'
}

export interface PropSurface {
  kind: 'tray' | 'slab' | 'plinth'
  /** width x depth x height in meters; the top face sits at y = 0. */
  size: Vec3
  material: {
    color: string
    roughness: number
    metalness: number
    clearcoat?: number
    /** Named procedural pattern the editor knows how to draw. */
    pattern?: 'leather' | 'wet-acrylic' | 'concrete'
  }
}

export interface LightRig {
  /** Environment intensity for reflections on the steel (a generated studio env, not the splat). */
  environmentIntensity: number
  keyLight: { position: Vec3; color: string; intensity: number }
  rimLight?: { position: Vec3; color: string; intensity: number }
  /** Moving light for highlights sliding across the case. */
  sweep?: { from: Vec3; to: Vec3; color: string; intensity: number }
}

export interface WorldAnchor {
  /** Where the set sits inside the splat world (applied to the world, inverted). */
  position: Vec3
  rotationY: number
  scale: number
}

export interface WatchTemplate {
  id: 'morning-desk' | 'neon-night' | 'gallery-plinth'
  name: string
  mood: string
  /** Text-to-image prompt for the scene still (FAL nano-banana-2). User-editable before running. */
  sceneImagePrompt: string
  /** Text prompt sent alongside the image to World Labs (empty-environment caption). */
  worldTextPrompt: string
  sceneImageAspect: '16:9'
  prop: PropSurface
  lights: LightRig
  /** Initial guess for placing the set inside the world; adjustable in the editor. */
  defaultAnchor: WorldAnchor
  durationSeconds: number
  shots: Shot[]
  /** ElevenLabs SFX prompt for an ambient bed (no music, no voices). */
  ambiencePrompt: string
  /** Splat depth of field: in-focus band around the focal plane, then falloff. */
  dof: { sharpRange: number; falloffRate: number; apertureAngle: number }
}

const NO_PEOPLE_NO_TEXT = 'No people, no hands, no watches or jewelry, no readable text, no logos, no signage with letters.'

export const TEMPLATES: WatchTemplate[] = [
  {
    id: 'morning-desk',
    name: 'Morning Desk',
    mood: 'Warm, calm, everyday ritual',
    sceneImagePrompt:
      'Photorealistic empty home study in early morning. Low warm sun streams through a large window with sheer linen curtains, ' +
      'long soft light beams and gentle dust in the air. A light oak desk runs across the foreground at eye level with the camera. ' +
      'Background: cream plaster walls, a tall green plant, a few closed hardcover books and a ceramic cup far back on a shelf. ' +
      'Minimal, airy, quiet. Shot from desk height with a 50mm lens. ' + NO_PEOPLE_NO_TEXT,
    worldTextPrompt:
      'Empty sunlit home study in early morning, warm low sun through a window with sheer curtains, light oak desk in the foreground, cream walls, a plant and books on a shelf, calm and minimal.',
    sceneImageAspect: '16:9',
    prop: {
      kind: 'tray',
      size: [0.22, 0.16, 0.012],
      material: { color: '#5a3a26', roughness: 0.55, metalness: 0, pattern: 'leather' },
    },
    lights: {
      environmentIntensity: 0.9,
      keyLight: { position: [-0.6, 0.5, -0.3], color: '#ffd9a8', intensity: 3.2 },
      rimLight: { position: [0.4, 0.25, -0.5], color: '#fff3e0', intensity: 1.2 },
    },
    defaultAnchor: { position: [0, -0.75, -1.2], rotationY: 0, scale: 1 },
    durationSeconds: 10,
    shots: [
      {
        id: 'push-in',
        label: 'Slow push-in to the dial',
        easing: 'easeInOut',
        keys: [
          { t: 0, position: [0.02, 0.07, 0.32], target: [0, 0.004, 0], fov: 28 },
          { t: 10, position: [0.0, 0.045, 0.11], target: [0, 0.004, 0], fov: 28 },
        ],
      },
    ],
    ambiencePrompt: 'ambient environment, loop of a quiet sunlit room in the morning, faint distant birdsong through a closed window, soft room tone',
    dof: { sharpRange: 0.05, falloffRate: 0.6, apertureAngle: 0.04 },
  },
  {
    id: 'neon-night',
    name: 'Neon Night',
    mood: 'Retro, electric, after dark',
    sceneImagePrompt:
      'Photorealistic empty retro 1980s arcade at night. Rows of glowing arcade cabinet screens showing abstract colorful shapes, ' +
      'magenta and cyan neon tube lights in simple geometric shapes on the walls, light haze in the air. A glossy wet black counter ' +
      'runs across the foreground at camera height, reflecting the neon. Moody, cinematic, high contrast. Shot from counter height with a 50mm lens. ' +
      NO_PEOPLE_NO_TEXT,
    worldTextPrompt:
      'Empty retro 1980s arcade at night, glowing cabinet screens with abstract shapes, magenta and cyan geometric neon tubes, light haze, glossy wet black counter in the foreground.',
    sceneImageAspect: '16:9',
    prop: {
      kind: 'slab',
      size: [0.3, 0.2, 0.02],
      material: { color: '#050507', roughness: 0.08, metalness: 0, clearcoat: 1, pattern: 'wet-acrylic' },
    },
    lights: {
      environmentIntensity: 0.35,
      keyLight: { position: [-0.4, 0.3, 0.2], color: '#ff3fb4', intensity: 2.6 },
      rimLight: { position: [0.45, 0.2, -0.35], color: '#36e7ff', intensity: 3.0 },
    },
    defaultAnchor: { position: [0, -1.0, -1.0], rotationY: 0, scale: 1 },
    durationSeconds: 8,
    shots: [
      {
        id: 'low-slide',
        label: 'Low lateral slide past the watch',
        easing: 'easeInOut',
        keys: [
          { t: 0, position: [-0.16, 0.025, 0.14], target: [0.01, 0.004, 0], fov: 32 },
          { t: 8, position: [0.16, 0.035, 0.12], target: [-0.01, 0.004, 0], fov: 32 },
        ],
      },
    ],
    ambiencePrompt: 'ambient environment, loop of an empty arcade at night, soft electronic hum of machines, distant muffled synth bleeps, no melody, no voices',
    dof: { sharpRange: 0.04, falloffRate: 0.8, apertureAngle: 0.05 },
  },
  {
    id: 'gallery-plinth',
    name: 'Gallery Plinth',
    mood: 'Architectural, quiet, premium',
    sceneImagePrompt:
      'Photorealistic empty minimalist art gallery. Polished concrete floor, tall white walls, a single large skylight casting a soft ' +
      'beam of daylight. A few abstract stone sculptures on low bases far in the background, no paintings. Calm, architectural, generous space. ' +
      'Shot from waist height with a 35mm lens. ' + NO_PEOPLE_NO_TEXT,
    worldTextPrompt:
      'Empty minimalist art gallery, polished concrete floor, tall white walls, a single skylight with a soft beam of daylight, a few abstract stone sculptures far in the background.',
    sceneImageAspect: '16:9',
    prop: {
      kind: 'plinth',
      size: [0.14, 0.14, 0.9],
      material: { color: '#b9b6b0', roughness: 0.85, metalness: 0, pattern: 'concrete' },
    },
    lights: {
      environmentIntensity: 1.1,
      keyLight: { position: [0.1, 1.2, 0.2], color: '#f4f7ff', intensity: 3.5 },
      sweep: { from: [-0.3, 0.2, 0.25], to: [0.3, 0.2, 0.25], color: '#ffffff', intensity: 2.0 },
    },
    defaultAnchor: { position: [0, -0.9, -1.5], rotationY: 0, scale: 1 },
    durationSeconds: 12,
    shots: [
      {
        id: 'crane-down',
        label: 'Crane down from above to hero angle',
        easing: 'easeInOut',
        keys: [
          { t: 0, position: [0.0, 0.42, 0.06], target: [0, 0, 0], fov: 30 },
          { t: 12, position: [0.05, 0.06, 0.16], target: [0, 0.006, 0], fov: 30 },
        ],
      },
    ],
    ambiencePrompt: 'ambient environment, loop of a large empty gallery hall, soft reverberant room tone, very faint distant footsteps echo, calm',
    dof: { sharpRange: 0.06, falloffRate: 0.5, apertureAngle: 0.035 },
  },
]

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id)
