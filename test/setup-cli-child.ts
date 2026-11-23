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

await import(new URL("../scripts/setup-model.mjs", import.meta.url).href);
