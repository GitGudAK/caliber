import type { ReactNode } from 'react'
import { BugIcon } from '@phosphor-icons/react'
import { Link } from 'wouter'
import { useSession } from '../lib/session'
import { AppButton } from './AppButton'
import { chrome } from './AppChrome'

export function TopBar({ trail }: { trail?: ReactNode }) {
  const debugOpen = useSession((s) => s.debugOpen)
  const toggleDebug = useSession((s) => s.toggleDebug)
  return (
    <div className={`${chrome.bar} ${chrome.enter} flex flex-shrink-0 items-center justify-between px-2 py-1 text-sm font-medium font-mono`}>
      <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
        <Link href="/" className="text-white">caliber</Link>
        {trail && <span className="min-w-0 truncate text-white/40">/ {trail}</span>}
      </div>
      <AppButton
        onClick={toggleDebug}
        active={debugOpen}
        className={`h-7 w-7 justify-center p-1 text-white ${debugOpen ? 'bg-white/15' : ''}`}
        aria-label={debugOpen ? 'Hide debug panel' : 'Show debug panel'}
        aria-pressed={debugOpen}
        title="Debug panel (`)"
      >
        <BugIcon size={16} weight={debugOpen ? 'fill' : 'regular'} />
      </AppButton>
    </div>
  )
}
