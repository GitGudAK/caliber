// Spark re-sorts splats only when the camera moved > 1 mm or turned > ~2.5 degrees since the
// last sort (hard-coded in SparkRenderer.updateInternal: `distanceTo(sortedCenter) > .001 ||
// dot(sortedDir) < .999`). At macro scale (a 6.5 cm watch, a world scaled to 0.06) a slow shot
// can stay under that for many frames and render a stale order. There is no option for the
// threshold, so we invalidate the last sorted viewpoint, which makes the next render's update
// see a view change and re-sort for the current camera.

import type { SparkRenderer } from '@sparkjsdev/spark'

const FAR = 1e9

/** Make the next render re-generate and re-sort for the current camera, regardless of how little it moved. */
export function forceResort(spark: SparkRenderer | null) {
  spark?.sortedCenter.set(FAR, FAR, FAR)
}

const SETTLE_TIMEOUT_MS = 5000
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Resolve once Spark has no update or sort pending, running or queued for the current view.
 * Call after a render: Spark schedules its update with setTimeout(1) from onBeforeRender.
 */
export async function settleSort(spark: SparkRenderer | null) {
  if (!spark) return
  await sleep(2)
  const deadline = performance.now() + SETTLE_TIMEOUT_MS
  while (spark.updateTimeoutId !== undefined || spark.sorting || spark.sortDirty || spark.sortTimeoutId !== undefined) {
    if (performance.now() > deadline) throw new Error(`Splat sort did not settle within ${SETTLE_TIMEOUT_MS / 1000}s`)
    await sleep(4)
  }
}
