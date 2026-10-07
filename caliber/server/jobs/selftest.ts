import type { JobRunner } from './runner.ts'

// A free diagnostic job: three timed steps, no network calls. Exists only to
// verify job progress and SSE end to end. Its result says so explicitly.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function registerSelftest(runner: JobRunner) {
  runner.register<unknown, { diagnostic: true; finishedAt: string }>('selftest', {
    steps: [
      { key: 'prepare', label: 'Prepare (diagnostic)' },
      { key: 'work', label: 'Work (diagnostic)' },
      { key: 'finish', label: 'Finish (diagnostic)' },
    ],
    async run(_input, ctx) {
      await ctx.step('prepare', async () => {
        ctx.detail('prepare', 'Self-test: no network calls, no cost')
        await sleep(800)
        ctx.progress(0.2)
      })
      await ctx.step('work', async () => {
        const ticks = 4
        for (let i = 1; i <= ticks; i++) {
          await sleep(600)
          ctx.detail('work', `Self-test tick ${i}/${ticks}`)
          ctx.progress(0.2 + (0.6 * i) / ticks)
        }
      })
      await ctx.step('finish', async () => {
        await sleep(800)
        ctx.detail('finish', 'Self-test complete')
        ctx.progress(1)
      })
      return { diagnostic: true, finishedAt: new Date().toISOString() }
    },
  })
}
