import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ENV_LOCAL_PATH = resolve(process.cwd(), ".env.local");

const PROVIDERS = [
  {
    id: "minimax",
    label: "MiniMax (OpenAI-compatible)",
    flow: "minimax"
  },
  {
    id: "codex",
    label: "OpenAI Codex auth (ChatGPT login)",
    flow: "codex"
  },
  {
    id: "openai-compatible",
    label: "Custom OpenAI-compatible",
    flow: "custom"
  },
  {
    id: "anthropic-compatible",
    label: "Anthropic-compatible",
    flow: "anthropic"
  },
  {
    id: "mock",
    label: "Mock provider (local only)",
    flow: "mock"
  }
];

const parseEnv = (content) => {
  const lines = content.split("\n");
  const order = [];
  const map = new Map();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      order.push({ type: "raw", value: line });
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) {
      order.push({ type: "raw", value: line });
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    map.set(key, value);
    order.push({ type: "key", key });
  }

  return { map, order };
};

const stringifyEnv = ({ map, order }) => {
  const rendered = [];
  const renderedKeys = new Set();

  for (const item of order) {
    if (item.type === "raw") {
      rendered.push(item.value);
      continue;
    }

    if (map.has(item.key)) {
      rendered.push(`${item.key}=${map.get(item.key)}`);
      renderedKeys.add(item.key);
    }
  }

  for (const [key, value] of map.entries()) {
    if (!renderedKeys.has(key)) {
      rendered.push(`${key}=${value}`);
    }
  }

  return rendered.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
};

const loadEnvLocal = () => {
  if (!existsSync(ENV_LOCAL_PATH)) {
    return {
      map: new Map(),
      order: []
    };
  }

  const content = readFileSync(ENV_LOCAL_PATH, "utf8");
  return parseEnv(content);
};

const ensureNonEmpty = async (rl, question, fallback = "") => {
  while (true) {
    const answer = (await rl.question(question)).trim();
    if (answer) {
      return answer;
    }
    if (fallback) {
      return fallback;
    }
    output.write("Value is required. Try again.\n");
  }
};

const probeModels = async ({ baseUrl, apiKey }) => {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: {
        authorization: `Bearer ${apiKey}`
      }
    });
    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    const data = Array.isArray(payload?.data) ? payload.data : [];

    return data
      .map((item) => (typeof item?.id === "string" ? item.id : ""))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
};

const probeAnthropicModels = async ({ baseUrl, apiKey, anthropicVersion = "2023-06-01" }) => {
  const cleanBaseUrl = baseUrl.replace(/\/+$/, "");
  const candidates = [`${cleanBaseUrl}/models`, `${cleanBaseUrl}/v1/models`];

  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": anthropicVersion
        }
      });
      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      const data = Array.isArray(payload?.data) ? payload.data : [];
      const models = data
        .map((item) => (typeof item?.id === "string" ? item.id : ""))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));

      if (models.length > 0) {
        return models;
      }
    } catch {
      // continue to next candidate URL
    }
  }

  return [];
};

const chooseModel = async (rl, models, fallbackPrompt) => {
  if (models.length === 0) {
    return ensureNonEmpty(rl, fallbackPrompt);
  }

  output.write("Available models:\n");
  models.slice(0, 30).forEach((model, index) => {
    output.write(`  ${index + 1}) ${model}\n`);
  });
  if (models.length > 30) {
    output.write(`  ... and ${models.length - 30} more\n`);
  }

  while (true) {
    const answer = (await rl.question("Choose model number or type model id: ")).trim();
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= models.length) {
      return models[index - 1];
    }
    if (answer) {
      return answer;
    }
  }
};

