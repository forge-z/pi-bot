import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import {
  LiveDoc,
  type Conversation,
  type Cursor,
  type EntryId,
  type EntryQuery,
  type Harness,
  type SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import { redactSecretPatterns } from "./config.js";
import { summarizeModelUsage } from "./conversation-usage.js";
import { mcpTaskCallId } from "./mcp-calls.js";
import type { Store } from "./store.js";

interface ToolReceipt {
  name: string;
  calls: number;
  ok: number;
  errors: number;
  unverified: number;
  durationMs: number | null;
}

interface ReceiptSummary {
  tools: ToolReceipt[];
  approvals: { requested: number; remembered: number };
  searches: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
}

interface ReceiptRow {
  status: "done" | "unanswered";
  summary: string;
}

const count = new Intl.NumberFormat("pt-BR");
const dollars = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 });

export class TurnReceipts {
  constructor(private store: Store) {}

  async record(
    harness: Harness,
    conversation: Conversation,
    settled: SettledSubmissionRecord,
    tools: ReadonlyMap<string, string>,
    redact = redactSecretPatterns,
  ) {
    if (settled.type !== "input") return;
    const conversationId = String(settled.conversationId);
    // Steers that share a final answer share one receipt, not one per message.
    const bounds = await harness.commit(async (tx) => {
      if (settled.status === "done") {
        let first = settled.entry;
        const pending = this.store.all<{ requestId: string }>(
          "SELECT requestId FROM requests WHERE conversationId=? AND status='pending'",
          conversationId,
        );
        for (const { requestId } of pending) {
          const input = await tx.submissionByRequest(
            settled.conversationId,
            requestId,
          );
          if (
            input?.type === "input" &&
            input.status === "done" &&
            input.answer === settled.answer &&
            input.entry < first
          )
            first = input.entry;
        }
        return { key: Number(settled.answer), first, last: settled.answer };
      }
      const live = await tx.doc(LiveDoc, settled.conversationId);
      const failure = live.runFailure;
      if (!failure?.inputs.includes(settled.id))
        return { key: -Number(settled.id) };
      const next = live.run?.first;
      const { items } = await tx.scanEntries(
        {
          conversationId: settled.conversationId,
          minEntryId: failure.first,
          maxEntryId: next === undefined ? undefined : ((next - 1) as EntryId),
        },
        1,
      );
      return {
        key: -Number(failure.inputs[0]),
        first: failure.first,
        last: items[0]?.id,
      };
    }, context);
    const existing = this.store.get<ReceiptRow>(
      "SELECT status,summary FROM turn_receipts WHERE conversationId=? AND turnKey=?",
      conversationId,
      bounds.key,
    );
    if (existing) return JSON.parse(existing.summary) as ReceiptSummary;

    const recorded = new Map<string, ToolReceipt>();
    const usages: Usage[] = [];
    const approvals = { requested: 0, remembered: 0 };
    let searches = 0;
    const hasMcp = this.store.get(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mcp_calls'",
    );
    const addTool = (message: ToolResultMessage, taskId?: number) => {
      const { toolName, isError, durationMs, details } = message;
      const callId =
        hasMcp && taskId !== undefined
          ? mcpTaskCallId(conversationId, taskId)
          : undefined;
      const call =
        callId &&
        this.store.get<{ state: string }>(
          "SELECT state FROM mcp_calls WHERE id=?",
          callId,
        );
      const approval =
        details &&
        typeof details === "object" &&
        "receiptApprovalRequested" in details &&
        details.receiptApprovalRequested === true;
      if (approval) approvals.requested++;
      const unverified =
        approval ||
        (!!call && ["uncertain", "running", "paused"].includes(call.state));
      if (callId) {
        const counted = this.store.get<{ total: number; remembered: number }>(
          `SELECT COUNT(*) AS total, COALESCE(SUM(json_valid(response)
             AND json_extract(response,'$.remembered') IS NOT NULL),0) AS remembered
           FROM mcp_interactions WHERE conversationId=? AND callId=?
           AND (kind='form' OR (kind='resume' AND json_valid(payload)
             AND json_extract(payload,'$.status')='approval-required'))`,
          conversationId,
          callId,
        );
        approvals.requested +=
          (counted?.total ?? 0) - (counted?.remembered ?? 0);
        approvals.remembered += counted?.remembered ?? 0;
      }
      const label = tools.get(toolName);
      const operation = label?.slice(label.indexOf("/") + 1);
      if (
        operation &&
        /(?:^|[\/_.-])search(?:$|[\/_.-])/i.test(
          operation.replace(/([a-z0-9])([A-Z])/g, "$1_$2"),
        )
      )
        searches++;
      const name =
        label && /^[\w./-]{1,120}$/.test(label)
          ? redactSecretPatterns(redact(label))
          : "(ferramenta não identificada)";
      const tally = recorded.get(name) ?? {
        name,
        calls: 0,
        ok: 0,
        errors: 0,
        unverified: 0,
        durationMs: 0,
      };
      tally.calls++;
      if (unverified) tally.unverified++;
      else if (
        isError ||
        (call && ["failed", "skipped", "abandoned"].includes(call.state))
      )
        tally.errors++;
      else tally.ok++;
      tally.durationMs =
        tally.durationMs !== null &&
        durationMs !== undefined &&
        Number.isFinite(durationMs) &&
        durationMs >= 0
          ? tally.durationMs + durationMs
          : null;
      recorded.set(name, tally);
    };
    const scan = async (
      query: Omit<EntryQuery, "conversationId">,
      visit: (
        entry: Awaited<ReturnType<Conversation["entries"]>>["items"][number],
      ) => boolean,
    ) => {
      let cursor: Cursor | undefined;
      do {
        const page = await conversation.entries(
          { ...query, order: "ascending" },
          100,
          cursor,
          context,
        );
        for (const entry of page.items) if (!visit(entry)) return;
        cursor = page.next;
      } while (cursor);
    };
    const finalCalls = new Set<string>();
    if (bounds.first !== undefined && bounds.last !== undefined)
      await scan(
        { minEntryId: bounds.first, maxEntryId: bounds.last },
        (entry) => {
          if (String(entry.conversationId) !== conversationId) return true;
          for (const message of entry.model ?? []) {
            if (message.role === "assistant") {
              if (message.usage) usages.push(message.usage);
              if (settled.status === "done" && entry.id === settled.answer)
                for (const part of message.content)
                  if (part.type === "toolCall") finalCalls.add(part.id);
            } else if (message.role === "toolResult") {
              addTool(message, entry.byTaskId);
            }
          }
          return true;
        },
      );
    // A terminating tool round settles with its assistant entry, before its results.
    if (bounds.last !== undefined && finalCalls.size)
      await scan({ minEntryId: (bounds.last + 1) as EntryId }, (entry) => {
        for (const message of entry.model ?? []) {
          if (message.role === "assistant") return false;
          if (
            message.role === "toolResult" &&
            finalCalls.delete(message.toolCallId)
          )
            addTool(message, entry.byTaskId);
        }
        return finalCalls.size > 0;
      });
    const { tokens, usd } = summarizeModelUsage(usages);
    const summary: ReceiptSummary = {
      tools: [...recorded.values()],
      approvals,
      searches,
      inputTokens: tokens.prompt,
      outputTokens: tokens.output,
      usd: usages.length && usd.available ? usd.total : null,
    };
    if (this.store.conversationDeleted(conversationId)) return;
    this.store.run(
      "INSERT OR IGNORE INTO turn_receipts VALUES (?,?,?,?)",
      conversationId,
      bounds.key,
      settled.status,
      JSON.stringify(summary),
    );
    return summary;
  }

