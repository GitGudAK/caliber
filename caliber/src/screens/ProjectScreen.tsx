import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode, type RefObject } from 'react'
import { Link } from 'wouter'
import { ArrowClockwise, ArrowLeft, UploadSimple, Watch } from '@phosphor-icons/react'
import type { Asset, AudioTrack, CameraShot, Placement, Project, ProjectScene, SceneLook, WorldPreset } from '../../shared/types'
import { api, errorMessage } from '../lib/api'
import { formatBytes } from '../lib/format'
import {
  createDebouncedSaver,
  defaultSpzKey,
  sortSpzKeys,
  type DebouncedSaver,
  type SaverState,
} from '../lib/placementSaver'
import { useSession } from '../lib/session'
import { useHealth } from '../lib/useHealth'
import { AppButton } from '../components/AppButton'
import { ChromeThumbnail, chrome } from '../components/AppChrome'
import { ErrorRow } from '../components/ErrorRow'
import { TopBar } from '../components/TopBar'
import { StudioCanvas, type StudioCanvasHandle } from '../viewer/StudioCanvas'
import type { RenderHandle } from '../viewer/renderHandle'
import { ExportPanel } from '../export/ExportPanel'
import { AudioSection } from '../audio/AudioSection'
import { useShotAudio } from '../audio/useShotAudio'

