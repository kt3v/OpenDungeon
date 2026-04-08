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
    const logPrefix = `[GatewayLLM ${new Date().toISOString()}]`;
    const trace = request.trace;
    const providerOrder = this.lastSuccessfulProvider === "primary"
      ? [this.primarySlot.name, ...(this.fallbackSlot ? [this.fallbackSlot.name] : [])]
      : this.fallbackSlot
        ? [this.fallbackSlot.name, this.primarySlot.name]
        : [this.primarySlot.name];
    trace?.setMeta?.("dm.gateway.providerOrder", providerOrder);
    trace?.setMeta?.("dm.gateway.maxRetries", this.resolvedConfig.maxRetries);
    trace?.setMeta?.("dm.gateway.maxConcurrent", this.resolvedConfig.maxConcurrent);

    try {
      const response = await this.executeWithRoundRobin(request, startTime, logPrefix);
      const latency = Date.now() - startTime;
      trace?.setMeta?.("dm.gateway.totalProviderTimeMs", latency);
      this.metrics.recordSuccess(latency);
      this.emitMetrics();
      return response;
    } catch (error) {
      const latency = Date.now() - startTime;
      trace?.setMeta?.("dm.gateway.totalProviderTimeMs", latency);
      this.metrics.recordFailure();
      this.emitMetrics();
      console.warn(`${logPrefix} Request failed after ${latency}ms:`, error instanceof Error ? error.message : error);
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
  private async executeWithRoundRobin(request: ChatRequest, startTime: number, logPrefix: string): Promise<ChatResponse> {
    const trace = request.trace;
    // Determine which provider to try first based on last successful
    const providers: ProviderSlot[] = this.lastSuccessfulProvider === "primary"
      ? [this.primarySlot, ...(this.fallbackSlot ? [this.fallbackSlot] : [])]
      : this.fallbackSlot
        ? [this.fallbackSlot, this.primarySlot]
        : [this.primarySlot];

    console.log(`${logPrefix} Starting round-robin. Providers: ${providers.map(p => p.name).join(", ")}. Elapsed: ${Date.now() - startTime}ms`);

    const errors: Error[] = [];
    const rateLimitedProviders: string[] = [];

    for (const slot of providers) {
      const slotStartTime = Date.now();
      console.log(`${logPrefix} Trying provider "${slot.name}" (isFallback: ${slot.isFallback}). Elapsed: ${slotStartTime - startTime}ms`);

      // Check rate limit immediately (no waiting)
      if (!slot.rateLimiter.tryConsume(1)) {
        this.metrics.recordRateLimited(slot.isFallback);
        const rateLimitError = new LlmProviderError(`Rate limit exceeded for ${slot.name}`, { status: 429 });
        console.log(`${logPrefix} Provider "${slot.name}" rate limited. Took: ${Date.now() - slotStartTime}ms`);
        rateLimitedProviders.push(slot.name);
        errors.push(rateLimitError);
        continue; // Try next provider
      }

      console.log(`${logPrefix} Rate limit check passed for "${slot.name}". Elapsed: ${Date.now() - startTime}ms`);

      // Try to execute on this provider
      try {
        const response = await this.executeOnProvider(request, slot, startTime, logPrefix);
        this.lastSuccessfulProvider = slot.isFallback ? "fallback" : "primary";
        if (slot.isFallback) {
          this.metrics.recordFallback();
        } else {
          this.metrics.recordPrimary();
        }
        trace?.setMeta?.("dm.gateway.usedFallback", slot.isFallback);
        trace?.setMeta?.("dm.gateway.finalProvider", slot.name);
        trace?.setMeta?.("dm.gateway.rateLimitedProviders", rateLimitedProviders);
        console.log(`${logPrefix} Provider "${slot.name}" succeeded. Total time: ${Date.now() - startTime}ms`);
        return response;
      } catch (error) {
        const errorTime = Date.now();
        // If it's a rate limit from the provider itself (not our rate limiter),
        // record it and try next provider
        if (error instanceof LlmProviderError && error.status === 429) {
          this.metrics.recordRateLimited(slot.isFallback);
        }
        console.log(`${logPrefix} Provider "${slot.name}" failed after ${errorTime - slotStartTime}ms: ${error instanceof Error ? error.message : error}`);
        trace?.setMeta?.(`dm.gateway.provider.${slot.name}.failed`, true);
        errors.push(error as Error);
      }
    }

    trace?.setMeta?.("dm.gateway.rateLimitedProviders", rateLimitedProviders);

    // All providers exhausted
    throw new LlmProviderError(
      `All providers failed: ${errors.map(e => e.message).join("; ")}`,
      { status: 503 }
    );
  }

  private async executeOnProvider(request: ChatRequest, slot: ProviderSlot, startTime: number, logPrefix: string): Promise<ChatResponse> {
    const trace = request.trace;
    // Check circuit breaker
    if (!slot.circuitBreaker.canExecute()) {
      trace?.setMeta?.(`dm.gateway.provider.${slot.name}.circuitOpen`, true);
      throw new LlmProviderError(`Circuit breaker is open for ${slot.name}`, { status: 503 });
    }

    // Wait for concurrency slot
    const beforeSemaphore = Date.now();
    console.log(`${logPrefix} [${slot.name}] Waiting for concurrency slot. Available: ${slot.semaphore.available}, Queue: ${slot.semaphore.queueLength}. Elapsed: ${beforeSemaphore - startTime}ms`);
    await slot.semaphore.acquire();
    const afterSemaphore = Date.now();
    const waitTime = afterSemaphore - beforeSemaphore;
    trace?.setMeta?.(`dm.gateway.provider.${slot.name}.queueWaitMs`, waitTime);
    trace?.setMeta?.(`dm.gateway.provider.${slot.name}.queueDepthAtAcquire`, slot.semaphore.queueLength);
    if (waitTime > 100) {
      console.log(`${logPrefix} [${slot.name}] Waited ${waitTime}ms for concurrency slot!`);
    }

    try {
      console.log(`${logPrefix} [${slot.name}] Executing LLM request. Elapsed: ${afterSemaphore - startTime}ms`);
      const response = await this.executeWithRetry(request, slot, startTime, logPrefix);
      slot.circuitBreaker.recordSuccess();
      this.recordTokenUsage(response);

      // Enhance response with provider information
      const providerType = slot.isFallback ? "fallback" : "primary";
      const enhancedResponse: ChatResponse = {
        ...response,
        provider: `gateway-${response.provider}`,
        model: response.model,
        raw: {
          ...((typeof response.raw === "object" && response.raw !== null) ? response.raw : {}),
          gatewayProviderType: providerType,
          underlyingProvider: response.provider,
          underlyingModel: response.model
        }
      };

      trace?.setMeta?.(`dm.gateway.provider.${slot.name}.success`, true);
      trace?.setMeta?.("dm.gateway.underlyingProvider", response.provider);
      trace?.setMeta?.("dm.gateway.underlyingModel", response.model);

      return enhancedResponse;
    } catch (error) {
      slot.circuitBreaker.recordFailure();
      throw error;
    } finally {
      slot.semaphore.release();
    }
  }

  private async executeWithRetry(request: ChatRequest, slot: ProviderSlot, startTime: number, logPrefix: string): Promise<ChatResponse> {
    const maxRetries = this.resolvedConfig.maxRetries;
    const trace = request.trace;
    let retryCount = 0;
    let backoffTotalMs = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const attemptStart = Date.now();
      try {
        trace?.setMeta?.(`dm.gateway.provider.${slot.name}.attemptCount`, attempt + 1);
        console.log(`${logPrefix} [${slot.name}] LLM call attempt ${attempt + 1}/${maxRetries + 1}. Elapsed: ${attemptStart - startTime}ms`);
        const response = await slot.provider.createResponse(request);
        const llmTime = Date.now() - attemptStart;
        trace?.setMeta?.(`dm.gateway.provider.${slot.name}.rawLatencyMs`, llmTime);
        trace?.setMeta?.("dm.gateway.retryCount", retryCount);
        trace?.setMeta?.("dm.gateway.backoffMsTotal", backoffTotalMs);
        console.log(`${logPrefix} [${slot.name}] LLM responded in ${llmTime}ms`);
        return response;
      } catch (error) {
        const errorTime = Date.now();
        const classified = classifyProviderError(error);
        console.log(`${logPrefix} [${slot.name}] LLM call failed after ${errorTime - attemptStart}ms (attempt ${attempt + 1}): ${error instanceof Error ? error.message : error}. Category: ${classified.category}, retryable: ${classified.retryable}`);

        // Don't retry non-retryable errors
        if (!classified.retryable || attempt >= maxRetries) {
          throw error;
        }

        // Exponential backoff with jitter
        const delay = this.calculateBackoff(attempt);
        retryCount += 1;
        backoffTotalMs += delay;
        trace?.setMeta?.("dm.gateway.retryCount", retryCount);
        trace?.setMeta?.("dm.gateway.backoffMsTotal", backoffTotalMs);
        trace?.setMeta?.(`dm.gateway.provider.${slot.name}.lastRetryCategory`, classified.category);
        console.log(`${logPrefix} [${slot.name}] Retrying after ${delay}ms backoff...`);
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
