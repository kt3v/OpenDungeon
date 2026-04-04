import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { EngineRuntime } from "@opendungeon/engine-core";
import { loadGameModuleFromPath } from "./module-loader.js";

// Human-readable event logging
const logEvent = (event: string, details: Record<string, unknown> = {}): void => {
  console.log(`[EVENT] ${event}`, JSON.stringify(details, null, 0));
};

const app = Fastify({ logger: false });
const loadedModule = await loadGameModuleFromPath(process.env.GAME_MODULE_PATH);
const runtime = new EngineRuntime(loadedModule.gameModule);

app.post("/simulate", async () => {
  const sessionId = randomUUID();
  logEvent("SIMULATE_STARTED", {
    module: runtime.getManifest().name,
    sessionId
  });

  const result = await runtime.executeTurn({
    tenantId: randomUUID(),
    campaignId: randomUUID(),
    sessionId,
    playerId: randomUUID(),
    character: { id: randomUUID(), name: "Test", className: "Warrior", level: 1, hp: 100 },
    actionText: "look around",
    worldState: {},
    recentEvents: []
  });

  logEvent("SIMULATE_COMPLETED", {
    sessionId,
    action: "look around"
  });

  return { manifest: runtime.getManifest(), result };
});

app.get("/health", async () => ({
  status: "ok",
  service: "orchestrator",
  module: runtime.getManifest().name,
  modulePath: loadedModule.modulePath
}));

const port = Number(process.env.PORT ?? 3002);
await app.listen({ port, host: "0.0.0.0" });
