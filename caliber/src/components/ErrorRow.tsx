import { WarningCircle, X } from '@phosphor-icons/react'
import { twMerge } from 'tailwind-merge'
import { AppButton } from './AppButton'

// The real error message, verbatim, in the chrome style.
export function ErrorRow({
  message,
  onDismiss,
  className = '',
}: {
  message: string
  onDismiss?: () => void
  className?: string
}) {
  return (
    <div
      role="alert"
      className={twMerge(
        'flex items-start gap-2 rounded border border-white/15 bg-white/5 px-2 py-1.5 text-xs text-red-200',
        className,
      )}
    >
      <WarningCircle size={14} weight="fill" className="mt-px flex-shrink-0 text-red-300" />
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{message}</span>
      {onDismiss && (
        <AppButton onClick={onDismiss} className="-my-0.5 h-5 w-5 justify-center p-0 text-red-200" aria-label="Dismiss error">
          <X size={12} weight="bold" />
        </AppButton>
      )}
    </div>
  )
}
