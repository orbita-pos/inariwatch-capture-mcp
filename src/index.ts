// Public surface of @inariwatch/capture-mcp.
// Spec: SKYNET_MASTER_PLAN.md piece 9 — MCP-native dev mode server.

export { runServer, stdioServerIO } from "./server.js"
export type { ServerIO } from "./server.js"
export { TOOL_DEFINITIONS, handleToolCall } from "./tools.js"
export type { ToolDefinition } from "./tools.js"
export { readEvents, findEventByFingerprint, resolveDevLogPath } from "./store.js"
export type { DevLogEvent, ReadOptions } from "./store.js"
