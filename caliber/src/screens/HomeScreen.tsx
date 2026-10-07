import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation } from 'wouter'
import { Plus, Trash } from '@phosphor-icons/react'
import type { Project } from '../../shared/types'
import { api, errorMessage } from '../lib/api'
import { formatTime } from '../lib/format'
import { AppButton } from '../components/AppButton'
import { ChromeThumbnail, chrome } from '../components/AppChrome'
import { ErrorRow } from '../components/ErrorRow'
import { TopBar } from '../components/TopBar'

export function HomeScreen() {
  const [, navigate] = useLocation()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setProjects(await api.listProjects())
      setLoadError(null)
    } catch (e) {
      setLoadError(errorMessage(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const create = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || creating) return
    setCreating(true)
    setActionError(null)
    try {
      const project = await api.createProject(trimmed)
      setName('')
      navigate(`/p/${project.id}`)
    } catch (e) {
      setActionError(errorMessage(e))
    } finally {
      setCreating(false)
    }
  }

  const remove = async (project: Project) => {
    if (!window.confirm(`Delete project "${project.name}" and its files?`)) return
    setDeletingId(project.id)
    setActionError(null)
    try {
      await api.deleteProject(project.id)
      setProjects((list) => list?.filter((p) => p.id !== project.id) ?? list)
    } catch (e) {
      setActionError(errorMessage(e))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="h-full w-full overflow-y-auto text-white">
      <div className="mx-auto flex w-full max-w-md flex-col gap-1 p-4 text-sm">
        <TopBar />

        <form onSubmit={create} className={`${chrome.bar} ${chrome.enter} flex items-center gap-1`}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New project name"
            aria-label="New project name"
            className="h-7 min-w-0 flex-1 rounded bg-transparent px-2 text-xs text-white outline-none placeholder:text-white/35 focus:bg-white/5"
          />
          <AppButton
            type="submit"
            disabled={!name.trim() || creating}
            className="h-7 flex-shrink-0 gap-1 border border-white/20 text-white disabled:pointer-events-none disabled:opacity-40"
          >
            <Plus size={14} weight="bold" />
            <span>{creating ? 'Creating…' : 'Create'}</span>
          </AppButton>
        </form>

        {actionError && <ErrorRow message={actionError} onDismiss={() => setActionError(null)} />}

        <div className={`${chrome.panel} ${chrome.enter} flex flex-col overflow-hidden`}>
          <div className={chrome.sectionHeader}>
            <span>Projects</span>
            {projects && <span className="text-white/35">{projects.length}</span>}
          </div>
          <div className="flex flex-col p-1.5">
            {loadError ? (
              <div className="flex flex-col gap-1">
                <ErrorRow message={loadError} />
                <AppButton onClick={() => void load()} className="self-start text-white">
                  Retry
                </AppButton>
              </div>
            ) : projects === null ? (
              <p className="px-2 py-1 text-xs text-white/55">Loading…</p>
            ) : projects.length === 0 ? (
              <p className="px-2 py-1 text-xs text-white/55">No projects yet. Create one above.</p>
            ) : (
              projects.map((project) => (
                <div key={project.id} className={`${chrome.row} ${chrome.rowIdle} pr-1`}>
                  <Link href={`/p/${project.id}`} className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1">
                    <ChromeThumbnail alt={`${project.name} watch`} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium leading-tight text-white">{project.name}</span>
                      <span className="truncate text-xs leading-tight text-white/45">
                        {project.watchAsset ? project.watchAsset.filename : 'No watch'} · {formatTime(project.updatedAt)}
                      </span>
                    </span>
                  </Link>
                  <AppButton
                    onClick={() => void remove(project)}
                    disabled={deletingId === project.id}
                    className="h-7 w-7 flex-shrink-0 justify-center p-1 text-white opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-80 hover:opacity-100 disabled:opacity-40"
                    aria-label={`Delete ${project.name}`}
                    title={`Delete ${project.name}`}
                  >
                    <Trash size={14} weight="regular" />
                  </AppButton>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