export function ProjectScreen({ id }: { id: string }) {
  const [project, setProject] = useState<Project | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [presets, setPresets] = useState<WorldPreset[] | null>(null)
  const [presetsError, setPresetsError] = useState<string | null>(null)
  // Local placement is the source of truth while editing; the server copy trails it.
  const [placement, setPlacement] = useState<Placement | null>(null)
  // Same for the camera shot. Both go through ONE scene saver, and every save carries the
  // newest placement AND shot, so a placement save can never revert a shot edit (or vice versa).
  const [shot, setShot] = useState<CameraShot | null>(null)
  const placementRef = useRef<Placement | null>(null)
  placementRef.current = placement
  const shotRef = useRef<CameraShot | null>(null)
  shotRef.current = shot
  // The soundtrack rides the same scene saver: every save carries placement, shot AND audio.
  const [audio, setAudio] = useState<AudioTrack | null>(null)
  const audioRef = useRef<AudioTrack | null>(null)
  audioRef.current = audio
  // Look settings: same saver, same rule.
  const [look, setLook] = useState<SceneLook | null>(null)
  const lookRef = useRef<SceneLook | null>(null)
  lookRef.current = look
  const [audioLibrary, setAudioLibrary] = useState<Asset[] | null>(null)
  const [audioLibraryError, setAudioLibraryError] = useState<string | null>(null)
  const canvasRef = useRef<StudioCanvasHandle | null>(null)
  // Offline renderer from the viewer, and the export frame aspect for its crop guide.
  const [renderHandle, setRenderHandle] = useState<RenderHandle | null>(null)
  const [frameAspect, setFrameAspect] = useState<number | null>(null)
  const onFrameAspectChange = useCallback((aspect: number | null) => setFrameAspect(aspect), [])
  const [saveState, setSaveState] = useState<SaverState>({ status: 'idle', error: null })
  const [viewerErrors, setViewerErrors] = useState<Record<string, string>>({})
  const splatQuality = useSession((s) => s.splatQuality)
  const setWorld = useSession((s) => s.setWorld)

  // Created in an effect (not useMemo) so StrictMode's mount/unmount/mount cycle gets a live saver.
  const saverRef = useRef<DebouncedSaver<ProjectScene> | null>(null)
  useEffect(() => {
    const saver = createDebouncedSaver<ProjectScene>({
      delayMs: 500,
      save: async (scene) => {
        const saved = await api.updateProject(id, { scene })
        // Keep the server's project record, but never overwrite the local placement with it.
        setProject(saved)
      },
      onState: setSaveState,
    })
    saverRef.current = saver
    return () => {
      // Leaving the screen: send any unsaved placement now rather than dropping it.
      saver.retry()
      saver.dispose()
      if (saverRef.current === saver) saverRef.current = null
    }
  }, [id])

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const loaded = await api.getProject(id)
      setProject(loaded)
      setPlacement(loaded.scene.placement)
      setShot(loaded.scene.shot ?? null)
      setAudio(loaded.scene.audio ?? null)
      setLook(loaded.scene.look ?? null)
    } catch (e) {
      setLoadError(errorMessage(e))
    }
  }, [id])

  const loadPresets = useCallback(async () => {
    setPresetsError(null)
    try {
      setPresets(await api.listPresets())
    } catch (e) {
      setPresetsError(errorMessage(e))
    }
  }, [])

  const loadAudioLibrary = useCallback(async () => {
    setAudioLibraryError(null)
    try {
      const list = await api.listAudio()
      setAudioLibrary(list)
      return list
    } catch (e) {
      setAudioLibraryError(errorMessage(e))
      throw e
    }
  }, [])

  useEffect(() => {
    setProject(null)
    void load()
    void loadPresets()
    loadAudioLibrary().catch(() => {})
  }, [load, loadPresets, loadAudioLibrary])

  const presetId = project?.scene.presetId ?? null
  const activePreset = presetId ? (presets?.find((p) => p.id === presetId) ?? null) : null
  // The server copies the preset default when a world is picked, so placement is normally set.
  const effectivePlacement = placement ?? activePreset?.defaultPlacement ?? null

  const presetIdRef = useRef(presetId)
  presetIdRef.current = presetId

  // Every save carries the newest placement, shot, audio AND look (refs are updated before this runs).
  const saveScene = useCallback(() => {
    saverRef.current?.update({
      presetId: presetIdRef.current,
      placement: placementRef.current,
      shot: shotRef.current,
      audio: audioRef.current,
      look: lookRef.current,
    })
  }, [])

  const changePlacement = useCallback(
    (next: Placement) => {
      setPlacement(next)
      placementRef.current = next
      saveScene()
    },
    [saveScene],
  )

  const changeShot = useCallback((next: CameraShot | null) => {
    setShot(next)
    shotRef.current = next
    saveScene()
  }, [saveScene])

  const changeAudio = useCallback((next: AudioTrack | null) => {
    setAudio(next)
    audioRef.current = next
    saveScene()
  }, [saveScene])

  const changeLook = useCallback((next: SceneLook | null) => {
    setLook(next)
    lookRef.current = next
    saveScene()
  }, [saveScene])

  const audioAsset = audio ? (audioLibrary?.find((a) => a.id === audio.assetId) ?? null) : null
  const shotAudio = useShotAudio(canvasRef, audio, audioAsset?.url ?? null, shot?.durationSeconds ?? null)

  const resetPlacement = useCallback(() => {
    if (activePreset) changePlacement(activePreset.defaultPlacement)
  }, [activePreset, changePlacement])

  const selectPreset = async (nextPresetId: string) => {
    // The old world's unsaved placement does not apply to the new world; wait out any
    // in-flight save so it cannot land after (and revert) the world change.
    const saver = saverRef.current
    saver?.discard()
    await saver?.whenIdle()
    const saved = await api.updateProject(id, { scene: { presetId: nextPresetId, placement: null } })
    setProject(saved)
    setPlacement(saved.scene.placement)
    setShot(saved.scene.shot ?? null)
    setAudio(saved.scene.audio ?? null)
    setLook(saved.scene.look ?? null)
    setSaveState({ status: 'idle', error: null })
  }

  const onPresetSaved = (preset: WorldPreset) =>
    setPresets((prev) => (prev ? prev.map((p) => (p.id === preset.id ? preset : p)) : prev))

  useEffect(() => {
    setWorld(project ? { project, preset: activePreset, placement: effectivePlacement, viewerErrors } : null)
  }, [project, activePreset, effectivePlacement, viewerErrors, setWorld])
  useEffect(() => () => setWorld(null), [setWorld])

  const spzKeys = activePreset ? sortSpzKeys(Object.keys(activePreset.files.spz)) : []
  const chosenKey = activePreset ? splatQuality[activePreset.id] : undefined
  const qualityKey = chosenKey && spzKeys.includes(chosenKey) ? chosenKey : defaultSpzKey(spzKeys)

  const onViewerError = useCallback((source: string, error: Error) => {
    setViewerErrors((prev) => ({ ...prev, [source]: error.message }))
  }, [])
  const splatUrl = qualityKey ? activePreset?.files.spz[qualityKey]?.url : undefined
  const watchUrl = project?.watchAsset?.url
  // The viewer clears its own errors when its inputs change; mirror that for the debug panel.
  useEffect(() => setViewerErrors({}), [splatUrl, watchUrl, activePreset?.id])

  return (
    <div className="flex h-full w-full flex-col gap-2 overflow-y-auto p-4 text-white md:flex-row md:overflow-hidden">
      <aside className="flex w-full flex-shrink-0 flex-col gap-1 text-sm md:w-72 md:overflow-y-auto [&>*]:flex-shrink-0">
        <TopBar trail={project?.name ?? id} />
        {loadError ? (
          <div className={`${chrome.panel} ${chrome.enter} flex flex-col gap-1 p-1.5`}>
            <ErrorRow message={loadError} />
            <div className="flex gap-1">
              <AppButton onClick={() => void load()} className="text-white">Retry</AppButton>
              <Link href="/" className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs opacity-80 hover:bg-white/10 hover:opacity-100">
                <ArrowLeft size={12} /> Projects
              </Link>
            </div>
          </div>
        ) : !project ? (
          <p className="px-2 py-1 text-xs text-white/55">Loading…</p>
        ) : (
          <>
            <WatchSection project={project} onProject={setProject} />
            <WorldSection
              presets={presets}
              presetsError={presetsError}
              onReloadPresets={() => void loadPresets()}
              activePresetId={presetId}
              activePreset={activePreset}
              onSelectPreset={selectPreset}
              spzKeys={spzKeys}
              qualityKey={qualityKey}
              placement={effectivePlacement}
              onResetPlacement={resetPlacement}
              onPresetSaved={onPresetSaved}
              saveState={saveState}
              onRetrySave={() => saverRef.current?.retry()}
            />
            <AudioSection
              library={audioLibrary}
              libraryError={audioLibraryError}
              onReloadLibrary={loadAudioLibrary}
              track={audio}
              onTrackChange={changeAudio}
              activePreset={activePreset}
              player={shotAudio}
              shotDuration={shot?.durationSeconds ?? null}
            />
            <ExportPanel
              projectId={id}
              shot={shot}
              handle={renderHandle}
              onFrameAspectChange={onFrameAspectChange}
              audioTrack={audio}
              audioAsset={audioAsset}
            />
          </>
        )}
      </aside>

      <div
        data-slot="viewer"
        className={`${chrome.panel} relative flex min-h-[50vh] flex-1 items-center justify-center overflow-hidden md:min-h-0`}
      >
        <ViewerSlot
          project={project}
          presets={presets}
          presetsError={presetsError}
          activePreset={activePreset}
          qualityKey={qualityKey}
          placement={effectivePlacement}
          onPlacementChange={changePlacement}
          onResetPlacement={resetPlacement}
          shot={shot}
          onShotChange={changeShot}
          onRenderHandle={setRenderHandle}
          frameAspect={frameAspect}
          onError={onViewerError}
          canvasRef={canvasRef}
          look={look}
          onLookChange={changeLook}
        />
      </div>
    </div>
  )
}

