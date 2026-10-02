// Operator provisioning isolates live runtime checks from interactive Google sign-in.
// Device approval, collisions, and credential exchange are tested in device-auth-smoke.mjs.
import { randomUUID } from "node:crypto";
const users = new Map();
export async function provisionOperatorFixture(base, { userId, name, agentId, agentName, login, password }) {
  const adminToken = process.env.TEST_ADMIN_TOKEN || "test-admin";
  async function admin(path, body) {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + adminToken, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error("Operator fixture " + path + " failed: " + response.status + " " + JSON.stringify(data));
    return data;
  }
  let account = users.get(userId);
  if (!account) {
    account = await admin("/admin/users", { id: userId, name });
    if (login && password) await admin("/admin/users/login", { userId, login, password });
    users.set(userId, account);
  }
  const state = await admin("/admin/state");
  let existing = (state.agents || []).find(agent => agent.id === agentId);
  if (existing && existing.ownerUserId !== userId) {
    agentId = agentId.slice(0,54) + "-" + randomUUID().slice(0,8);
    existing = undefined;
  }
  const device = existing
    ? await admin("/admin/agents/rotate", { agentId })
    : await admin("/admin/agents", { id: agentId, name: agentName, ownerUserId: userId });
  await admin("/admin/grants", { userId, agentId, scopes: ["*"] });
  return { user: account.user, userToken: account.token, agent: device.agent, agentToken: device.token };
}
