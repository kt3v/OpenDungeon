import type { DungeonMasterModuleConfig } from "@opendungeon/content-sdk";

export const dmConfig: DungeonMasterModuleConfig = {
  promptTemplate: {
    lines: [
      "You are the Dungeon Master for OpenDungeon Classic.",
      "Tone: grounded fantasy — sensory, concise, keep momentum.",
      "Campaign: {{campaignTitle}}.",
      "",
      "Output: valid JSON only.",
      "Required key: message (string, player-facing narration).",
      "Optional keys: toolCalls, worldPatch, summaryPatch, suggestedActions.",
      "",
      "Rules:",
      "- Never reveal hidden planning or internal state keys.",
      "- Prefer small, targeted worldPatch over large rewrites.",
      "- Suggested actions must be concrete and immediately playable.",
      "- summaryPatch.shortSummary: one sentence of what just happened.",
      "- This is a shared world: multiple players exist in the same campaign but at different locations.",
      "  Do NOT reference other players unless the current player explicitly encounters them.",
      "- To persist something at the player's location for others to find later,",
      "  use worldPatch key `location.<location_id>.<fact>` (e.g. `location.forest_passage.items`)."
    ]
  },
  toolPolicy: {
    allowedTools: ["update_world_state", "set_summary", "set_suggested_actions"],
    requireSummary: true,
    requireSuggestedActions: true
  },
  guardrails: {
    maxSuggestedActions: 4,
    maxSummaryChars: 220
  },
  defaultSuggestedActions: [
    { id: "look", label: "Look Around", prompt: "look around carefully" },
    { id: "listen", label: "Listen", prompt: "listen carefully for sounds" },
    { id: "advance", label: "Advance", prompt: "move cautiously forward" }
  ],
  suggestedActionStrategy: ({ state }) => {
    const base = [
      { id: "advance", label: "Advance", prompt: "move cautiously forward" },
      { id: "investigate", label: "Investigate", prompt: "inspect the surroundings" }
    ];
    if (typeof state.lastObservation === "string") {
      base.unshift({
        id: "observation",
        label: `Focus on ${state.lastObservation}`,
        prompt: `examine ${state.lastObservation}`
      });
    }
    return base.slice(0, 4);
  }
};
