/**
 * ACP Client — stdio JSON-RPC 2.0 connection to `agentao --acp --stdio`.
 * Ported from upstream blueprint with typed interfaces and vscode.EventEmitter.
 */
import { spawn, ChildProcessByStdio } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as readline from "node:readline";
import { EventEmitter, Disposable } from "vscode";
import type {
  AgentMessageChunk,
  ToolCall,
  ToolCallUpdate,
  AgentThinking,
  ToolResult,
  SessionStatusUpdate,
  RequestPermissionParams,
  ListModelsResult,
  JsonObject,
} from "./types";
import type { JsonValue, JsonArray } from "./json-types";

type JsonRpcId = number | string;

export interface ACPClientOptions {
  command?: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  rpcTimeoutMs?: number;
}

export class ACPClient implements Disposable {
  private proc!: ChildProcessByStdio<Writable, Readable, Readable>;
  private nextId = 1;
  private pending = new Map<JsonRpcId, {
    resolve: (msg: JsonObject) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private notifHandlers = new Map<string, Array<(params: JsonObject) => void>>();
  private serverReqHandler?: (method: string, params: JsonObject) => Promise<JsonObject>;
  private rpcTimeoutMs: number;
  private _sessionId?: string;
  private _cwd: string;
  private _disposables: Disposable[] = [];

  // ── Events ────────────────────────────────────────────────────────
  private readonly _onAgentMessageChunk = new EventEmitter<AgentMessageChunk>();
  readonly onAgentMessageChunk = this._onAgentMessageChunk.event;

  private readonly _onToolCall = new EventEmitter<ToolCall>();
  readonly onToolCall = this._onToolCall.event;

  private readonly _onToolCallUpdate = new EventEmitter<ToolCallUpdate>();
  readonly onToolCallUpdate = this._onToolCallUpdate.event;

  private readonly _onToolResult = new EventEmitter<ToolResult>();
  readonly onToolResult = this._onToolResult.event;

  private readonly _onAgentThinking = new EventEmitter<AgentThinking>();
  readonly onAgentThinking = this._onAgentThinking.event;

  private readonly _onSessionStatus = new EventEmitter<SessionStatusUpdate>();
  readonly onSessionStatus = this._onSessionStatus.event;

  private readonly _onRequestPermission = new EventEmitter<RequestPermissionParams>();
  readonly onRequestPermission = this._onRequestPermission.event;

  private readonly _onError = new EventEmitter<Error>();
  readonly onError = this._onError.event;

  private readonly _onStderr = new EventEmitter<string>();
  readonly onStderr = this._onStderr.event;

  constructor(private readonly opts: ACPClientOptions) {
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 60_000;
    this._cwd = opts.cwd;
    this._disposables.push(
      this._onAgentMessageChunk,
      this._onToolCall,
      this._onToolCallUpdate,
      this._onToolResult,
      this._onAgentThinking,
      this._onSessionStatus,
      this._onRequestPermission,
      this._onError,
      this._onStderr,
    );
  }

  get sessionId(): string | undefined { return this._sessionId; }
  get cwd(): string { return this._cwd; }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    const command = this.opts.command ?? "agentao";
    const args = this.opts.args ?? ["--acp", "--stdio"];
    this.proc = spawn(command, args, {
      cwd: this.opts.cwd,
      env: this.opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const processError = new Promise<never>((_, reject) => {
      this.proc.once("error", (err) => {
        const spawnErr = new Error(`Failed to start agentao process: ${err.message}`);
        this._onError.fire(spawnErr);
        reject(spawnErr);
      });
    });

    if (!this.proc.stdout || !this.proc.stderr || !this.proc.stdin) {
      throw new Error("Failed to establish stdio with agentao process");
    }

    const rl = readline.createInterface({
      input: this.proc.stdout,
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => this.dispatch(line));

    this.proc.stderr.on("data", (chunk: Buffer) => {
      this._onStderr.fire(chunk.toString());
    });

    this.proc.on("exit", (code, signal) => {
      let reason = `agentao subprocess exited`;
      if (code !== null) {
        reason += ` (code=${code})`;
        if (code === 1) {
          reason += " - 可能是配置错误或依赖问题";
        } else if (code === 0) {
          reason += " - 进程正常退出";
        }
      }
      if (signal !== null) {
        reason += ` (signal=${signal})`;
      }
      const err = new Error(reason);
      this._onError.fire(err);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(err);
      }
      this.pending.clear();
    });

    await Promise.race([
      processError,
      this.call("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "agentao-vscode", version: "0.1.0" },
        clientCapabilities: {},
      }),
    ]);

    // Register session/update handler
    this.onNotification("session/update", (params: JsonObject) => {
      const update = params.update as JsonObject;
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          this._onAgentMessageChunk.fire(update as unknown as AgentMessageChunk);
          break;
        case "tool_call":
          this._onToolCall.fire(update as unknown as ToolCall);
          break;
        case "tool_call_update":
          this._onToolCallUpdate.fire(update as unknown as ToolCallUpdate);
          break;
        case "tool_result":
          this._onToolResult.fire(update as unknown as ToolResult);
          break;
        case "agent_thinking":
          this._onAgentThinking.fire(update as unknown as AgentThinking);
          break;
        case "session_status":
          this._onSessionStatus.fire(update as unknown as SessionStatusUpdate);
          break;
      }
    });
  }

