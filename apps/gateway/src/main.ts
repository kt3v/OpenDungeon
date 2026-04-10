import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import { EngineRuntime } from "@opendungeon/engine-core";
import {
  getProviderRuntimeConfigFromEnv,
  createProviderFromEnv,
  createProvider,
  createGatewayProviderFromEnv,
  createArchitectProviderFromEnv,
  type LLMMetrics
} from "@opendungeon/providers-llm";
import { ArchitectRuntime, ArchitectOperationExecutor } from "@opendungeon/architect";
import type { ResourceSchema, StateOperation, StateVariable } from "@opendungeon/content-sdk";
import { loadGameModuleFromPath, type LoadedGameModule } from "./module-loader.js";
import { serverConfig } from "./server-config.js";
import { WorldStore } from "./world-store.js";
import { ActionProcessor, type ProcessorCallbacks } from "./action-processor.js";
import type { SessionEndReason } from "@opendungeon/shared";

// ---------------------------------------------------------------------------
// Human-readable event logging
// ---------------------------------------------------------------------------

type GameEvent = {
  timestamp: string;
  event: string;
  details: Record<string, unknown>;
};

const logGameEvent = (event: string, details: Record<string, unknown> = {}): void => {
  const entry: GameEvent = {
    timestamp: new Date().toISOString(),
    event,
    details
  };
  console.log(`[EVENT] ${event}`, JSON.stringify(details, null, 0));
};

// ---------------------------------------------------------------------------
// In-memory types
// ---------------------------------------------------------------------------

type User = {
  id: string;
  email: string;
  password: string;
  displayName: string;
  language: string;
  createdAt: string;
};

type Campaign = {
  id: string;
  title: string;
  moduleName: string;
  moduleVersion: string;
  ownerId: string;
  memberIds: Set<string>;
  createdAt: string;
};

type SessionEvent = {
  id: string;
  createdAt: string;
  playerId: string;
  actionText: string;
  message: string;
};

type SuggestedAction = {
  id: string;
  label: string;
  prompt: string;
};

/**
 * Session IS the character.
 * Creating a session creates a new character run within a campaign.
 * When the session ends all character data is cleared.
 *
 * All character data (HP, level, attributes, inventory + ephemeral state)
 * lives in characterState. No persistent progress between sessions.
 */
type Session = {
  id: string;
  campaignId: string;
  userId: string;
  characterName: string;
  characterClass: string;
  /// Player's current location - personal state, not shared across campaign
  location: string;
  /// Unified character state: hp, level, attributes, inventory + ephemeral data
  characterState: Record<string, unknown>;
  status: "active" | "ended";
  endReason?: SessionEndReason;
  events: SessionEvent[];
  suggestedActions: SuggestedAction[];
  summary?: string;
  createdAt: string;
};

type InMemoryDb = {
  usersById: Map<string, User>;
  usersByEmail: Map<string, User>;
  tokens: Map<string, string>;
  campaignsById: Map<string, Campaign>;
  sessionsById: Map<string, Session>;
};

type PersistenceContext = {
  prisma: PrismaClient | null;
};

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  displayName: z.string().min(1).optional(),
  language: z.string().optional()
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  language: z.string().optional()
});

const createCampaignSchema = z.object({
  title: z.string().min(1).max(120)
});

const createSessionSchema = z.object({
  name: z.string().min(1).max(80),
  className: z.string().min(1).max(80)
});

const submitActionSchema = z.object({
  actionText: z.string().min(1).max(1000),
  /** Optional explicit mechanic routing: "<mechanicId>.<actionId>", e.g. "extraction.extract" */
  mechanicActionId: z.string().min(1).max(64).optional()
});

const llmRuntimeConfig = getProviderRuntimeConfigFromEnv();

// ---------------------------------------------------------------------------
// DB initialisation
// ---------------------------------------------------------------------------

const createInMemoryDb = (): InMemoryDb => ({
  usersById: new Map(),
  usersByEmail: new Map(),
  tokens: new Map(),
  campaignsById: new Map(),
  sessionsById: new Map()
});

type RuntimeContext = {
  loadedModule: LoadedGameModule;
  runtime: EngineRuntime;
};


const parseJsonRecord = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
};

const applyStateOperations = (input: {
  operations: StateOperation[];
  variables: StateVariable[];
  worldState: Record<string, unknown>;
  characterState: Record<string, unknown>;
  location: string;
  actor: "dm" | "mechanic" | "system";
}): {
  worldState: Record<string, unknown>;
  worldPatch: Record<string, unknown>;
  characterState: Record<string, unknown>;
  location: string;
} => {
  const defs = new Map(input.variables.map((v) => [v.id, v]));
  const worldState = { ...input.worldState };
  const worldPatch: Record<string, unknown> = {};
  const characterState = { ...input.characterState };
  let location = input.location;

  for (const op of input.operations) {
    const def = defs.get(op.varId);
    if (!def) continue;
    if (!(def.writableBy ?? ["dm", "mechanic", "system"]).includes(input.actor)) continue;
    const target = def.scope === "world" ? worldState : characterState;
    const current = target[def.id];

    if (op.op === "set") {
      target[def.id] = op.value;
    } else if (op.op === "inc" || op.op === "dec") {
      const delta = Number(op.value);
      if (!Number.isFinite(delta)) continue;
      const prev = typeof current === "number" ? current : Number(current ?? 0);
      if (!Number.isFinite(prev)) continue;
      target[def.id] = op.op === "inc" ? prev + delta : prev - delta;
    } else if (op.op === "append") {
      const prev = Array.isArray(current) ? current : [];
      target[def.id] = [...prev, op.value];
    } else if (op.op === "remove") {
      const prev = Array.isArray(current) ? current : [];
      target[def.id] = prev.filter((item) => JSON.stringify(item) !== JSON.stringify(op.value));
    }

    if (def.scope === "world") {
      worldPatch[def.id] = worldState[def.id];
    }
    if (def.scope === "session" && def.id === "location" && typeof target[def.id] === "string") {
      location = target[def.id] as string;
    }
  }

  return { worldState, worldPatch, characterState, location };
};

