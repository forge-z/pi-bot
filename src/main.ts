import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Runtime } from "./runtime.js";
import { McpGateway } from "./mcp.js";
import { LongCallHeartbeat } from "./heartbeat.js";
import { loadHarnessConfig } from "./harness-config.js";
import {
  readConfig,
  bootstrapModels,
  LLM_PROVIDER_ID,
  preferredVolumeSelection,
  secretRedactor,
  SetupRequiredError,
  startupErrorMessage,
  telegramAllowlistMisconfiguration,
} from "./config.js";
import {
  migrateLegacyOfficialSetup,
  readPhoneGateway,
  readStoredAggregators,
  readStoredSetup,
  readStoredTelegram,
  readStoredWhatsapp,
  resolveWhatsappUsers,
  type StoredSetup,
} from "./setup.js";
import { vaultFromStore, withOauthBearer } from "./mcp-oauth.js";
import { Store, SqlCredentials, queueWhatsApp } from "./store.js";
import {
  cancelInactiveGateway,
  flushChannelDeliveries,
  whatsAppOauthChat,
} from "./channel.js";
import { logFailure } from "./log.js";
import { TelegramBotApi } from "./telegram-api.js";
import { configureTelegram, TelegramPolling } from "./telegram-polling.js";
import { sweepMcpApprovals } from "./telegram-approvals.js";
import { WhatsAppGateway, type WaSocketFactory } from "./whatsapp.js";
import {
  acceptWhatsAppMessage,
  queueWhatsAppUncertainNotices,
  queueWhatsappApprovals,
} from "./whatsapp-inbound.js";

function migrateVolume(dir: string) {
  const file = join(dir, "app.sqlite");
  if (!existsSync(file)) return;
  const db = new DatabaseSync(file);
  try {
    const migrated = migrateLegacyOfficialSetup(db, process.env);
    if (migrated)
      console.info(
        `Volume: chave compatível reaproveitada em ${migrated.providerId}/${migrated.modelId}.`,
      );
  } catch {
    /* A volume that cannot be migrated keeps the compat path. */
  } finally {
    db.close();
  }
}

function waitMessage(error: SetupRequiredError) {
  if (setupNeedsLogin(error))
    return (
      "Assinatura ChatGPT ainda não autenticada. Rode `npm run login` no terminal do container; " +
      "o bot começa a responder sozinho quando o login terminar."
    );
  if (/número do WhatsApp/i.test(error.message))
    return (
      "Sem o número do dono no WhatsApp. Rode `npm run setup` no terminal do container e escolha WhatsApp; " +
      "o bot fica no ar e começa a responder sozinho quando o assistente terminar."
    );
  if (/token do Telegram/i.test(error.message))
    return (
      "Sem token do Telegram no ambiente nem no volume. Rode `npm run setup` no terminal do container; " +
      "o bot fica no ar e começa a responder sozinho quando o assistente terminar."
    );
  if (/usuários permitidos do Telegram/i.test(error.message))
    return (
      "Sem usuários permitidos do Telegram no ambiente nem no volume. Rode `npm run setup` no terminal do container; " +
      "o bot fica no ar e começa a responder sozinho quando o assistente terminar."
    );
  return (
    "Sem provedor configurado. Rode `npm run setup` no terminal do container; " +
    "o bot começa a responder sozinho quando o assistente terminar."
  );
}

/**
 * A bot with no provider cannot answer, and killing the container would take away the
 * terminal needed to run the wizard. Wait instead, re-reading the volume: `npm run
 * setup` finishes and the bot starts on its own a few seconds later.
 */
