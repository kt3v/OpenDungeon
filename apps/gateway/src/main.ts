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
import { loadGameModuleFromPath, type LoadedGameModule } from "./module-loader.js";
import { serverConfig } from "./server-config.js";
import { WorldStore } from "./world-store.js";
import { ActionProcessor } from "./action-processor.js";
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
 * When the character dies the session ends; a new session = new character.
 *
 * worldState is NO LONGER stored here. The canonical shared world lives in
 * WorldStore (WorldFact table). Character-local context lives in characterState.
 */
type Session = {
  id: string;
  campaignId: string;
  userId: string;
  characterName: string;
  characterClass: string;
  characterLevel: number;
  characterHp: number;
  characterAttributes: Record<string, unknown>;
  characterInventory: Record<string, unknown>;
  /**
   * Character-local state: session-ephemeral flags, personal quest markers, etc.
   * Assembled with worldPatch from mechanics. Never shared across sessions.
   */
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
  displayName: z.string().min(1).optional()
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
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

const createRuntimeContext = async (): Promise<RuntimeContext> => {
  const loadedModule = await loadGameModuleFromPath(process.env.GAME_MODULE_PATH);

  // Create primary provider
  const primaryProvider = createProviderFromEnv();

  // Create optional fallback provider
  const fallbackProvider = process.env.GATEWAY_LLM_FALLBACK_PROVIDER
    ? createProvider({
        provider: process.env.GATEWAY_LLM_FALLBACK_PROVIDER as "openai-compatible" | "anthropic-compatible",
        baseUrl: process.env.GATEWAY_LLM_FALLBACK_BASE_URL,
        apiKey: process.env.GATEWAY_LLM_FALLBACK_API_KEY,
        model: process.env.GATEWAY_LLM_FALLBACK_MODEL,
        endpointPath: process.env.GATEWAY_LLM_FALLBACK_ENDPOINT_PATH
      })
    : undefined;

  // Create gateway provider with production safeguards
  const gatewayProvider = createGatewayProviderFromEnv(primaryProvider, fallbackProvider);

  // Log metrics periodically
  if (serverConfig.llmMetricsLogIntervalMs > 0) {
    setInterval(() => {
      const metrics = gatewayProvider.getMetrics();
      console.log("[LLM Metrics]", JSON.stringify(metrics));
    }, serverConfig.llmMetricsLogIntervalMs);
  }

  const runtime = new EngineRuntime(loadedModule.gameModule, { provider: gatewayProvider });
  return { loadedModule, runtime };
};

const parseJsonRecord = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
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
      ownerId: campaign.members.find((m) => m.role === "owner")?.userId ?? campaign.tenantId,
      memberIds: new Set(campaign.members.map((m) => m.userId)),
      createdAt: campaign.createdAt.toISOString()
    };
    db.campaignsById.set(loadedCampaign.id, loadedCampaign);
  }

  // Load sessions (characterState replaces worldState)
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
      characterLevel: session.characterLevel,
      characterHp: session.characterHp,
      characterAttributes: parseJsonRecord(session.characterAttributes),
      characterInventory: parseJsonRecord(session.characterInventory),
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
  const { runtime, loadedModule } = await createRuntimeContext();
  const db = createInMemoryDb();
  const persistence = await initPersistence(db);

  const worldStore = new WorldStore(persistence.prisma);

  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------

  const persistUser = async (user: User): Promise<void> => {
    if (!persistence.prisma) return;
    await persistence.prisma.user.upsert({
      where: { id: user.id },
      update: { email: user.email, password: user.password, displayName: user.displayName },
      create: { id: user.id, email: user.email, password: user.password, displayName: user.displayName }
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
    await persistence.prisma.session.upsert({
      where: { id: session.id },
      update: {
        status: session.status,
        characterLevel: session.characterLevel,
        characterHp: session.characterHp,
        characterAttributes: JSON.parse(JSON.stringify(session.characterAttributes)) as object,
        characterInventory: JSON.parse(JSON.stringify(session.characterInventory)) as object,
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
        characterLevel: session.characterLevel,
        characterHp: session.characterHp,
        characterAttributes: JSON.parse(JSON.stringify(session.characterAttributes)) as object,
        characterInventory: JSON.parse(JSON.stringify(session.characterInventory)) as object,
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
  const architectProvider = createProviderFromEnv();
  const architect = persistence.prisma
    ? {
        runtime: new ArchitectRuntime({ provider: architectProvider }),
        executor: new ArchitectOperationExecutor(persistence.prisma)
      }
    : undefined;

  const processor = new ActionProcessor(runtime, worldStore, persistence.prisma, {
    getSession(sessionId) {
      const s = db.sessionsById.get(sessionId);
      if (!s) return undefined;
      return {
        id: s.id,
        campaignId: s.campaignId,
        userId: s.userId,
        characterName: s.characterName,
        characterClass: s.characterClass,
        characterLevel: s.characterLevel,
        characterHp: s.characterHp,
        characterAttributes: s.characterAttributes,
        characterInventory: s.characterInventory,
        characterState: s.characterState,
        status: s.status,
        summary: s.summary,
        recentEvents: s.events,
        suggestedActions: s.suggestedActions
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
      if (mutation.characterHp !== undefined) session.characterHp = mutation.characterHp;
      if (mutation.characterLevel !== undefined) session.characterLevel = mutation.characterLevel;
      if (mutation.characterInventory !== undefined) {
        session.characterInventory = mutation.characterInventory;
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
  }, architect);

  app.addHook("onClose", async () => {
    if (persistence.prisma) await persistence.prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // Routes — info
  // ---------------------------------------------------------------------------

  app.get("/health", async () => ({
    status: "ok",
    service: "gateway",
    module: runtime.getManifest().name,
    modulePath: loadedModule.modulePath
  }));

  app.get("/llm/provider", async () => ({
    provider: llmRuntimeConfig.provider,
    model: llmRuntimeConfig.model ?? null,
    baseUrl: llmRuntimeConfig.baseUrl ?? null,
    endpointPath: llmRuntimeConfig.endpointPath ?? null,
    hasApiKey: llmRuntimeConfig.hasApiKey
  }));

  app.get("/module/info", async () => {
    const manifest = runtime.getManifest();
    return {
      name: manifest.name,
      version: manifest.version,
      capabilities: manifest.capabilities,
      availableClasses: runtime.getAvailableClasses()
    };
  });

  // ---------------------------------------------------------------------------
  // Routes — auth
  // ---------------------------------------------------------------------------

  app.post("/auth/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }
    const { email, password, displayName } = parsed.data;
    if (db.usersByEmail.has(email)) {
      return reply.code(409).send({ error: "EMAIL_IN_USE" });
    }
    const user: User = {
      id: randomUUID(),
      email,
      password,
      displayName: displayName ?? email.split("@")[0] ?? "player",
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
    const { email, password } = parsed.data;
    const user = db.usersByEmail.get(email);
    if (!user || user.password !== password) {
      return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
    }
    const token = randomUUID();
    db.tokens.set(token, user.id);

    logGameEvent("USER_LOGGED_IN", {
      userId: user.id,
      email: user.email
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
      moduleName: runtime.getManifest().name,
      moduleVersion: runtime.getManifest().version,
      ownerId: userId,
      memberIds: new Set([userId]),
      createdAt: new Date().toISOString()
    };
    db.campaignsById.set(campaign.id, campaign);
    await persistCampaign(campaign);
    await persistCampaignMember(campaign.id, userId, "owner");

    // Initialise canonical world state from game module
    const initialWorldState = runtime.getInitialWorldState();
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

    const campaigns = [...db.campaignsById.values()]
      .filter((c) => c.memberIds.has(userId))
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

    const campaigns = [...db.campaignsById.values()]
      .filter((c) => !c.memberIds.has(userId))
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
    const template = runtime.getCharacterTemplate(parsed.data.className);

    const characterInfo = {
      id: sessionId,
      name: parsed.data.name,
      className: parsed.data.className,
      level: template.level,
      hp: template.hp
    };

    // Read current canonical world state for hook context
    const currentWorldState = await worldStore.getView(campaign.id);

    // Run onCharacterCreated hooks — result goes to canonical world
    const charPatch = await runtime.onCharacterCreated({
      tenantId: campaign.ownerId,
      campaignId: campaign.id,
      playerId: userId,
      character: characterInfo,
      worldState: currentWorldState
    });

    if (charPatch.worldPatch && Object.keys(charPatch.worldPatch).length > 0) {
      await worldStore.applyPatch(campaign.id, charPatch.worldPatch, sessionId);
    }

    // Re-read world after character creation patch
    const worldAfterChar = charPatch.worldPatch
      ? { ...currentWorldState, ...charPatch.worldPatch }
      : currentWorldState;

    // Run onSessionStart hooks — worldPatch goes to canonical world,
    // any session-ephemeral state (sessionLoot, nearExit) also goes to world
    // (game modules that want session isolation should use characterPatch)
    const sessionPatch = await runtime.startSession({
      tenantId: campaign.ownerId,
      campaignId: campaign.id,
      sessionId,
      playerId: userId,
      worldState: worldAfterChar
    });

    if (sessionPatch.worldPatch && Object.keys(sessionPatch.worldPatch).length > 0) {
      await worldStore.applyPatch(campaign.id, sessionPatch.worldPatch, sessionId);
    }

    // Merge characterPatch from both lifecycle hooks into initial character state
    const initialCharacterState: Record<string, unknown> = {
      ...(charPatch.characterPatch ?? {}),
      ...(sessionPatch.characterPatch ?? {})
    };

    const session: Session = {
      id: sessionId,
      campaignId: campaign.id,
      userId,
      characterName: parsed.data.name,
      characterClass: parsed.data.className,
      characterLevel: template.level,
      characterHp: template.hp,
      characterAttributes: template.attributes ?? {},
      characterInventory: {},
      characterState: initialCharacterState,
      status: "active",
      events: [],
      suggestedActions: runtime.getSuggestedActions({ worldState: worldAfterChar }),
      summary: undefined,
      createdAt: new Date().toISOString()
    };
    db.sessionsById.set(session.id, session);
    await persistSession(session);

    logGameEvent("CHARACTER_CREATED", {
      characterId: session.id,
      name: session.characterName,
      className: session.characterClass,
      level: session.characterLevel,
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
          level: session.characterLevel,
          hp: session.characterHp
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
          level: s.characterLevel,
          hp: s.characterHp
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
      suggestedActions: runtime.getSuggestedActions({ worldState: mergedState })
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

    return {
      session: {
        id: session.id,
        campaignId: session.campaignId,
        userId: session.userId,
        character: {
          name: session.characterName,
          className: session.characterClass,
          level: session.characterLevel,
          hp: session.characterHp
        },
        status: session.status,
        endReason: session.endReason ?? null,
        summary: session.summary
      },
      worldState: worldView,
      characterState: session.characterState,
      events: session.events,
      createdAt: session.createdAt
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

    const endPatch = await runtime.endSession({
      tenantId: campaign.ownerId,
      campaignId: campaign.id,
      sessionId: session.id,
      playerId: userId,
      reason: "manual",
      worldState: mergedState
    });

    if (endPatch.worldPatch && Object.keys(endPatch.worldPatch).length > 0) {
      await worldStore.applyPatch(campaign.id, endPatch.worldPatch, session.id);
    }

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
