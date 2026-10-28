import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { matches, mockMcp, type MockMcpOptions, type MockMcpServer } from "../dist/index.js";
import { loopbackDeliversLateWrites } from "./helpers.ts";

// Streamable HTTP writes each reply after a pause, which some VPN and firewall drivers drop on loopback.
const skipHttp = (await loopbackDeliversLateWrites())
  ? false
  : "this machine drops late loopback writes (VPN or firewall driver); HTTP tests run in CI";

let server: MockMcpServer | undefined;
const clients: Client[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.close()));
  await server?.close();
  server = undefined;
});

async function start(options: MockMcpOptions): Promise<MockMcpServer> {
  server = await mockMcp(options);
  return server;
}

async function httpClient(s: MockMcpServer): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(s.url)));
  clients.push(client);
  return client;
}

async function memoryClient(s: MockMcpServer): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(await s.connectInMemory());
  clients.push(client);
  return client;
}

const text = (result: unknown) => (result as { content: { text: string }[] }).content[0]?.text;

for (const [label, connect] of [
  ["http", httpClient],
  ["memory", memoryClient],
] as const) {
  describe(`scripted steps (${label})`, { skip: label === "http" && skipHttp }, () => {
    it("runs the script from the example: a result, an error, then a hang", async () => {
      const s = await start({
        tools: {
          search_issues: [{ returns: [{ id: 1, title: "Bug" }] }, { throws: "rate_limited" }, { delayMs: 30_000 }],
        },
      });
      const client = await connect(s);
      const first = await client.callTool({ name: "search_issues", arguments: { q: "bug" } });
      assert.deepEqual(JSON.parse(text(first)!), [{ id: 1, title: "Bug" }]);
      await assert.rejects(client.callTool({ name: "search_issues", arguments: {} }), /rate_limited/);
      await assert.rejects(
        client.callTool({ name: "search_issues", arguments: {} }, undefined, { timeout: 100 }),
        /timed out/i,
      );
      await waitFor(() => s.calls[2]?.outcome === "cancelled");
      assert.deepEqual(
        s.calls.map((c) => [c.index, c.outcome, c.transport]),
        [
          [0, "result", label],
          [1, "protocol-error", label],
          [2, "cancelled", label],
        ],
      );
      assert.deepEqual(s.calls[0]?.arguments, { q: "bug" });
    });

    it("sends tool errors, content blocks, strings and structured content", async () => {
      const s = await start({
        tools: {
          fail: { toolError: "disk full" },
          image: { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] },
          greet: { returns: "hello" },
          weather: {
            outputSchema: { type: "object", properties: { temp: { type: "number" } } },
            responses: { returns: { temp: 21 } },
          },
          empty: {},
        },
      });
      const client = await connect(s);
      const fail = await client.callTool({ name: "fail", arguments: {} });
      assert.equal(fail.isError, true);
      assert.equal(text(fail), "disk full");
      const image = await client.callTool({ name: "image", arguments: {} });
      assert.deepEqual(image.content, [{ type: "image", data: "aGk=", mimeType: "image/png" }]);
      assert.equal(text(await client.callTool({ name: "greet", arguments: {} })), "hello");
      const weather = await client.callTool({ name: "weather", arguments: {} });
      assert.deepEqual(weather.structuredContent, { temp: 21 });
      assert.deepEqual((await client.callTool({ name: "empty", arguments: {} })).content, []);
      assert.deepEqual(
        s.calls.map((c) => c.outcome),
        ["tool-error", "result", "result", "result", "result"],
      );
    });

    it("sends protocol errors with a code and data", async () => {
      const s = await start({ tools: { t: { throws: { code: -32042, message: "nope", data: { retryAfter: 5 } } } } });
      const client = await connect(s);
      await assert.rejects(client.callTool({ name: "t", arguments: {} }), (error: { code: number; data: unknown }) => {
        assert.equal(error.code, -32042);
        assert.deepEqual(error.data, { retryAfter: 5 });
        return true;
      });
    });

    it("sends a malformed result unchecked, so the client's own validation fails", async () => {
      const s = await start({ tools: { broken: { result: { content: "not an array" } } } });
      const client = await connect(s);
      await assert.rejects(client.callTool({ name: "broken", arguments: {} }));
      assert.equal(s.calls[0]?.outcome, "result");
    });

    it("records calls to unknown tools and answers with -32602", async () => {
      const s = await start({ tools: {} });
      const client = await connect(s);
      await assert.rejects(client.callTool({ name: "made_up", arguments: { x: 1 } }), (error: { code: number }) => {
        assert.equal(error.code, -32602);
        return true;
      });
      assert.equal(s.calls[0]?.outcome, "unknown-tool");
      s.assertCalled("made_up", { with: { x: 1 } });
    });

    it("hangs until the client cancels", async () => {
      const s = await start({ tools: { stuck: { hang: true } } });
      const client = await connect(s);
      const controller = new AbortController();
      const pending = client.callTool({ name: "stuck", arguments: {} }, undefined, { signal: controller.signal });
      await s.waitForCalls(1);
      controller.abort();
      await assert.rejects(pending);
      await waitFor(() => s.calls[0]?.outcome === "cancelled");
      assert.ok(s.messages.some((m) => m.method === "notifications/cancelled"));
    });

    it("drops the connection on disconnect", async () => {
      const s = await start({ tools: { flaky: [{ disconnect: true }, { returns: "back" }] } });
      const client = await connect(s);
      await assert.rejects(client.callTool({ name: "flaky", arguments: {} }, undefined, { timeout: 2000 }));
      assert.equal(s.calls[0]?.outcome, "disconnected");
      const again = await connect(s);
      assert.equal(text(await again.callTool({ name: "flaky", arguments: {} })), "back");
    });

    it("tells clients when the tool list changes", async () => {
      const s = await start({ tools: { a: { returns: "a" } } });
      const client = await connect(s);
      if (label === "http") await new Promise((r) => setTimeout(r, 100)); // let the GET stream open
      let changed = 0;
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        changed++;
      });
      await s.setTool("b", { description: "new", responses: { returns: "b" } });
      await waitFor(() => changed === 1);
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        ["a", "b"],
      );
      await s.removeTool("a");
      await waitFor(() => changed === 2);
      assert.deepEqual(
        (await client.listTools()).tools.map((t) => t.name),
        ["b"],
      );
    });
  });
}

