import { z } from "zod";

export const sessionEndReasonSchema = z.enum([
  "manual",
  "extraction_success",
  "player_death",
  "campaign_complete",
  "abandoned"
]);

export type SessionEndReason = z.infer<typeof sessionEndReasonSchema>;

export const engineEventSchema = z.object({
  id: z.string().uuid(),
  campaignId: z.string().uuid(),
  sessionId: z.string().uuid(),
  type: z.enum([
    "session.started",
    "session.ended",
    "turn.started",
    "action.submitted",
    "action.resolved",
    "action.blocked",
    "world.updated",
    "player.updated",
    "session.summary.updated"
  ]),
  createdAt: z.string().datetime(),
  payload: z.record(z.unknown())
});

export type EngineEvent = z.infer<typeof engineEventSchema>;
