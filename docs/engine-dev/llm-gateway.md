# Production LLM Gateway

OpenDungeon includes a production-ready LLM gateway with a complete set of safeguards for working with LLM providers in production environments.

## Features

| Feature | Description |
|---------|-------------|
| **Rate Limiting** | Token bucket algorithm with RPM (requests per minute) and configurable window per provider |
| **Round-Robin Load Balancing** | Automatically switches between primary and fallback providers when rate limits are hit |
| **Concurrency Limiting** | Maximum of N parallel requests via semaphore, others wait in queue (per provider) |
| **Exponential Backoff** | Automatic retry with increasing delay and jitter (+/-25%) |
| **Circuit Breaker** | Automatic disabling on repeated errors, recovery via timeout and success threshold |
| **Fallback Provider** | Alternative provider with its own RPM limits; no waiting on rate limits |
| **Metrics** | Track latency, queue depth, error rate, circuit state, token usage, and provider distribution |

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

# Fallback rate limiting (optional - defaults to GATEWAY_LLM_RPM)
GATEWAY_LLM_FALLBACK_RPM=60

# ============================================
# Architect (dev tools) — separate model
# ============================================
LLM_ARCHITECT_MODEL=gpt-4o
```

## How It Works

### Round-Robin Rate Limiting

The gateway implements **round-robin with fail-over** for maximum throughput:

1. **No waiting** — if primary provider's rate limit is exceeded, request immediately tries fallback
2. **Independent counters** — each provider has its own token bucket RPM counter
3. **Smart routing** — remembers last successful provider and tries it first on next request
4. **Both exhausted** — only when both providers return 429, the request fails

### Rate Limiting (Token Bucket)

Each provider has its own token bucket. If the bucket is empty, the gateway immediately tries the other provider (no waiting).

### Circuit Breaker States

- **CLOSED**: Requests flow to the primary provider.
- **OPEN**: Provider is failing. Requests immediately try the other provider.
- **HALF_OPEN**: Recovery attempt. If `successThreshold` (default: 2) is met, it returns to CLOSED.

### Fallback Provider

Fallback is triggered when:
- Primary provider rate limit exceeded (429)
- Circuit breaker is open
- Network errors (5xx, timeouts)

The fallback provider has its own independent RPM limits and concurrency controls.

## Metrics

The gateway tracks performance and usage. Example metrics object:

```json
{
  "totalRequests": 150,
  "successfulRequests": 145,
  "failedRequests": 3,
  "primaryRequests": 98,
  "fallbackRequests": 47,
  "rateLimitedPrimary": 5,
  "rateLimitedFallback": 2,
  "queueDepth": 2,
  "averageLatencyMs": 1245,
  "circuitState": "closed",
  "currentConcurrency": 4,
  "totalInputTokens": 45200,
  "totalOutputTokens": 12800
}
```

### Metrics Fields

| Field | Description |
|-------|-------------|
| `totalRequests` | Total number of requests made through gateway |
| `successfulRequests` | Number of successful responses |
| `failedRequests` | Number of failed requests (both providers exhausted) |
| `primaryRequests` | Requests served by primary provider |
| `fallbackRequests` | Requests served by fallback provider |
| `rateLimitedPrimary` | Times primary provider was rate limited |
| `rateLimitedFallback` | Times fallback provider was rate limited |
| `queueDepth` | Current number of requests waiting for concurrency slots |
| `averageLatencyMs` | Average response latency in milliseconds |
| `circuitState` | Current circuit breaker state ("closed", "open", "half-open") |
| `currentConcurrency` | Number of requests currently being processed |
| `totalInputTokens` | Total input tokens across all requests |
| `totalOutputTokens` | Total output tokens across all responses |

## Provider Tracking in Action Results

When an action is resolved, the gateway tracks which provider was used:

```typescript
// In ActionResult (from @opendungeon/content-sdk)
interface ActionResult {
  message: string;
  // ... other fields
  llmProviderUsed?: string;  // e.g., "gateway-openai-compatible" or "gateway-anthropic-compatible"
}
```

This is logged in the `[EVENT] ACTION_RESOLVED` log entry:
```json
{
  "characterName": "Player1",
  "action": "look around",
  "message": "You see a dark corridor...",
  "provider": "gateway-openai-compatible"
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
  rpm: 60,
  fallbackRpm: 120,  // Fallback can have different rate limits
  onMetrics: (m) => console.log(`Tokens: ${m.totalInputTokens} in, ${m.totalOutputTokens} out`)
});
```

## Gateway vs Architect

| | Gateway | Architect |
|---|---------|-----------|
| **Purpose** | Live Game Loop (DM) | Dev Tools (Chronicler, Scaffold) |
| **Resilience** | ✅ High (Circuit, Fallback, Round-robin) | ❌ Low (Direct) |
| **Rate limiting** | ✅ Yes (per provider) | ❌ No |
| **Load balancing** | ✅ Round-robin | ❌ No |
| **Model** | `LLM_MODEL` | `LLM_ARCHITECT_MODEL` |
| **Provider** | `GatewayLLMProvider` | `OpenAICompatibleProvider` (etc) |
