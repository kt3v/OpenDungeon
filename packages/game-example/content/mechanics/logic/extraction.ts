import { defineMechanic } from "@opendungeon/content-sdk";

/**
 * Extraction mechanic — roguelite "extraction shooter" pattern.
 *
 * Rules:
 * - Items found during a session accumulate in `worldState.sessionLoot`.
 * - If the player reaches an exit and successfully extracts, session loot
 *   is moved to `worldState.persistedLoot[playerId]` (survives between runs).
 * - If the session ends via death or abandonment, session loot is lost.
 *
 * The DM is told to:
 * - Mark `nearExit: true` in worldPatch when the player reaches an exit point.
 * - Append found items to `lootFound` in worldPatch.
 *
 * This mechanic is fully self-contained. It does not touch engine-core or gateway.
 */
const STARTING_GEAR: Record<string, { id: string; label: string }[]> = {
  Warrior: [{ id: "iron_shield", label: "Iron Shield" }],
  Mage:    [{ id: "spell_tome", label: "Worn Spell Tome" }],
  Ranger:  [{ id: "quiver", label: "Quiver of Arrows" }]
};

export const extractionMechanic = defineMechanic({
  id: "extraction",

  hooks: {
    onCharacterCreated: async (ctx) => {
      const gear = STARTING_GEAR[ctx.characterClass] ?? [];

      const persistedKey = `persistedLoot_${ctx.playerId}`;
      const existing = Array.isArray(ctx.worldState[persistedKey])
        ? (ctx.worldState[persistedKey] as unknown[])
        : [];

      return {
        worldPatch: {
          [persistedKey]: [...existing, ...gear]
        },
        characterState: {
          gold: 10,
          inventory: gear.map(g => ({ id: g.id, label: g.label }))
        }
      };
    },

    onSessionStart: async (ctx) => {
      // Reset session loot at the start of each run
      return {
        worldPatch: {
          sessionLoot: [],
          nearExit: false
        }
      };
    },

    onActionResolved: async (result, ctx) => {
      const patch: Record<string, unknown> = {};

      // If the DM found loot this turn, add it to session loot
      const lootFound = result.worldPatch?.lootFound;
      if (Array.isArray(lootFound) && lootFound.length > 0) {
        const currentLoot = Array.isArray(ctx.worldState.sessionLoot)
          ? ctx.worldState.sessionLoot
          : [];
        patch.sessionLoot = [...currentLoot, ...lootFound];
        // Clear the transient lootFound key from the patch
        const { lootFound: _removed, ...rest } = result.worldPatch ?? {};
        result = { ...result, worldPatch: { ...rest, ...patch } };
      }

      // If the DM moved the player near an exit, surface the extract action
      if (result.worldPatch?.nearExit === true) {
        const sessionLoot = Array.isArray(ctx.worldState.sessionLoot)
          ? ctx.worldState.sessionLoot
          : [];
        const extractAction = {
          id: "extraction.extract",
          label: `Extract (${sessionLoot.length} item${sessionLoot.length !== 1 ? "s" : ""})`,
          prompt: "exit the dungeon and extract with your loot"
        };

        const existing = result.suggestedActions ?? [];
        if (!existing.some((a) => a.id === "extraction.extract")) {
          result = {
            ...result,
            suggestedActions: [extractAction, ...existing].slice(0, 4)
          };
        }
      }

      return result;
    },

    onSessionEnd: async (ctx) => {
      if (ctx.reason !== "extraction_success") {
        // Lost run — session loot is wiped (already gone when session ends)
        return {};
      }

      // Successful extraction — persist loot across runs
      const sessionLoot = Array.isArray(ctx.worldState.sessionLoot)
        ? ctx.worldState.sessionLoot
        : [];

      const persistedKey = `persistedLoot_${ctx.playerId}`;
      const existing = Array.isArray(ctx.worldState[persistedKey])
        ? (ctx.worldState[persistedKey] as unknown[])
        : [];

      return {
        worldPatch: {
          sessionLoot: [],
          [persistedKey]: [...existing, ...sessionLoot]
        }
      };
    }
  },

  actions: {
    camp: {
      description: "Set up a campfire to rest and recover",
      validate: (ctx) => {
        if (!ctx.worldState.safeToRest) {
          return "This area is too dangerous to camp. Find a safer spot first.";
        }
        return true;
      },
      resolve: async () => ({
        message:
          "You clear a small patch of ground, stack kindling, and coax a flame to life. The warmth is immediate. You settle in for a short rest.",
        worldPatch: {
          campfireActive: true,
          safeToRest: false
        },
        suggestedActions: [
          {
            id: "continue",
            label: "Break camp and move on",
            prompt: "put out the fire and continue"
          }
        ]
      })
    },

    revive: {
      description: "Use a revival token to return from death with reduced HP",
      validate: (ctx) => {
        const tokens = Number(ctx.worldState.revivalTokens);
        if (Number.isNaN(tokens) || tokens < 1) {
          return "You have no revival tokens. Death is permanent this run.";
        }
        return true;
      },
      resolve: async () => ({
        message:
          "The revival token shatters as you grasp it. A surge of warmth pulls you back from the brink. You survive — barely.",
        worldPatch: {
          revivalTokens: 0
        },
        characterState: {
          hp: 1
        }
      })
    },

    extract: {
      description: "Exit the dungeon and keep your session loot",
      validate: (ctx) => {
        if (ctx.worldState.nearExit !== true) {
          return "You must reach an exit point before you can extract.";
        }
        return true;
      },
      resolve: async (ctx) => {
        const sessionLoot = Array.isArray(ctx.worldState.sessionLoot)
          ? ctx.worldState.sessionLoot
          : [];
        const count = sessionLoot.length;

        return {
          message:
            count > 0
              ? `You slip through the exit, ${count} item${count !== 1 ? "s" : ""} secured. The dungeon can wait — you live to return.`
              : "You exit empty-handed, but alive. There is always another run.",
          endSession: "extraction_success"
        };
      }
    }
  }
});
