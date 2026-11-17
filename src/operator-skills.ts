import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-durable";
import { parse } from "yaml";
import { loadHarnessConfig } from "./harness-config.js";

/**
 * Operator skills on the data volume: `$DATA_DIR/skills/<name>/SKILL.md`.
 * `skills.always` lists the folder names. The prompt lists each name and
 * description. `read_skill` returns the body. A missing name, invalid
 * frontmatter, or unreadable file is logged and skipped.
 */

type Env = Record<string, string | undefined>;

/** Model-facing name. Registered only when at least one skill loaded. */
export const READ_SKILL_TOOL_NAME = "read_skill";

export interface OperatorSkill {
  name: string;
  /** Frontmatter `description`: when the skill applies. */
  description: string;
  body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function dataDir(env: Env) {
  return env.DATA_DIR?.trim() || "data";
}

/** One path segment. `..` and separators would escape `$DATA_DIR/skills`. */
function folderName(name: string) {
  return (
    name.length > 0 &&
    name === name.trim() &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(name)
  );
}

function skip(name: string, reason: string) {
  const label = name.replace(/\s+/g, " ").slice(0, 80);
  console.error(`Pi-Agent: skill ${label} ignorada (${reason}).`);
}

function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

const CATALOG_HEADER =
  "Operator skills. Each line is a name and when to use it. Call read_skill with the name to load the full instructions, then follow that body.";

function skillFile(
  text: string,
  folder: string,
): { description: string; body: string } | undefined {
  const source = text.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) {
    skip(folder, "frontmatter inválido");
    return;
  }
  let parsed: unknown;
  try {
    parsed = parse(match[1]);
  } catch {
    skip(folder, "frontmatter inválido");
    return;
  }
  if (!isRecord(parsed)) {
    skip(folder, "frontmatter inválido");
    return;
  }
  if (typeof parsed.name !== "string" || parsed.name !== folder) {
    skip(folder, "name ausente ou diferente da pasta");
    return;
  }
  if (typeof parsed.description !== "string" || !parsed.description.trim()) {
    skip(folder, "frontmatter inválido");
    return;
  }
  const body = match[2].trim();
  if (!body) {
    skip(folder, "corpo vazio");
    return;
  }
  return { description: parsed.description.trim(), body };
}

function readSkill(dir: string, name: string): OperatorSkill | undefined {
  if (!folderName(name)) {
    skip(name, "nome inválido");
    return;
  }
  let text: string;
  try {
    text = readFileSync(join(dir, name, "SKILL.md"), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    skip(name, code === "ENOENT" ? "não encontrada" : "ilegível");
    return;
  }
  const parsed = skillFile(text, name);
  if (!parsed) return;
  return { name, ...parsed };
}

/**
 * Skills for `skills.always`, in list order.
 * A missing, unreadable, or invalid file is logged and skipped.
 * This never throws.
 */
export function loadOperatorSkills(env: Env = process.env): OperatorSkill[] {
  try {
    const names = loadHarnessConfig(env).skillsAlways;
    const dir = join(dataDir(env), "skills");
    const skills: OperatorSkill[] = [];
    for (const name of names) {
      const skill = readSkill(dir, name);
      if (skill) skills.push(skill);
    }
    return skills;
  } catch (error) {
    console.error(
      `Pi-Agent: skills ignoradas (${error instanceof Error ? error.name : "erro"}).`,
    );
    return [];
  }
}

/** Name and trigger only. Empty when nothing loaded, so the prompt stays unchanged. */
export function operatorSkillCatalog(skills: readonly OperatorSkill[]): string {
  if (!skills.length) return "";
  return [
    CATALOG_HEADER,
    ...skills.map((skill) => `- ${skill.name}: ${oneLine(skill.description)}`),
  ].join("\n");
}

export function unknownSkillMessage(name: string) {
  const label = name
    .replace(/[\u0000-\u001f]/g, " ")
    .trim()
    .slice(0, 80);
  return `Unknown skill "${label || "(blank)"}". Use a name from the operator skills list.`;
}

/** Read-only. The name is matched against skills loaded at startup, never a path. */
export function createReadSkillTool(skills: readonly OperatorSkill[]) {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return defineTool({
    name: READ_SKILL_TOOL_NAME,
    description:
      "Read the full instructions of one operator skill by the name listed in the prompt. Read-only. Call it when a listed skill applies, then follow the returned body.",
    parameters: Type.Object({
      name: Type.String({
        description: "Skill name from the operator skills list",
        minLength: 1,
        maxLength: 80,
      }),
    }),
    replay: "safe",
    execute: async (args) => {
      const skill = byName.get(args.name.trim());
      if (!skill)
        return {
          isError: true,
          output: [
            { type: "text" as const, text: unknownSkillMessage(args.name) },
          ],
        };
      return { output: [{ type: "text" as const, text: skill.body }] };
    },
  });
}
