export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?:
    | {
        type: "json_schema";
        name: string;
        schema: Record<string, unknown>;
      }
    | {
        type: "json_object";
      };
}

export interface ChatResponse {
  text: string;
  provider: string;
  model: string;
  raw?: unknown;
}

export interface LlmProvider {
  name: string;
  model: string;
  createResponse(request: ChatRequest): Promise<ChatResponse>;
}

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  endpointPath?: string;
  extraHeaders?: Record<string, string>;
}

export interface AnthropicCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  anthropicVersion?: string;
  endpointPath?: string;
  extraHeaders?: Record<string, string>;
}

export class LlmProviderError extends Error {
  status?: number;
  body?: string;

  constructor(message: string, options?: { status?: number; body?: string }) {
    super(message);
    this.name = "LlmProviderError";
    this.status = options?.status;
    this.body = options?.body;
  }
}

export type LlmProviderErrorCategory = "auth" | "rate-limit" | "malformed-output" | "network" | "unknown";

export interface ClassifiedLlmProviderError {
  category: LlmProviderErrorCategory;
  retryable: boolean;
  status?: number;
}

export const classifyProviderError = (error: unknown): ClassifiedLlmProviderError => {
  if (error instanceof LlmProviderError) {
    if (error.status === 401 || error.status === 403) {
      return {
        category: "auth",
        retryable: false,
        status: error.status
      };
    }

    if (error.status === 429) {
      return {
        category: "rate-limit",
        retryable: true,
        status: error.status
      };
    }

    if (typeof error.status === "number" && error.status >= 500) {
      return {
        category: "network",
        retryable: true,
        status: error.status
      };
    }

    const body = error.body?.toLowerCase() ?? "";
    if (body.includes("json") || body.includes("parse") || body.includes("schema") || body.includes("format")) {
      return {
        category: "malformed-output",
        retryable: false,
        status: error.status
      };
    }

    return {
      category: "unknown",
      retryable: false,
      status: error.status
    };
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes("fetch failed") ||
      message.includes("network") ||
      message.includes("timeout") ||
      message.includes("econn")
    ) {
      return {
        category: "network",
        retryable: true
      };
    }

    if (message.includes("json") || message.includes("parse") || message.includes("schema") || message.includes("format")) {
      return {
        category: "malformed-output",
        retryable: false
      };
    }
  }

  return {
    category: "unknown",
    retryable: false
  };
};

export class MockProvider implements LlmProvider {
  name = "mock";
  model = "mock-v1";

  async createResponse(request: ChatRequest): Promise<ChatResponse> {
    const text = request.messages
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n")
      .slice(0, 500);

    if (request.responseFormat?.type === "json_object" || request.responseFormat?.type === "json_schema") {
      return {
        text: JSON.stringify({
          message: "You scan the corridor and hear distant dripping water.",
          toolCalls: [
            {
              tool: "update_world_state",
              args: {
                patch: {
                  lastObservation: "dripping_water",
                  tension: "rising"
                }
              }
            },
            {
              tool: "set_summary",
              args: {
                shortSummary: "The party pauses to observe and notices signs of water deeper in the dungeon.",
                latestBeat: "A new clue hints at flooded chambers ahead."
              }
            },
            {
              tool: "set_suggested_actions",
              args: {
                actions: [
                  { id: "listen", label: "Listen", prompt: "listen carefully" },
                  { id: "torch", label: "Raise Torch", prompt: "raise the torch and inspect the walls" },
                  { id: "advance", label: "Advance", prompt: "move toward the sound of water" }
                ]
              }
            }
          ]
        }),
        provider: this.name,
        model: this.model
      };
    }

    return {
      text: `mock-response:${text}`,
      provider: this.name,
      model: this.model
    };
  }
}

export class OpenAICompatibleProvider implements LlmProvider {
  name = "openai-compatible";
  model: string;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly endpointPath: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(config: OpenAICompatibleConfig) {
    this.baseUrl = stripTrailingSlash(config.baseUrl);
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.endpointPath = config.endpointPath ?? "/chat/completions";
    this.extraHeaders = config.extraHeaders ?? {};
  }

