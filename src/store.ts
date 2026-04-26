/**
 * Read-side of the dev-log JSONL written by `@inariwatch/capture` when
 * INARIWATCH_DEV_LOG=1. Each line is a single ErrorEvent (payload v1 or
 * v2; we just hand back the parsed object). We tail-read because the file
 * grows without bound — the SDK does not rotate it (intentionally simple)
 * and the MCP tools only ever care about the most recent N events.
 *
 * Default location matches the SDK: ${cwd}/.inariwatch/errors.jsonl.
 * Override with INARIWATCH_DEV_LOG_PATH (same env var the SDK honors) so
 * a user that customises one side automatically gets the other.
 */

import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"

export interface DevLogEvent {
  fingerprint: string
  title: string
  body: string
  severity: "critical" | "warning" | "info"
  timestamp: string
  // We deliberately type the rest as `unknown` — different SDK versions
  // ship different fields, and the MCP server is just a relay to the
  // editor's LLM, which can read the raw JSON itself.
  [key: string]: unknown
}

export function resolveDevLogPath(): string {
  return process.env.INARIWATCH_DEV_LOG_PATH ?? join(process.cwd(), ".inariwatch", "errors.jsonl")
}

export interface ReadOptions {
  /** Max events to return, counting from the tail. Default 50, hard cap 500. */
  limit?: number
  /** Filter by severity. Default: all. */
  severity?: "critical" | "warning" | "info"
}

const HARD_CAP = 500

/**
 * Read the dev log and return the most recent events. Returns [] if the
 * file does not exist (= no errors yet, or capture not running with
 * INARIWATCH_DEV_LOG=1).
 *
 * Implementation note: we read the whole file. For dev-mode where the
 * file is bounded by the dev session length (~hours, ~MBs at worst),
 * this is simpler and faster than seeking from the tail. If the file
 * ever grows past 50MB we slice the read.
 */
export async function readEvents(opts: ReadOptions = {}): Promise<DevLogEvent[]> {
  const path = resolveDevLogPath()
  const limit = Math.min(opts.limit ?? 50, HARD_CAP)

  let buf: string
  try {
    const st = await stat(path)
    if (st.size > 50 * 1024 * 1024) {
      // Big-file path: read only the last ~5MB and toss the partial first
      // line. Enough to comfortably hold 500 events.
      const fh = await import("node:fs/promises").then((m) => m.open(path, "r"))
      try {
        const len = Math.min(5 * 1024 * 1024, st.size)
        const buffer = Buffer.alloc(len)
        await fh.read(buffer, 0, len, st.size - len)
        buf = buffer.toString("utf8")
        const firstNl = buf.indexOf("\n")
        if (firstNl !== -1) buf = buf.slice(firstNl + 1)
      } finally {
        await fh.close()
      }
    } else {
      buf = await readFile(path, "utf8")
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }

  const lines = buf.split("\n")
  const out: DevLogEvent[] = []
  // Walk from the end so we can stop early once we have `limit` matches.
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const raw = lines[i]
    if (!raw || !raw.trim()) continue
    try {
      const evt = JSON.parse(raw) as DevLogEvent
      if (opts.severity && evt.severity !== opts.severity) continue
      out.push(evt)
    } catch {
      // Skip corrupted line — likely a partial write while the SDK was
      // appending. JSONL tolerates this naturally.
    }
  }
  return out
}

/**
 * Find one event by fingerprint (= the id surfaced by `get_recent_errors`).
 * Returns the most recent event matching that fingerprint, or null.
 */
export async function findEventByFingerprint(fingerprint: string): Promise<DevLogEvent | null> {
  const all = await readEvents({ limit: HARD_CAP })
  return all.find((e) => e.fingerprint === fingerprint) ?? null
}
