import { defineMechanics } from "@opendungeon/content-sdk";
import { extractionMechanic } from "./mechanics/extraction.js";
import { locationMechanic } from "./mechanics/location.js";

/**
 * TypeScript extension for OpenDungeon Classic.
 *
 * All other module data (classes, DM config, setting, skills, resources)
 * is loaded from JSON/Markdown files in the module root.
 *
 * This file only exports additional mechanics that implement complex,
 * stateful gameplay logic beyond what declarative files can express.
 */
export default defineMechanics({
  mechanics: [locationMechanic, extractionMechanic]
});
