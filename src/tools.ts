/**
 * The 3 dev-mode MCP tools spec'd in SKYNET_MASTER_PLAN.md piece 9:
 *
 *   - get_recent_errors      — list the latest N events with metadata
 *   - diagnose_error_id      — return the full event payload (incl.
 *                              forensics, runtimeSnap, causalGraph,
 *                              hypotheses) for one fingerprint
 *   - get_locals_at_frame    — extract `forensics.locals[frameIndex]`
 *                              from a specific event, useful when the
 *                              editor's LLM is debugging line-by-line
 *
 * Each tool returns `{ content: [{ type: "text", text: string }] }` — the
 * MCP "text content" shape the JSON-RPC server emits as `tools/call`
 * results. The text is JSON.stringified so the editor's LLM sees raw
 * data, not pre-rendered prose.
 */

import { findEventByFingerprint, readEvents, resolveDevLogPath, type DevLogEvent } from "./store.js"

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] }
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "get_recent_errors",
    description:
      "List the most recent errors captured by @inariwatch/capture in the local dev session. Reads " +
      "${cwd}/.inariwatch/errors.jsonl (or INARIWATCH_DEV_LOG_PATH). Returns up to `limit` events " +
      "(default 20, max 100), newest first, with id (fingerprint), title, severity, timestamp, and a " +
      "short body excerpt.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max events to return (1-100). Default 20." },
        severity: {
          type: "string",
          enum: ["critical", "warning", "info"],
          description: "Filter to a single severity. Omit for all.",
        },
      },
    },
  },
  {
    name: "diagnose_error_id",
    description:
      "Return the full payload for one error by id (fingerprint). Includes the full stack, request " +
      "context, breadcrumbs, runtimeSnap, forensics, causalGraph, and any hypotheses produced by the " +
      "local capture-agent peer. Use this after `get_recent_errors` returns the id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Error fingerprint as returned by get_recent_errors." },
      },
      required: ["id"],
    },
  },
  {
    name: "get_locals_at_frame",
    description:
      "Return the captured local variables for a specific stack frame of an error. Reads " +
      "`forensics.locals[frameIndex]` from the event payload. The frame index is 0-based, where 0 is " +
      "the throw site. Returns null if the event has no forensics or the frame is out of range.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Error fingerprint." },
        frame_index: { type: "number", description: "Frame index, 0 = throw site." },
      },
      required: ["id", "frame_index"],
    },
  },
]

function asTextResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
}

function summarize(evt: DevLogEvent): Record<string, unknown> {
  const bodyExcerpt =
    typeof evt.body === "string" ? evt.body.split("\n").slice(0, 4).join("\n") : evt.body
  return {
    id: evt.fingerprint,
    title: evt.title,
    severity: evt.severity,
    timestamp: evt.timestamp,
    bodyExcerpt,
    hasForensics: !!evt.forensics,
    hasCausalGraph: !!evt.causalGraph,
    hypothesisCount: Array.isArray(evt.hypotheses) ? evt.hypotheses.length : 0,
  }
}

export async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "get_recent_errors": {
      const limitArg = typeof args.limit === "number" ? args.limit : 20
      const limit = Math.max(1, Math.min(100, Math.floor(limitArg)))
      const sev = args.severity as "critical" | "warning" | "info" | undefined
      const events = await readEvents({ limit, severity: sev })
      return asTextResult({
        source: resolveDevLogPath(),
        count: events.length,
        events: events.map(summarize),
      })
    }

    case "diagnose_error_id": {
      const id = String(args.id ?? "")
      if (!id) throw new Error("diagnose_error_id: `id` is required")
      const evt = await findEventByFingerprint(id)
      if (!evt) return asTextResult({ found: false, id })
      return asTextResult({ found: true, event: evt })
    }

    case "get_locals_at_frame": {
      const id = String(args.id ?? "")
      const frameIndex = Number(args.frame_index)
      if (!id) throw new Error("get_locals_at_frame: `id` is required")
      if (!Number.isInteger(frameIndex) || frameIndex < 0) {
        throw new Error("get_locals_at_frame: `frame_index` must be a non-negative integer")
      }
      const evt = await findEventByFingerprint(id)
      if (!evt) return asTextResult({ found: false, id })
      const forensics = evt.forensics as { locals?: Record<string, Record<string, unknown>> } | undefined
      const locals = forensics?.locals?.[String(frameIndex)] ?? null
      return asTextResult({
        found: true,
        id,
        frameIndex,
        locals,
        // Surface async stack alongside locals — the editor LLM almost
        // always wants both for "what was happening here" reasoning.
        asyncStack: (forensics as { asyncStack?: string[] } | undefined)?.asyncStack ?? null,
      })
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}
