// The local API contract. Server routes (server/routes) and the frontend
// client (src/lib/api.ts) must both match this file. Change it here first.
//
// All errors: non-2xx status with JSON body { error: string } — the real
// message, never a generic one. The frontend shows it verbatim.
//
// GET    /api/health                      -> Health
// GET    /api/projects                    -> Project[]
// POST   /api/projects                    { name } -> Project
// GET    /api/projects/:id                -> Project
// PATCH  /api/projects/:id                { name?, scene?: ProjectScene } -> Project
//                                            scene.presetId must exist (404 otherwise); placement is validated
//                                            (finite numbers, Vec3 arrays of 3, worldScale > 0, size > 0, fov 5–120).
//                                            Setting a presetId with placement null copies the preset's defaultPlacement.
//                                            scene.shot (CameraShot | null) is validated: >= 2 keys, sorted t, first t = 0,
//                                            last t = durationSeconds, durationSeconds 1–60, fov 5–120, finite Vec3s.
//                                            Omitting scene.shot in a PATCH keeps the stored shot.
// DELETE /api/projects/:id                -> { ok: true }
// POST   /api/projects/:id/watch          multipart/form-data, field "file" (.glb only) -> Project
// POST   /api/projects/:id/watch/sample   (copies samples/casio_watch.glb; 404 if absent) -> Project
// GET    /api/projects/:id/jobs           -> Job[]
// GET    /api/jobs/:id                    -> Job                (polling fallback)
// GET    /api/jobs/:id/events             -> text/event-stream; event "job", data: Job (JSON).
//                                            Sends the current job immediately, then every change,
//                                            and closes after a terminal status (succeeded/failed).
// POST   /api/jobs/selftest               { projectId? } -> Job  (free diagnostic job: 3 steps over ~4s,
//                                            no network calls; used to verify SSE end to end)
// GET    /api/audio                       -> Asset[]  (library audio, kind 'audio', projectId null, newest first;
//                                            meta: { prompt, loop, durationSeconds, analysis?, requestHash, falRequestId })
// POST   /api/audio/preview               SfxRequestInput -> SfxPreview   (no network call; builds + fingerprints the request)
// POST   /api/audio                       SfxRequestInput & { approvedHash } -> 
//                                            409 if the rebuilt request's hash != approvedHash (the user must approve what is sent),
//                                            200 { cached: true, assets: Asset[] } if the ledger says completed (nothing sent),
//                                            201 Job (kind 'sfx'; steps: submit, generate, download, postprocess; result { assetIds })
//                                            Paid: goes through runPaidRequest. Files: data/assets/library/audio/<hash12>.mp3
//                                            PATCH project scene.audio (AudioTrack | null) is validated like shot/placement:
//                                            assetId must be a library 'audio' asset; volume 0–1; offset >= 0; fades 0–5.
//                                            Omitting scene.audio in a PATCH keeps the stored track.
//                                            scene.look (SceneLook | null) and scene.shot.dof (ShotDof, optional) are validated:
//                                            shadowOpacity 0–1, grain 0–0.1, apertureDegrees 0.1–5.7. Omitting look keeps it.
// GET    /api/presets                     -> WorldPreset[]      (library of finished worlds; shared by all projects)
// GET    /api/presets/:id                 -> WorldPreset
// PATCH  /api/presets/:id                 { name?, defaultPlacement? } -> WorldPreset
//                                            No DELETE: presets are paid outputs. Removing one is a manual, deliberate act.
// GET    /api/provider-requests/:hash     -> ProviderRequestRecord   (debug panel / "already generated" checks)
// POST   /api/projects/:id/exports        raw MP4 body (Content-Type: video/mp4), query: ?label=<text>
//                                            -> Asset (kind 'export'), file saved under data/exports/<projectId>/<timestamp>-<label>.mp4
//                                            Rejects non-MP4 bodies (checks the 'ftyp' box) with 400.
// GET    /api/projects/:id/exports        -> Asset[] (newest first)
// GET    /exports/<key>                   -> exported MP4 from data/exports, video/mp4, supports Range
// GET    /assets/<key>                    -> file bytes from data/assets, correct MIME, supports Range
//
// Storage keys: projects/<projectId>/<area>/<filename>, e.g. projects/abc/watch/casio_watch.glb
//               presets/<presetId>/<filename>, e.g. presets/xyz/world-500k.spz (project_id NULL on these assets)

export const API = {
  health: '/api/health',
  projects: '/api/projects',
  project: (id: string) => `/api/projects/${id}`,
  projectWatch: (id: string) => `/api/projects/${id}/watch`,
  projectWatchSample: (id: string) => `/api/projects/${id}/watch/sample`,
  projectJobs: (id: string) => `/api/projects/${id}/jobs`,
  job: (id: string) => `/api/jobs/${id}`,
  jobEvents: (id: string) => `/api/jobs/${id}/events`,
  selftest: '/api/jobs/selftest',
  presets: '/api/presets',
  preset: (id: string) => `/api/presets/${id}`,
  providerRequest: (hash: string) => `/api/provider-requests/${hash}`,
  projectExports: (id: string) => `/api/projects/${id}/exports`,
  audio: '/api/audio',
  audioPreview: '/api/audio/preview',
} as const
