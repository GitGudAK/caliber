export interface RenderHandle {
  canvas: HTMLCanvasElement
  /** Switch to offline export: stop the rAF loop, set drawing buffer to width x height at pixel ratio 1, camera aspect = width/height. */
  beginExport(width: number, height: number): Promise<void>
  /** Render the frame for shot time t exactly: camera from sampleShot, DOF applied, splat sort settled for this camera (render, await Spark's sort, render again if needed). When it resolves, the canvas holds that frame. */
  renderAt(t: number): Promise<void>
  /** Restore interactive size, pixel ratio, aspect and the rAF loop. */
  endExport(): void
}
