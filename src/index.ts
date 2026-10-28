/**
 * A scripted mock MCP server for testing agents: per-call responses, injected errors, latency and
 * dropped connections, plus assertions on which tools the agent called and with what arguments.
 *
 * @example
 * import { mockMcp } from "mcp-stub";
 *
 * const server = await mockMcp({
 *   tools: {
 *     search_issues: [
 *       { returns: [{ id: 1, title: "Bug" }] }, // 1st call
 *       { throws: "rate_limited" },            // 2nd call
 *       { delayMs: 30_000 },                   // 3rd call hangs
 *     ],
 *   },
 * });
 * // point your agent at server.url, then:
 * server.assertCalled("search_issues", { times: 3 });
 * await server.close();
 */
export { mockMcp, MockMcpServer } from "./server.js";
export { matches } from "./match.js";
export type {
  CallMatcher,
  CallOutcome,
  MockMcpOptions,
  ProtocolError,
  ReceivedMessage,
  Step,
  StepFunction,
  StepTiming,
  ToolCall,
  ToolDefinition,
  ToolScript,
} from "./types.js";
