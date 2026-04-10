import { defineMechanic } from "@opendungeon/content-sdk";

const STARTING_GEAR: Record<string, { id: string; label: string }[]> = {
  Warrior: [{ id: "iron_shield", label: "Iron Shield" }],
  Mage: [{ id: "spell_tome", label: "Worn Spell Tome" }],
  Ranger: [{ id: "quiver", label: "Quiver of Arrows" }]
};

export const extractionMechanic = defineMechanic({
  id: "extraction",

  hooks: {
    onCharacterCreated: async (ctx) => {
      const gear = STARTING_GEAR[ctx.characterClass] ?? [];
      return {
        stateOps: [
          { op: "set", varId: "gold", value: 10 },
          { op: "set", varId: "inventory", value: gear.map((g) => ({ id: g.id, label: g.label })) }
        ]
      };
    },

    onSessionStart: async () => ({
      stateOps: [
        { op: "set", varId: "sessionLoot", value: [] },
        { op: "set", varId: "nearExit", value: false }
      ]
    }),

    onActionResolved: async (result, ctx) => {
      const nearExit = ctx.characterState.nearExit === true;
      if (!nearExit) return result;

      const sessionLoot = Array.isArray(ctx.characterState.sessionLoot)
        ? ctx.characterState.sessionLoot
        : [];

      const extractAction = {
        id: "extraction.extract",
        label: `Extract (${sessionLoot.length} item${sessionLoot.length !== 1 ? "s" : ""})`,
        prompt: "exit the dungeon and extract with your loot"
      };

      const existing = result.suggestedActions ?? [];
      if (existing.some((a) => a.id === "extraction.extract")) {
        return result;
      }

      return {
        ...result,
        suggestedActions: [extractAction, ...existing].slice(0, 4)
      };
    },

    onSessionEnd: async () => ({
      stateOps: [
        { op: "set", varId: "sessionLoot", value: [] },
        { op: "set", varId: "nearExit", value: false }
      ]
    })
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
        stateOps: [
          { op: "set", varId: "safeToRest", value: false }
        ],
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
        const tokens = Number(ctx.worldState["revival.tokens"]);
        if (Number.isNaN(tokens) || tokens < 1) {
          return "You have no revival tokens. Death is permanent this run.";
        }
        return true;
      },
      resolve: async () => ({
        message:
          "The revival token shatters as you grasp it. A surge of warmth pulls you back from the brink. You survive - barely.",
        stateOps: [
          { op: "set", varId: "revival.tokens", value: 0 },
          { op: "set", varId: "revival.lastUse", value: "current_run" },
          { op: "set", varId: "hp", value: 1 }
        ]
      })
    },

    extract: {
      description: "Exit the dungeon and keep your session loot",
      validate: (ctx) => {
        if (ctx.characterState.nearExit !== true) {
          return "You must reach an exit point before you can extract.";
        }
        return true;
      },
      resolve: async (ctx) => {
        const sessionLoot = Array.isArray(ctx.characterState.sessionLoot)
          ? ctx.characterState.sessionLoot
          : [];
        const count = sessionLoot.length;

        return {
          message:
            count > 0
              ? `You slip through the exit, ${count} item${count !== 1 ? "s" : ""} secured. The dungeon can wait - you live to return.`
              : "You exit empty-handed, but alive. There is always another run.",
          endSession: "extraction_success"
        };
      }
    }
  }
});