async function modelsOrWait(dir: string) {
  let announced = "";
  for (;;) {
    migrateVolume(dir);
    const stored = readStoredSetup(dir);
    let store: Store | undefined;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const phone = readPhoneGateway(dir);
      if (
        phone === "whatsapp" &&
        !resolveWhatsappUsers(process.env, readStoredWhatsapp(dir))?.length
      )
        throw new SetupRequiredError("número do WhatsApp");
      const config = readConfig(
        process.env,
        readStoredAggregators(dir),
        readStoredTelegram(dir),
        phone === "whatsapp" ? { gateway: "whatsapp" } : undefined,
      );
      store = new Store(dir);
      const credentials = new SqlCredentials(store);
      const models = await bootstrapModels(credentials, process.env, {
        stored,
      });
      return { models, stored, store, config, phone };
    } catch (error) {
      store?.close();
      if (!(error instanceof SetupRequiredError)) throw error;
      const line = waitMessage(error);
      // One line per distinct gap. Repeating it every poll looks like a crash loop.
      if (line !== announced) {
        console.error(line);
        announced = line;
      }
      // Waiting is the expected state, not a fault: keep the healthcheck green so the
      // platform does not restart the container that holds the terminal you need.
      writeFileSync(
        join(dir, "health.json"),
        JSON.stringify({
          at: Date.now(),
          waiting: setupNeedsLogin(error) ? "login" : "setup",
        }),
      );
      await new Promise((done) => setTimeout(done, 10_000));
    }
  }
}

function setupNeedsLogin(error: SetupRequiredError) {
  return /login/i.test(error.message);
}

/** True when this file is the process entry. An import (the WhatsApp boot test) must not start the gateway. */
function runningAsMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

export async function startWhatsApp(input: {
  dir: string;
  models: Awaited<ReturnType<typeof bootstrapModels>>;
  store: Store;
  config: ReturnType<typeof readConfig>;
  selection: Awaited<ReturnType<typeof preferredVolumeSelection>>;
  /** Tests pass a socket and never open WhatsApp Web. */
  socketFactory?: WaSocketFactory;
}) {
  const users = resolveWhatsappUsers(
    process.env,
    readStoredWhatsapp(input.dir),
  );
  if (!users?.length) throw new SetupRequiredError("número do WhatsApp");
  cancelInactiveGateway(input.store, "whatsapp");
  rmSync(`${input.dir}/health.json`, { force: true });
  let notifyFlush = () => {};
  const started: { app?: Runtime } = {};
  const wa = new WhatsAppGateway({
    sessionDir: join(input.dir, "whatsapp-auth"),
    allowed: users,
    onMessage: async (message) => {
      if (!started.app) return;
      await acceptWhatsAppMessage(started.app, message);
    },
    socketFactory: input.socketFactory,
  });
  const mcp = withOauthBearer(
    input.config.mcp,
    vaultFromStore(input.store),
    (text, id) => {
      queueWhatsApp(
        input.store,
        `mcp-oauth:${id}`,
        whatsAppOauthChat(input.store, users[0] ?? "", (chatId) =>
          wa.outboundChat(chatId),
        ),
        text,
      );
      notifyFlush();
    },
  );
  const mcpGateway = new McpGateway(mcp);
  // One status line if a tool runs long. Edits are not supported, so later
  // ticks leave that first line in place.
  const heartbeat = new LongCallHeartbeat({
    send: async (chat, text) => {
      await wa.sendText(chat, text);
      return { message_id: 1 };
    },
    edit: async () => {},
    delete: async () => {},
  });
  const app = await Runtime.open({
    dir: input.dir,
    store: input.store,
    gateway: mcpGateway,
    heartbeat,
    models: input.models,
    mode: "live",
    phoneGateway: "whatsapp",
    ...(input.selection
      ? {
          provider: input.selection.provider,
          modelId: input.selection.modelId,
          effort: input.selection.effort,
        }
      : {}),
    redact: secretRedactor(process.env, mcp, () => {
      try {
        return input.store
          .all<{ value: string }>("SELECT value FROM credentials")
          .map((row) => row.value);
      } catch {
        return [];
      }
    }),
  });
  started.app = app;
  // Same promise lock as Telegram's flush: a slow chunk must finish before
  // the next tick sends the following one.
  let running: Promise<void> | undefined;
  const flush = () => {
    if (!running) {
      running = (async () => {
        try {
          await sweepMcpApprovals(app);
        } catch (error) {
          logFailure("Falha ao revisar aprovações do WhatsApp", error);
        }
        try {
          queueWhatsappApprovals(app);
        } catch (error) {
          logFailure("Falha ao enfileirar aprovações do WhatsApp", error);
        }
        try {
          queueWhatsAppUncertainNotices(app);
        } catch (error) {
          logFailure("Falha ao enfileirar avisos de MCP incerto", error);
        }
        try {
          await flushChannelDeliveries(app.store, wa, app.options.redact);
        } catch (error) {
          logFailure("Falha ao enviar mensagens do WhatsApp", error);
        }
      })().finally(() => {
        running = undefined;
      });
    }
    // Connected, waiting for a QR, or reconnecting after a drop. Keep health
    // green so Docker does not restart the process out of that wait.
    if (wa.live) {
      const path = join(input.dir, "health.json");
      writeFileSync(
        `${path}.tmp`,
        JSON.stringify({
          at: Date.now(),
          jobs_poller: app.pendingJobs.health(),
        }),
        { mode: 0o600 },
      );
      renameSync(`${path}.tmp`, path);
    }
    return running;
  };
  app.pendingJobs.start();
  app.tasks.start();
  app.flushTelegramPending = flush;
  notifyFlush = flush;
  const timer = setInterval(flush, 1000);
  timer.unref?.();
  await wa.start();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      clearInterval(timer);
      rmSync(`${input.dir}/health.json`, { force: true });
      app.pendingJobs.close();
      const tasks = app.tasks.close();
      await app.mcpCalls?.close();
      await tasks;
      // A job closed above can queue one last send. Wait for that flush
      // while the socket is still up, then close it.
      while (running) await running;
      await wa.close();
      await app.close();
      await mcpGateway.close();
    })());
  const onSignal = () => {
    void close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  for (const event of ["SIGTERM", "SIGINT"] as const)
    process.once(event, onSignal);
  flush();
  console.info("Pi-Agent: WhatsApp gateway iniciado.");
  return {
    close: async () => {
      for (const event of ["SIGTERM", "SIGINT"] as const)
        process.off(event, onSignal);
      await close();
    },
  };
}

