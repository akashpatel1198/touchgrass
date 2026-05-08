// Wire-format types mirroring the daemon's Pydantic models. Keep these in sync
// manually — OpenAPI codegen is a "Later" item per ROADMAP.

export type SessionStatus =
  | "active"
  | "waiting_permission"
  | "completed"
  | "failed";

export type MessageRole = "user" | "assistant" | "tool_call" | "tool_result";

export type PermissionStatus =
  | "pending"
  | "allowed_once"
  | "allowed_project"
  | "denied";

export type DecisionKind = "allow_once" | "allow_project" | "deny";

export interface Project {
  name: string;
  path: string;
}

export interface Session {
  id: string;
  project_name: string;
  goal: string | null;
  status: SessionStatus;
  created_at: string;
}

export interface Message {
  id: number;
  session_id: string;
  role: MessageRole;
  content: string;
  tool_name: string | null;
  tool_args: string | null;
  created_at: string;
}

export interface PermissionRequest {
  id: string;
  session_id: string;
  tool_name: string;
  tool_args: string;
  status: PermissionStatus;
  created_at: string;
  resolved_at: string | null;
}

export interface CreateSessionResponse {
  session_id: string;
}

export interface TreeEntry {
  name: string;
  type: "file" | "dir";
  size: number | null;
}

export interface FileSummaryResponse {
  path: string;
  summary: string;
  cached: boolean;
}

export interface FileContentsResponse {
  path: string;
  contents: string;
  size: number;
}
