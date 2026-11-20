import { Type } from "typebox";
import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineExtension,
  defineTool,
  section,
  type ConversationId,
  type EntryId,
  type Extension,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import type { SubagentsConfig } from "./harness-config.js";
import { wrapUntrustedToolResult } from "./untrusted.js";

/** Model-facing name, and the extension that carries it. */
const SUBAGENT_TOOL_NAME = "subagent";

/** Cap on one task text, and on the answer each task brings back. */
const MAX_TASK_CHARS = 8000;
const MAX_ANSWER_CHARS = 6000;

/**
 * Fixed system section while the tool is registered. `max_parallel` comes from
 * config and does not change until restart, so the prefix stays stable.
 */
export function subagentRule(maxParallel: number) {
  return `Use subagent to delegate self-contained read-only work that needs many tool calls or large reads: broad research across several sources, reading long documents or many results, comparing options. Each task must carry everything it needs (the subagent cannot see this conversation) and ask for a compact answer. Use tasks (up to ${maxParallel}) only for independent parts. Do not delegate a quick reply, a single lookup, or anything that changes data, sends messages, schedules, or needs approval: do that yourself. When the user asks for a subagent, use it. The answer comes back to you; you reply to the user.`;
}

/** The child's `instructions`. Its only system text besides the MCP sections. */
export const SUBAGENT_CHILD_INSTRUCTIONS =
  "You are a subagent working for another assistant, not for the user directly. Do only the task in the message, using read-only MCP tools when needed. You cannot change data, send messages, create schedules, call notify, tasks_create or ask_user, or wait for an approval: those tools do not exist here, and any MCP call that writes is refused. If the task needs one of those, say so in your answer. Your final text is returned to the assistant that called you. Keep it compact: the facts, numbers and sources it needs, and what you could not find.";

/** Returned for an MCP call that is not a read inside a subagent. Never sent. */
export const SUBAGENT_WRITE_REFUSAL =
  "Subagents are read-only: this call was not sent. Return what you found and say the action must be done by the main assistant.";

/** Stands in for a file an MCP tool produced inside a subagent. The child has no chat. */
export const SUBAGENT_MEDIA_OMITTED =
  "[arquivo omitido: um subagente não envia arquivos ao chat]";

const NESTED_REFUSAL = "Um subagente não pode criar outro subagente.";
const ARGS_REFUSAL = "Informe task ou tasks, não os dois.";

export interface SubagentHost {
  /** Parent conversation id when `id` is a subagent, otherwise null. */
  subagentParent(id: string): Promise<string | null>;
  /** The extensions a new child selects: MCP and, when installed, tool_search. */
  childExtensions(): Extension[];
}

/** Every conversation owned by `parent`, oldest first. Depth 1: children have none. */
export async function ownedConversations(
  commit: <T>(change: (tx: Tx) => Promise<T>) => Promise<T>,
  parent: ConversationId,
) {
  const ids: ConversationId[] = [];
  let cursor: Parameters<Tx["scanConversations"]>[2];
  do {
    const page = await commit((tx) =>
      tx.scanConversations(
        { ownerConversationId: parent, order: "ascending" },
        1000,
        cursor,
      ),
    );
    ids.push(...page.items.map((item) => item.id));
    cursor = page.next;
  } while (cursor);
  return ids;
}

