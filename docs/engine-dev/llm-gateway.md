# Production LLM Gateway

OpenDungeon includes a production-ready LLM gateway with a complete set of safeguards for working with LLM providers in production environments.

## Features

| Feature | Description |
|---------|-------------|
| **Rate Limiting** | Token bucket algorithm with RPM (requests per minute) and configurable window |
| **Concurrency Limiting** | Maximum of N parallel requests via semaphore, others wait in queue |
| **Exponential Backoff** | Automatic retry with increasing delay and jitter (+/-25%) |
| **Circuit Breaker** | Automatic disabling on repeated errors, recovery via timeout and success threshold |
| **Fallback Provider** | Switch to backup provider on specific error categories |
| **Metrics** | Track latency, queue depth, error rate, circuit state, and token usage |

## Configuration (.env.local)

If you use `pnpm od configure llm`, the interactive setup now includes presets for major providers. Ready-to-copy templates are available in `env-profiles/`.

```bash
# ============================================
# Primary LLM (for gateway and architect)
# ============================================
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini

# ============================================
# Gateway Production Settings
# ============================================

# Rate limiting: maximum requests per minute (default: 60)
GATEWAY_LLM_RPM=60

# Rate limiting: window for RPM calculation in ms (default: 60000)
GATEWAY_LLM_RPM_WINDOW_MS=60000

# Concurrency: maximum parallel requests (default: 5)
GATEWAY_LLM_MAX_CONCURRENT=5

# Retry: maximum retry attempts on error (default: 3)
GATEWAY_LLM_MAX_RETRIES=3

# Retry: base delay in ms (default: 1000)
GATEWAY_LLM_RETRY_BASE_DELAY_MS=1000

# Retry: maximum delay in ms (default: 30000)
GATEWAY_LLM_MAX_RETRY_DELAY_MS=30000

# Circuit breaker: errors before opening (default: 5)
GATEWAY_LLM_CIRCUIT_BREAKER_THRESHOLD=5

# Circuit breaker: recovery timeout in ms (default: 30000)
GATEWAY_LLM_CIRCUIT_BREAKER_RECOVERY_MS=30000

# ============================================
# Fallback Provider (optional)
# ============================================
GATEWAY_LLM_FALLBACK_PROVIDER=anthropic-compatible
GATEWAY_LLM_FALLBACK_BASE_URL=https://api.anthropic.com/v1
GATEWAY_LLM_FALLBACK_API_KEY=sk-ant-...
GATEWAY_LLM_FALLBACK_MODEL=claude-3-haiku-20240307

# ============================================
# Architect (dev tools) — separate model
# ============================================
LLM_ARCHITECT_MODEL=gpt-4o
```

## How It Works

### Rate Limiting (Token Bucket)
The gateway uses a token bucket to smooth out requests. If the bucket is empty, the request waits for a refill (up to 30 seconds before timing out).

### Circuit Breaker States
- **CLOSED**: Requests flow to the primary provider.
- **OPEN**: Primary is failing. Requests immediately fail (503) or trigger fallback.
- **HALF_OPEN**: Recovery attempt. If `successThreshold` (default: 2) is met, it returns to CLOSED.

### Fallback Provider
Fallback triggers on specific error categories defined in `LlmProviderErrorCategory`:
- `rate-limit` — provider returned 429.
- `network` — 5xx errors, timeouts, or fetch failures.
- `unknown` — unexpected errors.

Fallback does **NOT** trigger on `auth` (401/403) or `malformed-output` (parsing issues) by default.

## Metrics

The gateway tracks performance and usage. Example metrics object:

```json
{
  "totalRequests": 150,
  "successfulRequests": 145,
  "failedRequests": 3,
  "fallbackRequests": 2,
  "rateLimitedRequests": 5,
  "queueDepth": 2,
  "averageLatencyMs": 1245,
  "circuitState": "closed",
  "currentConcurrency": 4,
  "totalInputTokens": 45200,
  "totalOutputTokens": 12800
}
```

## Usage Examples

### Simple Request
```typescript
import { GatewayLLMProvider, createProvider } from "@opendungeon/providers-llm";

const primary = createProvider({
  provider: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-...",
  model: "gpt-4o-mini"
});

const gateway = new GatewayLLMProvider(primary, {
  rpm: 60,
  maxConcurrent: 5
});

const response = await gateway.createResponse({
  messages: [{ role: "user", content: "Hello!" }]
});
```

### With Fallback and Metrics
```typescript
import { createGatewayProvider } from "@opendungeon/providers-llm";

const gateway = createGatewayProvider({
  primary,
  fallback,
  fallbackOnErrors: ["rate-limit", "network"],
  onMetrics: (m) => console.log(`Tokens: ${m.totalInputTokens} in, ${m.totalOutputTokens} out`)
});
```

## Gateway vs Architect

| | Gateway | Architect |
|---|---------|-----------|
| **Purpose** | Live Game Loop (DM) | Dev Tools (Chronicler, Scaffold) |
| **Resilience** | ✅ High (Circuit, Fallback) | ❌ Low (Direct) |
| **Rate limiting** | ✅ Yes | ❌ No |
| **Model** | `LLM_MODEL` | `LLM_ARCHITECT_MODEL` |
| **Provider** | `GatewayLLMProvider` | `OpenAICompatibleProvider` (etc) |
