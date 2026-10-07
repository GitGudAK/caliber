import { useEffect, useState, type ReactNode } from 'react'
import { useLocation, useRoute } from 'wouter'
import { ArrowClockwise, Play, X } from '@phosphor-icons/react'
import type { JobStatus, StepStatus } from '../../shared/types'
import { api, errorMessage } from '../lib/api'
import { useHealth } from '../lib/useHealth'
import { useJob } from '../lib/useJob'
import { useSession } from '../lib/session'
import { AppButton } from './AppButton'
import { chrome } from './AppChrome'
import { ErrorRow } from './ErrorRow'

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

// Backtick toggles the panel; ignored while typing in a field.
export function DebugHotkey() {
  const toggleDebug = useSession((s) => s.toggleDebug)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '`' || event.metaKey || event.ctrlKey || event.altKey) return
      if (isEditableTarget(event.target)) return
      event.preventDefault()
      toggleDebug()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleDebug])
  return null
}

export function DebugPanel() {
  const open = useSession((s) => s.debugOpen)
  const toggleDebug = useSession((s) => s.toggleDebug)
  if (!open) return null
  return (
    <aside
      className={`${chrome.panel} ${chrome.enter} fixed right-4 top-4 z-50 flex max-h-[calc(100vh-2rem)] w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden text-xs text-white`}
    >
      <div className="flex flex-shrink-0 items-center justify-between px-2 py-1 font-mono text-sm font-medium">
        <span>debug</span>
        <AppButton onClick={toggleDebug} className="h-6 w-6 justify-center p-1 text-white" aria-label="Close debug panel" title="Close (`)">
          <X size={14} weight="bold" />
        </AppButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <HealthSection />
        <RouteSection />
        <WorldSection />
        <SelftestSection />
      </div>
    </aside>
  )
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-white/10">
      <div className={chrome.sectionHeader}>
        <span>{title}</span>
        {aside}
      </div>
      <div className="flex flex-col gap-1 px-2 py-1.5">{children}</div>
    </section>
  )
}

function KV({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="w-20 flex-shrink-0 text-white/45">{k}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-white/85">{children}</span>
    </div>
  )
}

function Bool({ value }: { value: boolean }) {
  return <span className={value ? 'text-green-300' : 'text-white/45'}>{value ? 'yes' : 'no'}</span>
}

function HealthSection() {
  const { health, error, loading, refresh } = useHealth()
  return (
    <Section
      title="Server"
      aside={
        <AppButton onClick={() => void refresh()} className="h-5 w-5 justify-center p-0 text-white" aria-label="Refresh health" title="Refresh">
          <ArrowClockwise size={12} weight="bold" />
        </AppButton>
      }
    >
      {loading && !health && !error ? (
        <span className="text-white/55">Loading…</span>
      ) : error ? (
        <ErrorRow message={error} />
      ) : health ? (
        <>
          <KV k="reachable"><Bool value /></KV>
          <KV k="worldlabs key"><Bool value={health.keys.worldlabs} /></KV>
          <KV k="fal key"><Bool value={health.keys.fal} /></KV>
          <KV k="sample watch"><Bool value={health.sampleWatchAvailable} /></KV>
        </>
      ) : null}
    </Section>
  )
}

function RouteSection() {
  const [location] = useLocation()
  const [, params] = useRoute<{ id: string }>('/p/:id')
  return (
    <Section title="Route">
      <KV k="path">{location}</KV>
      <KV k="project id">{params?.id ?? <span className="text-white/45">none</span>}</KV>
    </Section>
  )
}