describe("scripts", () => {
  it("repeats steps, then keeps repeating the last one", async () => {
    const s = await start({ tools: { t: [{ returns: "a", repeat: 2 }, { returns: "b" }, { returns: "c" }] } });
    const client = await memoryClient(s);
    const out: string[] = [];
    for (let i = 0; i < 6; i++) out.push(text(await client.callTool({ name: "t", arguments: {} }))!);
    assert.deepEqual(out, ["a", "a", "b", "c", "c", "c"]);
  });

  it("works a step out from the arguments", async () => {
    const s = await start({
      tools: {
        get_user: (call) =>
          call.arguments["id"] === 1 ? { returns: { name: "Ada" } } : { toolError: `no user ${String(call.arguments["id"])}` },
      },
    });
    const client = await memoryClient(s);
    assert.equal(text(await client.callTool({ name: "get_user", arguments: { id: 1 } })), '{"name":"Ada"}');
    const missing = await client.callTool({ name: "get_user", arguments: { id: 2 } });
    assert.equal(missing.isError, true);
    assert.equal(text(missing), "no user 2");
  });

  it("delays a result", async () => {
    const s = await start({ tools: { slow: { returns: "done", delayMs: 150 } } });
    const client = await memoryClient(s);
    const started = Date.now();
    assert.equal(text(await client.callTool({ name: "slow", arguments: {} })), "done");
    assert.ok(Date.now() - started >= 140);
  });

  it("lists tool metadata", async () => {
    const s = await start({
      tools: {
        search: {
          title: "Search",
          description: "Search issues",
          inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
          annotations: { readOnlyHint: true },
        },
        plain: [],
      },
    });
    const client = await memoryClient(s);
    const { tools } = await client.listTools();
    assert.deepEqual(tools, [
      {
        name: "search",
        title: "Search",
        description: "Search issues",
        inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        annotations: { readOnlyHint: true },
      },
      { name: "plain", inputSchema: { type: "object" } },
    ]);
  });

  it("sends server info and instructions", async () => {
    const s = await start({ serverInfo: { name: "github", version: "9.9.9" }, instructions: "Be nice." });
    const client = await memoryClient(s);
    assert.deepEqual(client.getServerVersion(), { name: "github", version: "9.9.9" });
    assert.equal(client.getInstructions(), "Be nice.");
    assert.deepEqual(client.getServerCapabilities()?.tools, { listChanged: true });
  });

  it("restarts a replaced tool's script but keeps counting its calls", async () => {
    const s = await start({ tools: { t: [{ returns: "1" }, { returns: "2" }] } });
    const client = await memoryClient(s);
    await client.callTool({ name: "t", arguments: {} });
    await s.setTool("t", [{ returns: "new" }]);
    assert.equal(text(await client.callTool({ name: "t", arguments: {} })), "new");
    assert.deepEqual(
      s.callsTo("t").map((c) => c.index),
      [0, 1],
    );
  });

  it("resets calls, messages and scripts", async () => {
    const s = await start({ tools: { t: [{ returns: "1" }, { returns: "2" }] } });
    const client = await memoryClient(s);
    await client.callTool({ name: "t", arguments: {} });
    s.reset();
    assert.equal(s.calls.length, 0);
    assert.equal(s.messages.length, 0);
    assert.equal(text(await client.callTool({ name: "t", arguments: {} })), "1");
    assert.equal(s.calls[0]?.index, 0);
  });
});