function ViewerSlot({
  project,
  presets,
  presetsError,
  activePreset,
  qualityKey,
  placement,
  onPlacementChange,
  onResetPlacement,
  shot,
  onShotChange,
  onRenderHandle,
  frameAspect,
  onError,
  canvasRef,
  look,
  onLookChange,
}: {
  project: Project | null
  presets: WorldPreset[] | null
  presetsError: string | null
  activePreset: WorldPreset | null
  qualityKey: string | null
  placement: Placement | null
  onPlacementChange: (p: Placement) => void
  onResetPlacement: () => void
  shot: CameraShot | null
  onShotChange: (shot: CameraShot | null) => void
  onRenderHandle: (handle: RenderHandle | null) => void
  frameAspect: number | null
  onError: (source: string, error: Error) => void
  canvasRef: RefObject<StudioCanvasHandle | null>
  look: SceneLook | null
  onLookChange: (look: SceneLook | null) => void
}) {
  if (!project) return null
  const presetId = project.scene.presetId
  const missing: string[] = []
  if (!project.watchAsset) missing.push('Add a watch')
  if (!presetId) missing.push('Pick a world')
  if (missing.length > 0) return <ViewerNote>{missing.join(' · ')}</ViewerNote>
  if (!activePreset) {
    if (presetsError) return <ViewerNote>World {presetId} could not be loaded: {presetsError}</ViewerNote>
    if (!presets) return <ViewerNote>Loading world…</ViewerNote>
    return <ViewerNote>World {presetId} is not in the library.</ViewerNote>
  }
  const spz = qualityKey ? activePreset.files.spz[qualityKey] : undefined
  if (!spz) return <ViewerNote>World “{activePreset.name}” has no splat file.</ViewerNote>
  if (!placement) return <ViewerNote>World “{activePreset.name}” has no placement.</ViewerNote>

  return (
    <div className="absolute inset-0">
      <StudioCanvas
        splatUrl={spz.url}
        watchUrl={project.watchAsset!.url}
        environmentUrl={activePreset.files.pano?.url}
        colliderUrl={activePreset.files.collider?.url}
        placement={placement}
        editable={true}
        onPlacementChange={onPlacementChange}
        onResetPlacement={onResetPlacement}
        shot={shot}
        onShotChange={onShotChange}
        onRenderHandle={onRenderHandle}
        frameAspect={frameAspect}
        onError={onError}
        ref={canvasRef}
        look={look}
        onLookChange={onLookChange}
      />
    </div>
  )
}

