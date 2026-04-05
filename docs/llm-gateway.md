# Production LLM Gateway

OpenDungeon now includes a production-ready LLM gateway with a complete set of safeguards for working with LLM providers in production environments.

## Features

| Feature | Description |
|---------|-------------|
| **Rate Limiting** | Token bucket algorithm with RPM (requests per minute) limiting |
| **Concurrency Limiting** | Maximum of N parallel requests, others wait in queue |
| **Exponential Backoff** | Automatic retry with increasing delay and jitter |
| **Circuit Breaker** | Automatic disabling on errors, recovery via timeout |
| **Fallback Provider** | Switch to backup provider on errors |
| **Metrics** | Track latency, queue depth, error rate, circuit state |

## Configuration (.env.local)

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
# Fallback Provider (e.g., Anthropic)
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

```
RPM = 60, Window = 60s

t=0:  bucket = 60 tokens
      request comes → consume 1 → bucket = 59
      
t=1s: refill 1 token → bucket = 60
      
t=61s: if all 60 tokens are spent,
       wait until t=120s for full refill
```

### Concurrency Control (Semaphore)

```
Max Concurrent = 5

Request 1 ──┐
Request 2 ──┤
Request 3 ──┼──┐
Request 4 ──┤  │  All 5 slots busy
Request 5 ──┘  │  Request 6 waits
               │
Request 6 ─────┘  (waits in queue)
```

### Retry with Exponential Backoff

```
Attempt 1: delay = 1000ms + jitter
Attempt 2: delay = 2000ms + jitter  
Attempt 3: delay = 4000ms + jitter
Attempt 4: delay = 8000ms + jitter (but capped at max)
```

### Circuit Breaker States

```
CLOSED  ──error──→  OPEN (after threshold)
  ↑                    │
  │                    │ wait recoveryTimeout
  │                    ↓
  └──success────  HALF_OPEN
  (successThreshold successes)
```

### Fallback Provider

Fallback triggers on errors:
- `rate-limit` — provider is rate limiting
- `network` — 5xx errors, timeouts
- `unknown` — unknown errors

Does NOT trigger on:
- `auth` — 401/403 (API key issues)
- `malformed-output` — response validation errors

## Metrics

Gateway logs metrics every 60 seconds (configurable via `serverConfig.llmMetricsLogIntervalMs`):

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
  "currentConcurrency": 4
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       ActionProcessor                           │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐    ┌─────────────────────┐    ┌─────────────┐│
│  │Action Queue │───▶│   GatewayLLMProvider │───▶│   Primary   ││
│  └─────────────┘    │   (rate/concurrency) │    │  Provider   ││
│                     │   - Token bucket       │    └─────┬───────┘│
│                     │   - Semaphore            │          │        │
│                     │   - Retry w/ backoff     │    ┌───────▼─────┐│
│                     │   - Circuit breaker     │    │   Fallback  ││
│                     │   - Metrics              │    │   Provider  ││
│                     └─────────────────────┘    └─────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Usage Examples

### Simple Request

```typescript
import { GatewayLLMProvider, createProvider } from "@opendungeon/providers-llm";

const primary = createProvider({
  provider: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
  model: "gpt-4o-mini"
});

const gateway = new GatewayLLMProvider(primary, {
  rpm: 60,
  maxConcurrent: 5,
  maxRetries: 3
});

const response = await gateway.createResponse({
  messages: [{ role: "user", content: "Hello!" }]
});
```

### With Fallback Provider

```typescript
const fallback = createProvider({
  provider: "anthropic-compatible",
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: "claude-3-haiku-20240307"
});

const gateway = new GatewayLLMProvider(primary, {
  rpm: 60,
  maxConcurrent: 5,
  fallback: {
    provider: fallback,
    onErrorCategories: ["rate-limit", "network"]
  }
});
```

### With Metrics

```typescript
const gateway = new GatewayLLMProvider(primary, {
  rpm: 60,
  onMetrics: (metrics) => {
    console.log("[LLM Metrics]", metrics);
    // Send to Datadog, Prometheus, etc.
  }
});
```

## Recommended Settings

### For OpenAI API (tpm-based)

```bash
GATEWAY_LLM_RPM=60              # 60 RPM on standard tier
GATEWAY_LLM_MAX_CONCURRENT=5    # Don't overwhelm the provider
GATEWAY_LLM_MAX_RETRIES=3
```

### For Anthropic API

```bash
GATEWAY_LLM_RPM=40              # 40 RPM on standard tier
GATEWAY_LLM_MAX_CONCURRENT=3    # More conservative
GATEWAY_LLM_MAX_RETRIES=3
```

### For Local Models (Ollama)

```bash
GATEWAY_LLM_RPM=1000            # Practically unlimited
GATEWAY_LLM_MAX_CONCURRENT=10   # Limited by hardware
GATEWAY_LLM_MAX_RETRIES=1       # Fewer retries for local
```

## Debugging

### Check Current State

```typescript
import { createGatewayProviderFromEnv } from "@opendungeon/providers-llm";

const provider = createGatewayProviderFromEnv(primary, fallback);

// Get current metrics
const metrics = provider.getMetrics();
console.log(metrics);
// {
//   totalRequests: 150,
//   successfulRequests: 145,
//   failedRequests: 3,
//   queueDepth: 2,
//   circuitState: "closed",
//   ...
// }
```

### Manual Circuit Breaker Reset

```typescript
provider.resetCircuitBreaker();
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Rate limit from provider | Automatic retry with backoff, then fallback |
| 5xx errors | Circuit breaker → fallback |
| Auth error (401/403) | No retry, error immediately |
| Parse error | No retry (format issue) |
| Wait limit exceeded | 429 error with "Rate limit exceeded" message |

## Gateway vs Architect

| | Gateway | Architect |
|---|---------|-----------|
| **Purpose** | Game loop (DM) | Dev tools (analyze, chronicler) |
| **Rate limiting** | ✅ Yes | ❌ No |
| **Concurrency** | ✅ Yes | ❌ No |
| **Retry/Backoff** | ✅ Yes | ❌ No (JSON repair only) |
| **Circuit breaker** | ✅ Yes | ❌ No |
| **Fallback** | ✅ Yes | ❌ No |
| **Model** | `LLM_MODEL` | `LLM_ARCHITECT_MODEL` |
| **Priority** | Reliability | Quality |

## API Endpoint

Gateway provides an endpoint for checking configuration:

```
GET /llm/provider

Response:
{
  "provider": "gateway-openai-compatible",
  "model": "gpt-4o-mini",
  "hasFallback": true,
  "circuitState": "closed"
}
```
