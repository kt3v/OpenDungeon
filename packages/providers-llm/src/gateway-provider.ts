import type { ChatRequest, ChatResponse, LlmProvider, LlmProviderErrorCategory } from "./index.js";
import { classifyProviderError, LlmProviderError } from "./index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GatewayLLMConfig {
  /** Maximum requests per minute per provider (default: 60) */
  rpm: number;
  /** Rolling window for rate limiting in ms (default: 60000) */
  rpmWindowMs: number;
  /** Maximum concurrent requests per provider (default: 5) */
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
  /** Rate limit config for fallback (uses same defaults as primary if not specified) */
  rpm?: number;
  rpmWindowMs?: number;
  maxConcurrent?: number;
}

export interface LLMMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  primaryRequests: number;
  fallbackRequests: number;
  rateLimitedPrimary: number;
  rateLimitedFallback: number;
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
   * Try to consume token immediately. Returns true if allowed.
   * No waiting - immediate check.
   */
  tryConsume(tokens = 1): boolean {
    this.refill();

    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }

    return false;
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
// Provider Wrapper with Rate Limiting and Circuit Breaker
// ---------------------------------------------------------------------------

interface ProviderSlot {
  name: string;
  provider: LlmProvider;
  rateLimiter: TokenBucketRateLimiter;
  semaphore: Semaphore;
  circuitBreaker: CircuitBreaker;
  isFallback: boolean;
}

// ---------------------------------------------------------------------------
// Metrics Collector
// ---------------------------------------------------------------------------

class MetricsCollector {
  private totalRequests = 0;
  private successfulRequests = 0;
  private failedRequests = 0;
  private primaryRequests = 0;
  private fallbackRequests = 0;
  private rateLimitedPrimary = 0;
  private rateLimitedFallback = 0;
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

  recordPrimary(): void {
    this.primaryRequests++;
  }

  recordFallback(): void {
    this.fallbackRequests++;
  }

  recordRateLimited(isFallback: boolean): void {
    if (isFallback) {
      this.rateLimitedFallback++;
    } else {
      this.rateLimitedPrimary++;
    }
  }

  recordTokens(inputTokens: number, outputTokens: number): void {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
  }

