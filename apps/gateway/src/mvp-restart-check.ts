import { buildApp } from "./main.js";

const requireDbUrl = (): void => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for restart check");
  }
};

const run = async (): Promise<void> => {
  requireDbUrl();

  const email = `restart-${Date.now()}@opendungeon.dev`;
  const password = "secret123";

  const app1 = await buildApp();

  const reg = await app1.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password, displayName: "Restart Tester" }
  });
  const regBody = reg.json();
  const token1 = regBody.token as string;

  const campaignRes = await app1.inject({
    method: "POST",
    url: "/campaigns",
    headers: { authorization: `Bearer ${token1}` },
    payload: { title: "Restart Campaign" }
  });
  const campaignId = campaignRes.json().campaign.id as string;

  await app1.inject({
    method: "POST",
    url: `/campaigns/${campaignId}/characters`,
    headers: { authorization: `Bearer ${token1}` },
    payload: { name: "Aren", className: "Ranger" }
  });

  const sessionRes = await app1.inject({
    method: "POST",
    url: `/campaigns/${campaignId}/sessions`,
    headers: { authorization: `Bearer ${token1}` }
  });
  const sessionId = sessionRes.json().session.id as string;

  await app1.inject({
    method: "POST",
    url: `/sessions/${sessionId}/actions`,
    headers: { authorization: `Bearer ${token1}` },
    payload: { actionText: "look around" }
  });

  await app1.close();

  const app2 = await buildApp();

  const login = await app2.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password }
  });
  const token2 = login.json().token as string;

  const stateRes = await app2.inject({
    method: "GET",
    url: `/sessions/${sessionId}/state`,
    headers: { authorization: `Bearer ${token2}` }
  });
  const stateBody = stateRes.json();

  if (!stateBody.worldState?.lastObservation) {
    throw new Error("worldState did not survive restart");
  }
  if (!Array.isArray(stateBody.events) || stateBody.events.length === 0) {
    throw new Error("events did not survive restart");
  }

  process.stdout.write("Restart check passed: world state and events restored\n");
  await app2.close();
};

run().catch((error) => {
  process.stderr.write(`Restart check failed: ${String(error)}\n`);
  process.exit(1);
});