const resolveIndicators = (input: {
  resources: ResourceSchema[];
  worldState: Record<string, unknown>;
  characterState: Record<string, unknown>;
  variables: StateVariable[];
  location: string;
}) => {
  const defs = new Map(input.variables.map((v) => [v.id, v]));
  return input.resources.map((resource) => {
    const def = defs.get(resource.varId);
    const source = def?.scope === "world" ? input.worldState : input.characterState;
    const value = resource.varId === "location" ? input.location : source[resource.varId];
    return {
      id: resource.id,
      label: resource.label,
      type: resource.type,
      value: value ?? resource.defaultValue ?? "-"
    };
  });
};

const initPersistence = async (db: InMemoryDb): Promise<PersistenceContext> => {
  if (!process.env.DATABASE_URL) {
    return { prisma: null };
  }

  const prisma = new PrismaClient();
  await prisma.$connect();

  // Load users
  const users = await prisma.user.findMany();
  for (const user of users) {
    const loadedUser: User = {
      id: user.id,
      email: user.email,
      password: user.password,
      displayName: user.displayName ?? user.email,
      language: user.language ?? "",
      createdAt: user.createdAt.toISOString()
    };
    db.usersById.set(loadedUser.id, loadedUser);
    db.usersByEmail.set(loadedUser.email, loadedUser);
  }

  // Load campaigns (no worldState — that lives in WorldFact rows)
  const campaigns = await prisma.campaign.findMany({ include: { members: true } });
  for (const campaign of campaigns) {
    const loadedCampaign: Campaign = {
      id: campaign.id,
      title: campaign.title,
      moduleName: campaign.moduleName,
      moduleVersion: campaign.moduleVersion,
      ownerId: campaign.members.find((m: { role: string; userId: string }) => m.role === "owner")?.userId ?? campaign.tenantId,
      memberIds: new Set(campaign.members.map((m: { userId: string }) => m.userId)),
      createdAt: campaign.createdAt.toISOString()
    };
    db.campaignsById.set(loadedCampaign.id, loadedCampaign);
  }

  // Load sessions (characterState is the unified character state)
  const sessions = await prisma.session.findMany();
  for (const session of sessions) {
    const campaign = db.campaignsById.get(session.campaignId);
    if (!campaign) continue;
    db.sessionsById.set(session.id, {
      id: session.id,
      campaignId: session.campaignId,
      userId: session.userId ?? "",
      characterName: session.characterName,
      characterClass: session.characterClass,
      location: session.location ?? "",
      characterState: parseJsonRecord(session.characterState),
      status: session.status === "ended" ? "ended" : "active",
      events: [],
      suggestedActions: [],
      summary: session.summary ?? undefined,
      createdAt: session.startedAt.toISOString()
    });
  }

  // Load recent event history into in-memory sessions
  const eventRows = await prisma.eventLog.findMany({ orderBy: { createdAt: "asc" } });
  for (const eventRow of eventRows) {
    const session = db.sessionsById.get(eventRow.sessionId);
    if (!session) continue;
    const payload = parseJsonRecord(eventRow.payload);
    session.events.push({
      id: eventRow.id,
      createdAt: eventRow.createdAt.toISOString(),
      playerId: typeof payload.playerId === "string" ? payload.playerId : "unknown",
      actionText: typeof payload.actionText === "string" ? payload.actionText : "",
      message: typeof payload.message === "string" ? payload.message : ""
    });
  }

  return { prisma };
};

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

const sanitizeUser = (user: User) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  language: user.language,
  createdAt: user.createdAt
});

const resolveUserId = (request: FastifyRequest, db: InMemoryDb): string | null => {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  return db.tokens.get(token) ?? null;
};

