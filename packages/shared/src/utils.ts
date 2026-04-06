/**
 * Strips markdown code fences from a string.
 * Common in LLM responses that wrap JSON in ```json blocks.
 */
export const stripCodeFence = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    const lines = trimmed.split("\n");
    // Remove the first line (fence opener like ```json) and last line (```)
    return lines.slice(1, -1).join("\n");
  }
  return value;
};

/**
 * Approximates the number of tokens in a string based on byte length.
 * Rule of thumb: 1 token ~= 4 characters or 4 bytes for UTF-8.
 */
export const approximateTokens = (value: string): number =>
  Math.ceil(Buffer.byteLength(value, "utf8") / 4);

/**
 * Checks if a value is a non-null object (record).
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
