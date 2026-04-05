import { defineGameModule, loadSkillsDirSync, loadLoreFilesSync } from "@opendungeon/content-sdk";
import { dmConfig } from "./content/dm-config.js";
import { availableClasses, getCharacterTemplate } from "./content/classes.js";
import { extractionMechanic } from "./mechanics/extraction.js";
import { locationMechanic } from "./mechanics/location.js";
import settingConfig from "../setting.json" with { type: "json" };

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

  /**
   * Setting / World Bible — base lore, tone, and constraints for all campaigns.
   * This establishes the world before any runtime lore is added.
   */
  setting: {
    /** Structured setting configuration from setting.json */
    config: settingConfig as import("@opendungeon/content-sdk").SettingConfig,
    /** Markdown lore files loaded from the lore/ directory */
    loreFiles: loadLoreFilesSync(new URL("../lore", import.meta.url).pathname)
  },

  dm: dmConfig,

  /**
   * Mechanics are evaluated in order.
   * Exploration handles deterministic look/listen actions (fast, no LLM).
   * Extraction intercepts action results to track loot and surfaces the extract action.
   */
  // locationMechanic handles character location and per-player position.
  // extractionMechanic handles roguelite loot accumulation and session end.
  // look / listen / inspect are now JSON skills — see skills/ directory.
  mechanics: [locationMechanic, extractionMechanic],

  // Declarative skills — drop a .json file into src/skills/ and it's picked up automatically.
  // No TypeScript, no imports, no restarts needed in dev mode.
  // JSON skill files live in skills/ at the package root — sibling of src/ and dist/.
  // "../skills" resolves correctly from both src/index.ts (dev) and dist/index.js (prod).
  skills: loadSkillsDirSync(new URL("../skills", import.meta.url).pathname)
});