  async createResponse(request: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content
      }))
    };

    if (typeof request.temperature === "number") {
      body.temperature = request.temperature;
    }
    if (typeof request.maxTokens === "number") {
      body.max_tokens = request.maxTokens;
    }
    if (request.responseFormat?.type === "json_object") {
      body.response_format = { type: "json_object" };
    }
    if (request.responseFormat?.type === "json_schema") {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: request.responseFormat.name,
          schema: request.responseFormat.schema
        }
      };
    }

    const url = `${this.baseUrl}${normalizePath(this.endpointPath)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new LlmProviderError("OpenAI-compatible request failed", {
        status: response.status,
        body: bodyText
      });
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      model?: string;
    };
    const text = payload.choices?.[0]?.message?.content;

    if (!text) {
      throw new LlmProviderError("OpenAI-compatible response did not include assistant text");
    }

    return {
      text,
      provider: this.name,
      model: payload.model ?? this.model,
      raw: payload
    };
  }
}

export class AnthropicCompatibleProvider implements LlmProvider {
  name = "anthropic-compatible";
  model: string;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly anthropicVersion: string;
  private readonly endpointPath: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(config: AnthropicCompatibleConfig) {
    this.baseUrl = stripTrailingSlash(config.baseUrl);
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.anthropicVersion = config.anthropicVersion ?? "2023-06-01";
    this.endpointPath = config.endpointPath ?? "/messages";
    this.extraHeaders = config.extraHeaders ?? {};
  }

  async createResponse(request: ChatRequest): Promise<ChatResponse> {
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");

    const messages = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: [
          {
            type: "text",
            text: message.content
          }
        ]
      }));

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: request.maxTokens ?? 1024
    };

    if (system) {
      body.system = system;
    }
    if (typeof request.temperature === "number") {
      body.temperature = request.temperature;
    }

    const url = `${this.baseUrl}${normalizePath(this.endpointPath)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": this.anthropicVersion,
        ...this.extraHeaders
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new LlmProviderError("Anthropic-compatible request failed", {
        status: response.status,
        body: bodyText
      });
    }

    const payload = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      model?: string;
    };
    const textParts = (payload.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string);
    const text = textParts.join("\n").trim();

    if (!text) {
      throw new LlmProviderError("Anthropic-compatible response did not include text content");
    }

    return {
      text,
      provider: this.name,
      model: payload.model ?? this.model,
      raw: payload
    };
  }
}

export interface ProviderFactoryInput {
  provider: "mock" | "openai-compatible" | "anthropic-compatible";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  endpointPath?: string;
  anthropicVersion?: string;
  extraHeaders?: Record<string, string>;
}

export interface ProviderRuntimeConfig extends ProviderFactoryInput {
  hasApiKey: boolean;
}

export const createProvider = (input: ProviderFactoryInput): LlmProvider => {
  if (input.provider === "mock") {
    return new MockProvider();
  }

  if (input.provider === "openai-compatible") {
    const { baseUrl, apiKey, model } = requireProviderCore(input);
    return new OpenAICompatibleProvider({
      baseUrl,
      apiKey,
      model,
      endpointPath: input.endpointPath,
      extraHeaders: input.extraHeaders
    });
  }

  const { baseUrl, apiKey, model } = requireProviderCore(input);
  return new AnthropicCompatibleProvider({
    baseUrl,
    apiKey,
    model,
    endpointPath: input.endpointPath,
    anthropicVersion: input.anthropicVersion,
    extraHeaders: input.extraHeaders
  });
};

export const createProviderFromEnv = (env: NodeJS.ProcessEnv = process.env): LlmProvider => {
  return createProvider(getProviderRuntimeConfigFromEnv(env));
};

export const getProviderRuntimeConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): ProviderRuntimeConfig => {
  const provider = (env.LLM_PROVIDER ?? "mock") as ProviderFactoryInput["provider"];
  const apiKey = env.LLM_API_KEY;

  return {
    provider,
    baseUrl: env.LLM_BASE_URL,
    apiKey,
    model: env.LLM_MODEL,
    endpointPath: env.LLM_ENDPOINT_PATH,
    anthropicVersion: env.LLM_ANTHROPIC_VERSION,
    extraHeaders: parseJsonHeaders(env.LLM_EXTRA_HEADERS_JSON),
    hasApiKey: Boolean(apiKey)
  };
};

const requireProviderCore = (input: ProviderFactoryInput): { baseUrl: string; apiKey: string; model: string } => {
  if (!input.baseUrl) {
    throw new Error("Missing required provider field: baseUrl");
  }
  if (!input.apiKey) {
    throw new Error("Missing required provider field: apiKey");
  }
  if (!input.model) {
    throw new Error("Missing required provider field: model");
  }

  return {
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    model: input.model
  };
};

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

const normalizePath = (value: string): string => (value.startsWith("/") ? value : `/${value}`);

const parseJsonHeaders = (value: string | undefined): Record<string, string> | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LLM_EXTRA_HEADERS_JSON must be a JSON object");
  }

  const entries = Object.entries(parsed);
  for (const [, headerValue] of entries) {
    if (typeof headerValue !== "string") {
      throw new Error("LLM_EXTRA_HEADERS_JSON values must be strings");
    }
  }

  return Object.fromEntries(entries) as Record<string, string>;
};
