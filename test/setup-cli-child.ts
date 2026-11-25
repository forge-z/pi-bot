import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
import { executorFixture, executorReply } from "./memory-executor-fixture.js";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith("/scripts/setup-model.mjs") &&
      specifier.startsWith("../dist/src/")
    ) {
      specifier = specifier
        .replace("../dist/src/", "../src/")
        .replace(/\.js$/, ".ts");
    }
    return nextResolve(specifier, context);
  },
});

if (process.env.SETUP_TEST_EXECUTOR === "1") {
  const resource = "https://executor.example/mcp?connection=bot";
  const issuer = "https://executor.example/auth";
  globalThis.fetch = async (input) => {
    const url = String(input);
    switch (url) {
      case "https://executor.example/.well-known/oauth-protected-resource/mcp?connection=bot":
        return Response.json({ resource, authorization_servers: [issuer] });
      case "https://executor.example/.well-known/oauth-authorization-server/auth":
        return Response.json({
          issuer,
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
          registration_endpoint: issuer + "/register",
        });
      case issuer + "/register":
        return Response.json({ client_id: "test-client" });
      case issuer + "/token":
        return Response.json({
          access_token: "test-access",
          refresh_token: "test-refresh",
          expires_in: 3600,
        });
      case "https://executor.example/mcp/whoami?connection=bot":
        return Response.json({
          organization: { id: "test-org" },
          access: { kind: "connection", id: "bot" },
          mode: "model",
        });
      default:
        throw new Error(`Unexpected setup test fetch: ${url}`);
    }
  };
}

const trace = process.env.SETUP_TEST_MEMORY;
if (trace) {
  globalThis.fetch = executorFixture((name, args) => {
    appendFileSync(trace, JSON.stringify({ name, args }) + "\n");
    if (name !== "describe") throw new Error("Setup executed an app tool");
    const tools = process.env.SETUP_TEST_MEMORY_DUPLICATE
      ? [
          { path: "tools.foobar.recall" },
          { path: "tools.foobar.recall" },
          { path: "tools.foobar.retain" },
        ]
      : [
          { path: 'tools["foo-bar"].recall' },
          { path: 'tools["foo-bar"].retain' },
        ];
    return executorReply({
      result: JSON.stringify({ items: tools, namespaces: [], missing: [] }),
    });
  }).fetch;
}

await import(new URL("../scripts/setup-model.mjs", import.meta.url).href);
