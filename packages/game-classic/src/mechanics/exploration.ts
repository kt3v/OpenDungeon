import { defineMechanic } from "@opendungeon/content-sdk";

/**
 * Exploration mechanic — handles deterministic look/listen actions
 * without calling the DM (LLM). Fast and always available.
 */
export const explorationMechanic = defineMechanic({
  id: "exploration",

  actions: {
    look: {
      description: "Observe your immediate surroundings",
      resolve: async (ctx) => {
        const loc = typeof ctx.worldState.location === "string"
          ? ctx.worldState.location
          : "the dungeon";

        return {
          message: `You scan ${loc}. Torchlight catches dust motes drifting past an iron door to the north.`,
          worldPatch: { lastObservation: "iron_door" },
          suggestedActions: [
            { id: "exploration.inspect_door", label: "Inspect the door", prompt: "inspect the iron door" },
            { id: "exploration.listen", label: "Listen at the door", prompt: "press your ear against the door" },
            { id: "advance", label: "Move north", prompt: "push open the door and advance north" }
          ]
        };
      }
    },

    listen: {
      description: "Listen carefully to your surroundings",
      resolve: async (ctx) => {
        const hasObservation = typeof ctx.worldState.lastObservation === "string";
        return {
          message: hasObservation
            ? "You hold your breath. Beyond the iron door you hear slow, deliberate footsteps."
            : "Silence — except for the distant drip of water somewhere below.",
          worldPatch: { lastSound: hasObservation ? "footsteps_beyond_door" : "dripping_water" }
        };
      }
    },

    inspect_door: {
      description: "Examine the iron door closely",
      resolve: async () => ({
        message:
          "The door is unlocked, but its hinges are rusted. Opening it will make noise. A faint draft suggests a room or passage beyond.",
        worldPatch: { doorInspected: true, doorLocked: false },
        suggestedActions: [
          { id: "advance", label: "Open the door (noisy)", prompt: "force the door open quickly" },
          { id: "exploration.listen", label: "Listen first", prompt: "press your ear against the door" }
        ]
      })
    }
  },

  dmPromptExtension: ({ worldState }) => {
    const lines: string[] = ["## Exploration State"];
    if (typeof worldState.location === "string") {
      lines.push(`Current location: ${worldState.location}`);
    }
    if (typeof worldState.lastObservation === "string") {
      lines.push(`Last observed: ${worldState.lastObservation}`);
    }
    if (typeof worldState.lastSound === "string") {
      lines.push(`Last heard: ${worldState.lastSound}`);
    }
    return lines.join("\n");
  }
});
