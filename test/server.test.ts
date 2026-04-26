/**
 * Smoke tests against the in-memory ServerIO so we exercise the JSON-RPC
 * dispatcher end-to-end without spawning a real subprocess. The cli.ts
 * entrypoint is just a stdio adapter, so coverage here transfers.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runServer, type ServerIO } from "../src/server.js"

interface MockedIO extends ServerIO {
  push(line: string): void
  end(): void
  outputs: string[]
}

function mockIO(): MockedIO {
  const inputs: Array<string | null> = []
  const waiters: Array<(line: string | null) => void> = []
  const outputs: string[] = []

  function deliver() {
    while (waiters.length && inputs.length) {
      const w = waiters.shift()!
      w(inputs.shift()!)
    }
  }

  return {
    push(line: string) { inputs.push(line); deliver() },
    end() { inputs.push(null); deliver() },
    outputs,
    readLine() {
      return new Promise<string | null>((resolve) => {
        if (inputs.length) return resolve(inputs.shift()!)
        waiters.push(resolve)
      })
    },
    writeLine(line: string) { outputs.push(line) },
  }
}

test("initialize handshake returns serverInfo + capabilities", async () => {
  const io = mockIO()
  const run = runServer(io)
  io.push(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }))
  io.end()
  await run

  assert.equal(io.outputs.length, 1)
  const res = JSON.parse(io.outputs[0])
  assert.equal(res.id, 1)
  assert.equal(res.result.serverInfo.name, "@inariwatch/capture-mcp")
  assert.ok(res.result.protocolVersion)
  assert.ok(res.result.capabilities.tools)
})

test("notifications/initialized returns nothing (no body, no id)", async () => {
  const io = mockIO()
  const run = runServer(io)
  io.push(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))
  io.end()
  await run

  assert.equal(io.outputs.length, 0)
})

test("tools/list returns the 3 dev-mode tools", async () => {
  const io = mockIO()
  const run = runServer(io)
  io.push(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }))
  io.end()
  await run

  const res = JSON.parse(io.outputs[0])
  const names = res.result.tools.map((t: { name: string }) => t.name).sort()
  assert.deepEqual(names, ["diagnose_error_id", "get_locals_at_frame", "get_recent_errors"])
})

test("tools/call: get_recent_errors reads from a fixture file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-mcp-"))
  const path = join(dir, "errors.jsonl")
  writeFileSync(
    path,
    [
      JSON.stringify({ fingerprint: "fp1", title: "boom", severity: "critical", body: "Error: boom\n  at a.js:1", timestamp: "2026-04-25T00:00:01Z" }),
      JSON.stringify({ fingerprint: "fp2", title: "warn", severity: "warning", body: "warn", timestamp: "2026-04-25T00:00:02Z" }),
      "", // blank line, must be skipped
      JSON.stringify({ fingerprint: "fp3", title: "info", severity: "info", body: "info", timestamp: "2026-04-25T00:00:03Z" }),
    ].join("\n") + "\n",
    "utf8",
  )
  process.env.INARIWATCH_DEV_LOG_PATH = path

  try {
    const io = mockIO()
    const run = runServer(io)
    io.push(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_recent_errors", arguments: { limit: 10 } } }))
    io.end()
    await run

    const res = JSON.parse(io.outputs[0])
    const payload = JSON.parse(res.result.content[0].text)
    assert.equal(payload.count, 3)
    // Newest first.
    assert.equal(payload.events[0].id, "fp3")
    assert.equal(payload.events[2].id, "fp1")
  } finally {
    delete process.env.INARIWATCH_DEV_LOG_PATH
    rmSync(dir, { recursive: true, force: true })
  }
})

test("tools/call: get_recent_errors honors severity filter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-mcp-"))
  const path = join(dir, "errors.jsonl")
  writeFileSync(
    path,
    [
      JSON.stringify({ fingerprint: "fp1", title: "boom", severity: "critical", body: "x", timestamp: "2026-04-25T00:00:01Z" }),
      JSON.stringify({ fingerprint: "fp2", title: "warn", severity: "warning", body: "y", timestamp: "2026-04-25T00:00:02Z" }),
    ].join("\n") + "\n",
    "utf8",
  )
  process.env.INARIWATCH_DEV_LOG_PATH = path

  try {
    const io = mockIO()
    const run = runServer(io)
    io.push(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_recent_errors", arguments: { severity: "critical" } } }))
    io.end()
    await run

    const res = JSON.parse(io.outputs[0])
    const payload = JSON.parse(res.result.content[0].text)
    assert.equal(payload.count, 1)
    assert.equal(payload.events[0].id, "fp1")
  } finally {
    delete process.env.INARIWATCH_DEV_LOG_PATH
    rmSync(dir, { recursive: true, force: true })
  }
})

test("tools/call: diagnose_error_id returns the full event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-mcp-"))
  const path = join(dir, "errors.jsonl")
  const evt = {
    fingerprint: "fp-x",
    title: "x",
    severity: "critical" as const,
    body: "stack",
    timestamp: "2026-04-25T00:00:01Z",
    forensics: { locals: { "0": { foo: { type: "primitive", value: 42 } } } },
    hypotheses: [{ text: "h1", prior: 0.5, cites: [], confidence: 0.6, source: "local_agent" }],
  }
  writeFileSync(path, JSON.stringify(evt) + "\n", "utf8")
  process.env.INARIWATCH_DEV_LOG_PATH = path

  try {
    const io = mockIO()
    const run = runServer(io)
    io.push(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "diagnose_error_id", arguments: { id: "fp-x" } } }))
    io.end()
    await run

    const res = JSON.parse(io.outputs[0])
    const payload = JSON.parse(res.result.content[0].text)
    assert.equal(payload.found, true)
    assert.equal(payload.event.title, "x")
    assert.equal(payload.event.hypotheses.length, 1)
  } finally {
    delete process.env.INARIWATCH_DEV_LOG_PATH
    rmSync(dir, { recursive: true, force: true })
  }
})

test("tools/call: get_locals_at_frame returns frame locals + asyncStack", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-mcp-"))
  const path = join(dir, "errors.jsonl")
  const evt = {
    fingerprint: "fp-y",
    title: "y",
    severity: "warning" as const,
    body: "b",
    timestamp: "2026-04-25T00:00:01Z",
    forensics: {
      locals: { "0": { x: { type: "primitive", value: 1 } }, "1": { y: { type: "primitive", value: 2 } } },
      asyncStack: ["async at a.js:1"],
    },
  }
  writeFileSync(path, JSON.stringify(evt) + "\n", "utf8")
  process.env.INARIWATCH_DEV_LOG_PATH = path

  try {
    const io = mockIO()
    const run = runServer(io)
    io.push(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "get_locals_at_frame", arguments: { id: "fp-y", frame_index: 1 } } }))
    io.end()
    await run

    const res = JSON.parse(io.outputs[0])
    const payload = JSON.parse(res.result.content[0].text)
    assert.equal(payload.found, true)
    assert.equal(payload.frameIndex, 1)
    assert.deepEqual(payload.locals, { y: { type: "primitive", value: 2 } })
    assert.deepEqual(payload.asyncStack, ["async at a.js:1"])
  } finally {
    delete process.env.INARIWATCH_DEV_LOG_PATH
    rmSync(dir, { recursive: true, force: true })
  }
})

test("tools/call: get_locals_at_frame rejects missing id", async () => {
  const io = mockIO()
  const run = runServer(io)
  io.push(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "get_locals_at_frame", arguments: { frame_index: 0 } } }))
  io.end()
  await run

  const res = JSON.parse(io.outputs[0])
  assert.equal(res.error.code, -32603)
  assert.match(res.error.message, /id.*is required/)
})

test("tools/call: missing file is empty list, not an error", async () => {
  process.env.INARIWATCH_DEV_LOG_PATH = join(tmpdir(), `nonexistent-${Date.now()}.jsonl`)
  try {
    const io = mockIO()
    const run = runServer(io)
    io.push(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "get_recent_errors", arguments: {} } }))
    io.end()
    await run

    const res = JSON.parse(io.outputs[0])
    const payload = JSON.parse(res.result.content[0].text)
    assert.equal(payload.count, 0)
  } finally {
    delete process.env.INARIWATCH_DEV_LOG_PATH
  }
})

test("unknown method returns -32601", async () => {
  const io = mockIO()
  const run = runServer(io)
  io.push(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "no_such_method" }))
  io.end()
  await run

  const res = JSON.parse(io.outputs[0])
  assert.equal(res.error.code, -32601)
})

test("malformed JSON returns -32700 with id=null", async () => {
  const io = mockIO()
  const run = runServer(io)
  io.push("{ not valid json")
  io.end()
  await run

  const res = JSON.parse(io.outputs[0])
  assert.equal(res.id, null)
  assert.equal(res.error.code, -32700)
})
