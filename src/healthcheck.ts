import { readFileSync } from "node:fs";
try {
  const { at } = JSON.parse(
    // Same normalization as main.ts, which writes this file.
    readFileSync(
      `${(process.env.DATA_DIR ?? "data").trim() || "data"}/health.json`,
      "utf8",
    ),
  );
  process.exit(typeof at === "number" && Date.now() - at < 90_000 ? 0 : 1);
} catch {
  process.exit(1);
}