describe("assertions", () => {
  async function withCalls(): Promise<MockMcpServer> {
    const s = await start({ tools: { search: { returns: "ok" }, open: { returns: "ok" }, close: { returns: "ok" } } });
    const client = await memoryClient(s);
    await client.callTool({ name: "search", arguments: { q: "bug", limit: 10 } });
    await client.callTool({ name: "open", arguments: { id: 1 } });
    await client.callTool({ name: "search", arguments: { q: "crash" } });
    return s;
  }

  it("passes and returns the matching calls", async () => {
    const s = await withCalls();
    assert.equal(s.assertCalled("search").length, 2);
    s.assertCalled("search", { times: 2 });
    assert.equal(s.assertCalled("search", { with: { q: /cr/ } })[0]?.index, 1);
    s.assertCalled("search", { with: { q: "bug" }, times: 1 });
    s.assertNotCalled("close");
    s.assertCalledInOrder("search", "open", "search");
    s.assertCalledInOrder("open");
  });

  it("explains failures", async () => {
    const s = await withCalls();
    assert.throws(() => s.assertCalled("search", { times: 3 }), {
      name: "AssertionError",
      message: /Expected "search" to be called 3 times, but it was called 2 times\.\nCalls:\n {2}#0 \{"q":"bug","limit":10\}/,
    });
    assert.throws(() => s.assertCalled("search", { with: { q: "nope" } }), /with \{"q":"nope"\}, but it was called 2 times, 0 of them matching/);
    assert.throws(() => s.assertCalled("close"), /Expected "close" to be called, but it was called 0 times\.$/);
    assert.throws(() => s.assertNotCalled("open"), /Expected "open" not to be called, but it was called 1 time\./);
    assert.throws(() => s.assertCalledInOrder("open", "close"), /search → open → search/);
  });

  it("waits for calls from an agent running in the background", async () => {
    const s = await start({ tools: { t: { returns: "ok" } } });
    const client = await memoryClient(s);
    setTimeout(() => void client.callTool({ name: "t", arguments: {} }), 50);
    const calls = await s.waitForCalls(1, { tool: "t" });
    assert.equal(calls.length, 1);
    await assert.rejects(s.waitForCalls(5, { timeoutMs: 50 }), /Timed out after 50 ms waiting for 5 tool calls; got 1/);
  });

  it("matches partially and deeply", () => {
    assert.ok(matches({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }, { b: { c: [1, { d: 2 }] } }));
    assert.ok(!matches({ a: [1, 2] }, { a: [1] }));
    assert.ok(!matches({ a: 1 }, { b: undefined }));
    assert.ok(matches("hello", /ell/));
    assert.ok(!matches(5, /5/));
  });
});

describe("transport", () => {
  it("records every message the server receives", { skip: skipHttp }, async () => {
    const s = await start({ tools: { t: { returns: "ok" } } });
    const client = await httpClient(s);
    await client.listTools();
    await client.callTool({ name: "t", arguments: {} });
    const methods = s.messages.map((m) => m.method);
    assert.deepEqual(methods.slice(0, 2), ["initialize", "notifications/initialized"]);
    assert.ok(methods.includes("tools/list"));
    assert.ok(methods.includes("tools/call"));
    assert.ok(s.messages.every((m) => m.sessionId !== undefined && m.transport === "http"));
    assert.equal(s.messages[0]?.isRequest, true);
    assert.equal(s.messages[1]?.isRequest, false);
  });

  it("keeps a separate session per HTTP client and shares the script between them", { skip: skipHttp }, async () => {
    const s = await start({ tools: { t: [{ returns: "1" }, { returns: "2" }] } });
    const a = await httpClient(s);
    const b = await httpClient(s);
    assert.equal(text(await a.callTool({ name: "t", arguments: {} })), "1");
    assert.equal(text(await b.callTool({ name: "t", arguments: {} })), "2");
    assert.notEqual(s.calls[0]?.sessionId, s.calls[1]?.sessionId);
  });

  it("rejects wrong paths, missing sessions and unknown sessions", { skip: skipHttp }, async () => {
    const s = await start({});
    const base = new URL(s.url);
    assert.equal((await fetch(new URL("/other", base))).status, 404);
    const post = (headers: Record<string, string>) =>
      fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ "mcp-session-id": "nope" })).status, 404);
    const bad = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    assert.equal(bad.status, 400);
  });

  it("serves a custom path and port-free URL", { skip: skipHttp }, async () => {
    const s = await start({ path: "/rpc" });
    assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/rpc$/);
    await httpClient(s);
  });

  it("skips HTTP with http: false", async () => {
    const s = await start({ http: false, tools: { t: { returns: "ok" } } });
    assert.throws(() => s.url, /isn't running/);
    const client = await memoryClient(s);
    assert.equal(text(await client.callTool({ name: "t", arguments: {} })), "ok");
  });

  it("releases hanging calls on close", async () => {
    const s = await start({ tools: { stuck: { hang: true } } });
    const client = await memoryClient(s);
    const pending = client.callTool({ name: "stuck", arguments: {} });
    await s.waitForCalls(1);
    await s.close();
    await assert.rejects(pending);
    assert.equal(s.calls[0]?.outcome, "disconnected");
  });
});

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