  show(conversationId: string, argument: string) {
    const ordinal = argument ? Number(argument) : 1;
    if (
      (argument && !/^[1-9]\d*$/.test(argument)) ||
      !Number.isSafeInteger(ordinal)
    )
      return "Uso: /receipt ou /receipt <n> (1 = último turno).";
    const row = this.store.get<ReceiptRow>(
      `SELECT status,summary FROM turn_receipts WHERE conversationId=?
       ORDER BY rowid DESC LIMIT 1 OFFSET ?`,
      conversationId,
      ordinal - 1,
    );
    if (!row) return "Nenhum recibo encontrado para esse turno.";
    const data = JSON.parse(row.summary) as ReceiptSummary;
    return [
      ordinal === 1
        ? "Recibo do último turno"
        : `Recibo — ${ordinal}º turno mais recente`,
      row.status === "done" ? "Turno concluído." : "Turno sem resposta.",
      data.tools.length ? "Ferramentas:" : "Nenhuma ferramenta chamada.",
      ...data.tools.map(
        (item) =>
          `• ${item.name}: ${item.calls} chamada(s), ${item.ok} ok, ${item.errors} erro(s), ${item.unverified} sem verificar · ${item.durationMs === null ? "tempo indisponível" : `${count.format(item.durationMs)} ms`}`,
      ),
      `Aprovações: ${data.approvals.requested} pedida(s), ${data.approvals.remembered} lembrada(s).`,
      `Buscas: ${data.searches}.`,
      `Modelo: ${count.format(data.inputTokens)} tokens de entrada, ${count.format(data.outputTokens)} de saída · ${cost(data)}.`,
    ].join("\n");
  }
}

function cost(summary: ReceiptSummary) {
  return summary.usd === null
    ? "custo indisponível"
    : `US$ ${dollars.format(summary.usd)}`;
}

export function receiptFooter(summary: ReceiptSummary) {
  const calls = summary.tools.reduce((total, tool) => total + tool.calls, 0);
  return `Recibo: ${calls} chamada(s) · ${count.format(summary.inputTokens + summary.outputTokens)} tokens · ${cost(summary)} · /receipt`;
}
