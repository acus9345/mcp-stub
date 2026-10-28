# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-28

### Added

- `mockMcp()` starts a mock MCP server over Streamable HTTP, with `connectInMemory()` for clients in the same process.
- Per-call scripts: `returns`, `content`, `toolError`, `throws`, `delayMs`, `hang`, `result` (sent unchecked), `disconnect`, step functions and `repeat`.
- A record of every tool call and JSON-RPC message, with each call's outcome.
- `assertCalled`, `assertNotCalled`, `assertCalledInOrder` and `waitForCalls`.
- `setTool` and `removeTool`, which send `notifications/tools/list_changed`, and `reset()`.