const readCodexToken = () => {
  const authPath = resolve(homedir(), ".codex", "auth.json");
  if (!existsSync(authPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8"));
    const token = parsed?.tokens?.access_token;
    return typeof token === "string" && token.trim() ? token : null;
  } catch {
    return null;
  }
};

const applyConfig = (envState, values, prefix = "") => {
  for (const [key, value] of Object.entries(values)) {
    const fullKey = prefix ? `${prefix}_${key}` : key;
    envState.map.set(fullKey, value);
  }
};

const printSummary = (values, title = "LLM settings") => {
  output.write(`\n${title}:\n`);
  output.write(`  LLM_PROVIDER=${values.LLM_PROVIDER}\n`);
  output.write(`  LLM_BASE_URL=${values.LLM_BASE_URL}\n`);
  output.write(`  LLM_MODEL=${values.LLM_MODEL}\n`);
  if (values.LLM_ENDPOINT_PATH) {
    output.write(`  LLM_ENDPOINT_PATH=${values.LLM_ENDPOINT_PATH}\n`);
  }
  output.write("  LLM_API_KEY=[hidden]\n");
};

const printFallbackSummary = (values) => {
  output.write("\nFallback provider settings:\n");
  output.write(`  GATEWAY_LLM_FALLBACK_PROVIDER=${values.GATEWAY_LLM_FALLBACK_PROVIDER}\n`);
  output.write(`  GATEWAY_LLM_FALLBACK_BASE_URL=${values.GATEWAY_LLM_FALLBACK_BASE_URL}\n`);
  output.write(`  GATEWAY_LLM_FALLBACK_MODEL=${values.GATEWAY_LLM_FALLBACK_MODEL}\n`);
  if (values.GATEWAY_LLM_FALLBACK_ENDPOINT_PATH) {
    output.write(`  GATEWAY_LLM_FALLBACK_ENDPOINT_PATH=${values.GATEWAY_LLM_FALLBACK_ENDPOINT_PATH}\n`);
  }
  output.write("  GATEWAY_LLM_FALLBACK_API_KEY=[hidden]\n");
};

const configureProvider = async (rl, providerType) => {
  // Find provider config
  const selected = PROVIDERS.find(p => p.id === providerType);
  if (!selected) {
    throw new Error(`Unknown provider type: ${providerType}`);
  }

  if (selected.flow === "mock") {
    return {
      LLM_PROVIDER: "mock",
      LLM_BASE_URL: "",
      LLM_API_KEY: "",
      LLM_MODEL: "",
      LLM_ENDPOINT_PATH: "",
      LLM_ANTHROPIC_VERSION: "2023-06-01",
      LLM_EXTRA_HEADERS_JSON: ""
    };
  }

  if (selected.flow === "minimax") {
    const apiKey = await ensureNonEmpty(rl, "MiniMax API key: ");
    const baseUrl = await ensureNonEmpty(
      rl,
      "Base URL (default https://api.minimax.io/anthropic): ",
      "https://api.minimax.io/anthropic"
    );
    const anthropicVersion = await ensureNonEmpty(rl, "Anthropic version (default 2023-06-01): ", "2023-06-01");
    output.write("Checking available models (Anthropic-compatible)...\n");
    const models = await probeAnthropicModels({ baseUrl, apiKey, anthropicVersion });
    const model = await chooseModel(rl, models, "Model id (from MiniMax docs/dashboard): ");

    return {
      LLM_PROVIDER: "anthropic-compatible",
      LLM_BASE_URL: baseUrl,
      LLM_API_KEY: apiKey,
      LLM_MODEL: model,
      LLM_ENDPOINT_PATH: "/v1/messages",
      LLM_ANTHROPIC_VERSION: anthropicVersion,
      LLM_EXTRA_HEADERS_JSON: ""
    };
  }

  if (selected.flow === "codex") {
    output.write("\nCodex auth flow\n");
    output.write("1) If needed, login in another terminal with: codex login\n");
    output.write("2) This setup reads your access token from ~/.codex/auth.json\n\n");

    const token = readCodexToken();
    if (!token) {
      throw new Error("Could not find Codex access token. Run 'codex login' first, then retry.");
    }

    const baseUrl = await ensureNonEmpty(rl, "Base URL (default https://api.openai.com/v1): ", "https://api.openai.com/v1");
    output.write("Checking available models...\n");
    const models = await probeModels({ baseUrl, apiKey: token });
    const model = await chooseModel(rl, models, "Model id: ");

    return {
      LLM_PROVIDER: "openai-compatible",
      LLM_BASE_URL: baseUrl,
      LLM_API_KEY: token,
      LLM_MODEL: model,
      LLM_ENDPOINT_PATH: "/chat/completions",
      LLM_ANTHROPIC_VERSION: "2023-06-01",
      LLM_EXTRA_HEADERS_JSON: ""
    };
  }

  if (selected.flow === "anthropic") {
    const apiKey = await ensureNonEmpty(rl, "Anthropic API key: ");
    const baseUrl = await ensureNonEmpty(
      rl,
      "Base URL (default https://api.anthropic.com/v1): ",
      "https://api.anthropic.com/v1"
    );
    const anthropicVersion = await ensureNonEmpty(rl, "Anthropic version (default 2023-06-01): ", "2023-06-01");
    output.write("Checking available models...\n");
    const models = await probeAnthropicModels({ baseUrl, apiKey, anthropicVersion });
    const model = await chooseModel(rl, models, "Model id: ");

    return {
      LLM_PROVIDER: "anthropic-compatible",
      LLM_BASE_URL: baseUrl,
      LLM_API_KEY: apiKey,
      LLM_MODEL: model,
      LLM_ENDPOINT_PATH: "/v1/messages",
      LLM_ANTHROPIC_VERSION: anthropicVersion,
      LLM_EXTRA_HEADERS_JSON: ""
    };
  }

  // Custom OpenAI-compatible
  const baseUrl = await ensureNonEmpty(rl, "Base URL: ");
  const apiKey = await ensureNonEmpty(rl, "API key: ");
  output.write("Checking available models...\n");
  const models = await probeModels({ baseUrl, apiKey });
  const model = await chooseModel(rl, models, "Model id: ");
  const endpointPath = await ensureNonEmpty(rl, "Endpoint path (default /chat/completions): ", "/chat/completions");

  return {
    LLM_PROVIDER: "openai-compatible",
    LLM_BASE_URL: baseUrl,
    LLM_API_KEY: apiKey,
    LLM_MODEL: model,
    LLM_ENDPOINT_PATH: endpointPath,
    LLM_ANTHROPIC_VERSION: "2023-06-01",
    LLM_EXTRA_HEADERS_JSON: ""
  };
};

const run = async () => {
  const rl = readline.createInterface({ input, output });

  try {
    output.write("OpenDungeon LLM Setup\n");
    output.write("=====================\n\n");

    // Step 1: Choose provider type
    output.write("Which provider do you want to configure?\n");
    output.write("1) Main (Primary) Provider - used for all AI responses\n");
    output.write("2) Fallback Provider - backup when main provider fails\n");
    output.write("3) Both Main and Fallback\n\n");

    let setupMode;
    while (!setupMode) {
      const answer = (await rl.question("Choose (1-3): ")).trim();
      if (answer === "1" || answer === "2" || answer === "3") {
        setupMode = answer;
      }
    }

    const envState = loadEnvLocal();

    // Configure Main Provider
    if (setupMode === "1" || setupMode === "3") {
      output.write("\n--- Main Provider Setup ---\n\n");
      PROVIDERS.forEach((provider, index) => {
        output.write(`${index + 1}) ${provider.label}\n`);
      });

      let selectedProvider;
      while (!selectedProvider) {
        const answer = (await rl.question("Choose provider: ")).trim();
        const index = Number(answer);
        if (Number.isInteger(index) && index >= 1 && index <= PROVIDERS.length) {
          selectedProvider = PROVIDERS[index - 1].id;
        }
      }

      if (selectedProvider === "mock") {
        const values = {
          LLM_PROVIDER: "mock",
          LLM_BASE_URL: "",
          LLM_API_KEY: "",
          LLM_MODEL: "",
          LLM_ENDPOINT_PATH: "",
          LLM_ANTHROPIC_VERSION: "2023-06-01",
          LLM_EXTRA_HEADERS_JSON: ""
        };
        applyConfig(envState, values);
        writeFileSync(ENV_LOCAL_PATH, stringifyEnv(envState), "utf8");
        output.write("\nMock provider enabled in .env.local\n");
        
        if (setupMode === "1") {
          output.write("\nNext: pnpm llm:probe -w @opendungeon/gateway\n");
          return;
        }
      } else {
        const values = await configureProvider(rl, selectedProvider);
        applyConfig(envState, values);
        writeFileSync(ENV_LOCAL_PATH, stringifyEnv(envState), "utf8");
        printSummary(values, "Main Provider");
      }
    }

    // Configure Fallback Provider
    if (setupMode === "2" || setupMode === "3") {
      output.write("\n--- Fallback Provider Setup ---\n");
      output.write("(Used when main provider is rate limited or unavailable)\n\n");
      
      PROVIDERS.forEach((provider, index) => {
        output.write(`${index + 1}) ${provider.label}\n`);
      });

      let selectedProvider;
      while (!selectedProvider) {
        const answer = (await rl.question("Choose fallback provider: ")).trim();
        const index = Number(answer);
        if (Number.isInteger(index) && index >= 1 && index <= PROVIDERS.length) {
          selectedProvider = PROVIDERS[index - 1].id;
        }
      }

      if (selectedProvider === "mock") {
        output.write("\nNote: Mock provider is not recommended as a fallback.\n");
        output.write("It's better to use a different real provider (e.g., Anthropic as fallback for OpenAI).\n\n");
        const confirm = (await rl.question("Continue with mock anyway? (y/N): ")).trim().toLowerCase();
        if (confirm !== "y" && confirm !== "yes") {
          output.write("Skipping fallback configuration.\n");
          if (setupMode === "2") {
            output.write("No changes made.\n");
            return;
          }
        }
      }

      const values = await configureProvider(rl, selectedProvider);
      
      // Convert to fallback env vars
      const fallbackValues = {
        GATEWAY_LLM_FALLBACK_PROVIDER: values.LLM_PROVIDER,
        GATEWAY_LLM_FALLBACK_BASE_URL: values.LLM_BASE_URL,
        GATEWAY_LLM_FALLBACK_API_KEY: values.LLM_API_KEY,
        GATEWAY_LLM_FALLBACK_MODEL: values.LLM_MODEL,
        GATEWAY_LLM_FALLBACK_ENDPOINT_PATH: values.LLM_ENDPOINT_PATH || "/chat/completions"
      };

      applyConfig(envState, fallbackValues);
      writeFileSync(ENV_LOCAL_PATH, stringifyEnv(envState), "utf8");
      printFallbackSummary(fallbackValues);
    }

    output.write("\n" + "=".repeat(50) + "\n");
    output.write("Setup complete!\n");
    output.write("\nTest your configuration:\n");
    output.write("  pnpm llm:probe -w @opendungeon/gateway\n");
    output.write("\n");

  } finally {
    rl.close();
  }
};

run().catch((error) => {
  process.stderr.write(`LLM setup failed: ${String(error)}\n`);
  process.exit(1);
});
