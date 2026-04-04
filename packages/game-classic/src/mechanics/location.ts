import { defineMechanic } from "@opendungeon/content-sdk";

// ---------------------------------------------------------------------------
// World map — known locations with short DM-facing descriptions
// ---------------------------------------------------------------------------

const LOCATIONS: Record<string, string> = {
  dungeon_entrance:  "the main entrance — rubble-framed corridor, torches guttering",
  fortress_gate:     "a fortified gatehouse, iron portcullis half-raised, arrow slits on both walls",
  arcane_vault:      "a collapsed library, arcane runes on cracked stone, scrolls scattered across broken shelves",
  forest_passage:    "a narrow tunnel where tree roots pierce the ceiling, damp soil underfoot",
  northern_corridor: "a wide corridor heading north, water stains on the walls",
  great_hall:        "a vast hall with a vaulted ceiling, remains of long tables, cold fireplace",
  treasury:          "a heavy iron door, hinges rusted — wealth once lay beyond",
  crypts:            "sunken chambers smelling of old stone and decay, burial niches in the walls"
};

// Starting location per character class — each class enters the dungeon
// from a different point, so players share a world but begin apart.
const CLASS_STARTS: Record<string, string> = {
  Warrior: "fortress_gate",
  Mage:    "arcane_vault",
  Ranger:  "forest_passage"
};

const DEFAULT_START = "dungeon_entrance";

// ---------------------------------------------------------------------------
// Mechanic
// ---------------------------------------------------------------------------

export const locationMechanic = defineMechanic({
  id: "location",

  hooks: {
    /**
     * Assign a class-specific starting location into characterState.
     * This is personal — other players start elsewhere in the same world.
     */
    onCharacterCreated: async (ctx) => {
      const startLocation = CLASS_STARTS[ctx.character.className] ?? DEFAULT_START;
      return {
        characterPatch: { location: startLocation }
      };
    },

    /**
     * When the DM moves the player (worldPatch.location), intercept it:
     * remove it from the shared worldPatch and place it in characterPatch
     * so location stays personal and doesn't overwrite other players' position.
     */
    onActionResolved: async (result) => {
      const newLocation = result.worldPatch?.location;
      if (typeof newLocation !== "string") return result;

      const { location: _removed, ...restWorldPatch } = result.worldPatch ?? {};
      return {
        ...result,
        worldPatch: Object.keys(restWorldPatch).length > 0 ? restWorldPatch : undefined,
        characterPatch: { ...result.characterPatch, location: newLocation }
      };
    }
  },

  /**
   * Inject the player's current location into every DM turn.
   * Also surfaces any world facts scoped to this location
   * (keys of the form "location.<name>.<fact>" in shared worldState).
   */
  dmPromptExtension: ({ worldState }) => {
    const location =
      typeof worldState.location === "string" ? worldState.location : DEFAULT_START;

    const desc = LOCATIONS[location] ?? location.replace(/_/g, " ");

    // Collect shared world facts for this specific location
    const prefix = `location.${location}.`;
    const localFacts = Object.entries(worldState)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => `  ${k.slice(prefix.length)}: ${JSON.stringify(v)}`)
      .join("\n");

    return [
      "## Player Location",
      `Current location: ${location} — ${desc}`,
      localFacts ? `World facts here:\n${localFacts}` : "",
      "",
      "Location rules:",
      "- When the player moves to a new area, set `\"location\": \"<id>\"` in worldPatch.",
      "  Use snake_case IDs. The engine keeps location personal (not shared with other players).",
      "- To record something that happened at a place (item left, door broken, NPC met),",
      `  use worldPatch key \`\"location.${location}.<fact>\"\` so other players can discover it.`,
      "- Known locations: " + Object.keys(LOCATIONS).join(", ")
    ]
      .filter(Boolean)
      .join("\n");
  }
});
