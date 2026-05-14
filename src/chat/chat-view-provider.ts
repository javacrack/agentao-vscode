import * as vscode from "vscode";
import { ACPClient } from "../acp/client";
import { SessionStore, StoredMessage } from "../persistence/session-store";
import { MessageList } from "./message-list";
import { OutputChannel } from "../ui/output-channel";
import { ModelStatusBar } from "../ui/status-bar";

type WebviewMessage =
  | { type: "sendMessage"; text: string }
  | { type: "cancelMessage" }
  | { type: "newSession" }
  | { type: "clearHistory" }
  | { type: "openFile"; path: string }
  | { type: "openSettings" }
  | { type: "openConfigure" }
  | { type: "switchModel" }
  | { type: "searchFiles"; query: string }
  | { type: "searchSymbols"; query: string }
  | { type: "exportSession" }
  | { type: "getConfigStatus" }
  | { type: "refreshConfig" }
  | { type: "reconnect" };

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "agentao.chat";

  private _view?: vscode.WebviewView;
  private _messageList = new MessageList();
  private _isStreaming = false;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    client: ACPClient,
    private readonly _store: SessionStore,
    private readonly _output: OutputChannel,
    private readonly _statusBar?: ModelStatusBar,
    private readonly _reconnect?: () => Promise<boolean>,
  ) {
    this._client = client;
    this._setupAcpEvents();
  }

  set client(client: ACPClient) {
    this._client = client;
    this._setupAcpEvents();
  }

  private _client: ACPClient;

  private _setupAcpEvents(): void {
    if (!this._client) {
      return;
    }

    this._client.onAgentMessageChunk((chunk) => {
      const text = (chunk.content as { text?: string })?.text ?? "";
      const msg = this._messageList.appendToAssistant(text);
      if (msg) {
        this._isStreaming = true;
        this._postToWebview({
          type: "append",
          id: msg.id,
          text,
        });
      }
    });

    // 移除 onChange 的 sync 消息，避免重复渲染
    this._messageList.onChange = () => {};

    this._client.onToolCall((tc) => {
      const c = tc.content as { toolCallId?: string; tool?: string; args?: string };
      const id = c.toolCallId ?? `tc_${Date.now()}`;
      const tool = c.tool ?? "unknown";
      const args = c.args ?? "";
      this._messageList.addToolCall(id, tool, args);
      this._postToWebview({
        type: "tool_call",
        toolCallId: id,
        tool,
        args,
      });
    });

    this._client.onToolResult((tr) => {
      const c = tr.content as { toolCallId?: string; result?: string };
      const id = c.toolCallId ?? "";
      const result = c.result ?? "";
      this._messageList.updateToolResult(id, result);
      this._postToWebview({
        type: "tool_result",
        toolCallId: id,
        result,
      });
    });

    this._client.onAgentThinking((t) => {
      const text = (t.content as { text?: string })?.text ?? "";
      this._postToWebview({ type: "thinking", text });
    });

    this._client.onSessionStatus((s) => {
      const status = (s.content as { status?: string })?.status;
      if (status === "idle" || status === "error" || status === "cancelled") {
        if (status === "error") {
          this._messageList.markError();
          this._postToWebview({ type: "error" });
        } else {
          this._messageList.completeLast();
          this._postToWebview({ type: "complete" });
        }
        this._isStreaming = false;
        // Persist
        this._store.setChatHistory(this._messageList.toStoredMessages()).catch(() => {});
      }
    });

    this._messageList.onChange = () => {
      this._postToWebview({
        type: "sync",
        messages: this._messageList.all.map((m) => this._serializeMessage(m)),
      });
    };
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    // Send initial config status so the webview knows if API key is set
    this._sendConfigStatus();

    // Refresh config status when view becomes visible
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._sendConfigStatus();
      }
    });

    webviewView.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      switch (msg.type) {
        case "sendMessage":
          await this._handleSendMessage(msg.text);
          break;
        case "cancelMessage":
          if (this._client) {
            try {
              await this._client.cancel();
              this._isStreaming = false;
              this._postToWebview({ type: "complete" });
            } catch (err) {
              this._output.logError(`Cancel failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          break;
        case "newSession":
          await vscode.commands.executeCommand("agentao.newSession");
          break;
        case "clearHistory":
          await vscode.commands.executeCommand("agentao.clearHistory");
          break;
        case "openFile":
          await this._handleOpenFile(msg.path);
          break;
        case "openSettings":
          await vscode.commands.executeCommand("workbench.action.openSettings", "agentao");
          break;
        case "openConfigure":
          await vscode.commands.executeCommand("agentao.configure");
          break;
        case "switchModel":
          await vscode.commands.executeCommand("agentao.switchModel");
          break;
        case "searchFiles":
          await this._handleSearchFiles(msg.query);
          break;
        case "searchSymbols":
          await this._handleSearchSymbols(msg.query);
          break;
        case "exportSession":
          await this._handleExportSession();
          break;
        case "getConfigStatus":
          this._postToWebview({ type: "configStatus", hasApiKey: !!(await this._store.getApiKey()) });
          break;
        case "refreshConfig":
          this._sendConfigStatus();
          break;
        case "reconnect": {
          const doReconnect = this._reconnect;
          if (!doReconnect) break;
          vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "正在重新连接 Agentao..." },
            async () => {
              const ok = await doReconnect();
              this._postToWebview({ type: "reconnectResult", success: ok });
              if (ok) {
                this._isStreaming = false;
                this._messageList.add("assistant", "连接已恢复，请发送消息。");
                this._messageList.completeLast();
                this._postToWebview({
                  type: "sync",
                  messages: this._messageList.all.map((m) => this._serializeMessage(m)),
                });
              }
            },
          );
          break;
        }
      }
    });
  }

  restoreHistory(messages: StoredMessage[]): void {
    this._messageList.restoreFromStored(messages);
    this._postToWebview({
      type: "sync",
      messages: this._messageList.all.map((m) => this._serializeMessage(m)),
    });
  }

  clearChat(): void {
    this._messageList.clear();
    this._postToWebview({ type: "clear" });
  }

  showWelcomeMessage(message: string): void {
    this._postToWebview({ type: "welcomeMessage", message });
  }

  async sendMessage(text: string): Promise<void> {
    await this._handleSendMessage(text);
  }

  private async _handleSendMessage(text: string): Promise<void> {
    if (!text.trim()) return;
    if (!this._client) {
      this._postToWebview({ type: "error", message: "Agentao 客户端未连接，请检查配置后重试。", showReconnect: true });
      return;
    }
    if (this._isStreaming) {
      try {
        await this._client.cancel();
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (err) {
        this._output.logError(`Failed to cancel previous request: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this._messageList.add("user", text.trim());
    const assistantMsg = this._messageList.add("assistant", "_思考中..._");

    this._postToWebview({
      type: "sync",
      messages: this._messageList.all.map((m) => this._serializeMessage(m)),
    });

    try {
      await this._client.prompt(text.trim());
      this._isStreaming = false;
      this._messageList.completeLast();
      this._postToWebview({ type: "complete" });
      this._store.setChatHistory(this._messageList.toStoredMessages()).catch(() => {});
    } catch (err) {
      this._messageList.markError();
      const errMsg = err instanceof Error ? err.message : String(err);
      let userHint = errMsg;
      let showReconnect = true;
      // Provide actionable hints for common failures
      if (errMsg.includes("timeout") || errMsg.includes("timed out")) {
        userHint = `请求超时。可能原因：\n1. API Key 无效或未配置\n2. Base URL 不可达\n3. 模型名称不正确\n\n请点击工具栏的 ⚙️ 图标检查配置，或点击下方的「重新连接」按钮。`;
      } else if (errMsg.includes("rpc error") || errMsg.includes("No active session")) {
        userHint = "与 Agentao 的连接已中断。请点击下方的「重新连接」按钮重试。";
      } else if (errMsg.includes("ENOENT") || errMsg.includes("spawn")) {
        userHint = "Agentao 进程未启动，请检查 Conda 环境和命令配置。";
      } else if (errMsg.includes("process exited") || errMsg.includes("subprocess exited")) {
        userHint = "Agentao 进程已退出。请点击下方的「重新连接」按钮重启。";
      } else {
        userHint = `请求失败：${errMsg}\n\n请检查配置或点击下方的「重新连接」按钮重试。`;
      }
      this._output.logError(`Prompt failed: ${errMsg}`);
      // Replace the "thinking" content with the error
      assistantMsg.content = `\n\n**错误**: ${userHint}`;
      this._postToWebview({ type: "error", message: userHint, showReconnect });
      this._isStreaming = false;
    }
  }

  private _serializeMessage(m: import("./message-list").ChatMessage) {
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      status: m.status,
      toolCalls: m.toolCalls,
    };
  }

  private _sendConfigStatus(): void {
    this._store.getApiKey().then((key) => {
      this._postToWebview({ type: "configStatus", hasApiKey: !!key });
    });
  }

  private _postToWebview(msg: Record<string, unknown>): void {
    this._view?.webview.postMessage(msg);
  }

  private async _handleOpenFile(path: string): Promise<void> {
    try {
      // Normalize path - replace forward slashes with backslashes on Windows
      const normalizedPath = path.replace(/\//g, "\\").replace(/:\d+:?\d*$/, "");

      // Try to open as absolute path first
      let uri = vscode.Uri.file(normalizedPath);

      // If file doesn't exist, try relative to workspace
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        // Try workspace relative
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceFolder) {
          const relativePath = path.startsWith("\\") || path.startsWith("/")
            ? path.substring(1)
            : path;
          uri = vscode.Uri.file(`${workspaceFolder}\\${relativePath}`);
        }
      }

      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err) {
      this._output.logWarn(`Failed to open file: ${path} - ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async _handleSearchFiles(query: string): Promise<void> {
    try {
      const files = await vscode.workspace.findFiles(`**/*${query}**`, "**/node_modules/**", 20);
      const items = files.map((uri) => ({
        label: uri.fsPath.split(/[/\\]/).pop() || uri.fsPath,
        description: vscode.workspace.asRelativePath(uri),
        uri,
      }));

      const chosen = await vscode.window.showQuickPick(items, {
        placeHolder: `Select a file matching "${query}"`,
      });

      if (chosen) {
        const doc = await vscode.workspace.openTextDocument(chosen.uri);
        await vscode.window.showTextDocument(doc, { preview: false });
        // Insert @mention into chat
        const relativePath = vscode.workspace.asRelativePath(chosen.uri);
        this._postToWebview({ type: "insertMention", text: `@${relativePath} ` });
      }
    } catch (err) {
      this._output.logWarn(`File search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async _handleSearchSymbols(query: string): Promise<void> {
    try {
      const results = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        "vscode.executeWorkspaceSymbolProvider",
        query
      );

      if (!results || results.length === 0) {
        this._output.log("No symbols found");
        return;
      }

      const items = results.map((sym) => ({
        label: sym.name,
        description: `${sym.kind} — ${vscode.workspace.asRelativePath(sym.location.uri)}:${sym.location.range.start.line + 1}`,
        location: sym.location,
      }));

      const chosen = await vscode.window.showQuickPick(items, {
        placeHolder: `Select a symbol matching "${query}"`,
      });

      if (chosen) {
        const doc = await vscode.workspace.openTextDocument(chosen.location.uri);
        await vscode.window.showTextDocument(doc, {
          preview: false,
          selection: chosen.location.range,
        });
        // Insert #mention into chat
        this._postToWebview({
          type: "insertMention",
          text: `#${chosen.label} `,
        });
      }
    } catch (err) {
      this._output.logWarn(`Symbol search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async _handleExportSession(): Promise<void> {
    const messages = this._messageList.toStoredMessages();
    if (messages.length === 0) {
      vscode.window.showInformationMessage("没有可导出的消息");
      return;
    }

    const data = messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls?.map((tc) => ({ tool: tc.tool, args: tc.args, result: tc.result })),
      timestamp: new Date(m.timestamp).toISOString(),
    }));

    const json = JSON.stringify(data, null, 2);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const defaultUri = vscode.Uri.file(`${process.env.USERPROFILE || "/tmp"}/agentao-session-${timestamp}.json`);

    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { "JSON": ["json"] },
      title: "导出会话",
    });

    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(json, "utf-8"));
      vscode.window.showInformationMessage(`会话已导出: ${vscode.workspace.asRelativePath(uri)}`);
    }
  }

  private _getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "dist", "webview", "chat.js"),
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agentao Chat</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border);
      --btn-primary: var(--vscode-button-background);
      --btn-primary-fg: var(--vscode-button-foreground);
      --btn-secondary: var(--vscode-button-secondaryBackground);
      --btn-secondary-fg: var(--vscode-button-secondaryForeground);
      --bubble-user: var(--vscode-editor-inactiveSelectionBackground, #2563eb33);
      --bubble-assistant: var(--vscode-textCodeBlock-background, #ffffff0a);
      --border: var(--vscode-panel-border, #00000020);
      --scrollbar: var(--vscode-scrollbarSlider-background);
      --accent: var(--vscode-textLink-foreground);
      --error: var(--vscode-errorForeground);
      --success: var(--vscode-terminal-ansiGreen, #4ec9b0);
      --warning: var(--vscode-terminal-ansiYellow, #dcdcaa);
      --code-bg: var(--vscode-editor-background);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--fg);
      background: var(--bg);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* Toolbar */
    #toolbar {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      padding: 4px 8px;
      border-bottom: 1px solid var(--border);
      gap: 4px;
      background: var(--bg);
    }
    .toolbar-btn {
      background: none;
      border: 1px solid transparent;
      color: var(--fg);
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.85em;
      opacity: 0.7;
      transition: opacity 0.2s, background 0.2s;
    }
    .toolbar-btn:hover {
      opacity: 1;
      background: var(--vscode-list-hoverBackground);
      border-color: var(--border);
    }
    .toolbar-btn.warning { color: var(--warning); }

    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    #messages::-webkit-scrollbar { width: 10px; }
    #messages::-webkit-scrollbar-track { background: transparent; }
    #messages::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 5px; }
    #messages::-webkit-scrollbar-thumb:hover { background: var(--scrollbar); opacity: 0.8; }

    .time-separator {
      text-align: center;
      color: var(--fg);
      opacity: 0.4;
      font-size: 0.75em;
      margin: 12px 0 8px 0;
      position: relative;
    }
    .time-separator::before {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      top: 50%;
      border-top: 1px solid var(--border);
    }
    .time-separator span {
      background: var(--bg);
      padding: 0 8px;
      position: relative;
    }

    .msg {
      display: flex;
      gap: 8px;
      margin-bottom: 2px;
      animation: slideIn 0.2s ease-out;
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .msg.user {
      justify-content: flex-end;
    }
    .msg.assistant {
      justify-content: flex-start;
    }

    .msg-bubble {
      max-width: 85%;
      padding: 8px 12px;
      border-radius: 8px;
      line-height: 1.5;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    .msg.user .msg-bubble {
      background: var(--bubble-user);
      border-bottom-right-radius: 2px;
    }
    .msg.assistant .msg-bubble {
      background: var(--bubble-assistant);
      border: 1px solid var(--border);
      border-bottom-left-radius: 2px;
    }

    .msg-status {
      font-size: 0.7em;
      display: inline-block;
      margin-left: 4px;
      vertical-align: middle;
    }
    .msg-status.pending { color: var(--warning); }
    .msg-status.error { color: var(--error); }
    .msg-status.complete { color: var(--success); }

    .msg-content { word-break: break-word; }
    .msg-content p { margin: 0.4em 0; }
    .msg-content ul, .msg-content ol { margin: 0.4em 0 0.4em 1.5em; }
    .msg-content li { margin: 0.2em 0; }
    .msg-content table { border-collapse: collapse; width: 100%; margin: 0.5em 0; }
    .msg-content th, .msg-content td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
    .msg-content blockquote { border-left: 3px solid var(--accent); padding-left: 8px; margin: 0.5em 0; opacity: 0.8; }
    .msg-content img { max-width: 100%; border-radius: 4px; }

    .msg-content pre {
      background: var(--vscode-textCodeBlock-background, #1e1e1e);
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 8px 0;
      position: relative;
      border: 1px solid var(--border);
    }
    .msg-content pre code {
      font-family: var(--vscode-editor-font-family, 'Courier New', monospace);
      font-size: 0.9em;
      line-height: 1.4;
    }
    .code-block-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.75em;
      opacity: 0.7;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--border);
    }
    .code-lang { font-weight: 600; }
    .code-copy-btn {
      background: none;
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 2px 6px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 0.75em;
      opacity: 0.7;
      transition: opacity 0.2s;
    }
    .code-copy-btn:hover { opacity: 1; background: var(--btn-secondary); }

    .file-link {
      color: var(--accent);
      text-decoration: none;
      border-bottom: 1px dotted var(--accent);
      cursor: pointer;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
    }
    .file-link:hover {
      background: var(--vscode-list-hoverBackground, #2d2d30);
      border-bottom: 1px solid var(--accent);
    }

    .thinking {
      background: var(--vscode-textBlockQuote-background, #ffffff08);
      border-left: 3px solid var(--accent);
      padding: 8px 10px;
      border-radius: 4px;
      font-style: italic;
      opacity: 0.85;
      font-size: 0.95em;
      margin: 8px 0;
      cursor: pointer;
      user-select: none;
    }
    .thinking.collapsed { max-height: 2em; overflow: hidden; }
    .thinking::before { content: '▼ '; font-style: normal; margin-right: 4px; transition: transform 0.2s; }
    .thinking.collapsed::before { transform: rotate(-90deg); }

    .tool-call {
      background: var(--vscode-textBlockQuote-background, #ffffff08);
      border: 1px solid var(--border);
      border-radius: 6px;
      margin: 8px 0;
      overflow: hidden;
    }
    .tool-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 10px;
      background: var(--vscode-textCodeBlock-background, #1e1e1e);
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      user-select: none;
    }
    .tool-name {
      font-weight: 600;
      color: var(--accent);
      font-size: 0.9em;
    }
    .tool-status {
      font-size: 0.75em;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--warning);
      color: #000;
    }
    .tool-status.success { background: var(--success); }
    .tool-status.error { background: var(--error); }
    .tool-args, .tool-result {
      padding: 10px;
      background: var(--bg);
      border-top: 1px solid var(--border);
      font-size: 0.85em;
      max-height: 200px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .tool-args.hidden, .tool-result.hidden { display: none; }

    .msg-time {
      font-size: 0.7em;
      opacity: 0.5;
      margin-top: 4px;
      padding-top: 4px;
      text-align: right;
    }

    #welcome {
      text-align: center;
      color: var(--fg);
      opacity: 0.5;
      padding: 60px 20px;
      font-size: 1.1em;
    }

    .typing-indicator {
      display: flex;
      gap: 4px;
      align-items: center;
      padding: 8px 0;
    }
    .typing-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--fg);
      opacity: 0.6;
      animation: bounce 1.4s infinite;
    }
    .typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes bounce {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.6; }
      30% { transform: translateY(-6px); opacity: 1; }
    }

    #input-area {
      padding: 8px;
      border-top: 1px solid var(--border);
      display: flex;
      gap: 6px;
      background: var(--bg);
    }
    #input {
      flex: 1;
      resize: none;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      padding: 8px 10px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      min-height: 36px;
      max-height: 120px;
      line-height: 1.4;
    }
    #input:focus { outline: 1px solid var(--vscode-focusBorder); }
    #send-btn, #cancel-btn {
      padding: 8px 14px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: var(--vscode-font-size);
      color: var(--btn-primary-fg);
      background: var(--btn-primary);
      white-space: nowrap;
      transition: opacity 0.2s;
    }
    #send-btn:hover { opacity: 0.9; }
    #send-btn:active { opacity: 0.8; }
    #cancel-btn { background: var(--error); }
    #cancel-btn:hover { opacity: 0.9; }
    .hidden { display: none !important; }

    /* Highlight.js styles */
    .hljs { background: transparent; padding: 0; color: var(--vscode-editor-foreground); }
    .hljs-comment { color: #6a9955; font-style: italic; }
    .hljs-keyword { color: #569cd6; }
    .hljs-operator { color: #d4d4d4; }
    .hljs-function { color: #dcdcaa; }
    .hljs-string { color: #ce9178; }
    .hljs-number { color: #b5cea8; }
    .hljs-regexp { color: #ce9178; }
    .hljs-type { color: #4ec9b0; }
    .hljs-variable { color: #9cdcfe; }
    .hljs-params { color: #9cdcfe; }
    .hljs-title { color: #dcdcaa; }
    .hljs-attr { color: #9cdcfe; }
    .hljs-attribute { color: #9cdcfe; }
    .hljs-built_in { color: #4ec9b0; }
    .hljs-symbol { color: #b5cea8; }
    .hljs-link { color: #569cd6; text-decoration: underline; }
    .hljs-meta { color: #569cd6; }
    .hljs-doctag { color: #6a9955; }
    .hljs-emphasis { font-style: italic; }
    .hljs-strong { font-weight: bold; }
    .hljs-addition { color: #6a9955; background: rgba(106, 153, 85, 0.2); }
    .hljs-deletion { color: #964b00; background: rgba(150, 75, 0, 0.2); }

    .hljs { background: transparent; padding: 0; }
    .hljs-attr { color: #9cdcfe; }
    .hljs-string { color: #ce9178; }
    .hljs-number { color: #b5cea8; }
    .hljs-literal { color: #569cd6; }
    .hljs-keyword { color: #569cd6; }

    /* Search bar styles */
    #search-bar {
      padding: 4px 8px;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 4px;
    }
    #search-bar.hidden { display: none; }
    #search-input {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      padding: 4px 8px;
      font-size: 0.9em;
    }
    #search-input:focus { outline: 1px solid var(--vscode-focusBorder); }
    #search-close {
      background: none;
      border: none;
      color: var(--vscode-editor-foreground);
      font-size: 1.2em;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 3px;
    }
    #search-close:hover { background: var(--vscode-list-hoverBackground); }
    .search-highlight {
      background: var(--vscode-editor-findMatchHighlightBackground, #f003);
      border: 1px solid var(--vscode-editor-findMatchHighlightBorder, #ff03);
    }
  </style>
</head>
<body>
  <div id="toolbar">
    <button class="toolbar-btn" id="toolbar-new-session" title="新建会话">+ 新会话</button>
    <button class="toolbar-btn" id="toolbar-clear" title="清除历史">清除</button>
    <button class="toolbar-btn" id="toolbar-export" title="导出会话">导出</button>
    <button class="toolbar-btn" id="toolbar-model" title="切换模型">模型</button>
    <button class="toolbar-btn" id="toolbar-configure" title="配置">⚙️ 配置</button>
  </div>
  <div id="config-warning" class="hidden" style="padding: 6px 12px; background: var(--warning); color: #000; text-align: center; font-size: 0.85em; cursor: pointer;">
    ⚠️ 未配置 API Key，点击此处进行配置
  </div>
  <div id="search-bar" class="hidden">
    <input id="search-input" placeholder="搜索聊天记录..." />
    <button id="search-close" title="关闭搜索">×</button>
  </div>
  <div id="messages">
    <div id="welcome">Ask me anything about your codebase</div>
  </div>
  <div id="input-area">
    <textarea id="input" placeholder="Type a message... (Shift+Enter for newline)" rows="1"></textarea>
    <button id="send-btn" title="Send">Send</button>
    <button id="cancel-btn" class="hidden" title="Cancel">Cancel</button>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
