// WebSocket client for `/sessions/{id}/stream`. Two streams of payloads share
// the connection:
//
//   1. `replay` envelopes — the daemon sends the last N persisted messages on
//      every connect (and reconnect). Treat each open as "wipe transcript and
//      repaint from replay" so reconnects don't duplicate rows.
//   2. Live `Event`s — assistant_message, tool_call, tool_result,
//      permission_request, session_status, error. Same shape as the daemon's
//      `events.Event` dataclass.
//
// Reconnect-with-backoff is built in. Sends are NOT routed through this
// wrapper — submit prompts via REST (`api.submitPrompt`); the WS is
// receive-only from the client's perspective for v1.
//
// RN's WebSocket constructor accepts a 3rd argument with `{ headers }`. That's
// how we attach the bearer token (the Web platform's WebSocket doesn't support
// custom headers, but RN's polyfill does).

import type { ApiConfig } from "./client";
import type { MessageRole, SessionStatus } from "./types";

export interface ReplayPayload {
  id: number;
  role: MessageRole;
  content: string;
  tool_name: string | null;
  tool_args: string | null;
  created_at: string;
}

export type WsEvent =
  | { type: "replay"; session_id: string; payload: ReplayPayload }
  | {
      type: "assistant_message";
      session_id: string;
      payload: { text: string };
    }
  | {
      type: "tool_call";
      session_id: string;
      payload: {
        tool_use_id: string;
        tool_name: string;
        tool_args: unknown;
      };
    }
  | {
      type: "tool_result";
      session_id: string;
      payload: {
        tool_use_id: string;
        content: unknown;
        is_error: boolean;
      };
    }
  | {
      type: "permission_request";
      session_id: string;
      payload: {
        request_id: string;
        tool_name: string;
        tool_args: unknown;
        created_at: string;
      };
    }
  | {
      type: "session_status";
      session_id: string;
      payload: { status: SessionStatus };
    }
  | { type: "error"; session_id: string; payload: { message: string } };

export type WsConnectionStatus = "connecting" | "open" | "closed";

export interface WsHandlers {
  onEvent: (event: WsEvent) => void;
  onStatusChange?: (status: WsConnectionStatus) => void;
}

export interface WsHandle {
  close: () => void;
}

const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 16000, 30000];

export function connectSessionStream(
  config: ApiConfig,
  sessionId: string,
  handlers: WsHandlers,
): WsHandle {
  const wsUrl =
    config.baseUrl.replace(/^http/, "ws").replace(/\/$/, "") +
    `/sessions/${encodeURIComponent(sessionId)}/stream`;

  let socket: WebSocket | null = null;
  let attempt = 0;
  let cancelled = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (s: WsConnectionStatus) => handlers.onStatusChange?.(s);

  const open = () => {
    if (cancelled) return;
    setStatus("connecting");
    // RN's WebSocket polyfill takes a 3rd `options` arg with `headers`. The
    // DOM lib's type signature doesn't include it, so we cast the constructor.
    const Ctor = WebSocket as unknown as new (
      url: string,
      protocols: string | string[] | undefined,
      options: { headers?: Record<string, string> },
    ) => WebSocket;
    socket = new Ctor(wsUrl, undefined, {
      headers: { Authorization: `Bearer ${config.bearerToken}` },
    });

    socket.onopen = () => {
      attempt = 0;
      setStatus("open");
    };
    socket.onmessage = (msg) => {
      if (typeof msg.data !== "string") return;
      try {
        const parsed = JSON.parse(msg.data) as WsEvent;
        handlers.onEvent(parsed);
      } catch {
        // ignore malformed frames
      }
    };
    socket.onerror = () => {
      // The error event is followed by close; reconnect logic lives there.
    };
    socket.onclose = () => {
      socket = null;
      if (cancelled) {
        setStatus("closed");
        return;
      }
      const delay =
        BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)];
      attempt += 1;
      setStatus("connecting");
      reconnectTimer = setTimeout(open, delay);
    };
  };

  open();

  return {
    close() {
      cancelled = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        const s = socket;
        socket = null;
        s.close();
      }
      setStatus("closed");
    },
  };
}
