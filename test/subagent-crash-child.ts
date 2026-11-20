import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";

// The parent delegates; the child's first request never answers. The test
// kills this process there, then reopens the same directory.
const faux = fauxProvider();
faux.setResponses([
  fauxAssistantMessage(
    [fauxToolCall("subagent", { task: "Liste três leitores de RSS" })],
    { stopReason: "toolUse" },
  ),
  async () => {
    console.log("CHILD_STARTED");
    return new Promise<never>(() => {});
  },
]);
const models = createModels();
models.setProvider(faux.provider);
const app = await Runtime.open({
  dir: process.argv[2]!,
  gateway: { catalog: async () => [] },
  models,
});
const id = await app.create();
console.log(`PARENT ${id}`);
await app.submit(id, "crash-turn", "Pesquise leitores de RSS", "web");
setInterval(() => {}, 1000);
