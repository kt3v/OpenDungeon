import { defineMechanics } from "@opendungeon/content-sdk";
import { extractionMechanic } from "./mechanics/extraction.js";

/**
 * TypeScript extension for OpenDungeon Classic.
 *
 * All other module data (classes, DM config, setting, context modules, indicators)
 * is loaded from JSON/Markdown files in the module root.
 *
 * This file only exports additional mechanics that implement complex,
 * stateful gameplay logic beyond what declarative files can express.
 */
export default defineMechanics({
  mechanics: [extractionMechanic]
});
