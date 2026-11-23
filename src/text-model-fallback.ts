import { addAbortListener } from "node:events";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import {
  clampThinkingLevel,
  type Models,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai/models";
import type { TextModelRef } from "./setup.js";

const PRIMARY_TIMEOUT_MS = 120_000;

function failure(
  model: Model<Api>,
  error: unknown,
  aborted: boolean,
): AssistantMessage {
  return {
    role: "assistant",
    provider: model.provider,
    model: model.id,
    api: model.api,
    content: [],
    timestamp: Date.now(),
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

export function withTextModelFallback(
  models: Models,
  selection: TextModelRef | undefined,
  timeoutMs = PRIMARY_TIMEOUT_MS,
): Models {
  if (
    typeof selection?.provider !== "string" ||
    typeof selection.modelId !== "string"
  )
    return models;

  const streamSimple = (
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ) => {
    const fallback = models.getModel(selection.provider, selection.modelId);
    const callerSignal = options?.signal;
    if (
      !fallback ||
      (fallback.provider === model.provider && fallback.id === model.id) ||
      callerSignal?.aborted
    )
      return models.streamSimple(model, context, options);

    const output = createAssistantMessageEventStream();
    let primaryPartial = false;
    const attempt = async (
      candidate: Model<Api>,
      requestOptions: ModelsSimpleStreamOptions,
      primary: boolean,
    ) => {
      const { signal } = requestOptions;
      let abortListener: Disposable | undefined;
      try {
        signal?.throwIfAborted();
        const request = (async () => {
          const stream = models.streamSimple(
            candidate,
            context,
            requestOptions,
          );
          for await (const event of stream) {
            signal?.throwIfAborted();
            if (event.type === "done" || event.type === "error") continue;
            if (primary && event.partial.content.length) primaryPartial = true;
            // The durable progress ledger cannot replace already streamed partials.
            if (primary || !primaryPartial) output.push(event);
          }
          return stream.result();
        })();
        if (!signal) return await request;
        const cancelled = new Promise<never>((_, reject) => {
          abortListener = addAbortListener(signal, () => reject(signal.reason));
        });
        return await Promise.race([request, cancelled]);
      } catch (error) {
        return failure(candidate, error, Boolean(callerSignal?.aborted));
      } finally {
        abortListener?.[Symbol.dispose]();
      }
    };

    void (async () => {
      const deadline = new AbortController();
      const timer = setTimeout(
        () =>
          deadline.abort(new Error("Primary text model request timed out.")),
        timeoutMs,
      );
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, deadline.signal])
        : deadline.signal;
      let result: AssistantMessage;
      try {
        result = await attempt(
          model,
          { ...options, signal, maxRetries: 0 },
          true,
        );
      } finally {
        clearTimeout(timer);
      }
      if (
        !callerSignal?.aborted &&
        (deadline.signal.aborted ||
          result.stopReason === "error" ||
          result.stopReason === "aborted")
      ) {
        const crossProvider = model.provider !== fallback.provider;
        const reasoning =
          options?.reasoning && clampThinkingLevel(fallback, options.reasoning);
        result = await attempt(
          fallback,
          {
            ...options,
            reasoning: reasoning === "off" ? undefined : reasoning,
            ...(crossProvider
              ? {
                  apiKey: undefined,
                  headers: undefined,
                  env: undefined,
                  transformHeaders: undefined,
                }
              : {}),
          },
          false,
        );
      }
      const reason = result.stopReason;
      if (reason === "error" || reason === "aborted")
        output.push({ type: "error", reason, error: result });
      else if (reason !== "pending")
        output.push({ type: "done", reason, message: result });
      output.end(result);
    })();
    return output;
  };

  const routed: Partial<Models> = {
    streamSimple,
    completeSimple: (model, context, options) =>
      streamSimple(model, context, options).result(),
    fetchDeferred: (model, handle, options) =>
      models.fetchDeferred(
        models.getModel(handle.provider, handle.modelId) ?? model,
        handle,
        options,
      ),
    cancelDeferred: (model, handle, options) =>
      models.cancelDeferred(
        models.getModel(handle.provider, handle.modelId) ?? model,
        handle,
        options,
      ),
  };
  return new Proxy(models, {
    get(target, name: keyof Models) {
      const value = routed[name] ?? target[name];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
