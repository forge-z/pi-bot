import { registerHooks } from "node:module";

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

await import(new URL("../scripts/setup-model.mjs", import.meta.url).href);
