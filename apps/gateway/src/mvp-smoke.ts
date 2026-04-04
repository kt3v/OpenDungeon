import { buildApp } from "./main.js";

const app = await buildApp();

const printStep = (step: string, payload: unknown): void => {
  process.stdout.write(`\n=== ${step} ===\n`);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
};

/**
 * Poll an action until it completes (done or failed).
 * Returns the result body. Retries up to maxAttempts with delayMs gap.
 */
const pollAction = async (
  sessionId: string,
  actionId: string,
  token: string,
  maxAttempts = 60,
  delayMs = 500
): Promise<unknown> => {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/actions/${actionId}`,
      headers: { authorization: `Bearer ${token}` }
    });
    const body = res.json() as { status: string; result?: unknown; error?: string };
    if (body.status === "done") return body.result;
    if (body.status === "failed") throw new Error(`Action failed: ${body.error}`);
    // Still pending/processing — wait before retrying
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("Action timed out waiting for result");
};

const run = async (): Promise<void> => {
  // 1. Register first player
  const registerResponse = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: "demo@opendungeon.dev", password: "secret123", displayName: "Demo" }
  });
  const { token } = registerResponse.json() as { token: string };
  printStep("1) Register", { token: "***" });

  // 2. Create campaign
  const createCampaignResponse = await app.inject({
    method: "POST",
    url: "/campaigns",
    headers: { authorization: `Bearer ${token}` },
    payload: { title: "MVP Dungeon" }
  });
  const { campaign } = createCampaignResponse.json() as { campaign: { id: string } };
  const campaignId = campaign.id;
  printStep("2) Create Campaign", { campaignId });

  // 3. Start session (creates character)
  const createSessionResponse = await app.inject({
    method: "POST",
    url: `/campaigns/${campaignId}/sessions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "Aren", className: "Ranger" }
  });
  const { session } = createSessionResponse.json() as { session: { id: string } };
  const sessionId = session.id;
  printStep("3) Start Session", createSessionResponse.json());

  // 4. Suggested actions
  const suggestedResponse = await app.inject({
    method: "GET",
    url: `/sessions/${sessionId}/suggested-actions`,
    headers: { authorization: `Bearer ${token}` }
  });
  printStep("4) Suggested Actions", suggestedResponse.json());

  // 5. Register second player and join campaign
  const registerSecondResponse = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: "ally@opendungeon.dev", password: "secret123", displayName: "Ally" }
  });
  const { token: secondToken } = registerSecondResponse.json() as { token: string };
  printStep("5) Register Second Player", { token: "***" });

  const joinResponse = await app.inject({
    method: "POST",
    url: `/campaigns/${campaignId}/join`,
    headers: { authorization: `Bearer ${secondToken}` }
  });
  printStep("6) Second Player Joins Campaign", joinResponse.json());

  // 7. Second player starts their own session
  const createSecondSessionResponse = await app.inject({
    method: "POST",
    url: `/campaigns/${campaignId}/sessions`,
    headers: { authorization: `Bearer ${secondToken}` },
    payload: { name: "Lyra", className: "Mage" }
  });
  const { session: secondSession } = createSecondSessionResponse.json() as {
    session: { id: string };
  };
  const secondSessionId = secondSession.id;
  printStep("7) Second Player Session", createSecondSessionResponse.json());

  // 8. First player submits action (async — returns 202 + actionId)
  const actionResponse = await app.inject({
    method: "POST",
    url: `/sessions/${sessionId}/actions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { actionText: "look around" }
  });
  const { actionId } = actionResponse.json() as { actionId: string };
  printStep("8) Submit Action (202)", { actionId });

  // 9. Second player submits action in parallel (different session, same campaign)
  const secondActionResponse = await app.inject({
    method: "POST",
    url: `/sessions/${secondSessionId}/actions`,
    headers: { authorization: `Bearer ${secondToken}` },
    payload: { actionText: "look around" }
  });
  const { actionId: secondActionId } = secondActionResponse.json() as { actionId: string };
  printStep("9) Second Player Action (202)", { actionId: secondActionId });

  // 10. Poll both actions for results (demonstrates parallel processing)
  const [firstResult, secondResult] = await Promise.all([
    pollAction(sessionId, actionId, token),
    pollAction(secondSessionId, secondActionId, secondToken)
  ]);
  printStep("10) First Action Result", firstResult);
  printStep("11) Second Action Result", secondResult);

  // 12. Session state (worldState = canonical world, characterState = personal)
  const stateResponse = await app.inject({
    method: "GET",
    url: `/sessions/${sessionId}/state`,
    headers: { authorization: `Bearer ${token}` }
  });
  printStep("12) Session State", stateResponse.json());

  // 13. Campaign world state (shared across all players)
  const campaignStateResponse = await app.inject({
    method: "GET",
    url: `/campaigns/${campaignId}/state`,
    headers: { authorization: `Bearer ${token}` }
  });
  printStep("13) Campaign World State", campaignStateResponse.json());

  // 14. Manual session end
  const endSessionResponse = await app.inject({
    method: "POST",
    url: `/sessions/${sessionId}/end`,
    headers: { authorization: `Bearer ${token}` }
  });
  printStep("14) End Session", endSessionResponse.json());

  // 15. Start new session — reads same campaign world state (shared persistence)
  const nextSessionResponse = await app.inject({
    method: "POST",
    url: `/campaigns/${campaignId}/sessions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "Aren II", className: "Warrior" }
  });
  const { session: nextSession } = nextSessionResponse.json() as { session: { id: string } };
  printStep("15) Start Next Session", nextSessionResponse.json());

  const nextStateResponse = await app.inject({
    method: "GET",
    url: `/sessions/${nextSession.id}/state`,
    headers: { authorization: `Bearer ${token}` }
  });
  printStep("16) Next Session Inherits Campaign World", nextStateResponse.json());

  await app.close();
};

run().catch(async (error: unknown) => {
  process.stderr.write(`MVP smoke failed: ${String(error)}\n`);
  await app.close();
  process.exit(1);
});
