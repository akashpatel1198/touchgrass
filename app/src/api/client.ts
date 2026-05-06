// Thin fetch wrapper with bearer auth + typed errors. The daemon URL and bearer
// token come from secure storage; this module only knows how to make a request
// once those are configured.

import type {
  CreateSessionResponse,
  DecisionKind,
  Message,
  PermissionRequest,
  Project,
  Session,
} from "./types";

const REQUEST_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "network"
      | "unauthorized"
      | "not_found"
      | "conflict"
      | "server"
      | "client",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiConfig {
  baseUrl: string;
  bearerToken: string;
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort());
  }
  // Best-effort cleanup; AbortController has no public clear-timer hook here.
  void timer;
  return controller.signal;
}

async function request<T>(
  config: ApiConfig,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const url = `${config.baseUrl.replace(/\/$/, "")}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.bearerToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: withTimeout(signal),
    });
  } catch (exc) {
    throw new ApiError(
      exc instanceof Error ? exc.message : "network failure",
      "network",
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = extractDetail(payload, response);
    if (response.status === 401)
      throw new ApiError(detail, "unauthorized", 401);
    if (response.status === 404) throw new ApiError(detail, "not_found", 404);
    if (response.status === 409) throw new ApiError(detail, "conflict", 409);
    if (response.status >= 500)
      throw new ApiError(detail, "server", response.status);
    throw new ApiError(detail, "client", response.status);
  }

  return payload as T;
}

function extractDetail(payload: unknown, response: Response): string {
  if (payload && typeof payload === "object" && "detail" in payload) {
    const detail = (payload as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
  }
  return `${response.status} ${response.statusText}`;
}

export const api = {
  health: (config: ApiConfig) => request<{ status: string }>(config, "GET", "/health"),
  listProjects: (config: ApiConfig) =>
    request<Project[]>(config, "GET", "/projects"),
  listProjectSessions: (config: ApiConfig, projectName: string) =>
    request<Session[]>(
      config,
      "GET",
      `/projects/${encodeURIComponent(projectName)}/sessions`,
    ),
  createSession: (
    config: ApiConfig,
    projectName: string,
    goal: string | null,
  ) =>
    request<CreateSessionResponse>(
      config,
      "POST",
      `/projects/${encodeURIComponent(projectName)}/sessions`,
      { goal },
    ),
  getSession: (config: ApiConfig, sessionId: string) =>
    request<Session>(config, "GET", `/sessions/${sessionId}`),
  getMessages: (
    config: ApiConfig,
    sessionId: string,
    opts?: { limit?: number; beforeId?: number },
  ) => {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.beforeId !== undefined)
      params.set("before_id", String(opts.beforeId));
    const query = params.toString();
    return request<Message[]>(
      config,
      "GET",
      `/sessions/${sessionId}/messages${query ? `?${query}` : ""}`,
    );
  },
  submitPrompt: (config: ApiConfig, sessionId: string, text: string) =>
    request<{ status: string }>(
      config,
      "POST",
      `/sessions/${sessionId}/prompts`,
      { text },
    ),
  listPendingPermissions: (config: ApiConfig) =>
    request<PermissionRequest[]>(config, "GET", "/permissions/pending"),
  decidePermission: (
    config: ApiConfig,
    requestId: string,
    decision: DecisionKind,
  ) =>
    request<void>(
      config,
      "POST",
      `/permissions/${requestId}/decision`,
      { decision },
    ),
};
