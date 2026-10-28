/** A JSON-RPC error the server sends instead of a result. */
export interface ProtocolError {
  /** JSON-RPC error code. Defaults to -32603 (internal error). */
  code?: number;
  message: string;
  data?: unknown;
}

/** Fields every step can carry. */
export interface StepTiming {
  /** Wait this long before answering. A cancelled call stops waiting and sends nothing. */
  delayMs?: number;
  /** Use this step for this many calls before moving to the next one. Defaults to 1. */
  repeat?: number;
}

/**
 * One scripted answer to a tool call. Each call to a tool takes the next step in its list,
 * and the last step repeats once the list runs out.
 */
export type Step =
  | (StepTiming & {
      /** Reply with this value: a string becomes one text block, anything else becomes JSON text. */
      returns: unknown;
    })
  | (StepTiming & {
      /** Reply with these content blocks as they are. */
      content: unknown[];
      structuredContent?: Record<string, unknown>;
    })
  | (StepTiming & {
      /** Send this as the JSON-RPC result without checking it, to test how the agent handles a malformed reply. */
      result: unknown;
    })
  | (StepTiming & {
      /** Reply with a tool error (`isError: true`) carrying this text, the way MCP servers report failed tool runs. */
      toolError: string;
    })
  | (StepTiming & {
      /** Answer with a JSON-RPC error instead of a result. A string becomes the message. */
      throws: string | ProtocolError;
    })
  | {
      /** Never answer. The call stays open until the client cancels it or the server closes. */
      hang: true;
    }
  | (StepTiming & {
      /** Drop the connection mid-call. Over HTTP the session is gone too, so the client has to initialize again. */
      disconnect: true;
    })
  | (StepTiming & { delayMs: number })
  | StepFunction;

/** A step worked out at call time, for answers that depend on the arguments. */
export type StepFunction = (call: ToolCall) => Step | Promise<Step>;

/** A tool's definition and script. */
export interface ToolDefinition {
  title?: string;
  description?: string;
  /** JSON Schema for the arguments. Defaults to `{ type: "object" }`. Arguments aren't checked against it. */
  inputSchema?: Record<string, unknown>;
  /** JSON Schema for the result. When set, `returns` objects are also sent as `structuredContent`. */
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /** The steps calls go through. Defaults to an empty result. */
  responses?: Step | Step[];
}

/** A tool given as its steps alone, one step, or a full definition. */
export type ToolScript = Step | Step[] | ToolDefinition;

/** What happened to a tool call. */
export type CallOutcome =
  | "pending"
  | "result"
  | "tool-error"
  | "protocol-error"
  | "unknown-tool"
  | "cancelled"
  | "disconnected";

/** A tool call the server received. */
export interface ToolCall {
  /** The tool's name, as the client sent it. */
  tool: string;
  /** The arguments, as the client sent them. */
  arguments: Record<string, unknown>;
  /** How many calls to this tool came before this one, starting at 0. */
  index: number;
  /** The MCP session ID over HTTP, or `undefined` in memory. */
  sessionId: string | undefined;
  transport: "http" | "memory";
  /** `Date.now()` when the call arrived. */
  startedAt: number;
  /** `Date.now()` when the call finished, or `undefined` while it's still open. */
  endedAt: number | undefined;
  outcome: CallOutcome;
  /** The `_meta` the client sent with the call, if any. */
  meta: Record<string, unknown> | undefined;
}

/** A JSON-RPC message the server received. */
export interface ReceivedMessage {
  method: string;
  params: unknown;
  /** `true` for a request, `false` for a notification. */
  isRequest: boolean;
  sessionId: string | undefined;
  transport: "http" | "memory";
}

export interface MockMcpOptions {
  /** The tools to offer, by name. */
  tools?: Record<string, ToolScript>;
  /** Port to listen on. Defaults to a free one. */
  port?: number;
  /** Host to listen on. Defaults to 127.0.0.1. */
  host?: string;
  /** Path for the MCP endpoint. Defaults to "/mcp". */
  path?: string;
  /** Set to false to skip the HTTP server and only connect in memory. */
  http?: boolean;
  /** The server name and version sent on initialize. */
  serverInfo?: { name: string; version: string };
  /** Instructions sent on initialize. */
  instructions?: string;
}

export interface CallMatcher {
  /** The exact number of calls expected. */
  times?: number;
  /** A call with arguments that match this (deep, partial; RegExps test strings). */
  with?: Record<string, unknown>;
}
