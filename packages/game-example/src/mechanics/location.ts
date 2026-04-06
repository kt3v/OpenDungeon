import { defineMechanic } from "@opendungeon/content-sdk";

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
  }
});
