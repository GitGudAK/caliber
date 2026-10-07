import type { ReactNode } from 'react'
import { ArrowCounterClockwise, ArrowLineDown, ArrowsClockwise, ArrowsOutCardinal } from '@phosphor-icons/react'
import { twMerge } from 'tailwind-merge'
import { chrome } from '../components/AppChrome'
import type { SceneLook } from '../../shared/types'
import { MAX_GRAIN } from './look'

export type GizmoMode = 'translate' | 'rotate'

export interface PlacementToolbarProps {
  mode: GizmoMode
  onModeChange: (mode: GizmoMode) => void
  onDrop: () => void
  /** When set, Drop is disabled and this explains why. */
  dropUnavailable?: string
  /** Result of the last action (e.g. a raycast miss), shown under the buttons. */
  message?: { tone: 'info' | 'error'; text: string } | null
  onReset?: () => void
  watchSize: number
  onWatchSizeChange: (v: number) => void
  worldScale: number
  onWorldScaleChange: (v: number) => void
  /** Look controls; the section is hidden when not provided. */
  look?: SceneLook
  onLookChange?: (look: SceneLook) => void
  /** Measured tilt of the surface under the watch, degrees (null = not measured). */
  tiltDeg?: number | null
  tiltDetail?: string
  /** World currently has a levelling tilt. */
  levelled?: boolean
  /** Undefined = unavailable (no collider); the reason is shown by dropUnavailable. */
  onLevel?: () => void
  onResetLevel?: () => void
}

function ToolButton({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active?: boolean
  disabled?: boolean
  title: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={twMerge(
        chrome.row,
        'h-7 px-2 text-xs text-white',
        active ? chrome.rowActive : chrome.rowIdle,
        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:opacity-40',
      )}
    >
      {children}
    </button>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  digits,
  unit,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  digits: number
  unit?: string
  onChange: (v: number) => void
}) {
  return (
    <label className="flex flex-col gap-1 px-2 py-1 text-xs text-white/80">
      <span className="flex items-center justify-between">
        <span className="text-white/55">{label}</span>
        <span className="font-mono tabular-nums text-white">
          {value.toFixed(digits)}
          {unit}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-white"
      />
    </label>
  )
}

/** Watch placement controls, rendered top-right over the canvas when the viewer is editable. */
export function PlacementToolbar({
  mode,
  onModeChange,
  onDrop,
  dropUnavailable,
  message,
  onReset,
  watchSize,
  onWatchSizeChange,
  worldScale,
  onWorldScaleChange,
  look,
  onLookChange,
  tiltDeg,
  tiltDetail,
  levelled,
  onLevel,
  onResetLevel,
}: PlacementToolbarProps) {
  return (
    <div
      className={twMerge(chrome.panel, 'absolute right-3 top-3 z-20 flex w-60 flex-col text-xs text-white')}
      data-testid="placement-toolbar"
    >
      <div className={chrome.sectionHeader}>
        <span>Placement</span>
        <span className="text-white/40">W move · E rotate</span>
      </div>
      <div className="flex flex-wrap items-center gap-1 p-1">
        <ToolButton active={mode === 'translate'} title="Move (W)" onClick={() => onModeChange('translate')}>
          <ArrowsOutCardinal size={14} /> Move
        </ToolButton>
        <ToolButton active={mode === 'rotate'} title="Rotate (E)" onClick={() => onModeChange('rotate')}>
          <ArrowsClockwise size={14} /> Rotate
        </ToolButton>
        <ToolButton
          title={dropUnavailable ?? 'Drop the watch straight down onto the surface below it'}
          disabled={!!dropUnavailable}
          onClick={onDrop}
        >
          <ArrowLineDown size={14} /> Drop
        </ToolButton>
        <ToolButton
          title={onReset ? 'Reset placement' : 'Reset is not available here'}
          disabled={!onReset}
          onClick={() => onReset?.()}
        >
          <ArrowCounterClockwise size={14} /> Reset
        </ToolButton>
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t border-white/10 p-1">
        <ToolButton title={onLevel ? 'Tilt the world so the surface under the watch is horizontal' : (dropUnavailable ?? '')} disabled={!onLevel} onClick={() => onLevel?.()}>
          Level surface
        </ToolButton>
        <ToolButton title="Remove the levelling tilt" disabled={!onResetLevel || !levelled} onClick={() => onResetLevel?.()}>
          Reset level
        </ToolButton>
        <span className="ml-auto px-1 font-mono tabular-nums text-white/80" title={tiltDetail} data-testid="surface-tilt">
          {tiltDeg === null || tiltDeg === undefined ? 'tilt –' : `tilt ${tiltDeg.toFixed(2)}°`}
        </span>
      </div>
      {(dropUnavailable || message) && (
        <div className="flex flex-col gap-1 border-t border-white/10 px-2 py-1">
          {dropUnavailable && <div className="text-white/55">{dropUnavailable}</div>}
          {message && (
            <div role={message.tone === 'error' ? 'alert' : 'status'} className={message.tone === 'error' ? 'text-red-300' : 'text-white/80'}>
              {message.text}
            </div>
          )}
        </div>
      )}
      <div className="border-t border-white/10 py-1">
        <Slider
          label="Watch size"
          value={watchSize}
          min={0.03}
          max={0.12}
          step={0.001}
          digits={3}
          unit=" m"
          onChange={onWatchSizeChange}
        />
        <Slider
          label="World scale"
          value={worldScale}
          min={0.02}
          max={0.2}
          step={0.001}
          digits={3}
          unit="×"
          onChange={onWorldScaleChange}
        />
      </div>
      {look && onLookChange && (
        <>
          <div className={twMerge(chrome.sectionHeader, 'border-t')}>
            <span>Look</span>
          </div>
          <div className="flex flex-wrap items-center gap-1 p-1">
            <ToolButton active={look.shadows} title="Key-light shadow on the surface" onClick={() => onLookChange({ ...look, shadows: !look.shadows })}>
              Shadows {look.shadows ? 'on' : 'off'}
            </ToolButton>
            <ToolButton active={look.contact} title="Soft contact shadow where the watch touches the surface" onClick={() => onLookChange({ ...look, contact: !look.contact })}>
              Contact {look.contact ? 'on' : 'off'}
            </ToolButton>
          </div>
          <div className="pb-1">
            {look.shadows && (
              <Slider
                label="Shadow opacity"
                value={look.shadowOpacity}
                min={0}
                max={1}
                step={0.01}
                digits={2}
                onChange={(shadowOpacity) => onLookChange({ ...look, shadowOpacity })}
              />
            )}
            <Slider label="Grain" value={look.grain} min={0} max={MAX_GRAIN} step={0.001} digits={3} onChange={(grain) => onLookChange({ ...look, grain })} />
          </div>
        </>
      )}
    </div>
  )
}
