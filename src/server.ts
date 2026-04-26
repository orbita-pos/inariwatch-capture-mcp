/**
 * Minimal MCP (Model Context Protocol) server over stdio.
 *
 * Wire format: JSON-RPC 2.0, one message per line (newline-delimited JSON).
 * That matches the official `@modelcontextprotocol/sdk` stdio transport
 * and is what Cursor / Claude Code / Continue speak when they spawn an
 * `mcp` server via the `command + args` config.
 *
 * Why hand-rolled instead of `@modelcontextprotocol/sdk`:
 *   - Same reason as capture-agent's openai.ts — pulling the SDK adds
 *     ~100KB and a dependency tree this peer doesn't need. We implement
 *     exactly the 4 methods Cursor calls during dev: `initialize`,
 *     `tools/list`, `tools/call`, plus `notifications/initialized`.
 *   - Keeps capture-mcp under ~10KB shipped, install-time near-zero.
 *
 * Methods supported:
 *   - initialize             → capability handshake
 *   - tools/list             → returns TOOL_DEFINITIONS
 *   - tools/call             → dispatches to handleToolCall
 *   - notifications/initialized → no-op (the spec wants a 200, no body)
 *
 * Anything else returns JSON-RPC error -32601 (method not found).
 */

import { TOOL_DEFINITIONS, handleToolCall } from "./tools.js"

const PROTOCOL_VERSION = "2024-11-05"
const SERVER_NAME = "@inariwatch/capture-mcp"
const SERVER_VERSION = "0.1.0-alpha.0"

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface ServerIO {
  /** Read newline-delimited JSON. Resolves with `null` on EOF. */
  readLine(): Promise<string | null>
  /** Write one JSON-RPC message + trailing newline. */
  writeLine(line: string): void
}

function makeError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } }
}

async function dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null

  switch (req.method) {
    case "initialize": {
      // The client sends its protocolVersion + capabilities; we mirror the
      // protocolVersion if it matches ours, otherwise pin to ours and let
      // the client decide whether to proceed.
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: {}, // we offer tools, no listChanged subscriptions
          },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      }
    }

    case "notifications/initialized":
      // Notifications carry no `id`; they expect no response.
      return null

    case "tools/list": {
      return { jsonrpc: "2.0", id, result: { tools: TOOL_DEFINITIONS } }
    }

    case "tools/call": {
      const name = String(req.params?.name ?? "")
      const args = (req.params?.arguments as Record<string, unknown>) ?? {}
      if (!name) return makeError(id, -32602, "tools/call: `name` is required")
      try {
        const result = await handleToolCall(name, args)
        return { jsonrpc: "2.0", id, result }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Tool errors are returned as JSON-RPC errors per MCP spec —
        // keeps the editor's LLM aware of the failure rather than
        // silently shipping bad data.
        return makeError(id, -32603, `tool error: ${msg}`)
      }
    }

    case "ping":
      // Not in the MCP spec, but cheap and useful for health checks
      // (e.g. our own smoke test). Servers MAY accept extra methods.
      return { jsonrpc: "2.0", id, result: {} }

    default:
      // Notifications (no id) for unknown methods are silently dropped;
      // requests get -32601.
      if (req.id === undefined) return null
      return makeError(id, -32601, `method not found: ${req.method}`)
  }
}

export async function runServer(io: ServerIO): Promise<void> {
  while (true) {
    const line = await io.readLine()
    if (line === null) return
    if (!line.trim()) continue

    let req: JsonRpcRequest
    try {
      req = JSON.parse(line) as JsonRpcRequest
    } catch (err) {
      // Per JSON-RPC 2.0, parse errors get id=null and code=-32700.
      io.writeLine(JSON.stringify(makeError(null, -32700, "parse error", String(err))))
      continue
    }

    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      io.writeLine(JSON.stringify(makeError(req.id ?? null, -32600, "invalid request")))
      continue
    }

    const res = await dispatch(req)
    if (res !== null) io.writeLine(JSON.stringify(res))
  }
}

/**
 * Concrete stdio adapter. Reads one line at a time from process.stdin
 * (newline-delimited JSON) and writes responses to process.stdout.
 */
export function stdioServerIO(): ServerIO {
  let buffer = ""
  let eof = false
  const queue: string[] = []
  const waiters: Array<(line: string | null) => void> = []

  function flushQueue() {
    while (waiters.length && (queue.length || eof)) {
      const w = waiters.shift()!
      w(queue.shift() ?? null)
    }
  }

  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk
    let nl: number
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      queue.push(line)
    }
    flushQueue()
  })
  process.stdin.on("end", () => {
    if (buffer.length > 0) queue.push(buffer)
    buffer = ""
    eof = true
    flushQueue()
  })

  return {
    readLine() {
      return new Promise<string | null>((resolve) => {
        if (queue.length) return resolve(queue.shift()!)
        if (eof) return resolve(null)
        waiters.push(resolve)
      })
    },
    writeLine(line: string) {
      process.stdout.write(line + "\n")
    },
  }
}
