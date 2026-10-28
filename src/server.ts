import { AssertionError } from "node:assert";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  isInitializeRequest,
  isJSONRPCRequest,
  ListToolsRequestSchema,
  type JSONRPCRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, isPlainObject, matches } from "./match.js";
import type {
  CallMatcher,
  MockMcpOptions,
  ReceivedMessage,
  Step,
  ToolCall,
  ToolDefinition,
  ToolScript,
} from "./types.js";

const STEP_KEYS = ["returns", "content", "result", "toolError", "throws", "hang", "disconnect", "delayMs"];

interface ToolState {
  definition: ToolDefinition;
  steps: Step[];
  cursor: number;
  used: number;
}

interface Connection {
  server: Server;
  transport: Transport;
  kind: "http" | "memory";
}

interface Waiter {
  count: number;
  tool: string | undefined;
  resolve: (calls: ToolCall[]) => void;
}

interface RequestExtra {
  signal: AbortSignal;
}

/** Starts a mock MCP server with scripted tools. Close it when you're done. */
export async function mockMcp(options: MockMcpOptions = {}): Promise<MockMcpServer> {
  const server = new MockMcpServer(options);
  await server.listen();
  return server;
}

/** A running mock MCP server. Create one with {@link mockMcp}. */
export class MockMcpServer {
  readonly #options: MockMcpOptions;
  readonly #path: string;
  readonly #tools = new Map<string, ToolState>();
  readonly #calls: ToolCall[] = [];
  readonly #messages: ReceivedMessage[] = [];
  readonly #callCounts = new Map<string, number>();
  readonly #connections = new Set<Connection>();
  readonly #sessions = new Map<string, Connection>();
  readonly #waiting = new Set<() => void>();
  #waiters: Waiter[] = [];
  #http: HttpServer | undefined;
  #url: string | undefined;
  #closed = false;

  constructor(options: MockMcpOptions = {}) {
    this.#options = options;
    this.#path = options.path ?? "/mcp";
    for (const [name, script] of Object.entries(options.tools ?? {})) this.#tools.set(name, toState(script));
  }