const requireUserId = (request: FastifyRequest, db: InMemoryDb): string => {
  const userId = resolveUserId(request, db);
  if (!userId) throw new Error("UNAUTHORIZED");
  return userId;
};

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export const buildApp = async (): Promise<FastifyInstance> => {
  // Providers are created once and reused across module reloads
  const primaryProvider = createProviderFromEnv();
  const fallbackProvider = process.env.GATEWAY_LLM_FALLBACK_PROVIDER
    ? createProvider({
        provider: process.env.GATEWAY_LLM_FALLBACK_PROVIDER as "openai-compatible" | "anthropic-compatible",
        baseUrl: process.env.GATEWAY_LLM_FALLBACK_BASE_URL,
        apiKey: process.env.GATEWAY_LLM_FALLBACK_API_KEY,
        model: process.env.GATEWAY_LLM_FALLBACK_MODEL,
        endpointPath: process.env.GATEWAY_LLM_FALLBACK_ENDPOINT_PATH
      })
    : undefined;
  const gatewayProvider = createGatewayProviderFromEnv(primaryProvider, fallbackProvider);
  const hasRouterOverrides = [
    process.env.LLM_ROUTER_PROVIDER,
    process.env.LLM_ROUTER_BASE_URL,
    process.env.LLM_ROUTER_API_KEY,
    process.env.LLM_ROUTER_MODEL,
    process.env.LLM_ROUTER_ENDPOINT_PATH,
    process.env.LLM_ROUTER_ANTHROPIC_VERSION,
    process.env.LLM_ROUTER_EXTRA_HEADERS_JSON
  ].some((value) => typeof value === "string" && value.trim().length > 0);
  const routerProvider = hasRouterOverrides
    ? (() => {
        const routerBaseConfig = getProviderRuntimeConfigFromEnv();
        return createProvider({
          ...routerBaseConfig,
          provider: (process.env.LLM_ROUTER_PROVIDER as typeof routerBaseConfig.provider | undefined) ?? routerBaseConfig.provider,
          baseUrl: process.env.LLM_ROUTER_BASE_URL ?? routerBaseConfig.baseUrl,
          apiKey: process.env.LLM_ROUTER_API_KEY ?? routerBaseConfig.apiKey,
          model: process.env.LLM_ROUTER_MODEL ?? routerBaseConfig.model,
          endpointPath: process.env.LLM_ROUTER_ENDPOINT_PATH ?? routerBaseConfig.endpointPath,
          anthropicVersion: process.env.LLM_ROUTER_ANTHROPIC_VERSION ?? routerBaseConfig.anthropicVersion,
          extraHeaders: routerBaseConfig.extraHeaders
        });
      })()
    : gatewayProvider;

  if (serverConfig.llmMetricsLogIntervalMs > 0) {
    setInterval(() => {
      const metrics = gatewayProvider.getMetrics();
      console.log("[LLM Metrics]", JSON.stringify(metrics));
    }, serverConfig.llmMetricsLogIntervalMs);
  }

  const createRuntimeContext = async (): Promise<RuntimeContext> => {
    const loadedModule = await loadGameModuleFromPath(process.env.GAME_MODULE_PATH);
    const runtime = new EngineRuntime(loadedModule.gameModule, {
      provider: gatewayProvider,
      routerProvider
    } as ConstructorParameters<typeof EngineRuntime>[1]);
    return { loadedModule, runtime };
  };

  let runtimeCtx = await createRuntimeContext();
  const db = createInMemoryDb();
  const persistence = await initPersistence(db);

  const worldStore = new WorldStore(persistence.prisma);
  await worldStore.syncStateCatalog(
    runtimeCtx.loadedModule.gameModule.manifest.name,
    runtimeCtx.loadedModule.gameModule.manifest.version,
    runtimeCtx.loadedModule.gameModule.state?.variables ?? []
  );

  for (const session of db.sessionsById.values()) {
    const [characterState, sessionState] = await Promise.all([
      worldStore.getCharacterView(session.campaignId, session.id),
      worldStore.getSessionView(session.campaignId, session.id)
    ]);

    if (Object.keys(characterState).length > 0) {
      session.characterState = characterState;
    }
    if (typeof sessionState.location === "string") {
      session.location = sessionState.location;
    }
  }

  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------

  const persistUser = async (user: User): Promise<void> => {
    if (!persistence.prisma) return;
    await persistence.prisma.user.upsert({
      where: { id: user.id },
      update: { email: user.email, password: user.password, displayName: user.displayName, language: user.language },
      create: { id: user.id, email: user.email, password: user.password, displayName: user.displayName, language: user.language }
    });
  };

  const persistCampaign = async (campaign: Campaign): Promise<void> => {
    if (!persistence.prisma) return;
    await persistence.prisma.campaign.upsert({
      where: { id: campaign.id },
      update: { title: campaign.title, moduleName: campaign.moduleName, moduleVersion: campaign.moduleVersion },
      create: {
        id: campaign.id,
        tenantId: campaign.ownerId,
        title: campaign.title,
        moduleName: campaign.moduleName,
        moduleVersion: campaign.moduleVersion
      }
    });
  };

  const persistCampaignMember = async (campaignId: string, userId: string, role: string): Promise<void> => {
    if (!persistence.prisma) return;
    await persistence.prisma.campaignMember.upsert({
      where: { campaignId_userId: { campaignId, userId } },
      update: { role },
      create: { campaignId, userId, role }
    });
  };

  const persistSession = async (session: Session): Promise<void> => {
    if (!persistence.prisma) return;
    await worldStore.upsertScopedState({
      campaignId: session.campaignId,
      sessionId: session.id,
      scope: "character",
      state: session.characterState,
      lastSessionId: session.id
    });
    await worldStore.upsertScopedState({
      campaignId: session.campaignId,
      sessionId: session.id,
      scope: "session",
      state: { location: session.location },
      lastSessionId: session.id
    });

    await persistence.prisma.session.upsert({
      where: { id: session.id },
      update: {
        status: session.status,
        location: session.location,
        characterState: JSON.parse(JSON.stringify(session.characterState)) as object,
        summary: session.summary ?? null,
        endedAt: session.status === "ended" ? new Date() : null
      },
      create: {
        id: session.id,
        campaignId: session.campaignId,
        userId: session.userId || null,
        characterName: session.characterName,
        characterClass: session.characterClass,
        location: session.location,
        characterState: JSON.parse(JSON.stringify(session.characterState)) as object,
        status: session.status,
        summary: session.summary ?? null,
        startedAt: new Date(session.createdAt)
      }
    });
  };

  const persistEvent = async (
    campaignId: string,
    sessionId: string,
    payload: Record<string, unknown>
  ): Promise<void> => {
    if (!persistence.prisma) return;
    await persistence.prisma.eventLog.create({
      data: {
        campaignId,
        sessionId,
        type: "action.resolved",
        payload: JSON.parse(JSON.stringify(payload)) as object
      }
    });
  };

  // ---------------------------------------------------------------------------
  // ActionProcessor wiring
  // ---------------------------------------------------------------------------

  // Architect uses its own provider (can be different model from gateway)
  const architectProvider = createArchitectProviderFromEnv();
  const backgroundLoreProvider = createProviderFromEnv();
  const architect = persistence.prisma
    ? {
        runtime: new ArchitectRuntime({ provider: architectProvider }),
        executor: new ArchitectOperationExecutor(persistence.prisma)
      }
    : undefined;

  const processorCallbacks: ProcessorCallbacks = {
    getSession(sessionId) {
      const s = db.sessionsById.get(sessionId);
      if (!s) return undefined;
      // Get user language for this session
      const user = db.usersById.get(s.userId);
      return {
        id: s.id,
        campaignId: s.campaignId,
        userId: s.userId,
        characterName: s.characterName,
        characterClass: s.characterClass,
        location: s.location,
        characterState: s.characterState,
        status: s.status,
        summary: s.summary,
        recentEvents: s.events,
        suggestedActions: s.suggestedActions,
        userLanguage: user?.language
      };
    },

    getCampaign(campaignId) {
      const c = db.campaignsById.get(campaignId);
      if (!c) return undefined;
      return {
        id: c.id,
        title: c.title,
        ownerId: c.ownerId,
        moduleName: c.moduleName,
        moduleVersion: c.moduleVersion
      };
    },

    async commitSessionMutation(sessionId, mutation) {
      const session = db.sessionsById.get(sessionId);
      if (!session) return;

      if (mutation.characterState !== undefined) {
        session.characterState = mutation.characterState;
      }
      if (mutation.location !== undefined) {
        session.location = mutation.location;
      }
      if (mutation.summary !== undefined) session.summary = mutation.summary;
      if (mutation.suggestedActions) session.suggestedActions = mutation.suggestedActions;

      session.events.push(mutation.appendEvent);

      if (mutation.endSession) {
        session.status = "ended";
        session.endReason = mutation.endSession;
      }

      await persistSession(session);
    }
  };

  let processor = new ActionProcessor(
    runtimeCtx.runtime,
    worldStore,
    persistence.prisma,
    processorCallbacks,
    backgroundLoreProvider,
    runtimeCtx.loadedModule.gameModule.state?.variables ?? [],
    architect
  );

  // ---------------------------------------------------------------------------
  // Graceful drain state
  // ---------------------------------------------------------------------------

  /**
   * When true, the server rejects new action submissions with 503 SERVER_DRAINING.
   * In-flight actions continue until completion. Once activeCount reaches 0,
   * drainSettledAt is set and the server is safe to stop.
   */
  let draining = false;
  let drainSettledAt: string | null = null;

  const beginDrain = (): void => {
    if (draining) return;
    draining = true;
    drainSettledAt = null;
    console.log("[drain] Entering drain mode — new action submissions are now blocked");
    // 5-minute ceiling: if LLM hangs longer than that, something is very wrong
    processor.drain(5 * 60_000).then((ok) => {
      drainSettledAt = new Date().toISOString();
      console.log(
        ok
          ? "[drain] All in-flight actions completed — server is safe to stop"
          : "[drain] Drain timed out after 5 minutes — some actions may not have completed"
      );
    });
  };

  // SIGUSR2 from `od drain` triggers graceful drain mode.
  // (SIGUSR1 is reserved by Node.js for the inspector.)
  process.on("SIGUSR2", () => {
    console.log("[drain] SIGUSR2 received");
    beginDrain();
  });

  // ---------------------------------------------------------------------------
  // Module hot-reload
  // ---------------------------------------------------------------------------

  let reloading = false;
  const reloadModule = async (): Promise<void> => {
    if (reloading) {
      console.log("[reload] Already in progress, skipping");
      return;
    }
    reloading = true;
    // Reset drain state on reload so the server accepts actions again
    draining = false;
    drainSettledAt = null;
    try {
      const newCtx = await createRuntimeContext();
      const drained = await processor.drain(30_000);
      if (!drained) console.warn("[reload] Drain timed out after 30s, forcing swap");
      runtimeCtx = newCtx;
      await worldStore.syncStateCatalog(
        runtimeCtx.loadedModule.gameModule.manifest.name,
        runtimeCtx.loadedModule.gameModule.manifest.version,
        runtimeCtx.loadedModule.gameModule.state?.variables ?? []
      );
      processor = new ActionProcessor(
        newCtx.runtime,
        worldStore,
        persistence.prisma,
        processorCallbacks,
        backgroundLoreProvider,
        newCtx.loadedModule.gameModule.state?.variables ?? [],
        architect
      );
      console.log("[reload] Module reloaded:", newCtx.loadedModule.entryPath);
    } catch (err) {
      console.error("[reload] Failed to load new module, keeping current:", err);
    } finally {
      reloading = false;
    }
  };

  app.addHook("onClose", async () => {
    if (persistence.prisma) await persistence.prisma.$disconnect();
  });

  // Graceful SIGTERM: close Fastify cleanly so the onClose hook runs.
  // `od stop` sends SIGTERM; after `od drain` confirms zero in-flight actions
  // this completes almost instantly.
  process.on("SIGTERM", () => {
    console.log("[shutdown] SIGTERM received — closing gracefully");
    app.close().then(() => process.exit(0)).catch(() => process.exit(1));
  });

  // ---------------------------------------------------------------------------
  // Routes — info
  // ---------------------------------------------------------------------------

  app.get("/health", async () => ({
    status: draining ? "draining" : "ok",
    service: "gateway",
    module: runtimeCtx.runtime.getManifest().name,
    modulePath: runtimeCtx.loadedModule.modulePath,
    drain: draining
      ? { active: true, activeCount: processor.activeCount, ready: drainSettledAt !== null }
      : undefined
  }));

  app.get("/llm/provider", async () => ({
    provider: llmRuntimeConfig.provider,
    model: llmRuntimeConfig.model ?? null,
    baseUrl: llmRuntimeConfig.baseUrl ?? null,
    endpointPath: llmRuntimeConfig.endpointPath ?? null,
    hasApiKey: llmRuntimeConfig.hasApiKey
  }));

  app.get("/module/info", async () => {
    const manifest = runtimeCtx.runtime.getManifest();
    return {
      name: manifest.name,
      version: manifest.version,
      capabilities: manifest.capabilities,
      availableClasses: runtimeCtx.runtime.getAvailableClasses()
    };
  });

  app.post("/admin/reload", async (request, reply) => {
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken) {
      return reply.code(403).send({ error: "RELOAD_DISABLED", message: "ADMIN_TOKEN not configured" });
    }
    const authHeader = request.headers.authorization ?? "";
    const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    if (provided !== adminToken) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
    // Acknowledge immediately — drain may take up to 30s
    void reply.code(202).send({ status: "reload_initiated" });
    void reloadModule();
  });

  /**
   * Initiate graceful drain via HTTP (alternative to SIGUSR2 signal).
   * Requires ADMIN_TOKEN.
   */
  app.post("/admin/drain", async (request, reply) => {
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken) {
      return reply.code(403).send({ error: "DRAIN_DISABLED", message: "ADMIN_TOKEN not configured" });
    }
    const authHeader = request.headers.authorization ?? "";
    const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    if (provided !== adminToken) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
    beginDrain();
    return reply.code(202).send({
      status: drainSettledAt ? "ready" : "draining",
      activeCount: processor.activeCount,
      message: drainSettledAt
        ? "All actions completed — server is safe to stop"
        : "Drain initiated — new action submissions are blocked"
    });
  });

  /**
   * Poll drain status. Intentionally unauthenticated — exposes only operational
   * counters, no sensitive data. `od drain` polls this to know when it's safe to stop.
   */
  app.get("/admin/drain/status", async () => ({
    draining,
    activeCount: processor.activeCount,
    ready: draining && drainSettledAt !== null,
    settledAt: drainSettledAt
  }));

  // ---------------------------------------------------------------------------
  // Routes — auth
  // ---------------------------------------------------------------------------

  app.post("/auth/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }
    const { email, password, displayName, language } = parsed.data;
    if (db.usersByEmail.has(email)) {
      return reply.code(409).send({ error: "EMAIL_IN_USE" });
    }
    const user: User = {
      id: randomUUID(),
      email,
      password,
      displayName: displayName ?? email.split("@")[0] ?? "player",
      language: language ?? "",
      createdAt: new Date().toISOString()
    };
    db.usersById.set(user.id, user);
    db.usersByEmail.set(user.email, user);
    await persistUser(user);
    const token = randomUUID();
    db.tokens.set(token, user.id);

    logGameEvent("USER_REGISTERED", {
      userId: user.id,
      email: user.email,
      displayName: user.displayName
    });

    return { token, user: sanitizeUser(user) };
  });

  app.post("/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }
    const { email, password, language } = parsed.data;
    const user = db.usersByEmail.get(email);
    if (!user || user.password !== password) {
      return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
    }

    // Update user language if provided
    if (language && language !== user.language) {
      user.language = language;
      await persistUser(user);
    }

    const token = randomUUID();
    db.tokens.set(token, user.id);

    logGameEvent("USER_LOGGED_IN", {
      userId: user.id,
      email: user.email,
      language: user.language || "default"
    });

    return { token, user: sanitizeUser(user) };
  });

  app.get("/me", async (request, reply) => {
    try {
      const userId = requireUserId(request, db);
      const user = db.usersById.get(userId);
      if (!user) return reply.code(404).send({ error: "USER_NOT_FOUND" });
      return { user: sanitizeUser(user) };
    } catch {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
  });

  // ---------------------------------------------------------------------------
  // Routes — campaigns
  // ---------------------------------------------------------------------------

  app.post("/campaigns", async (request, reply) => {
    let userId: string;
    try { userId = requireUserId(request, db); }
    catch { return reply.code(401).send({ error: "UNAUTHORIZED" }); }

    if (!serverConfig.canBasicAccountCreateCampaigns) {
      return reply.code(403).send({ error: "CAMPAIGN_CREATION_DISABLED" });
    }

    const parsed = createCampaignSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }

    const campaign: Campaign = {
      id: randomUUID(),
      title: parsed.data.title,
      moduleName: runtimeCtx.runtime.getManifest().name,
      moduleVersion: runtimeCtx.runtime.getManifest().version,
      ownerId: userId,
      memberIds: new Set([userId]),
      createdAt: new Date().toISOString()
    };
    db.campaignsById.set(campaign.id, campaign);
    await persistCampaign(campaign);
    await persistCampaignMember(campaign.id, userId, "owner");

    // Initialise canonical world state from game module
    const initialWorldState = runtimeCtx.runtime.getInitialWorldState();
    await worldStore.initCampaign(campaign.id, initialWorldState);

    logGameEvent("CAMPAIGN_CREATED", {
      campaignId: campaign.id,
      title: campaign.title,
      ownerId: userId,
      module: campaign.moduleName
    });

    return {
      campaign: {
        id: campaign.id,
        title: campaign.title,
        moduleName: campaign.moduleName,
        moduleVersion: campaign.moduleVersion,
        ownerId: campaign.ownerId,
        createdAt: campaign.createdAt
      }
    };
  });

  app.get("/campaigns", async (request, reply) => {
    let userId: string;
    try { userId = requireUserId(request, db); }
    catch { return reply.code(401).send({ error: "UNAUTHORIZED" }); }

    const currentModuleName = runtimeCtx.runtime.getManifest().name;

    const campaigns = [...db.campaignsById.values()]
      .filter((c) => c.memberIds.has(userId))
      .filter((c) => c.moduleName === currentModuleName)
      .map((c) => ({
        id: c.id,
        title: c.title,
        moduleName: c.moduleName,
        moduleVersion: c.moduleVersion,
        ownerId: c.ownerId,
        createdAt: c.createdAt
      }));

    return { campaigns };
  });

  // Returns campaigns the authenticated user has NOT yet joined (for discovery/join flow)
  app.get("/campaigns/discover", async (request, reply) => {
    let userId: string;
    try { userId = requireUserId(request, db); }
    catch { return reply.code(401).send({ error: "UNAUTHORIZED" }); }

    const currentModuleName = runtimeCtx.runtime.getManifest().name;

    const campaigns = [...db.campaignsById.values()]
      .filter((c) => !c.memberIds.has(userId))
      .filter((c) => c.moduleName === currentModuleName)
      .map((c) => ({
        id: c.id,
        title: c.title,
        moduleName: c.moduleName,
        moduleVersion: c.moduleVersion,
        ownerId: c.ownerId,
        membersCount: c.memberIds.size,
        createdAt: c.createdAt
      }));

    return { campaigns };
  });

  app.get("/campaigns/:campaignId/state", async (request, reply) => {
    let userId: string;
    try { userId = requireUserId(request, db); }
    catch { return reply.code(401).send({ error: "UNAUTHORIZED" }); }

    const campaignId = z.string().uuid().safeParse(
      (request.params as { campaignId?: string }).campaignId
    );
    if (!campaignId.success) return reply.code(400).send({ error: "INVALID_CAMPAIGN_ID" });

    const campaign = db.campaignsById.get(campaignId.data);
    if (!campaign) return reply.code(404).send({ error: "CAMPAIGN_NOT_FOUND" });
    if (campaign.moduleName !== runtimeCtx.runtime.getManifest().name) {
      return reply.code(404).send({ error: "CAMPAIGN_NOT_FOUND" });
    }
    if (!campaign.memberIds.has(userId)) return reply.code(403).send({ error: "FORBIDDEN" });

    // Always read from canonical store — never stale in-memory blob
    const worldState = await worldStore.getView(campaign.id);

    return {
      campaign: {
        id: campaign.id,
        title: campaign.title,
        moduleName: campaign.moduleName,
        moduleVersion: campaign.moduleVersion,
        ownerId: campaign.ownerId,
        createdAt: campaign.createdAt
      },
      worldState
    };
  });

  app.post("/campaigns/:campaignId/join", async (request, reply) => {
    let userId: string;
    try { userId = requireUserId(request, db); }
    catch { return reply.code(401).send({ error: "UNAUTHORIZED" }); }

    const campaignId = z.string().uuid().safeParse(
      (request.params as { campaignId?: string }).campaignId
    );
    if (!campaignId.success) return reply.code(400).send({ error: "INVALID_CAMPAIGN_ID" });

    const campaign = db.campaignsById.get(campaignId.data);
    if (!campaign) return reply.code(404).send({ error: "CAMPAIGN_NOT_FOUND" });
    if (campaign.moduleName !== runtimeCtx.runtime.getManifest().name) {
      return reply.code(404).send({ error: "CAMPAIGN_NOT_FOUND" });
    }

    campaign.memberIds.add(userId);
    await persistCampaignMember(campaign.id, userId, "player");

    logGameEvent("PLAYER_JOINED_CAMPAIGN", {
      campaignId: campaign.id,
      campaignTitle: campaign.title,
      playerId: userId,
      membersCount: campaign.memberIds.size
    });

    return {
      campaign: {
        id: campaign.id,
        title: campaign.title,
        ownerId: campaign.ownerId,
        membersCount: campaign.memberIds.size
      }
    };
  });

  // ---------------------------------------------------------------------------
  // Routes — sessions (Session IS the character)
  // ---------------------------------------------------------------------------

  app.post("/campaigns/:campaignId/sessions", async (request, reply) => {
    let userId: string;
    try { userId = requireUserId(request, db); }
    catch { return reply.code(401).send({ error: "UNAUTHORIZED" }); }

    const campaignId = z.string().uuid().safeParse(
      (request.params as { campaignId?: string }).campaignId
    );
    if (!campaignId.success) return reply.code(400).send({ error: "INVALID_CAMPAIGN_ID" });

    const parsed = createSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }

    const campaign = db.campaignsById.get(campaignId.data);
    if (!campaign) return reply.code(404).send({ error: "CAMPAIGN_NOT_FOUND" });
    if (campaign.moduleName !== runtimeCtx.runtime.getManifest().name) {
      return reply.code(404).send({ error: "CAMPAIGN_NOT_FOUND" });
    }
    if (!campaign.memberIds.has(userId)) return reply.code(403).send({ error: "FORBIDDEN" });

    // Enforce max active sessions per account
    if (serverConfig.maxActiveSessions > 0) {
      const activeCount = [...db.sessionsById.values()].filter(
        (s) => s.userId === userId && s.status === "active"
      ).length;
      if (activeCount >= serverConfig.maxActiveSessions) {
        return reply.code(409).send({
          error: "MAX_ACTIVE_SESSIONS_REACHED",
          max: serverConfig.maxActiveSessions
        });
      }
    }

    const sessionId = randomUUID();
    const template = runtimeCtx.runtime.getCharacterTemplate(parsed.data.className);

    // Initial character state from template
    let initialCharacterState: Record<string, unknown> = {
      hp: template.hp,
      level: template.level,
      attributes: template.attributes ?? {},
      inventory: []
    };

    // Read current canonical world state for hook context
    const currentWorldState = await worldStore.getView(campaign.id);

    // Run onCharacterCreated hooks — result goes to canonical world
    const charPatch = await runtimeCtx.runtime.onCharacterCreated({
      tenantId: campaign.ownerId,
      campaignId: campaign.id,
      playerId: userId,
      characterClass: parsed.data.className,
      characterState: initialCharacterState,
      location: "", // Starting location - will be populated by engine/mechanics
      worldState: currentWorldState
    });

    const stateVariables = runtimeCtx.loadedModule.gameModule.state?.variables ?? [];
    const appliedCharPatch = applyStateOperations({
      operations: charPatch.stateOps ?? [],
      variables: stateVariables,
      worldState: currentWorldState,
      characterState: initialCharacterState,
      location: "",
      actor: "mechanic"
    });
    await worldStore.logOperations({
      campaignId: campaign.id,
      sessionId,
      actor: "mechanic",
      source: "on_character_created",
      operations: charPatch.stateOps ?? [],
      variables: stateVariables,
      valueBefore: { ...currentWorldState, ...initialCharacterState },
      valueAfter: { ...appliedCharPatch.worldState, ...appliedCharPatch.characterState, location: appliedCharPatch.location }
    });

    if (Object.keys(appliedCharPatch.worldPatch).length > 0) {
      await worldStore.applyPatch(campaign.id, appliedCharPatch.worldPatch, sessionId);
    }

    initialCharacterState = appliedCharPatch.characterState;
    const worldAfterChar = appliedCharPatch.worldState;

    // Run onSessionStart hooks
    const sessionPatch = await runtimeCtx.runtime.startSession({
      tenantId: campaign.ownerId,
      campaignId: campaign.id,
      sessionId,
      playerId: userId,
      characterState: initialCharacterState,
      worldState: worldAfterChar
    });

    const appliedSessionPatch = applyStateOperations({
      operations: sessionPatch.stateOps ?? [],
      variables: stateVariables,
      worldState: worldAfterChar,
      characterState: initialCharacterState,
      location: appliedCharPatch.location,
      actor: "mechanic"
    });
    await worldStore.logOperations({
      campaignId: campaign.id,
      sessionId,
      actor: "mechanic",
      source: "on_session_start",
      operations: sessionPatch.stateOps ?? [],
      variables: stateVariables,
      valueBefore: { ...worldAfterChar, ...initialCharacterState, location: appliedCharPatch.location },
      valueAfter: { ...appliedSessionPatch.worldState, ...appliedSessionPatch.characterState, location: appliedSessionPatch.location }
    });

    if (Object.keys(appliedSessionPatch.worldPatch).length > 0) {
      await worldStore.applyPatch(campaign.id, appliedSessionPatch.worldPatch, sessionId);
    }

    initialCharacterState = appliedSessionPatch.characterState;

    // Get starting location from hook operations
    const startingLocation = appliedSessionPatch.location;

    const session: Session = {
      id: sessionId,
      campaignId: campaign.id,
      userId,
      characterName: parsed.data.name,
      characterClass: parsed.data.className,
      location: startingLocation,
      characterState: initialCharacterState,
      status: "active",
      events: [],
      suggestedActions: runtimeCtx.runtime.getSuggestedActions({ worldState: appliedSessionPatch.worldState }),
      summary: undefined,
      createdAt: new Date().toISOString()
    };
    db.sessionsById.set(session.id, session);
    await persistSession(session);

    logGameEvent("CHARACTER_CREATED", {
      characterId: session.id,
      name: session.characterName,
      className: session.characterClass,
      level: session.characterState.level,
      campaignId: campaign.id,
      playerId: userId
    });

    return {
      session: {
        id: session.id,
        campaignId: session.campaignId,
        userId: session.userId,
        character: {
          name: session.characterName,
          className: session.characterClass,
          level: session.characterState.level,
          hp: session.characterState.hp
        },
        status: session.status,
        createdAt: session.createdAt
      }
    };
  });

  app.get("/campaigns/:campaignId/sessions", async (request, reply) => {
    let userId: string;
    try { userId = requireUserId(request, db); }
    catch { return reply.code(401).send({ error: "UNAUTHORIZED" }); }

    const campaignId = z.string().uuid().safeParse(
      (request.params as { campaignId?: string }).campaignId
    );
    if (!campaignId.success) return reply.code(400).send({ error: "INVALID_CAMPAIGN_ID" });

    const campaign = db.campaignsById.get(campaignId.data);
    if (!campaign) return reply.code(404).send({ error: "CAMPAIGN_NOT_FOUND" });
    if (campaign.moduleName !== runtimeCtx.runtime.getManifest().name) {
      return reply.code(404).send({ error: "CAMPAIGN_NOT_FOUND" });
    }
    if (!campaign.memberIds.has(userId)) return reply.code(403).send({ error: "FORBIDDEN" });

    const sessions = [...db.sessionsById.values()]
      .filter((s) => s.campaignId === campaign.id && (!s.userId || s.userId === userId))
      .map((s) => ({
        id: s.id,
        campaignId: s.campaignId,
        userId: s.userId,
        character: {
          name: s.characterName,
          className: s.characterClass,
          level: s.characterState.level,
          hp: s.characterState.hp
        },
        status: s.status,
        endReason: s.endReason ?? null,
        summary: s.summary ?? null,
        createdAt: s.createdAt
      }));

    return { sessions };
  });

  // ---------------------------------------------------------------------------
  // Routes — actions (async, per-campaign serialised commit)
  // ---------------------------------------------------------------------------

  /**
   * Submit an action. Returns 202 immediately with an actionId.
   * The action is processed asynchronously:
   *   1. LLM call (parallel across sessions)
   *   2. World-state commit (serialised per campaign to avoid races)
   * Poll GET /sessions/:id/actions/:actionId for the result.
   */
  app.post("/sessions/:sessionId/actions", async (request, reply) => {
    let userId: string;
    try { userId = requireUserId(request, db); }
    catch { return reply.code(401).send({ error: "UNAUTHORIZED" }); }

    const sessionId = z.string().uuid().safeParse(
      (request.params as { sessionId?: string }).sessionId
    );
    if (!sessionId.success) return reply.code(400).send({ error: "INVALID_SESSION_ID" });

    const parsed = submitActionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }

    const session = db.sessionsById.get(sessionId.data);
    if (!session) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
    if (session.status !== "active") return reply.code(409).send({ error: "SESSION_NOT_ACTIVE" });
    if (session.userId !== userId) return reply.code(403).send({ error: "FORBIDDEN" });

    // Reject new submissions during graceful drain so in-flight actions can finish
    if (draining) {
      return reply.code(503).send({
        error: "SERVER_DRAINING",
        message: "The server is preparing to restart. Please wait a moment and try again."
      });
    }

    const campaign = db.campaignsById.get(session.campaignId);
    if (!campaign) return reply.code(404).send({ error: "CAMPAIGN_NOT_FOUND" });
    if (!campaign.memberIds.has(userId)) return reply.code(403).send({ error: "FORBIDDEN" });

    const actionId = processor.enqueue(
      session.id,
      campaign.id,
      parsed.data.actionText,
      parsed.data.mechanicActionId
    );

    logGameEvent("PLAYER_ACTION_SUBMITTED", {
      actionId,
      characterName: session.characterName,
      action: parsed.data.actionText,
      mechanic: parsed.data.mechanicActionId ?? "narrative"
    });

    return reply.code(202).send({ actionId });
  });

  /**
   * Poll an action result.
   * Returns { status: "pending"|"processing"|"done"|"failed", result?, error? }
   */
  app.get("/sessions/:sessionId/actions/:actionId", async (request, reply) => {
    let userId: string;
    try { userId = requireUserId(request, db); }
    catch { return reply.code(401).send({ error: "UNAUTHORIZED" }); }

    const params = request.params as { sessionId?: string; actionId?: string };
    const sessionId = z.string().uuid().safeParse(params.sessionId);
    const actionId = z.string().uuid().safeParse(params.actionId);

    if (!sessionId.success || !actionId.success) {
      return reply.code(400).send({ error: "INVALID_PARAMS" });
    }

    const session = db.sessionsById.get(sessionId.data);
    if (!session) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
    if (session.userId !== userId) return reply.code(403).send({ error: "FORBIDDEN" });

    const entry = processor.get(actionId.data);
    if (!entry || entry.sessionId !== sessionId.data) {
      return reply.code(404).send({ error: "ACTION_NOT_FOUND" });
    }

    if (entry.status === "done") {
      return { status: "done", result: entry.result };
    }
    if (entry.status === "failed") {
      return { status: "failed", error: entry.errorMessage };
    }
    return { status: entry.status };
  });

  // ---------------------------------------------------------------------------
  // Routes — session state
  // ---------------------------------------------------------------------------

  app.get("/sessions/:sessionId/suggested-actions", async (request, reply) => {
    let userId: string;
    try { userId = requireUserId(request, db); }
    catch { return reply.code(401).send({ error: "UNAUTHORIZED" }); }

    const sessionId = z.string().uuid().safeParse(
      (request.params as { sessionId?: string }).sessionId
    );
    if (!sessionId.success) return reply.code(400).send({ error: "INVALID_SESSION_ID" });

    const session = db.sessionsById.get(sessionId.data);
    if (!session) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });

    const campaign = db.campaignsById.get(session.campaignId);
    if (!campaign) return reply.code(404).send({ error: "CAMPAIGN_NOT_FOUND" });
    if (!campaign.memberIds.has(userId)) return reply.code(403).send({ error: "FORBIDDEN" });

    if (session.suggestedActions.length > 0) {
      return { suggestedActions: session.suggestedActions };
    }

    // Fallback: derive from merged world view + character state
    const worldView = await worldStore.getView(campaign.id);
    const mergedState = { ...worldView, ...session.characterState };
    return {
      suggestedActions: runtimeCtx.runtime.getSuggestedActions({ worldState: mergedState })
    };
  });

  app.get("/sessions/:sessionId/state", async (request, reply) => {
    let userId: string;
    try { userId = requireUserId(request, db); }
    catch { return reply.code(401).send({ error: "UNAUTHORIZED" }); }

    const sessionId = z.string().uuid().safeParse(
      (request.params as { sessionId?: string }).sessionId
    );
    if (!sessionId.success) return reply.code(400).send({ error: "INVALID_SESSION_ID" });

    const session = db.sessionsById.get(sessionId.data);
    if (!session) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });

    const campaign = db.campaignsById.get(session.campaignId);
    if (!campaign) return reply.code(404).send({ error: "CAMPAIGN_NOT_FOUND" });
    if (!campaign.memberIds.has(userId)) return reply.code(403).send({ error: "FORBIDDEN" });

    // Return canonical world view + character state as merged context
    const worldView = await worldStore.getView(campaign.id);
    const resources = runtimeCtx.loadedModule.gameModule.resources ?? [];
    const stateVariables = runtimeCtx.loadedModule.gameModule.state?.variables ?? [];
    const resolvedIndicators = resolveIndicators({
      resources,
      worldState: worldView,
      characterState: session.characterState,
      variables: stateVariables,
      location: session.location
    });

    return {
      session: {
        id: session.id,
        campaignId: session.campaignId,
        userId: session.userId,
        character: {
          name: session.characterName,
          className: session.characterClass,
          level: session.characterState.level,
          hp: session.characterState.hp
        },
        status: session.status,
        endReason: session.endReason ?? null,
        summary: session.summary
      },
      worldState: worldView,
      characterState: session.characterState,
      location: session.location,
      events: session.events,
      createdAt: session.createdAt,
      resolvedIndicators
    };
  });

  app.post("/sessions/:sessionId/end", async (request, reply) => {
    let userId: string;
    try { userId = requireUserId(request, db); }
    catch { return reply.code(401).send({ error: "UNAUTHORIZED" }); }

    const sessionId = z.string().uuid().safeParse(
      (request.params as { sessionId?: string }).sessionId
    );
    if (!sessionId.success) return reply.code(400).send({ error: "INVALID_SESSION_ID" });

    const session = db.sessionsById.get(sessionId.data);
    if (!session) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });

    const campaign = db.campaignsById.get(session.campaignId);
    if (!campaign) return reply.code(404).send({ error: "CAMPAIGN_NOT_FOUND" });
    if (campaign.ownerId !== userId) {
      return reply.code(403).send({ error: "ONLY_OWNER_CAN_END_SESSION" });
    }

    const currentWorldState = await worldStore.getView(campaign.id);
    const mergedState = { ...currentWorldState, ...session.characterState };

    const endPatch = await runtimeCtx.runtime.endSession({
      tenantId: campaign.ownerId,
      campaignId: campaign.id,
      sessionId: session.id,
      playerId: userId,
      reason: "manual",
      characterState: session.characterState,
      worldState: mergedState
    });

    const appliedEndPatch = applyStateOperations({
      operations: endPatch.stateOps ?? [],
      variables: runtimeCtx.loadedModule.gameModule.state?.variables ?? [],
      worldState: currentWorldState,
      characterState: session.characterState,
      location: session.location,
      actor: "mechanic"
    });
    await worldStore.logOperations({
      campaignId: campaign.id,
      sessionId: session.id,
      actor: "mechanic",
      source: "manual_end_session",
      operations: endPatch.stateOps ?? [],
      variables: runtimeCtx.loadedModule.gameModule.state?.variables ?? [],
      valueBefore: { ...currentWorldState, ...session.characterState, location: session.location },
      valueAfter: { ...appliedEndPatch.worldState, ...appliedEndPatch.characterState, location: appliedEndPatch.location }
    });

    if (Object.keys(appliedEndPatch.worldPatch).length > 0) {
      await worldStore.applyPatch(campaign.id, appliedEndPatch.worldPatch, session.id);
    }

    session.characterState = appliedEndPatch.characterState;
    session.location = appliedEndPatch.location;

    session.status = "ended";
    session.endReason = "manual";
    await persistSession(session);

    logGameEvent("SESSION_ENDED", {
      sessionId: session.id,
      characterName: session.characterName,
      reason: "manual",
      campaignId: campaign.id
    });

    return {
      session: {
        id: session.id,
        status: session.status,
        endReason: session.endReason
      }
    };
  });

  // ---------------------------------------------------------------------------
  // Signal-based and file-watch reload triggers
  // ---------------------------------------------------------------------------

  process.on("SIGHUP", () => {
    console.log("[reload] SIGHUP received, triggering module reload");
    void reloadModule();
  });

  if (process.env.NODE_ENV !== "production" && process.env.GAME_MODULE_PATH) {
    const { watch } = await import("node:fs");
    const { resolve: resolvePath } = await import("node:path");
    const resolutionBase = process.env.INIT_CWD?.trim() ? process.env.INIT_CWD : process.cwd();
    const watchPath = resolvePath(resolutionBase, process.env.GAME_MODULE_PATH.trim());
    let debounce: ReturnType<typeof setTimeout> | null = null;
    watch(watchPath, { recursive: true }, (_, filename) => {
      if (!filename) return;
      if (filename.startsWith("node_modules") || filename.startsWith("dist")) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        console.log(`[reload] File changed: ${filename}`);
        void reloadModule();
      }, 500);
    });
    console.log(`[reload] Watching for changes: ${watchPath}`);
  }

  return app;
};

const isEntryPoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isEntryPoint) {
  const app = await buildApp();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: "0.0.0.0" });
}
