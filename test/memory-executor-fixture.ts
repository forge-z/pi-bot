import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const executorFixtureUrl = "https://mcp.executor.sh/mcp";

export function executorReply(body: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

// Exercise the real MCP SDK and gateway with synthetic JSON-RPC at the HTTP boundary.
export function executorFixture(
  reply: (
    name: string,
    args: Record<string, unknown>,
  ) => CallToolResult | Promise<CallToolResult>,
) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input) !== executorFixtureUrl)
      throw new Error("Unexpected MCP endpoint");
    if (init?.method !== "POST") return new Response(null, { status: 405 });
    const { method, id, params } = JSON.parse(String(init.body));
    if (id === undefined) return new Response(null, { status: 202 });
    let result;
    if (method === "initialize")
      result = {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "executor-fixture", version: "1" },
      };
    else if (method === "tools/list")
      result = {
        tools: ["search", "describe", "call"].map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
      };
    else if (method === "tools/call") {
      const { name, arguments: args } = params;
      calls.push({ name, args });
      result = await reply(name, args);
    } else throw new Error("Unexpected MCP method");
    return Response.json({ jsonrpc: "2.0", id, result });
  };
  return { fetch, calls };
}