  /** Starts the HTTP server. {@link mockMcp} calls this for you. */
  async listen(): Promise<void> {
    if (this.#options.http === false || this.#http) return;
    const http = createServer((req, res) => {
      this.#handleHttp(req, res).catch((error: unknown) => {
        if (!res.headersSent) sendRpcError(res, 500, ErrorCode.InternalError, String(error));
        else res.end();
      });
    });
    this.#http = http;
    const host = this.#options.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(this.#options.port ?? 0, host, () => {
        http.off("error", reject);
        resolve();
      });
    });
    const { port } = http.address() as AddressInfo;
    const urlHost = host.includes(":") ? `[${host}]` : host;
    this.#url = `http://${urlHost}:${port}${this.#path}`;
  }

  /** The Streamable HTTP endpoint to point your agent at. */
  get url(): string {
    if (this.#url === undefined) throw new Error("The HTTP server isn't running (it was started with http: false).");
    return this.#url;
  }

  /** Every tool call so far, in the order they arrived, including calls to tools that don't exist. */
  get calls(): readonly ToolCall[] {
    return this.#calls;
  }

  /** Every JSON-RPC request and notification so far: initialize, tools/list, pings, cancellations and the rest. */
  get messages(): readonly ReceivedMessage[] {
    return this.#messages;
  }

  /** The calls to one tool, in order. */
  callsTo(tool: string): ToolCall[] {
    return this.#calls.filter((call) => call.tool === tool);
  }

  /**
   * Connects a client in the same process without HTTP. Pass the returned transport to `client.connect()`.
   */
  async connectInMemory(): Promise<Transport> {
    this.#assertOpen();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await this.#attach(serverSide, "memory");
    return clientSide;
  }

  /**
   * Adds or replaces a tool and tells connected clients the tool list changed. A replaced tool starts
   * its new script from the first step; `index` on its calls keeps counting.
   */
  async setTool(name: string, script: ToolScript): Promise<void> {
    this.#tools.set(name, toState(script));
    await this.#notifyToolsChanged();
  }

  /** Removes a tool and tells connected clients the tool list changed. */
  async removeTool(name: string): Promise<void> {
    if (this.#tools.delete(name)) await this.#notifyToolsChanged();
  }

  /** Clears recorded calls and messages and sends every tool back to its first step. Connections stay open. */
  reset(): void {
    this.#calls.length = 0;
    this.#messages.length = 0;
    this.#callCounts.clear();
    for (const state of this.#tools.values()) {
      state.cursor = 0;
      state.used = 0;
    }
  }

  /**
   * Waits until there are at least `count` tool calls (to `tool`, when given), for agents that run in the
   * background. Rejects after `timeoutMs` (default 5000).
   */
  waitForCalls(count: number, options: { tool?: string; timeoutMs?: number } = {}): Promise<ToolCall[]> {
    const current = this.#matchingCalls(options.tool);
    if (current.length >= count) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 5000;
      const waiter: Waiter = {
        count,
        tool: options.tool,
        resolve: (calls) => {
          clearTimeout(timer);
          resolve(calls);
        },
      };
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        const seen = this.#matchingCalls(options.tool).length;
        const what = options.tool === undefined ? "tool calls" : `calls to "${options.tool}"`;
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${count} ${what}; got ${seen}.`));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  /**
   * Throws unless `tool` was called. With `times`, it must have been called exactly that many times;
   * with `with`, only calls whose arguments match count. Returns the matching calls.
   */
  assertCalled(tool: string, matcher: CallMatcher = {}): ToolCall[] {
    const calls = this.callsTo(tool);
    const matching = matcher.with === undefined ? calls : calls.filter((c) => matches(c.arguments, matcher.with));
    const ok = matcher.times === undefined ? matching.length > 0 : matching.length === matcher.times;
    if (!ok) {
      const expected =
        `Expected "${tool}" to be called` +
        (matcher.with === undefined ? "" : ` with ${describe(matcher.with)}`) +
        (matcher.times === undefined ? "" : ` ${plural(matcher.times, "time")}`);
      const actual = matcher.with === undefined ? "" : `, ${matching.length} of them matching`;
      throw new AssertionError({
        message: `${expected}, but it was called ${plural(calls.length, "time")}${actual}.${listCalls(calls)}`,
      });
    }
    return matching;
  }

  /** Throws if `tool` was called. */
  assertNotCalled(tool: string): void {
    const calls = this.callsTo(tool);
    if (calls.length > 0) {
      throw new AssertionError({
        message: `Expected "${tool}" not to be called, but it was called ${plural(calls.length, "time")}.${listCalls(calls)}`,
      });
    }
  }

  /** Throws unless these tools were called in this order. Other calls may come before, between and after. */
  assertCalledInOrder(...tools: string[]): void {
    let next = 0;
    for (const call of this.#calls) {
      if (call.tool === tools[next]) next++;
      if (next === tools.length) return;
    }
    const order = this.#calls.map((c) => c.tool).join(" → ") || "(no calls)";
    throw new AssertionError({
      message: `Expected calls in the order ${tools.join(" → ")}, but the calls were: ${order}.`,
    });
  }

  /** Closes every connection and stops the HTTP server. Calls that are still waiting are dropped. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const release of this.#waiting) release();
    this.#waiting.clear();
    await Promise.allSettled([...this.#connections].map((conn) => conn.server.close()));
    const http = this.#http;
    if (http) {
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async #handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== this.#path) {
      res.writeHead(404, { "content-type": "text/plain" }).end(`Not found. The MCP endpoint is ${this.#path}`);
      return;
    }
    let body: unknown;
    if (req.method === "POST") {
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendRpcError(res, 400, ErrorCode.ParseError, "Parse error: the body isn't valid JSON");
        return;
      }
    }
    const header = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(header) ? header[0] : header;
    if (sessionId !== undefined) {
      const conn = this.#sessions.get(sessionId);
      if (!conn) {
        sendRpcError(res, 404, -32001, "Session not found");
        return;
      }
      await (conn.transport as StreamableHTTPServerTransport).handleRequest(req, res, body);
      return;
    }
    const initializing = Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body);
    if (req.method !== "POST" || !initializing) {
      sendRpcError(res, 400, ErrorCode.InvalidRequest, "Bad request: send initialize first, or an Mcp-Session-Id header");
      return;
    }
    if (this.#closed) {
      sendRpcError(res, 503, ErrorCode.InternalError, "The mock server is closed");
      return;
    }
    let conn: Connection | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        if (conn) this.#sessions.set(id, conn);
      },
    });
    conn = await this.#attach(transport, "http");
    await transport.handleRequest(req, res, body);
  }

  async #attach(transport: Transport, kind: "http" | "memory"): Promise<Connection> {
    const server = new Server(this.#options.serverInfo ?? { name: "mcp-stub", version: "0.1.0" }, {
      capabilities: { tools: { listChanged: true } },
      ...(this.#options.instructions === undefined ? {} : { instructions: this.#options.instructions }),
    });
    const conn: Connection = { server, transport, kind };
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.#listTools() }) as never);
    // tools/call goes through the fallback handler so `result` steps reach the client unchecked.
    server.fallbackRequestHandler = (request, extra) => {
      if (request.method === "tools/call") return this.#callTool(request, extra, conn) as Promise<never>;
      return Promise.reject(rpcError(ErrorCode.MethodNotFound, "Method not found"));
    };
    server.onerror = () => {};
    server.onclose = () => {
      this.#connections.delete(conn);
      if (transport.sessionId !== undefined) this.#sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    const deliver = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if ("method" in message) {
        this.#messages.push({
          method: message.method,
          params: message.params,
          isRequest: isJSONRPCRequest(message),
          sessionId: transport.sessionId,
          transport: kind,
        });
      }
      deliver?.(message, extra);
    };
    this.#connections.add(conn);
    return conn;
  }

  #listTools(): unknown[] {
    return [...this.#tools].map(([name, { definition: d }]) => ({
      name,
      ...(d.title === undefined ? {} : { title: d.title }),
      ...(d.description === undefined ? {} : { description: d.description }),
      inputSchema: d.inputSchema ?? { type: "object" },
      ...(d.outputSchema === undefined ? {} : { outputSchema: d.outputSchema }),
      ...(d.annotations === undefined ? {} : { annotations: d.annotations }),
    }));
  }

  async #callTool(request: JSONRPCRequest, extra: RequestExtra, conn: Connection): Promise<unknown> {
    const params = isPlainObject(request.params) ? request.params : {};
    const name = typeof params["name"] === "string" ? params["name"] : "";
    const args = isPlainObject(params["arguments"]) ? params["arguments"] : {};
    const meta = isPlainObject(params["_meta"]) ? params["_meta"] : undefined;
    const index = this.#callCounts.get(name) ?? 0;
    this.#callCounts.set(name, index + 1);
    const call: ToolCall = {
      tool: name,
      arguments: args,
      index,
      sessionId: conn.transport.sessionId,
      transport: conn.kind,
      startedAt: Date.now(),
      endedAt: undefined,
      outcome: "pending",
      meta,
    };
    this.#calls.push(call);
    this.#wakeWaiters();
    const finish = (outcome: ToolCall["outcome"]) => {
      call.outcome = outcome;
      call.endedAt = Date.now();
    };

    const state = this.#tools.get(name);
    if (!state) {
      finish("unknown-tool");
      throw rpcError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
    let step = takeStep(state);
    try {
      if (typeof step === "function") step = await step(call);
    } catch (error) {
      finish("protocol-error");
      throw rpcError(ErrorCode.InternalError, error instanceof Error ? error.message : String(error));
    }
    if (typeof step === "function") throw new TypeError(`The step function for "${name}" returned another function.`);

    if ("hang" in step) {
      await this.#wait(undefined, extra.signal);
      finish(extra.signal.aborted ? "cancelled" : "disconnected");
      return {};
    }
    if (step.delayMs !== undefined && step.delayMs > 0) {
      await this.#wait(step.delayMs, extra.signal);
      if (extra.signal.aborted || this.#closed) {
        finish(extra.signal.aborted ? "cancelled" : "disconnected");
        return {};
      }
    }
    if ("disconnect" in step) {
      finish("disconnected");
      await conn.server.close();
      return {};
    }
    if ("throws" in step) {
      finish("protocol-error");
      const e = typeof step.throws === "string" ? { message: step.throws } : step.throws;
      throw rpcError(e.code ?? ErrorCode.InternalError, e.message, e.data);
    }
    if ("toolError" in step) {
      finish("tool-error");
      return { content: [{ type: "text", text: step.toolError }], isError: true };
    }
    finish("result");
    if ("result" in step) return step.result;
    if ("content" in step) {
      return step.structuredContent === undefined
        ? { content: step.content }
        : { content: step.content, structuredContent: step.structuredContent };
    }
    if ("returns" in step) {
      const value = step.returns;
      const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
      const structured = state.definition.outputSchema !== undefined && isPlainObject(value);
      return structured ? { content: [{ type: "text", text }], structuredContent: value } : { content: [{ type: "text", text }] };
    }
    return { content: [] };
  }

  /** Waits `ms` (or forever), until the signal aborts or the server closes. */
  #wait(ms: number | undefined, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.#closed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        this.#waiting.delete(done);
        resolve();
      };
      const timer = ms === undefined ? undefined : setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      this.#waiting.add(done);
    });
  }

  #matchingCalls(tool: string | undefined): ToolCall[] {
    return tool === undefined ? [...this.#calls] : this.callsTo(tool);
  }

  #wakeWaiters(): void {
    this.#waiters = this.#waiters.filter((waiter) => {
      const calls = this.#matchingCalls(waiter.tool);
      if (calls.length < waiter.count) return true;
      waiter.resolve(calls);
      return false;
    });
  }

  async #notifyToolsChanged(): Promise<void> {
    await Promise.allSettled([...this.#connections].map((conn) => conn.server.sendToolListChanged()));
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("The mock server is closed.");
  }
}