async function startProcess() {
  process.umask(0o077);
  try {
    loadHarnessConfig();
    const dir = resolve((process.env.DATA_DIR ?? "data").trim() || "data");
    const {
      models,
      stored,
      store: bootstrapStore,
      config,
      phone,
    }: {
      models: Awaited<ReturnType<typeof bootstrapModels>>;
      stored: StoredSetup;
      store: Store;
      config: ReturnType<typeof readConfig>;
      phone: "telegram" | "whatsapp";
    } = await modelsOrWait(dir);
    // Safe deploy hint: endpoint and catalog only, never credentials.
    const selection = await preferredVolumeSelection(
      models,
      new SqlCredentials(bootstrapStore),
      stored,
    );
    const llm = models.getProvider(LLM_PROVIDER_ID);
    const llmCatalog = llm ? models.getModels(LLM_PROVIDER_ID) : [];
    const active = selection?.provider;
    const activeProvider = active ? models.getProvider(active) : undefined;
    const activeCatalog = active ? models.getModels(active) : [];
    console.info(
      active && active !== LLM_PROVIDER_ID && activeProvider
        ? `Pi-Agent: provedor ${active} (${activeProvider.baseUrl ?? "catálogo oficial"}) — ${activeCatalog.length} modelo(s) do catálogo pi-ai, reasoning habilitado em ${activeCatalog.filter((model) => model.reasoning).length}.`
        : llm
          ? `Pi-Agent: provedor compatível ${LLM_PROVIDER_ID} (${llm.baseUrl ?? "sem endpoint"}) — ${llmCatalog.length} modelo(s), reasoning habilitado em ${llmCatalog.filter((model) => model.reasoning).length}.`
          : `Pi-Agent: assinatura ChatGPT via ${
              models
                .getProviders()
                .filter(
                  (provider) =>
                    provider.id === "openai" || provider.id === "openai-codex",
                )
                .map((provider) => provider.id)
                .join(", ") || "openai"
            }.`,
    );
    if (phone === "whatsapp") {
      await startWhatsApp({
        dir,
        models,
        store: bootstrapStore,
        config,
        selection,
      });
    } else {
      const api = new TelegramBotApi(config.token);
      const bot = (await api.call("getMe")) as {
        id: number;
        username?: string;
      };
      const allowlistMisconfig = telegramAllowlistMisconfiguration(
        bot.id,
        config,
      );
      if (allowlistMisconfig) throw new Error(allowlistMisconfig);
      cancelInactiveGateway(bootstrapStore, "telegram");
      rmSync(`${dir}/health.json`, { force: true });
      let notifyFlush = () => {};
      const mcp = withOauthBearer(
        config.mcp,
        vaultFromStore(bootstrapStore),
        (text, id) => {
          const chat = config.users[0];
          if (!chat) return;
          bootstrapStore.queueTelegram(`mcp-oauth:${id}`, chat, text);
          notifyFlush();
        },
      );
      const gateway = new McpGateway(mcp);
      // Status for a tool call that outlives a minute; best effort, never durable.
      const heartbeat = new LongCallHeartbeat({
        send: async (chat, text, options) =>
          (await api.call("sendMessage", {
            chat_id: chat,
            text,
            ...(options.messageThreadId === undefined
              ? {}
              : { message_thread_id: options.messageThreadId }),
          })) as { message_id?: number },
        edit: async (chat, messageId, text) => {
          await api.call("editMessageText", {
            chat_id: chat,
            message_id: messageId,
            text,
          });
        },
        delete: async (chat, messageId) => {
          await api.call("deleteMessage", {
            chat_id: chat,
            message_id: messageId,
          });
        },
      });
      const app = await Runtime.open({
        dir,
        store: bootstrapStore,
        gateway,
        heartbeat,
        models,
        mode: "live",
        // Bootstrap only: the choice from `npm run setup` seeds the default once;
        // /model and /thinking own it afterwards.
        ...(selection
          ? {
              provider: selection.provider,
              modelId: selection.modelId,
              effort: selection.effort,
            }
          : {}),
        redact: secretRedactor(
          {
            ...process.env,
            // The token may come from the volume. Clear _FILE so a placeholder file
            // does not hide that value from the redactor.
            TELEGRAM_BOT_TOKEN: config.token,
            TELEGRAM_BOT_TOKEN_FILE: "",
          },
          mcp,
          () => {
            try {
              return bootstrapStore
                .all<{ value: string }>("SELECT value FROM credentials")
                .map((row) => row.value);
            } catch {
              return [];
            }
          },
        ),
        initialize: (store) => configureTelegram(store, config, bot),
      });
      const polling = new TelegramPolling(app, api, config, bot);
      // Jobs that outlive the turn: the poller wakes a turn when one finishes.
      app.pendingJobs.start();
      app.flushTelegramPending = () => polling.engine.flush();
      notifyFlush = () => app.flushTelegramPending?.();
      let closing: Promise<void> | undefined;
      const close = () =>
        (closing ??= (async () => {
          rmSync(`${dir}/health.json`, { force: true });
          const draining = polling.close();
          app.pendingJobs.close();
          const tasks = app.tasks.close();
          await app.mcpCalls?.close();
          await draining;
          await tasks;
          await app.close();
          await gateway.close();
        })());
      // Exit after the drain. `npm run setup` signals this process; the container
      // restart policy (unless-stopped) starts it again so it re-reads the volume.
      // A handler that only closes leaves the event loop up, and the old token,
      // allowlist, and MCP gateway stay in memory.
      for (const event of ["SIGTERM", "SIGINT"] as const)
        process.once(event, () => {
          void close().then(
            () => process.exit(0),
            () => process.exit(1),
          );
        });
      polling.start(() => {
        void close().finally(() => {
          process.exitCode = 1;
        });
      });
      void polling.engine.flush();
      console.info("Pi-Agent: Telegram polling iniciado.");
    }
  } catch (error) {
    console.error(startupErrorMessage(error));
    process.exitCode = 1;
  }
}

if (runningAsMain()) await startProcess();
