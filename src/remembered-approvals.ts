import type { Store } from "./store.js";

/** A read the user chose to always allow: one server, one tool and, when the call names one, one resource. */
export interface RememberedApproval {
  id: number;
  server: string;
  tool: string;
  resource: string | null;
  binding: string;
  origin: string;
  conversationId: string;
  createdAt: number;
}

export interface ApprovalTarget {
  server: string;
  tool: string;
  resource: string | null;
  binding: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Argument names that pick the thing a read looks at, folded (lowercase, no separators). */
const RESOURCE_KEYS = new Set([
  "account",
  "accountid",
  "base",
  "baseid",
  "board",
  "boardid",
  "calendar",
  "calendarid",
  "channel",
  "channelid",
  "database",
  "databaseid",
  "document",
  "documentid",
  "drive",
  "driveid",
  "file",
  "fileid",
  "folder",
  "folderid",
  "label",
  "labelid",
  "list",
  "listid",
  "mailbox",
  "org",
  "organization",
  "owner",
  "page",
  "pageid",
  "project",
  "projectid",
  "repo",
  "repository",
  "sheet",
  "sheetid",
  "site",
  "siteid",
  "spreadsheet",
  "spreadsheetid",
  "table",
  "tableid",
  "team",
  "teamid",
  "workspace",
  "workspaceid",
]);

const fold = (name: string) => name.replace(/[_.:/-]/g, "").toLowerCase();

/** The resource named by a call's arguments, as stable JSON, or null when none is named. */
export function approvalResource(input: unknown): string | null {
  if (!object(input)) return null;
  const picked: [string, string | number | boolean][] = [];
  for (const [key, value] of Object.entries(input)) {
    if (!RESOURCE_KEYS.has(fold(key))) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      picked.push([fold(key), value]);
  }
  if (!picked.length) return null;
  picked.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(picked));
}

/** Words that never become a remembered approval, whatever a read list says. */
const NEVER = new Set([
  "send",
  "reply",
  "forward",
  "post",
  "publish",
  "delete",
  "remove",
  "destroy",
  "purge",
  "trash",
  "pay",
  "payment",
  "payout",
  "charge",
  "transfer",
  "refund",
  "purchase",
  "buy",
  "order",
  "invoice",
  "create",
  "update",
  "write",
  "set",
  "put",
  "patch",
  "upload",
  "merge",
  "revoke",
  "exec",
  "run",
  "start",
  "stop",
  "execute",
  "call",
  "resume",
]);

/** True when no word of the path is a send, delete, payment or other write verb. */
export function rememberableToolName(tool: string) {
  const trimmed = tool.trim();
  if (!trimmed || trimmed.length > 200) return false;
  const words = trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  return words.length > 0 && !words.some((word) => NEVER.has(word));
}

export class RememberedApprovals {
  constructor(private store: Store) {
    store.db.exec(
      `CREATE TABLE IF NOT EXISTS remembered_approvals(id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL, tool TEXT NOT NULL, resource TEXT, binding TEXT NOT NULL, origin TEXT NOT NULL, conversationId TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS remembered_approvals_target ON remembered_approvals(server,tool);`,
    );
  }
  /** The rule for exactly this target. A changed credential binding never matches. */
  match(target: ApprovalTarget) {
    return this.store.get<RememberedApproval>(
      "SELECT * FROM remembered_approvals WHERE server=? AND tool=? AND resource IS ? AND binding=? ORDER BY id LIMIT 1",
      target.server,
      target.tool,
      target.resource,
      target.binding,
    );
  }
  remember(target: ApprovalTarget, origin: string, conversationId: string) {
    const existing = this.match(target);
    if (existing) return existing;
    const id = Number(
      this.store.run(
        "INSERT INTO remembered_approvals(server,tool,resource,binding,origin,conversationId,createdAt) VALUES (?,?,?,?,?,?,?)",
        target.server,
        target.tool,
        target.resource,
        target.binding,
        origin,
        conversationId,
        Date.now(),
      ).lastInsertRowid,
    );
    return this.store.get<RememberedApproval>(
      "SELECT * FROM remembered_approvals WHERE id=?",
      id,
    )!;
  }
  list() {
    return this.store.all<RememberedApproval>(
      "SELECT * FROM remembered_approvals ORDER BY id",
    );
  }
  revoke(id: number) {
    return (
      Number(
        this.store.run("DELETE FROM remembered_approvals WHERE id=?", id)
          .changes,
      ) > 0
    );
  }
}

/** `/approvals` body: one line per rule, numbered by its id for `/revoke <n>`. */
export function formatRememberedApprovals(rules: RememberedApproval[]) {
  if (!rules.length)
    return "No remembered approvals. A read approval card offers “Sempre permitir isto”.";
  const lines = rules.map((rule) => {
    const resource = rule.resource
      ? ` · ${Object.entries(JSON.parse(rule.resource) as Record<string, unknown>)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(", ")}`
      : "";
    const date = new Date(rule.createdAt).toISOString().slice(0, 16);
    return `${rule.id}. ${rule.server}/${rule.tool}${resource} · ${date} UTC · ${rule.origin}`;
  });
  return [
    "Remembered approvals (reads only):",
    ...lines,
    "",
    "/revoke <n> removes one; that read asks again.",
  ].join("\n");
}

/** `/revoke <n>`: removes one rule by the number `/approvals` shows. */
export function revokeRememberedApproval(
  rules: RememberedApprovals,
  argument: string,
) {
  const match = /^(\d{1,9})$/.exec(argument.trim());
  if (!match) return "Use /revoke <n> with a number from /approvals.";
  return rules.revoke(Number(match[1]))
    ? `Approval ${match[1]} revoked. That read asks for approval again.`
    : `No remembered approval ${match[1]}. Use /approvals to see the list.`;
}
