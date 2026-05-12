// ACP (Agent Client Protocol) v1 type definitions

export type { JsonObject, JsonValue, JsonArray } from "./json-types";

// ── JSON-RPC base ──────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: Record<string, unknown>;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// ── ACP Methods ────────────────────────────────────────────────

export const ACP_METHODS = {
  INITIALIZE: "initialize",
  SESSION_NEW: "session/new",
  SESSION_PROMPT: "session/prompt",
  SESSION_CANCEL: "session/cancel",
  SESSION_LOAD: "session/load",
  SESSION_SET_MODEL: "session/set_model",
  SESSION_LIST_MODELS: "session/list_models",
  SESSION_UPDATE: "session/update",
  SESSION_REQUEST_PERMISSION: "session/request_permission",
  ASK_USER: "_agentao.cn/ask_user",
} as const;

export type AcpMethod = (typeof ACP_METHODS)[keyof typeof ACP_METHODS];

// ── Initialize ─────────────────────────────────────────────────

export interface InitializeParams {
  protocolVersion: number;
  clientInfo?: { name: string; version: string };
  clientCapabilities?: Record<string, unknown>;
}

export interface InitializeResult {
  protocolVersion: number;
  serverInfo?: { name: string; version: string };
  capabilities: {
    experimental?: Record<string, unknown>;
  };
}

// ── Session ────────────────────────────────────────────────────

export interface SessionNewParams {
  cwd: string;
  mcpServers?: Record<string, unknown>[];
}

export interface SessionNewResult {
  sessionId: string;
}

export interface SessionLoadParams {
  sessionId: string;
  cwd: string;
  history?: unknown[];
}

export interface SessionPromptParams {
  sessionId: string;
  prompt: string;
}

export interface SessionCancelParams {
  sessionId: string;
}

export interface SessionSetModelParams {
  sessionId: string;
  modelName: string;
}

// ── Models ─────────────────────────────────────────────────────

export interface ModelInfo {
  name: string;
  description?: string;
}

export interface ListModelsResult {
  models: ModelInfo[];
}

// ── Session Update (server→client notification) ────────────────

export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdate;
}

export type SessionUpdate =
  | AgentMessageChunk
  | ToolCall
  | ToolCallUpdate
  | AgentThinking
  | ToolResult
  | SessionStatusUpdate;

export interface AgentMessageChunk {
  sessionUpdate: "agent_message_chunk";
  content: { text: string };
}

export interface AgentThinking {
  sessionUpdate: "agent_thinking";
  content: { text: string };
}

export interface ToolCall {
  sessionUpdate: "tool_call";
  content: {
    toolCallId: string;
    tool: string;
    args: string;
  };
}

export interface ToolCallUpdate {
  sessionUpdate: "tool_call_update";
  content: {
    toolCallId: string;
    status?: "pending" | "running" | "success" | "error";
  };
}

export interface ToolResult {
  sessionUpdate: "tool_result";
  content: {
    toolCallId: string;
    result: string;
  };
}

export interface SessionStatusUpdate {
  sessionUpdate: "session_status";
  content: {
    status: "idle" | "running" | "error" | "cancelled";
    stopReason?: string;
  };
}

// ── Request Permission (server→client request) ─────────────────

export interface RequestPermissionParams {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    tool: string;
    title?: string;
    args?: string;
  };
  options: PermissionOption[];
}

export interface PermissionOption {
  id: string;
  label: string;
}

export interface RequestPermissionResponse {
  sessionId: string;
  outcome: {
    optionId: string;
  };
}

// ── Ask User (Agentao extension) ───────────────────────────────

export interface AskUserParams {
  sessionId: string;
  prompt: string;
  options?: { id: string; label: string }[];
}

export interface AskUserResponse {
  sessionId: string;
  response: string;
}
