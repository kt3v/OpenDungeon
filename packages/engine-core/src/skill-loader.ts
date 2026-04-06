import type { Mechanic } from "@opendungeon/content-sdk";

/**
 * Legacy identifier kept only for backwards compile-time compatibility.
 * Runtime skill conversion is intentionally removed.
 */
export const SKILLS_MECHANIC_ID = "skills";

/**
 * @deprecated Declarative skill runtime is removed in vNext.
 * This helper now always returns null.
 */
export const skillSchemasToMechanic = (_schemas: unknown[]): Mechanic | null => null;