function toState(script: ToolScript): ToolState {
  const definition: ToolDefinition =
    typeof script === "function" || Array.isArray(script) || isStep(script) ? { responses: script as Step | Step[] } : script;
  const responses = definition.responses;
  const steps = responses === undefined ? [] : Array.isArray(responses) ? responses : [responses];
  return { definition, steps, cursor: 0, used: 0 };
}

function isStep(value: object): value is Step {
  return STEP_KEYS.some((key) => key in value);
}

/** The next step for a call. The last step repeats once the others are used up. */
function takeStep(state: ToolState): Step {
  const { steps } = state;
  const step = steps[Math.min(state.cursor, steps.length - 1)];
  if (step === undefined) return { content: [] };
  if (state.cursor < steps.length - 1) {
    state.used++;
    const repeat = typeof step === "function" || "hang" in step ? 1 : (step.repeat ?? 1);
    if (state.used >= repeat) {
      state.cursor++;
      state.used = 0;
    }
  }
  return step;
}

function rpcError(code: number, message: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code }, data === undefined ? {} : { data });
}

function sendRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function listCalls(calls: ToolCall[]): string {
  if (calls.length === 0) return "";
  return "\nCalls:\n" + calls.map((c) => `  #${c.index} ${describe(c.arguments)}`).join("\n");
}
