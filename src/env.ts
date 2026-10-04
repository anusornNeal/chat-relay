export interface Env {
  RELAY: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
  USAGE: DurableObjectNamespace;
  AUDIT: DurableObjectNamespace;
  DASHBOARD: DurableObjectNamespace;
  ASSETS?: Fetcher;
  ADMIN_TOKEN?: string;
  AGENT_TOKEN?: string;
  CALLER_TOKEN?: string;
  USER_RATE_LIMIT_PER_WINDOW?: string;
  USER_RATE_WINDOW_SECONDS?: string;
  USER_DAILY_CALL_QUOTA?: string;
  AUDIT_RETENTION_DAYS?: string;
  OPENAI_APPS_CHALLENGE?: string;
  PUBLIC_BASE_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
}

export type AuthUser = { id: string; name: string };
