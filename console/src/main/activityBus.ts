import { EventEmitter } from 'node:events'
import type { ActivityEvent, ActivityRun } from '../shared/types'

const MAX_RUNS = 300
const MAX_OUTPUT_CHARS = 200_000 // per-run tail cap

/**
 * A process-local event bus for tool activity. Pure Node (no Electron import) so
 * the MCP server and tool runner can depend on it; the main process subscribes and
 * forwards events to the renderer (live viewer) over IPC.
 */
class ActivityBus extends EventEmitter {
  private runs = new Map<string, ActivityRun>()
  private order: string[] = []

  publish(ev: ActivityEvent): void {
    this.apply(ev)
    this.emit('activity', ev)
  }

  private apply(ev: ActivityEvent): void {
    if (ev.kind === 'run-started') {
      this.runs.set(ev.run.runId, { ...ev.run })
      this.order.push(ev.run.runId)
      this.trim()
    } else if (ev.kind === 'run-output') {
      const run = this.runs.get(ev.runId)
      if (run) {
        run.output += ev.chunk
        if (run.output.length > MAX_OUTPUT_CHARS) {
          run.output = run.output.slice(run.output.length - MAX_OUTPUT_CHARS)
        }
      }
    } else if (ev.kind === 'run-finished') {
      const run = this.runs.get(ev.runId)
      if (run) {
        run.status = ev.status
        run.exitCode = ev.exitCode
        run.finishedAt = ev.finishedAt
      }
    }
  }

  private trim(): void {
    while (this.order.length > MAX_RUNS) {
      const id = this.order.shift()
      if (id) this.runs.delete(id)
    }
  }

  /** Snapshot of known runs, oldest-first — used to hydrate a freshly opened viewer. */
  snapshot(): ActivityRun[] {
    return this.order.map((id) => this.runs.get(id)).filter((r): r is ActivityRun => !!r)
  }

  get(runId: string): ActivityRun | undefined {
    return this.runs.get(runId)
  }

  clear(): void {
    this.runs.clear()
    this.order = []
  }
}

export const activityBus = new ActivityBus()
