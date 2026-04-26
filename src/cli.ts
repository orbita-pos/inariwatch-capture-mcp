#!/usr/bin/env node
/**
 * Bin entrypoint. Run as `npx @inariwatch/capture-mcp` from an editor's
 * MCP server config (Cursor, Claude Code, Continue, etc.).
 *
 * No CLI flags — everything is driven by env vars so the same config
 * works in editors that only allow `command + args + env`:
 *
 *   - INARIWATCH_DEV_LOG_PATH  (optional) — override the JSONL file
 *                                read by the server. Default:
 *                                ${cwd}/.inariwatch/errors.jsonl.
 *
 * The server speaks JSON-RPC 2.0 over stdio. Anything written to stderr
 * is forwarded verbatim by editors and visible in their MCP debug
 * panel — used here for boot-time diagnostics only.
 */

import { runServer, stdioServerIO } from "./server.js"
import { resolveDevLogPath } from "./store.js"

process.stderr.write(
  `[@inariwatch/capture-mcp] reading ${resolveDevLogPath()}\n`,
)

runServer(stdioServerIO()).catch((err) => {
  process.stderr.write(`[@inariwatch/capture-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