async function answerText(
  api: ToolExecutionApi,
  answer: EntryId,
  callContext: Context,
) {
  const entry = await api.commit(
    (tx) => tx.entry(AssistantEntry, answer),
    callContext,
  );
  const message = entry?.model?.[0] as AssistantMessage | undefined;
  const text = (message?.content ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
  return text.length > MAX_ANSWER_CHARS
    ? `${text.slice(0, MAX_ANSWER_CHARS)}\n[resposta cortada em ${MAX_ANSWER_CHARS} caracteres]`
    : text;
}

function refusal(text: string) {
  return { isError: true, output: [{ type: "text" as const, text }] };
}

export function createSubagentExtension(
  host: SubagentHost,
  config: SubagentsConfig,
) {
  const taskText = Type.String({ minLength: 1, maxLength: MAX_TASK_CHARS });
  return defineExtension({
    name: SUBAGENT_TOOL_NAME,
    sections: [
      section("subagents", () => subagentRule(config.maxParallel), {
        tag: false,
      }),
    ],
    tools: [
      defineTool({
        name: SUBAGENT_TOOL_NAME,
        description: `Delegate self-contained read-only work to a subagent and get its final answer back. The subagent does not see this conversation: put everything it needs in the task. Use task for one job, or tasks (up to ${config.maxParallel}) for independent jobs that run in parallel.`,
        parameters: Type.Object({
          task: Type.Optional(taskText),
          tasks: Type.Optional(
            Type.Array(Type.Object({ task: taskText }), {
              minItems: 1,
              maxItems: config.maxParallel,
            }),
          ),
        }),
        // A rerun finds the children this call created and the submissions it made.
        replay: "safe",
        execute: async (args, api, callContext) => {
          if (await host.subagentParent(String(api.conversationId)))
            return refusal(NESTED_REFUSAL);
          if ((args.task === undefined) === (args.tasks === undefined))
            return refusal(ARGS_REFUSAL);
          const tasks = args.tasks?.map((item) => item.task) ?? [args.task!];
          const children = await api.commit(async (tx) => {
            // Reads first: a table read after a write in one commit is refused.
            const existing = (
              await tx.scanConversations(
                { ownerTaskId: api.taskId, order: "ascending" },
                tasks.length,
              )
            ).items;
            if (existing.length === tasks.length)
              return existing.map((item) => item.id);
            if (existing.length > 0)
              throw new Error("subagent children do not match this call");
            const ids: ConversationId[] = [];
            for (let i = 0; i < tasks.length; i++) {
              // Starts as a copy of the parent's agent, so the model is inherited.
              const created = await tx.createConversation({
                ownership: { kind: "task", taskId: api.taskId },
              });
              await configure(tx, created.id, {
                extensions: host.childExtensions(),
                thinkingLevel: config.thinking,
                maxTurns: config.maxTurns,
                instructions: SUBAGENT_CHILD_INSTRUCTIONS,
              });
              ids.push(created.id);
            }
            return ids;
          }, callContext);
          await api.details({ conversationIds: children }, callContext);
          const results = await Promise.allSettled(
            children.map(async (id, index) => {
              const handle = await api.conversation(id, callContext);
              if (!handle) return `[tarefa ${index + 1} sem resposta: missing]`;
              const submission = await handle.submit(
                {
                  type: "input",
                  content: tasks[index]!,
                  requestId: `subagent:${api.taskId}:${index}`,
                },
                callContext,
              );
              const settled = await submission.wait(callContext);
              if (settled.status === "done" && settled.type === "input")
                return answerText(api, settled.answer, callContext);
              const category =
                "reason" in settled &&
                typeof settled.reason === "string" &&
                settled.reason.trim()
                  ? settled.reason.trim()
                  : settled.status;
              return category === "aborted"
                ? `[tarefa ${index + 1} interrompida]`
                : `[tarefa ${index + 1} sem resposta: ${category}]`;
            }),
          );
          const parts = results.map((result, index) =>
            result.status === "fulfilled"
              ? result.value || `[tarefa ${index + 1} sem resposta: empty]`
              : `[tarefa ${index + 1} sem resposta: error]`,
          );
          const text =
            parts.length === 1
              ? parts[0]!
              : parts
                  .map((part, index) => `## Tarefa ${index + 1}\n${part}`)
                  .join("\n\n");
          return {
            output: [
              {
                type: "text",
                text: wrapUntrustedToolResult(SUBAGENT_TOOL_NAME, text),
              },
            ],
            details: { conversationIds: children },
          };
        },
      }),
    ],
  });
}
