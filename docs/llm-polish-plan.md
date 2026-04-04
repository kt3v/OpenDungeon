# LLM Polish Plan

This plan tracks post-MVP improvements for provider UX, reliability, and content-first architecture.

## Phase 1 - Provider UX (near-term)

- Add interactive setup command for provider selection and key onboarding.
- Support provider-specific onboarding paths:
  - MiniMax: key input, model discovery, save config.
  - Codex/ChatGPT auth: reuse local Codex session token when available.
- Add a quick diagnostics endpoint and probe command for preflight checks.
- Expose active provider/model status in web UI.

## Phase 2 - Runtime Guardrails

- Move tool contract schemas into shared SDK types and validation helpers.
- Add strict limits for state patch size and summary length.
- Add deterministic fallback behavior for each tool call category.
- Add provider error classification (auth, rate-limit, malformed output, network).

## Phase 3 - Content-first DM Expansion

- Add module-level DM prompt templates with context slots.
- Add module-level tool policy (allowed tools and constraints per module).
- Add module-level suggested action strategy for different campaign styles.

## Phase 4 - Testability and CI

- Add integration test profile for real provider smoke checks (optional/manual secrets).
- Add golden tests for DM JSON parsing and tool-call normalization.
- Add end-to-end tests for summary persistence and suggested actions refresh.

## Phase 5 - Developer Experience

- Add `llm:setup --non-interactive` mode for CI and scripts.
- Add env profile loader command (`llm:profile`), e.g. minimax/codex templates.
- Add better docs for multi-provider routing and provider failover strategy.
