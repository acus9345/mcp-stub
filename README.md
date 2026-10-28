# mcp-stub

A scripted mock MCP server for testing AI agents. Decide what each tool call returns, make the 2nd call fail and the 3rd one hang, then check which tools your agent called and with what arguments.

[![npm](https://img.shields.io/npm/v/mcp-stub)](https://www.npmjs.com/package/mcp-stub)
[![CI](https://github.com/acus9345/mcp-stub/actions/workflows/ci.yml/badge.svg)](https://github.com/acus9345/mcp-stub/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/mcp-stub)](LICENSE)

```ts
import { mockMcp } from "mcp-stub";

const server = await mockMcp({
  tools: {
    search_issues: [
      { returns: [{ id: 1, title: "Bug" }] }, // 1st call
      { throws: "rate_limited" },            // 2nd call
      { delayMs: 30_000 },                   // 3rd call hangs
    ],
  },
});

await runMyAgent({ mcpUrl: server.url }); // point your agent at the mock

server.assertCalled("search_issues", { times: 3 });
server.assertCalled("search_issues", { with: { query: /bug/i } });
await server.close();
```

Real MCP servers can't fail on demand, so the error paths of an agent (retries, timeouts, a tool that returns nonsense) usually go untested. mcp-stub makes those failures happen on the call you choose.

- **Scripted responses per call.** Each call takes the next step; the last step repeats.
- **Failures on demand:** tool errors, JSON-RPC errors, delays, hangs, malformed results and dropped connections.
- **Assertions** on which tools were called, how often, in what order and with what arguments.
- **Streamable HTTP or in memory.** Test any agent that takes an MCP URL, in any language, or connect an SDK client in the same process.
- **One dependency:** the official `@modelcontextprotocol/sdk`.

It mocks the server so you can test the agent. To check that a real server follows the spec, use [`@modelcontextprotocol/conformance`](https://www.npmjs.com/package/@modelcontextprotocol/conformance) instead.

## Install

```sh
npm install --save-dev mcp-stub
```

Needs Node.js 20 or later. Works with any test runner: `node:test`, Vitest, Jest and others.

## Steps

A tool's script is a list of steps. Call 1 gets the first step, call 2 the second, and so on. Once the list runs out, the last step repeats.

| Step | What the agent gets |
| --- | --- |
| `{ returns: value }` | A result. A string becomes one text block; anything else is sent as JSON text. |
| `{ content: [...] }` | A result with these content blocks (text, image, audio, resource links), plus optional `structuredContent`. |
| `{ toolError: "message" }` | A failed tool run: `isError: true` with the message, the way MCP servers report errors the model should see. |
| `{ throws: "message" }` | A JSON-RPC error instead of a result. Use `{ throws: { code, message, data } }` to set the code. |
| `{ delayMs: 2000, ... }` | The step's answer, after a wait. Alone, an empty result after the wait. A cancelled call stops waiting. |
| `{ hang: true }` | No answer at all, until the client cancels or the server closes. |
| `{ result: anything }` | This exact JSON-RPC result, unchecked, to test how the agent handles a malformed reply. |
| `{ disconnect: true }` | A dropped connection mid-call. Over HTTP the session is gone, so the client has to initialize again. |
| `(call) => step` | A step worked out from the call, for answers that depend on the arguments. Can be async. |

Add `repeat: n` to use a step for `n` calls in a row:

```ts
const server = await mockMcp({
  tools: {
    fetch_page: [
      { throws: { code: -32000, message: "upstream timeout" }, repeat: 2 }, // calls 1 and 2 fail
      { returns: "<html>…</html>" },                                       // then it recovers
    ],
  },
});
```

A tool can be a single step, a list of steps, or a full definition with a description and schemas the agent sees in `tools/list`:

```ts
const server = await mockMcp({
  tools: {
    get_weather: {
      description: "Current weather for a city",
      inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      outputSchema: { type: "object", properties: { tempC: { type: "number" } } },
      annotations: { readOnlyHint: true },
      responses: (call) =>
        call.arguments.city === "Paris" ? { returns: { tempC: 21 } } : { toolError: `Unknown city: ${call.arguments.city}` },
    },
    delete_repo: { toolError: "permission denied" },
  },
});
```

With an `outputSchema`, object `returns` values are also sent as `structuredContent`. Arguments aren't checked against `inputSchema`, so you can see exactly what the agent sent, valid or not. A call to a tool that doesn't exist gets the spec's `-32602` error and is still recorded.

## Connecting

**Over HTTP.** `server.url` is a Streamable HTTP endpoint such as `http://127.0.0.1:52811/mcp`. Pass it to anything that speaks MCP: your own agent, the Claude Agent SDK, the OpenAI Agents SDK, LangChain's MCP adapters, or a Python agent started from your test. Each client gets its own session, and they share the scripts.

**In memory.** Skip the network and connect an SDK client in the same process:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const server = await mockMcp({ http: false, tools: { ping: { returns: "pong" } } });
const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(await server.connectInMemory());
```

## Checking what the agent did

```ts
server.assertCalled("search_issues");                                  // at least once
server.assertCalled("search_issues", { times: 2 });                    // exactly twice
server.assertCalled("search_issues", { with: { repo: "acme/api" } });  // with matching arguments
server.assertNotCalled("delete_repo");
server.assertCalledInOrder("search_issues", "get_issue", "add_comment");
```

`with` matches deeply and partially: extra keys in the real arguments are fine, arrays must match item by item, and a RegExp tests a string. A failed assertion throws an `AssertionError` listing the calls that did happen:

```
AssertionError: Expected "search_issues" to be called 3 times, but it was called 2 times.
Calls:
  #0 {"query":"bug","limit":10}
  #1 {"query":"crash"}
```

For anything else, read the record yourself:

```ts
server.calls;                 // every tool call, in order
server.callsTo("get_issue");  // the calls to one tool
server.messages;              // every JSON-RPC message: initialize, tools/list, pings, cancellations…
```

Each call has `tool`, `arguments`, `index` (0 for the first call to that tool), `outcome`, `startedAt`, `endedAt`, `sessionId` and `meta`. The `outcome` is one of `result`, `tool-error`, `protocol-error`, `unknown-tool`, `cancelled`, `disconnected` or `pending`, so you can check that the agent really cancelled the call that hung:

```ts
await runMyAgent({ mcpUrl: server.url, toolTimeoutMs: 1000 });
assert.equal(server.callsTo("search_issues")[2].outcome, "cancelled");
```

When the agent runs in the background, wait for it:

```ts
const calls = await server.waitForCalls(3, { tool: "search_issues", timeoutMs: 10_000 });
```

## Changing tools during a test

```ts
await server.setTool("new_tool", { returns: "hi" }); // add or replace, then notify clients
await server.removeTool("search_issues");             // remove, then notify clients
server.reset();                                       // clear the record and restart every script
```

`setTool` and `removeTool` send `notifications/tools/list_changed`, so you can test that the agent picks up new tools. A replaced tool starts its new script from the first step.

## API

### `mockMcp(options?): Promise<MockMcpServer>`

| Option | Default | |
| --- | --- | --- |
| `tools` | `{}` | The tools, by name: a step, a list of steps, or a definition. |
| `port` | a free port | Port to listen on. |
| `host` | `"127.0.0.1"` | Host to listen on. |
| `path` | `"/mcp"` | Path of the MCP endpoint. |
| `http` | `true` | Set to `false` to connect in memory only. |
| `serverInfo` | `{ name: "mcp-stub", version: "0.1.0" }` | Name and version sent on initialize. |
| `instructions` | none | Server instructions sent on initialize. |

### `MockMcpServer`

| Member | |
| --- | --- |
| `url` | The Streamable HTTP endpoint. |
| `calls`, `callsTo(tool)` | The recorded tool calls. |
| `messages` | Every JSON-RPC request and notification received. |
| `assertCalled(tool, { times?, with? })` | Throws unless the tool was called (that many times, with those arguments). Returns the matching calls. |
| `assertNotCalled(tool)` | Throws if the tool was called. |
| `assertCalledInOrder(...tools)` | Throws unless the tools were called in this order. Other calls may come in between. |
| `waitForCalls(count, { tool?, timeoutMs? })` | Resolves once there are at least `count` calls. |
| `connectInMemory()` | Returns a transport for an SDK `Client`. |
| `setTool(name, script)`, `removeTool(name)` | Change the tools and notify clients. |
| `reset()` | Clear the record and restart every script. |
| `close()` | Close every connection and stop the server. Also works with `await using`. |

`matches(actual, expected)` is exported too, the same partial matcher `with` uses.

## License

MIT
