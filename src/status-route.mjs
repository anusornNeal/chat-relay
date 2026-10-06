function unavailable() {
  return Response.json({ error: "relay_unavailable" }, { status: 503 });
}

function limited() {
  return Response.json({ error: "rate_limited" }, { status: 429 });
}

function forwardRegistryFailure(response) {
  if (response.status >= 500) return unavailable();
  if (response.status === 429) return limited();
  return response;
}

export async function handleStatusRequest({
  request,
  expectedProtocolVersion,
  authenticate,
  resolveAgent,
  getAgentAccess,
  getRelayStatus,
  features = {},
}) {
  let authentication;
  try {
    authentication = await authenticate();
  } catch {
    return unavailable();
  }
  if (!authentication || typeof authentication !== "object") return unavailable();
  if (authentication.response?.status >= 500) return unavailable();
  if (authentication.response?.status === 429) return limited();
  if (!authentication.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const user = authentication.user;
  const requestUrl = new URL(request.url);
  const compact = requestUrl.searchParams.get("compact") === "1";
  let agentId = requestUrl.searchParams.get("agentId") || undefined;
  if (!agentId) {
    let resolved;
    try {
      resolved = await resolveAgent(user.id);
    } catch {
      return unavailable();
    }
    if (!resolved || typeof resolved !== "object") return unavailable();
    if (!resolved.ok) {
      if (!resolved.response) return unavailable();
      return forwardRegistryFailure(resolved.response);
    }
    agentId = resolved.agentId;
  }

  let access;
  try {
    access = await getAgentAccess(user.id, agentId);
  } catch {
    return unavailable();
  }
  if (!access || !(access.response instanceof Response) || !access.data || typeof access.data !== "object") {
    return unavailable();
  }
  if (!access.response.ok) return forwardRegistryFailure(access.response);

  let relayStatus = { online: false };
  if (access.data.authorized) {
    try {
      const response = await getRelayStatus(agentId);
      if (!response.ok) return unavailable();
      relayStatus = await response.json();
      if (!relayStatus || typeof relayStatus !== "object" || typeof relayStatus.online !== "boolean") {
        return unavailable();
      }
    } catch {
      return unavailable();
    }
  }

  const connection = { ...relayStatus };
  delete connection.diagnostics;

  if (compact) {
    return Response.json({
      agentId,
      agentName: access.data.agent?.name ?? agentId,
      enabled: access.data.agent?.enabled === true,
      authorized: access.data.authorized === true,
      reauthorizationRequired: access.data.reauthorizationRequired === true,
      online: relayStatus.online,
      features: features && typeof features === "object" ? features : {},
      expectedProtocolVersion,
    });
  }

  return Response.json({
    agentId,
    agentName: access.data.agent?.name ?? agentId,
    ownerUserId: access.data.agent?.ownerUserId ?? null,
    enabled: access.data.agent?.enabled === true,
    retiredAt: access.data.agent?.retiredAt ?? null,
    lastSeenAt: access.data.agent?.lastSeenAt ?? null,
    scopes: access.data.scopes ?? [],
    authorized: access.data.authorized === true,
    reauthorizationRequired: access.data.reauthorizationRequired === true,
    online: relayStatus.online,
    connection,
    lifecycle: relayStatus.lifecycle ?? null,
    features: features && typeof features === "object" ? features : {},
    expectedProtocolVersion,
  });
}
