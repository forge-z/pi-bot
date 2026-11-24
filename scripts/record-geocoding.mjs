import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const file = new URL("../test/geocoding-fixtures.json", import.meta.url);
const fixture = JSON.parse(await readFile(file, "utf8"));

// Compare types by field path without depending on result count or order.
function shape(value) {
  const fields = new Set();
  function visit(node, path) {
    if (Array.isArray(node)) {
      fields.add(`${path}: array`);
      for (const item of node) visit(item, `${path}[]`);
    } else if (node === null) {
      fields.add(`${path}: null`);
    } else if (typeof node === "object") {
      fields.add(`${path}: object`);
      for (const [key, child] of Object.entries(node))
        visit(child, `${path}.${key}`);
    } else {
      fields.add(`${path}: ${typeof node}`);
    }
  }
  visit(value, "$");
  return fields;
}

const responses = {};
const recordedOn = new Date().toISOString().slice(0, 10);
for (const [url, previous] of Object.entries(fixture.responses)) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const current = await response.json();
  if (
    !current ||
    typeof current !== "object" ||
    Array.isArray(current) ||
    current.error === true
  )
    throw new Error(`Invalid geocoding response for ${url}`);

  const before = shape(previous);
  const after = shape(current);
  const removed = [...before.difference(after)].sort();
  const added = [...after.difference(before)].sort();
  if (removed.length || added.length)
    console.warn(
      `Response shape changed for ${url}\n${[
        ...removed.map((field) => `- ${field}`),
        ...added.map((field) => `+ ${field}`),
      ].join("\n")}`,
    );
  responses[url] = current;
}

const json = await format(
  JSON.stringify({ ...fixture, recordedOn, responses }),
  {
    filepath: fileURLToPath(file),
  },
);
const temporary = new URL(`geocoding-fixtures.${process.pid}.tmp`, file);
try {
  await writeFile(temporary, json, { flag: "wx" });
  await rename(temporary, file);
} finally {
  await rm(temporary, { force: true });
}
console.log(
  `Recorded ${Object.keys(responses).length} geocoding responses on ${recordedOn}.`,
);