  async newSession(cwd: string, mcpServers?: JsonObject[]): Promise<string> {
    const params: JsonObject = { cwd };
    if (mcpServers) params.mcpServers = mcpServers;
    const r = await this.call("session/new", params);
    this._sessionId = r.sessionId as string;
    this._cwd = cwd;
    return this._sessionId;
  }

  async loadSession(sessionId: string, cwd: string, history?: JsonValue[]): Promise<void> {
    const params: JsonObject = { sessionId, cwd };
    if (history) params.history = history;
    await this.call("session/load", params);
    this._sessionId = sessionId;
    this._cwd = cwd;
  }

  async prompt(text: string): Promise<JsonObject> {
    if (!this._sessionId) throw new Error("No active session");
    return this.call("session/prompt", {
      sessionId: this._sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  async cancel(): Promise<void> {
    if (!this._sessionId) return;
    await this.call("session/cancel", { sessionId: this._sessionId });
  }

  async listModels(): Promise<ListModelsResult> {
    if (!this._sessionId) throw new Error("No active session");
    const r = await this.call("session/list_models", { sessionId: this._sessionId });
    return r as unknown as ListModelsResult;
  }

  async setModel(modelName: string): Promise<void> {
    if (!this._sessionId) throw new Error("No active session");
    await this.call("session/set_model", { sessionId: this._sessionId, modelName });
  }

  onNotification(method: string, handler: (params: JsonObject) => void): void {
    let handlers = this.notifHandlers.get(method);
    if (!handlers) {
      handlers = [];
      this.notifHandlers.set(method, handlers);
    }
    handlers.push(handler);
  }

  onServerRequest(handler: (method: string, params: JsonObject) => Promise<JsonObject>): void {
    this.serverReqHandler = handler;
  }

  dispose(): void {
    for (const d of this._disposables) d.dispose();
  }

  async close(): Promise<void> {
    this.proc.stdin.end();
    await new Promise<void>((resolve) => {
      if (this.proc.exitCode !== null) { resolve(); return; }
      this.proc.once("exit", () => resolve());
    });
  }

  // ── Internal ──────────────────────────────────────────────────────

  private call(method: string, params: JsonObject): Promise<JsonObject> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`rpc timeout: ${method}`));
        }
      }, this.rpcTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private async dispatch(line: string): Promise<void> {
    if (!line.trim()) return;
    let msg: JsonObject;
    try {
      msg = JSON.parse(line) as JsonObject;
    } catch {
      console.error("bad json from agent:", line);
      return;
    }

    const hasId = "id" in msg && msg.id !== undefined && msg.id !== null;
    const hasMethod = typeof msg.method === "string";

    if (hasId && !hasMethod) {
      const id = msg.id as JsonRpcId;
      const entry = this.pending.get(id);
      if (entry) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (msg.error) {
          const errObj = msg.error as { message?: string };
          entry.reject(
            Object.assign(
              new Error(errObj.message ?? "rpc error"),
              msg.error,
            ),
          );
        } else {
          entry.resolve((msg.result as JsonObject) ?? {});
        }
      }
    } else if (hasMethod && !hasId) {
      const handlers = this.notifHandlers.get(msg.method as string);
      if (handlers) {
        for (const h of handlers) {
          h((msg.params as JsonObject) ?? {});
        }
      }
    } else if (hasMethod && hasId) {
      let response: JsonObject;
      try {
        if (!this.serverReqHandler) {
          response = { result: { outcome: { outcome: "cancelled" } } };
        } else {
          response = await this.serverReqHandler(
            msg.method as string,
            (msg.params as JsonObject) ?? {},
          );
        }
      } catch (err) {
        response = { error: { code: -32603, message: String(err) } };
      }
      this.send({ jsonrpc: "2.0", id: msg.id as JsonRpcId, ...response });
    }
  }

  private send(msg: JsonObject): void {
    if (!this.proc.stdin || this.proc.stdin.writableEnded) {
      // 提供更详细的错误信息帮助用户诊断问题
      const reason = !this.proc.stdin 
        ? "进程未正确启动" 
        : this.proc.stdin.writableEnded 
          ? "进程已退出" 
          : "未知原因";
      throw new Error(`Cannot send message: agentao stdin is unavailable (${reason})`);
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }
}