function ViewerNote({ children }: { children: ReactNode }) {
  return <span className="px-4 text-center text-xs text-white/45">{children}</span>
}

function WorldSection({
  presets,
  presetsError,
  onReloadPresets,
  activePresetId,
  activePreset,
  onSelectPreset,
  spzKeys,
  qualityKey,
  placement,
  onResetPlacement,
  onPresetSaved,
  saveState,
  onRetrySave,
}: {
  presets: WorldPreset[] | null
  presetsError: string | null
  onReloadPresets: () => void
  activePresetId: string | null
  activePreset: WorldPreset | null
  onSelectPreset: (id: string) => Promise<void>
  spzKeys: string[]
  qualityKey: string | null
  placement: Placement | null
  onResetPlacement: () => void
  onPresetSaved: (preset: WorldPreset) => void
  saveState: SaverState
  onRetrySave: () => void
}) {
  const setSplatQuality = useSession((s) => s.setSplatQuality)
  const [selecting, setSelecting] = useState<string | null>(null)
  const [selectError, setSelectError] = useState<string | null>(null)
  const [savingDefault, setSavingDefault] = useState(false)
  const [defaultError, setDefaultError] = useState<string | null>(null)
  const [defaultSavedFor, setDefaultSavedFor] = useState<Placement | null>(null)

  const select = async (id: string) => {
    if (id === activePresetId || selecting) return
    setSelecting(id)
    setSelectError(null)
    try {
      await onSelectPreset(id)
    } catch (e) {
      setSelectError(`Could not switch world: ${errorMessage(e)}`)
    } finally {
      setSelecting(null)
    }
  }

  const saveAsDefault = async () => {
    if (!activePreset || !placement) return
    setSavingDefault(true)
    setDefaultError(null)
    try {
      onPresetSaved(await api.updatePreset(activePreset.id, { defaultPlacement: placement }))
      setDefaultSavedFor(placement)
    } catch (e) {
      setDefaultError(`Could not save default placement: ${errorMessage(e)}`)
    } finally {
      setSavingDefault(false)
    }
  }

  return (
    <div className={`${chrome.panel} ${chrome.enter} flex flex-col overflow-hidden`}>
      <div className={chrome.sectionHeader}>
        <span>World</span>
        {selecting && <span className="text-white/35">Switching…</span>}
      </div>
      <div className="flex flex-col gap-1 p-1.5">
        {presetsError ? (
          <>
            <ErrorRow message={`Could not load worlds: ${presetsError}`} />
            <AppButton onClick={onReloadPresets} className="gap-1 self-start text-white">
              <ArrowClockwise size={12} weight="bold" />
              <span>Retry</span>
            </AppButton>
          </>
        ) : !presets ? (
          <p className="px-2 py-1 text-xs text-white/55">Loading worlds…</p>
        ) : presets.length === 0 ? (
          <p className="px-2 py-1 text-xs text-white/55">
            No worlds yet. Generated worlds are saved here so they never need to be generated again.
          </p>
        ) : (
          <div className="flex flex-col">
            {presets.map((preset) => {
              const active = preset.id === activePresetId
              const keys = sortSpzKeys(Object.keys(preset.files.spz))
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => void select(preset.id)}
                  disabled={selecting !== null}
                  aria-pressed={active}
                  className={`${chrome.row} ${active ? chrome.rowActive : chrome.rowIdle} min-w-0 gap-2 px-1 py-1 text-left disabled:pointer-events-none`}
                >
                  <ChromeThumbnail thumbnailUrl={preset.files.thumbnail?.url} alt={preset.name} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-xs font-medium leading-tight text-white/90">{preset.name}</span>
                    <span className="truncate text-xs leading-tight text-white/45">
                      {preset.templateId ?? 'custom'} · {keys.length > 0 ? keys.join(' / ') : 'no splat'}
                    </span>
                  </span>
                  {active && <span className="flex-shrink-0 pr-1 text-xs text-white/55">Active</span>}
                </button>
              )
            })}
          </div>
        )}
        {selectError && <ErrorRow message={selectError} onDismiss={() => setSelectError(null)} />}

        {activePreset && (
          <div className="mt-1 flex flex-col gap-1 border-t border-white/10 pt-1.5">
            {spzKeys.length > 1 && (
              <div className="flex flex-wrap items-center gap-1 px-1">
                <span className="mr-1 text-xs text-white/45">Splat quality</span>
                {spzKeys.map((key) => (
                  <AppButton
                    key={key}
                    onClick={() => setSplatQuality(activePreset.id, key)}
                    active={key === qualityKey}
                    className={`font-mono text-white ${key === qualityKey ? 'bg-white/15' : ''}`}
                  >
                    {key}
                  </AppButton>
                ))}
              </div>
            )}
            {spzKeys.length === 1 && (
              <p className="px-1 text-xs text-white/45">
                Splat quality <span className="font-mono text-white/70">{spzKeys[0]}</span> (only one available)
              </p>
            )}

            <AppButton onClick={onResetPlacement} disabled={!placement} className="text-white disabled:pointer-events-none disabled:opacity-40">
              Reset to world default
            </AppButton>
            <AppButton
              onClick={() => void saveAsDefault()}
              disabled={!placement || savingDefault}
              className="text-white disabled:pointer-events-none disabled:opacity-40"
            >
              {savingDefault ? 'Saving default…' : 'Save placement as this world’s default'}
            </AppButton>
            {defaultSavedFor && JSON.stringify(defaultSavedFor) === JSON.stringify(placement) && !savingDefault && (
              <p className="px-2 text-xs text-white/55">Saved as the default for “{activePreset.name}”.</p>
            )}
            {defaultError && <ErrorRow message={defaultError} onDismiss={() => setDefaultError(null)} />}

            <PlacementStatus state={saveState} onRetry={onRetrySave} />
          </div>
        )}
      </div>
    </div>
  )
}

