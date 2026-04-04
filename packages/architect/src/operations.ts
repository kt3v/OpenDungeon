export type LoreEntityType = "NPC" | "Location" | "Item" | "Faction" | "Lore";
export type MilestoneType = "boss_kill" | "story_beat" | "campaign_end" | "custom";
export type LoreSource = "runtime" | "developer" | "chronicler";

export type ArchitectOperation =
  | {
      op: "upsert_lore";
      entityName: string;
      type: LoreEntityType;
      description: string;
      /** When true, overwrites an existing entry regardless of its current content */
      authoritative?: boolean;
    }
  | {
      op: "set_world_fact";
      key: string;
      value: unknown;
      /** Recorded in WorldFact.lastSessionId to distinguish architect writes from player writes */
      sourceTag: "developer" | "chronicler";
    }
  | {
      op: "append_session_archive";
      sessionId: string;
      text: string;
    }
  | {
      op: "append_campaign_archive";
      text: string;
    }
  | {
      op: "create_milestone";
      title: string;
      description: string;
      milestoneType: MilestoneType;
      sessionId?: string;
    }
  | {
      op: "resolve_lore_conflict";
      entityName: string;
      canonicalDescription: string;
    };
