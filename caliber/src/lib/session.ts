import { create } from 'zustand'
import type { Placement, Project, WorldPreset } from '../../shared/types'

/** What the project screen currently shows, mirrored for the debug panel. */
export interface WorldDebugSnapshot {
  project: Project
  preset: WorldPreset | null
  placement: Placement | null
  /** Latest viewer error message per source (splat, watch, environment, ...). */
  viewerErrors: Record<string, string>
}

// In-memory session state (not persisted).
interface SessionState {
  recentJobIds: string[]
  debugOpen: boolean
  /** Chosen splat quality (spz key) per preset id. UI-only; never saved to the server. */
  splatQuality: Record<string, string>
  world: WorldDebugSnapshot | null
  addJob: (id: string) => void
  toggleDebug: () => void
  setSplatQuality: (presetId: string, key: string) => void
  setWorld: (world: WorldDebugSnapshot | null) => void
}

export const useSession = create<SessionState>((set) => ({
  recentJobIds: [],
  debugOpen: false,
  splatQuality: {},
  world: null,
  addJob: (id) => set((s) => ({ recentJobIds: [id, ...s.recentJobIds.filter((x) => x !== id)].slice(0, 8) })),
  toggleDebug: () => set((s) => ({ debugOpen: !s.debugOpen })),
  setSplatQuality: (presetId, key) => set((s) => ({ splatQuality: { ...s.splatQuality, [presetId]: key } })),
  setWorld: (world) => set({ world }),
}))