function PlacementStatus({ state, onRetry }: { state: SaverState; onRetry: () => void }) {
  if (state.status === 'error') {
    return (
      <div className="flex flex-col gap-1">
        <ErrorRow message={`Placement not saved: ${state.error ?? 'unknown error'}`} />
        <AppButton onClick={onRetry} className="gap-1 self-start text-white">
          <ArrowClockwise size={12} weight="bold" />
          <span>Retry</span>
        </AppButton>
      </div>
    )
  }
  if (state.status === 'idle') return null
  return (
    <p className="px-2 text-xs text-white/45">
      Placement · {state.status === 'saved' ? 'Saved' : 'Saving…'}
    </p>
  )
}

function WatchSection({ project, onProject }: { project: Project; onProject: (p: Project) => void }) {
  const { health, error: healthError } = useHealth()
  const [busy, setBusy] = useState<'upload' | 'sample' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const asset = project.watchAsset

  const upload = async (file: File) => {
    setBusy('upload')
    setError(null)
    try {
      onProject(await api.uploadWatch(project.id, file))
    } catch (e) {
      setError(`Upload of ${file.name} failed: ${errorMessage(e)}`)
    } finally {
      setBusy(null)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const applySample = async () => {
    setBusy('sample')
    setError(null)
    try {
      onProject(await api.useSampleWatch(project.id))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    const files = event.dataTransfer.files
    if (files.length !== 1) {
      setError(`Drop exactly one .glb file (got ${files.length}).`)
      return
    }
    void upload(files[0])
  }

  return (
    <div className={`${chrome.panel} ${chrome.enter} flex flex-col overflow-hidden`}>
      <div className={chrome.sectionHeader}>
        <span>Watch</span>
        {busy && <span className="text-white/35">{busy === 'upload' ? 'Uploading…' : 'Copying sample…'}</span>}
      </div>
      <div className="flex flex-col gap-1 p-1.5">
        {asset ? (
          <div className="flex min-w-0 items-center gap-2 px-1 py-1">
            <ChromeThumbnail alt={asset.filename} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-xs font-medium leading-tight text-white/90">{asset.filename}</span>
              <span className="truncate text-xs leading-tight text-white/45">{formatBytes(asset.bytes)}</span>
              <a
                href={asset.url}
                target="_blank"
                rel="noreferrer"
                className="truncate font-mono text-[11px] leading-tight text-white/45 hover:text-white/80"
                title={asset.url}
              >
                {asset.url}
              </a>
            </span>
          </div>
        ) : (
          <p className="px-2 py-1 text-xs text-white/55">No watch model yet.</p>
        )}

        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex flex-col items-center gap-1 rounded border border-dashed px-2 py-3 text-center text-xs transition-colors ${
            dragging ? 'border-white/50 bg-white/10 text-white' : 'border-white/15 text-white/55'
          }`}
        >
          <span>{asset ? 'Drop a .glb to replace' : 'Drop a .glb here'}</span>
          <AppButton
            onClick={() => inputRef.current?.click()}
            disabled={busy !== null}
            className="gap-1 border border-white/20 text-white disabled:pointer-events-none disabled:opacity-40"
          >
            <UploadSimple size={14} weight="bold" />
            <span>Choose file</span>
          </AppButton>
          <input
            ref={inputRef}
            type="file"
            accept=".glb,model/gltf-binary"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void upload(file)
            }}
          />
        </div>

        {health?.sampleWatchAvailable && (
          <AppButton
            onClick={() => void applySample()}
            disabled={busy !== null}
            className="gap-1 text-white disabled:pointer-events-none disabled:opacity-40"
          >
            <Watch size={14} weight="regular" />
            <span>Use sample watch (Casio)</span>
          </AppButton>
        )}

        {healthError && <ErrorRow message={`Health check failed: ${healthError}`} />}
        {error && <ErrorRow message={error} onDismiss={() => setError(null)} />}
      </div>
    </div>
  )
}
