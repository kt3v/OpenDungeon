import type { ChatRequest, ChatResponse, LlmProvider, LlmProviderErrorCategory } from "./index.js";
import { classifyProviderError, LlmProviderError } from "./index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GatewayLLMConfig {
  /** Maximum requests per minute (default: 60) */
  rpm: number;
  /** Rolling window for rate limiting in ms (default: 60000) */
  rpmWindowMs: number;
  /** Maximum concurrent requests (default: 5) */
  maxConcurrent: number;
  /** Maximum retry attempts for failed requests (default: 3) */
  maxRetries: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  retryBaseDelayMs: number;
  /** Maximum retry delay in ms (default: 30000) */
  maxRetryDelayMs: number;
  /** Circuit breaker configuration */
  circuitBreaker: CircuitBreakerConfig;
  /** Fallback provider configuration */
  fallback?: FallbackConfig;
  /** Optional metrics callback */
  onMetrics?: (metrics: LLMMetrics) => void;
}

export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit (default: 5) */
  failureThreshold: number;
  /** Time in ms before attempting recovery (default: 30000) */
  recoveryTimeoutMs: number;
  /** Number of successes to close circuit (default: 2) */
  successThreshold: number;
}

export interface FallbackConfig {
  /** Fallback provider instance */
  provider: LlmProvider;
  /** Error categories that trigger fallback (default: all retryable) */
  onErrorCategories: LlmProviderErrorCategory[];
}

export interface LLMMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  fallbackRequests: number;
  rateLimitedRequests: number;
  queueDepth: number;
  averageLatencyMs: number;
  circuitState: CircuitState;
  currentConcurrency: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

type CircuitState = "closed" | "open" | "half-open";

// ---------------------------------------------------------------------------
// Token Bucket Rate Limiter
// ---------------------------------------------------------------------------

class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;
  private readonly windowMs: number;

  constructor(rpm: number, windowMs: number) {
    this.maxTokens = rpm;
    this.tokens = rpm;
    this.refillRate = rpm / (windowMs / 1000); // tokens per second
    this.windowMs = windowMs;
    this.lastRefill = Date.now();
  }

  /**
   * Try to consume tokens. Returns wait time in ms if not enough tokens.
   */
  tryConsume(tokens = 1): { allowed: boolean; waitMs: number } {
    this.refill();

    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return { allowed: true, waitMs: 0 };
    }

    const needed = tokens - this.tokens;
    const waitMs = Math.ceil((needed / this.refillRate) * 1000);
    return { allowed: false, waitMs };
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    const tokensToAdd = (elapsedMs / 1000) * this.refillRate;

    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
}

// ---------------------------------------------------------------------------
// Semaphore for Concurrency Control
// ---------------------------------------------------------------------------