function WorldSection() {
  const world = useSession((s) => s.world)
  if (!world) {
    return (
      <Section title="World">
        <span className="text-white/45">No project open.</span>
      </Section>
    )
  }
  const { project, preset, placement, viewerErrors } = world
  const files: [string, string][] = preset
    ? [
        ...Object.entries(preset.files.spz).map(([key, asset]): [string, string] => [`spz ${key}`, asset.url]),
        ['collider', preset.files.collider?.url ?? ''],
        ['pano', preset.files.pano?.url ?? ''],
        ['thumbnail', preset.files.thumbnail?.url ?? ''],
        ['scene image', preset.files.sceneImage?.url ?? ''],
        ['world json', preset.files.worldJson?.url ?? ''],
      ]
    : []
  return (
    <Section title="World">
      <KV k="preset id">{project.scene.presetId ?? <span className="text-white/45">none</span>}</KV>
      {project.scene.presetId && !preset && <span className="text-white/45">Preset not loaded.</span>}
      {preset && (
        <>
          <KV k="name">{preset.name}</KV>
          <KV k="template">{preset.templateId ?? <span className="text-white/45">none</span>}</KV>
          {files.map(([k, url]) => (
            <KV key={k} k={k}>
              {url ? (
                <a href={url} target="_blank" rel="noreferrer" className="hover:text-white">
                  {url}
                </a>
              ) : (
                <span className="text-white/45">missing</span>
              )}
            </KV>
          ))}
          <details>
            <summary className="cursor-pointer text-white/45">provenance</summary>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-white/85">
              {JSON.stringify(preset.provenance, null, 2)}
            </pre>
          </details>
        </>
      )}
      <details>
        <summary className="cursor-pointer text-white/45">placement{project.scene.placement ? '' : ' (not saved on project)'}</summary>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-white/85">
          {placement ? JSON.stringify(placement, null, 2) : 'null'}
        </pre>
      </details>
      {Object.entries(viewerErrors).map(([source, message]) => (
        <ErrorRow key={source} message={`viewer ${source}: ${message}`} />
      ))}
    </Section>
  )
}

const STATUS_CLASS: Record<JobStatus | StepStatus, string> = {
  queued: 'text-white/55',
  pending: 'text-white/45',
  running: 'text-yellow-300',
  succeeded: 'text-green-300',
  failed: 'text-red-300',
  skipped: 'text-white/35',
}

function SelftestSection() {
  const recentJobIds = useSession((s) => s.recentJobIds)
  const addJob = useSession((s) => s.addJob)
  const [, params] = useRoute<{ id: string }>('/p/:id')
  const [selectedId, setSelectedId] = useState<string | null>(recentJobIds[0] ?? null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const { job, error, transport } = useJob(selectedId)

  const run = async () => {
    setStarting(true)
    setStartError(null)
    try {
      const created = await api.startSelftest(params?.id)
      addJob(created.id)
      setSelectedId(created.id)
    } catch (e) {
      setStartError(errorMessage(e))
    } finally {
      setStarting(false)
    }
  }

  return (
    <Section title="Jobs">
      <AppButton
        onClick={() => void run()}
        disabled={starting}
        className="gap-1 self-start border border-white/20 text-white disabled:pointer-events-none disabled:opacity-40"
      >
        <Play size={12} weight="fill" />
        <span>{starting ? 'Starting…' : 'Run self-test job'}</span>
      </AppButton>
      {startError && <ErrorRow message={startError} />}

      {selectedId && (
        <div className="mt-1 flex flex-col gap-1 rounded border border-white/15 p-1.5">
          <KV k="job id">{selectedId}</KV>
          {!job && !error && <span className="text-white/55">Loading…</span>}
          {job && (
            <>
              <KV k="kind">{job.kind}</KV>
              <KV k="status"><span className={STATUS_CLASS[job.status]}>{job.status}</span></KV>
              <KV k="transport">{transport}</KV>
              <KV k="progress">{Math.round(job.progress * 100)}%</KV>
              <div className="h-1 overflow-hidden rounded bg-white/10">
                <div className="h-full bg-white/60 transition-[width]" style={{ width: `${Math.round(job.progress * 100)}%` }} />
              </div>
              <div className="flex flex-col">
                {job.steps.map((step) => (
                  <div key={step.key} className="flex min-w-0 items-baseline gap-2 py-0.5">
                    <span className={`w-16 flex-shrink-0 font-mono ${STATUS_CLASS[step.status]}`}>{step.status}</span>
                    <span className="min-w-0 flex-1">
                      <span className="text-white/85">{step.label}</span>
                      {step.detail && <span className="block break-words text-white/45">{step.detail}</span>}
                    </span>
                  </div>
                ))}
              </div>
              {job.error && <ErrorRow message={job.error} />}
            </>
          )}
          {!job && <KV k="transport">{transport}</KV>}
          {error && <ErrorRow message={error} />}
        </div>
      )}

      {recentJobIds.length > 0 && (
        <div className="mt-1 flex flex-col">
          <span className="px-0.5 text-white/45">Recent (this session)</span>
          {recentJobIds.map((id) => (
            <AppButton
              key={id}
              onClick={() => setSelectedId(id)}
              active={id === selectedId}
              className={`font-mono text-white ${id === selectedId ? 'bg-white/15' : ''}`}
            >
              {id}
            </AppButton>
          ))}
        </div>
      )}
    </Section>
  )
}