  getMetrics(primarySlot: ProviderSlot, fallbackSlot?: ProviderSlot): LLMMetrics {
    const avgLatency = this.successfulRequests > 0
      ? this.totalLatencyMs / this.successfulRequests
      : 0;

    const totalConcurrency = primarySlot.semaphore.available +
      (fallbackSlot?.semaphore.available ?? 0);
    const maxConcurrency = primarySlot.semaphore.available + primarySlot.semaphore.queueLength +
      (fallbackSlot ? fallbackSlot.semaphore.available + fallbackSlot.semaphore.queueLength : 0);

    return {
      totalRequests: this.totalRequests,
      successfulRequests: this.successfulRequests,
      failedRequests: this.failedRequests,
      primaryRequests: this.primaryRequests,
      fallbackRequests: this.fallbackRequests,
      rateLimitedPrimary: this.rateLimitedPrimary,
      rateLimitedFallback: this.rateLimitedFallback,
      queueDepth: primarySlot.semaphore.queueLength + (fallbackSlot?.semaphore.queueLength ?? 0),
      averageLatencyMs: Math.round(avgLatency),
      circuitState: primarySlot.circuitBreaker.getState(),
      currentConcurrency: maxConcurrency - totalConcurrency,
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

  private readonly primarySlot: ProviderSlot;
  private readonly fallbackSlot?: ProviderSlot;
  private readonly resolvedConfig: GatewayLLMConfig;
  private readonly metrics: MetricsCollector;
  private lastSuccessfulProvider: "primary" | "fallback" = "primary";

  constructor(primaryProvider: LlmProvider, config: Partial<GatewayLLMConfig> = {}) {
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

    // Create primary provider slot
    this.primarySlot = {
      name: primaryProvider.name,
      provider: primaryProvider,
      rateLimiter: new TokenBucketRateLimiter(this.resolvedConfig.rpm, this.resolvedConfig.rpmWindowMs),
      semaphore: new Semaphore(this.resolvedConfig.maxConcurrent),
      circuitBreaker: new CircuitBreaker(this.resolvedConfig.circuitBreaker),
      isFallback: false
    };

    // Create fallback provider slot if configured
    if (this.resolvedConfig.fallback) {
      const fallbackRpm = this.resolvedConfig.fallback.rpm ?? this.resolvedConfig.rpm;
      const fallbackWindowMs = this.resolvedConfig.fallback.rpmWindowMs ?? this.resolvedConfig.rpmWindowMs;
      const fallbackMaxConcurrent = this.resolvedConfig.fallback.maxConcurrent ?? this.resolvedConfig.maxConcurrent;

      this.fallbackSlot = {
        name: this.resolvedConfig.fallback.provider.name,
        provider: this.resolvedConfig.fallback.provider,
        rateLimiter: new TokenBucketRateLimiter(fallbackRpm, fallbackWindowMs),
        semaphore: new Semaphore(fallbackMaxConcurrent),
        circuitBreaker: new CircuitBreaker(this.resolvedConfig.circuitBreaker),
        isFallback: true
      };
    }

    this.metrics = new MetricsCollector();
  }

  async createResponse(request: ChatRequest): Promise<ChatResponse> {
    this.metrics.recordRequest();

    const startTime = Date.now();

    try {
      const response = await this.executeWithRoundRobin(request);
      const latency = Date.now() - startTime;
      this.metrics.recordSuccess(latency);
      this.emitMetrics();
      return response;
    } catch (error) {
      this.metrics.recordFailure();
      this.emitMetrics();
      throw error;
    }
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics(): LLMMetrics {
    return this.metrics.getMetrics(this.primarySlot, this.fallbackSlot);
  }

  /**
   * Reset circuit breaker to closed state for both providers
   */
  resetCircuitBreaker(): void {
    this.primarySlot.circuitBreaker.reset();
    this.fallbackSlot?.circuitBreaker.reset();
  }

  /**
   * Round-robin execution: try providers in order, skip rate-limited ones
   */
  private async executeWithRoundRobin(request: ChatRequest): Promise<ChatResponse> {
    // Determine which provider to try first based on last successful
    const providers: ProviderSlot[] = this.lastSuccessfulProvider === "primary"
      ? [this.primarySlot, ...(this.fallbackSlot ? [this.fallbackSlot] : [])]
      : this.fallbackSlot
        ? [this.fallbackSlot, this.primarySlot]
        : [this.primarySlot];

    const errors: Error[] = [];

    for (const slot of providers) {
      // Check rate limit immediately (no waiting)
      if (!slot.rateLimiter.tryConsume(1)) {
        this.metrics.recordRateLimited(slot.isFallback);
        errors.push(new LlmProviderError(`Rate limit exceeded for ${slot.name}`, { status: 429 }));
        continue; // Try next provider
      }

      // Try to execute on this provider
      try {
        const response = await this.executeOnProvider(request, slot);
        this.lastSuccessfulProvider = slot.isFallback ? "fallback" : "primary";
        if (slot.isFallback) {
          this.metrics.recordFallback();
        } else {
          this.metrics.recordPrimary();
        }
        return response;
      } catch (error) {
        // If it's a rate limit from the provider itself (not our rate limiter),
        // record it and try next provider
        if (error instanceof LlmProviderError && error.status === 429) {
          this.metrics.recordRateLimited(slot.isFallback);
        }
        errors.push(error as Error);
      }
    }

    // All providers exhausted
    throw new LlmProviderError(
      `All providers failed: ${errors.map(e => e.message).join("; ")}`,
      { status: 503 }
    );
  }

  private async executeOnProvider(request: ChatRequest, slot: ProviderSlot): Promise<ChatResponse> {
    // Check circuit breaker
    if (!slot.circuitBreaker.canExecute()) {
      throw new LlmProviderError(`Circuit breaker is open for ${slot.name}`, { status: 503 });
    }

    // Wait for concurrency slot
    await slot.semaphore.acquire();

    try {
      const response = await this.executeWithRetry(request, slot);
      slot.circuitBreaker.recordSuccess();
      this.recordTokenUsage(response);
      return response;
    } catch (error) {
      slot.circuitBreaker.recordFailure();
      throw error;
    } finally {
      slot.semaphore.release();
    }
  }

  private async executeWithRetry(request: ChatRequest, slot: ProviderSlot): Promise<ChatResponse> {
    const maxRetries = this.resolvedConfig.maxRetries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await slot.provider.createResponse(request);
        return response;
      } catch (error) {
        const classified = classifyProviderError(error);

        // Don't retry non-retryable errors
        if (!classified.retryable || attempt >= maxRetries) {
          throw error;
        }

        // Exponential backoff with jitter
        const delay = this.calculateBackoff(attempt);
        await sleep(delay);
      }
    }

    throw new LlmProviderError("Max retries exceeded");
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
  /** Rate limit: requests per minute for primary (default: 60) */
  rpm?: number;
  /** Rate limit: requests per minute for fallback (default: same as primary) */
  fallbackRpm?: number;
  /** Rolling window for rate limiting in ms (default: 60000) */
  rpmWindowMs?: number;
  /** Max concurrent requests per provider (default: 5) */
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
 * Create a production-ready gateway LLM provider with round-robin fail-over
 */
export function createGatewayProvider(input: GatewayProviderFactoryInput): GatewayLLMProvider {
  const fallbackConfig: FallbackConfig | undefined = input.fallback
    ? {
        provider: input.fallback,
        rpm: input.fallbackRpm ?? input.rpm,
        rpmWindowMs: input.rpmWindowMs,
        maxConcurrent: input.maxConcurrent
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
        rpm: parseIntOrDefault(env.GATEWAY_LLM_FALLBACK_RPM, parseIntOrDefault(env.GATEWAY_LLM_RPM, 60)),
        rpmWindowMs: parseIntOrDefault(env.GATEWAY_LLM_RPM_WINDOW_MS, 60000),
        maxConcurrent: parseIntOrDefault(env.GATEWAY_LLM_MAX_CONCURRENT, 5)
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