class Semaphore {
  private permits: number;
  private readonly waiting: Array<(value: void) => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }

  get available(): number {
    return this.permits;
  }

  get queueLength(): number {
    return this.waiting.length;
  }
}

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private successes = 0;
  private nextAttempt = 0;

  constructor(private readonly config: CircuitBreakerConfig) {}

  canExecute(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (Date.now() >= this.nextAttempt) {
        this.state = "half-open";
        this.successes = 0;
        return true;
      }
      return false;
    }
    return true; // half-open
  }

  recordSuccess(): void {
    this.failures = 0;

    if (this.state === "half-open") {
      this.successes++;
      if (this.successes >= this.config.successThreshold) {
        this.state = "closed";
      }
    }
  }

  recordFailure(): void {
    this.failures++;

    if (this.state === "half-open") {
      this.state = "open";
      this.nextAttempt = Date.now() + this.config.recoveryTimeoutMs;
    } else if (this.state === "closed" && this.failures >= this.config.failureThreshold) {
      this.state = "open";
      this.nextAttempt = Date.now() + this.config.recoveryTimeoutMs;
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  reset(): void {
    this.state = "closed";
    this.failures = 0;
    this.successes = 0;
  }
}

// ---------------------------------------------------------------------------
// Metrics Collector
// ---------------------------------------------------------------------------

class MetricsCollector {
  private totalRequests = 0;
  private successfulRequests = 0;
  private failedRequests = 0;
  private fallbackRequests = 0;
  private rateLimitedRequests = 0;
  private totalLatencyMs = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;

  recordRequest(): void {
    this.totalRequests++;
  }

  recordSuccess(latencyMs: number): void {
    this.successfulRequests++;
    this.totalLatencyMs += latencyMs;
  }

  recordFailure(): void {
    this.failedRequests++;
  }

  recordFallback(): void {
    this.fallbackRequests++;
  }

  recordRateLimited(): void {
    this.rateLimitedRequests++;
  }

  recordTokens(inputTokens: number, outputTokens: number): void {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
  }

  getMetrics(currentConcurrency: number, queueDepth: number, circuitState: CircuitState): LLMMetrics {
    const avgLatency = this.successfulRequests > 0
      ? this.totalLatencyMs / this.successfulRequests
      : 0;

    return {
      totalRequests: this.totalRequests,
      successfulRequests: this.successfulRequests,
      failedRequests: this.failedRequests,
      fallbackRequests: this.fallbackRequests,
      rateLimitedRequests: this.rateLimitedRequests,
      queueDepth,
      averageLatencyMs: Math.round(avgLatency),
      circuitState,
      currentConcurrency,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens
    };
  }
}

// ---------------------------------------------------------------------------
// Gateway LLM Provider
// ---------------------------------------------------------------------------

export class GatewayLLMProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;

  private readonly primaryProvider: LlmProvider;
  private readonly resolvedConfig: GatewayLLMConfig;
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly semaphore: Semaphore;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly metrics: MetricsCollector;

  constructor(primaryProvider: LlmProvider, config: Partial<GatewayLLMConfig> = {}) {
    this.primaryProvider = primaryProvider;
    this.name = `gateway-${primaryProvider.name}`;
    this.model = primaryProvider.model;

    const baseConfig: GatewayLLMConfig = {
      rpm: 60,
      rpmWindowMs: 60000,
      maxConcurrent: 5,
      maxRetries: 3,
      retryBaseDelayMs: 1000,
      maxRetryDelayMs: 30000,
      circuitBreaker: {
        failureThreshold: 5,
        recoveryTimeoutMs: 30000,
        successThreshold: 2
      }
    };

    this.resolvedConfig = {
      ...baseConfig,
      ...config,
      circuitBreaker: {
        ...baseConfig.circuitBreaker,
        ...(config.circuitBreaker ?? {})
      }
    };

    this.rateLimiter = new TokenBucketRateLimiter(this.resolvedConfig.rpm, this.resolvedConfig.rpmWindowMs);
    this.semaphore = new Semaphore(this.resolvedConfig.maxConcurrent);
    this.circuitBreaker = new CircuitBreaker(this.resolvedConfig.circuitBreaker);
    this.metrics = new MetricsCollector();
  }

  async createResponse(request: ChatRequest): Promise<ChatResponse> {
    this.metrics.recordRequest();

    // Wait for rate limiter
    const rateLimitResult = await this.waitForRateLimit();
    if (!rateLimitResult.allowed) {
      throw new LlmProviderError("Rate limit exceeded - request dropped after waiting", {
        status: 429
      });
    }

    // Wait for concurrency slot
    await this.semaphore.acquire();

    const startTime = Date.now();

    try {
      const response = await this.executeWithRetry(request);
      const latency = Date.now() - startTime;
      this.metrics.recordSuccess(latency);
      this.emitMetrics();
      return response;
    } catch (error) {
      this.metrics.recordFailure();
      this.emitMetrics();
      throw error;
    } finally {
      this.semaphore.release();
    }
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics(): LLMMetrics {
    return this.metrics.getMetrics(
      this.resolvedConfig.maxConcurrent - this.semaphore.available,
      this.semaphore.queueLength,
      this.circuitBreaker.getState()
    );
  }

  /**
   * Reset circuit breaker to closed state
   */
  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }

  private async waitForRateLimit(): Promise<{ allowed: boolean }> {
    const maxWaitMs = 30000; // Max 30 seconds wait
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const result = this.rateLimiter.tryConsume(1);
      if (result.allowed) {
        return { allowed: true };
      }

      this.metrics.recordRateLimited();

      // Wait before trying again
      await sleep(Math.min(result.waitMs, 1000));
    }

    return { allowed: false };
  }

  private async executeWithRetry(request: ChatRequest): Promise<ChatResponse> {
    const maxRetries = this.resolvedConfig.maxRetries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.executeWithCircuitBreaker(request);
        return response;
      } catch (error) {
        const classified = classifyProviderError(error);

        // Don't retry non-retryable errors
        if (!classified.retryable || attempt >= maxRetries) {
          // Try fallback if configured
          if (this.resolvedConfig.fallback && this.shouldUseFallback(classified.category)) {
            return await this.executeFallback(request);
          }
          throw error;
        }

        // Exponential backoff with jitter
        const delay = this.calculateBackoff(attempt);
        await sleep(delay);
      }
    }

    throw new LlmProviderError("Max retries exceeded");
  }

  private async executeWithCircuitBreaker(request: ChatRequest): Promise<ChatResponse> {
    if (!this.circuitBreaker.canExecute()) {
      throw new LlmProviderError("Circuit breaker is open", { status: 503 });
    }

    try {
      const response = await this.primaryProvider.createResponse(request);
      this.circuitBreaker.recordSuccess();
      this.recordTokenUsage(response);
      return response;
    } catch (error) {
      this.circuitBreaker.recordFailure();
      throw error;
    }
  }

  private recordTokenUsage(response: ChatResponse): void {
    const raw = response.raw as Record<string, unknown> | undefined;
    if (!raw) return;

    const usage = raw.usage as Record<string, unknown> | undefined;
    if (!usage) return;

    const inputTokens = (usage.prompt_tokens as number) ?? 0;
    const outputTokens = (usage.completion_tokens as number) ?? 0;

    if (inputTokens > 0 || outputTokens > 0) {
      this.metrics.recordTokens(inputTokens, outputTokens);
    }
  }

  private async executeFallback(request: ChatRequest): Promise<ChatResponse> {
    if (!this.resolvedConfig.fallback) {
      throw new LlmProviderError("No fallback provider configured");
    }

    this.metrics.recordFallback();
    const response = await this.resolvedConfig.fallback.provider.createResponse(request);
    this.recordTokenUsage(response);
    return response;
  }

  private shouldUseFallback(category: LlmProviderErrorCategory): boolean {
    if (!this.resolvedConfig.fallback) return false;

    const fallbackCategories = this.resolvedConfig.fallback.onErrorCategories;
    return fallbackCategories.includes(category);
  }

  private calculateBackoff(attempt: number): number {
    const baseDelay = this.resolvedConfig.retryBaseDelayMs;
    const maxDelay = this.resolvedConfig.maxRetryDelayMs;

    // Exponential backoff: 2^attempt * baseDelay
    const exponentialDelay = Math.pow(2, attempt) * baseDelay;

    // Add jitter (+/-25%) to avoid thundering herd
    const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);

    return Math.min(exponentialDelay + jitter, maxDelay);
  }

  private emitMetrics(): void {
    if (this.resolvedConfig.onMetrics) {
      this.resolvedConfig.onMetrics(this.getMetrics());
    }
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

export interface GatewayProviderFactoryInput {
  /** Primary provider */
  primary: LlmProvider;
  /** Optional fallback provider */
  fallback?: LlmProvider;
  /** Error categories that trigger fallback (default: all) */
  fallbackOnErrors?: LlmProviderErrorCategory[];
  /** Rate limit: requests per minute (default: 60) */
  rpm?: number;
  /** Max concurrent requests (default: 5) */
  maxConcurrent?: number;
  /** Max retry attempts (default: 3) */
  maxRetries?: number;
  /** Base retry delay in ms (default: 1000) */
  retryBaseDelayMs?: number;
  /** Circuit breaker failure threshold (default: 5) */
  circuitBreakerThreshold?: number;
  /** Circuit breaker recovery timeout in ms (default: 30000) */
  circuitBreakerRecoveryMs?: number;
  /** Metrics callback */
  onMetrics?: (metrics: LLMMetrics) => void;
}

/**
 * Create a production-ready gateway LLM provider with all safeguards
 */
export function createGatewayProvider(input: GatewayProviderFactoryInput): GatewayLLMProvider {
  const fallbackConfig: FallbackConfig | undefined = input.fallback
    ? {
        provider: input.fallback,
        onErrorCategories: input.fallbackOnErrors ?? [
          "rate-limit",
          "network",
          "unknown"
        ]
      }
    : undefined;

  return new GatewayLLMProvider(input.primary, {
    rpm: input.rpm ?? 60,
    maxConcurrent: input.maxConcurrent ?? 5,
    maxRetries: input.maxRetries ?? 3,
    retryBaseDelayMs: input.retryBaseDelayMs ?? 1000,
    circuitBreaker: {
      failureThreshold: input.circuitBreakerThreshold ?? 5,
      recoveryTimeoutMs: input.circuitBreakerRecoveryMs ?? 30000,
      successThreshold: 2
    },
    fallback: fallbackConfig,
    onMetrics: input.onMetrics
  });
}

/**
 * Create gateway provider from environment variables
 */
export function createGatewayProviderFromEnv(
  primaryProvider: LlmProvider,
  fallbackProvider?: LlmProvider,
  env: NodeJS.ProcessEnv = process.env
): GatewayLLMProvider {
  const parseIntOrDefault = (value: string | undefined, defaultValue: number): number => {
    const parsed = value ? parseInt(value, 10) : NaN;
    return isNaN(parsed) ? defaultValue : parsed;
  };

  const fallbackConfig: FallbackConfig | undefined = fallbackProvider
    ? {
        provider: fallbackProvider,
        onErrorCategories: ["rate-limit", "network", "unknown"]
      }
    : undefined;

  return new GatewayLLMProvider(primaryProvider, {
    rpm: parseIntOrDefault(env.GATEWAY_LLM_RPM, 60),
    rpmWindowMs: parseIntOrDefault(env.GATEWAY_LLM_RPM_WINDOW_MS, 60000),
    maxConcurrent: parseIntOrDefault(env.GATEWAY_LLM_MAX_CONCURRENT, 5),
    maxRetries: parseIntOrDefault(env.GATEWAY_LLM_MAX_RETRIES, 3),
    retryBaseDelayMs: parseIntOrDefault(env.GATEWAY_LLM_RETRY_BASE_DELAY_MS, 1000),
    maxRetryDelayMs: parseIntOrDefault(env.GATEWAY_LLM_MAX_RETRY_DELAY_MS, 30000),
    circuitBreaker: {
      failureThreshold: parseIntOrDefault(env.GATEWAY_LLM_CIRCUIT_BREAKER_THRESHOLD, 5),
      recoveryTimeoutMs: parseIntOrDefault(env.GATEWAY_LLM_CIRCUIT_BREAKER_RECOVERY_MS, 30000),
      successThreshold: 2
    },
    fallback: fallbackConfig
  });
}
