import { defineGameModule } from "@opendungeon/content-sdk";
import { dmConfig } from "./content/dm-config.js";
import { availableClasses, getCharacterTemplate } from "./content/classes.js";
import { explorationMechanic } from "./mechanics/exploration.js";
import { extractionMechanic } from "./mechanics/extraction.js";
import { locationMechanic } from "./mechanics/location.js";

const manifest = {
  name: "@opendungeon/game-classic",
  version: "0.2.0",
  engine: "^1.0.0",
  contentApi: "^2.0.0",
  capabilities: ["map.v1", "inventory.v1", "dialogue.v1", "extraction.v1"],
  entry: "dist/index.js",
  stateVersion: 2
};

export default defineGameModule({
  manifest,

  initial: {
    // Shared campaign world — no player-specific keys here.
    // Location is assigned per-character by locationMechanic.onCharacterCreated.
    // sessionLoot / nearExit are reset per-session by extractionMechanic.onSessionStart.
    worldState: () => ({})
  },

  characters: {
    availableClasses,
    getTemplate: getCharacterTemplate
  },

  dm: dmConfig,

  /**
   * Mechanics are evaluated in order.
   * Exploration handles deterministic look/listen actions (fast, no LLM).
   * Extraction intercepts action results to track loot and surfaces the extract action.
   */
  // locationMechanic runs first: sets starting location and intercepts movement patches.
  mechanics: [locationMechanic, explorationMechanic, extractionMechanic]
});
