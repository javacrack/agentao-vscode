import * as vscode from "vscode";
import { spawn, spawnSync } from "node:child_process";
import { basename } from "node:path";
import { existsSync } from "node:fs";
import { ACPClient } from "./acp/client";
import { ChatViewProvider } from "./chat/chat-view-provider";
import { OutputChannel } from "./ui/output-channel";
import { ToolPermissionHandler } from "./ui/tool-permission";
import { ModelStatusBar } from "./ui/status-bar";
import { ConfigPanel } from "./ui/config-panel";
import { SessionStore } from "./persistence/session-store";
import type { JsonObject } from "./acp/json-types";

let client: ACPClient | undefined;
let store: SessionStore | undefined;
let output: OutputChannel | undefined;
let chatProvider: ChatViewProvider | undefined;
let statusBar: ModelStatusBar | undefined;
let condaEnv: string;
let condaPath: string;
let openaiModel: string;
let commandPath: string;

/** Restart the ACP client with fresh config. */
async function restartClient(): Promise<boolean> {
  if (!client || !output || !store) return false;
  const cfg = vscode.workspace.getConfiguration("agentao");
  const cp = cfg.get<string>("commandPath", "agentao");
  const ag = cfg.get<string[]>("args", ["--acp", "--stdio"]);
  const wd = resolveWorkspaceFolder(cfg.get<string>("workingDirectory", "${workspaceFolder}"));
  const mcpServers = cfg.get<JsonObject[]>("mcpServers", []);

  output.log("Restarting agentao client...");
  try {
    await client.close();
  } catch { /* ignore */ }

  let resolved: { command: string; args: string[] };
  try {
    resolved = await resolveAgentCommand(cp, ag, cfg.get<string>("condaEnv", ""), cfg.get<string>("condaPath", ""), output);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.logError(message);
    vscode.window.showErrorMessage(message);
    return false;
  }

  const env: NodeJS.ProcessEnv = { ...(process.env as NodeJS.ProcessEnv) };
  const openaiApiKey = cfg.get<string>("openaiApiKey", "");
  if (openaiApiKey) {
    env.OPENAI_API_KEY = openaiApiKey;
  } else {
    const stored = await store.getApiKey();
    if (stored) env.OPENAI_API_KEY = stored;
  }
  const baseUrl = cfg.get<string>("openaiBaseUrl", "");
  if (baseUrl) env.OPENAI_BASE_URL = baseUrl;
  openaiModel = cfg.get<string>("openaiModel", "");
  if (openaiModel) env.OPENAI_MODEL = openaiModel;
  Object.assign(env, cfg.get<Record<string, string>>("env", {}));

  let stderrBuffer = "";
  const newClient = new ACPClient({
    command: resolved.command,
    args: resolved.args,
    cwd: wd,
    env,
    rpcTimeoutMs: cfg.get<number>("rpcTimeoutMs", 60000),
  });
  newClient.onStderr((text) => {
    stderrBuffer += text;
    output!.logStderr(text);
  });
  newClient.onError((err) => output!.logError(err.message));

  try {
    output.log(`Starting agentao: ${resolved.command} ${resolved.args.join(" ")}`);
    await newClient.start();
    output.log("ACP initialize handshake successful");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.logError(`Failed to start agentao: ${message}`);
    
    let detailedMessage = `启动 agentao 失败: ${message}`;
    if (stderrBuffer) {
      detailedMessage += `\n\nAgentao 错误输出:\n${stderrBuffer.trim()}`;
      output.logError(`Agentao stderr: ${stderrBuffer}`);
    }
    
    const detectedPath = autoDetectAgentaoPath();
    if (detectedPath && detectedPath !== cp) {
      await cfg.update("commandPath", detectedPath, vscode.ConfigurationTarget.Global);
      detailedMessage += `\n\n已自动检测到 agentao 路径: ${detectedPath}`;
      output.log(`Auto-detected agentao path: ${detectedPath}`);
    }
    
    vscode.window.showErrorMessage(detailedMessage);
    return false;
  }

  const sid = await newClient.newSession(wd, mcpServers);
  await store.setSessionId(sid);
  output.log(`New session: ${sid}`);

  // Re-wire server request handler
  const permHandler = new ToolPermissionHandler(newClient, store);
  newClient.onServerRequest(async (method: string, params: JsonObject) => {
    if (method === "session/request_permission") {
      return permHandler.handlePermission(params as unknown as Record<string, unknown>) as unknown as JsonObject;
    }
    return { result: {} };
  });

  client = newClient;
  if (chatProvider) {
    chatProvider.client = newClient;
  }
  statusBar?.refresh();
  chatProvider?.clearChat();
  vscode.window.showInformationMessage("Agentao 客户端已重启，请重试对话");
  return true;
}

export async function activate(context: vscode.ExtensionContext) {
  try {
    store = new SessionStore(context.globalState, context.secrets);
    output = new OutputChannel(context);
    output.log("Agentao extension activating...");

    const config = vscode.workspace.getConfiguration("agentao");
    commandPath = config.get<string>("commandPath", "agentao");
    const args = config.get<string[]>("args", ["--acp", "--stdio"]);
    output.log(`Loaded commandPath config: "${commandPath}"`);

    const workingDir = resolveWorkspaceFolder(
      config.get<string>("workingDirectory", "${workspaceFolder}"),
    );
    const extraEnv = config.get<Record<string, string>>("env", {});
    condaEnv = config.get<string>("condaEnv", "");
    condaPath = config.get<string>("condaPath", "");
    const openaiApiKey = config.get<string>("openaiApiKey", "");
    const openaiBaseUrl = config.get<string>("openaiBaseUrl", "");
    openaiModel = config.get<string>("openaiModel", "");

    // Register: configure command early, before client startup
    // Opens a multi-item configuration panel for batch editing
    context.subscriptions.push(
      vscode.commands.registerCommand("agentao.configure", () => {
        ConfigPanel.render(
          context.extensionUri,
          store!,
          output!,
          () => restartClient(),
          () => listCondaEnvironments(config.get<string>("condaPath", "") || "conda"),
          autoDetectCondaPath(),
          autoDetectAgentaoPath(),
        );
      }),
    );
    output.log("agentao.configure command registered");

    // Also register focus command early
    context.subscriptions.push(
      vscode.commands.registerCommand("agentao.focusChat", async () => {
        await vscode.commands.executeCommand("agentao.chat.focus");
      }),
    );
    output.log("agentao.focusChat command registered");

    // Register showOutput command
    context.subscriptions.push(
      vscode.commands.registerCommand("agentao.showOutput", () => {
        output!.show();
      }),
    );
    output.log("agentao.showOutput command registered");

  // Build environment — inject model params from settings
  const env: NodeJS.ProcessEnv = { ...(process.env as NodeJS.ProcessEnv) };

  // API key: prefer settings value, fall back to secret storage
  if (openaiApiKey) {
    env.OPENAI_API_KEY = openaiApiKey;
  } else {
    const storedApiKey = await store.getApiKey();
    if (storedApiKey) {
      env.OPENAI_API_KEY = storedApiKey;
    }
  }

  // Base URL and model from settings
  if (openaiBaseUrl) {
    env.OPENAI_BASE_URL = openaiBaseUrl;
  }
  if (openaiModel) {
    env.OPENAI_MODEL = openaiModel;
  }

  Object.assign(env, extraEnv);

  // Resolve agentao command and optionally ask the user for a conda environment
  let agentCommand = commandPath;
  let agentArgs = args;
  let resolveError: string | undefined;
  try {
    const resolved = await resolveAgentCommand(commandPath, args, condaEnv, condaPath, output!);
    agentCommand = resolved.command;
    agentArgs = resolved.args;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output!.logWarn(`agentao 启动配置失败: ${message}，将尝试延迟连接`);
    resolveError = message;
  }

  // 注册 webview（提前注册，确保窗口能显示）
  let viewDisposable: vscode.Disposable;

  // 如果配置有误，仍然继续注册命令（但跳过需要 client 的初始化步骤）
  if (!resolveError) {
    // Start ACP client
    client = new ACPClient({
      command: agentCommand,
      args: agentArgs,
      cwd: workingDir,
      env,
      rpcTimeoutMs: config.get<number>("rpcTimeoutMs", 60000),
    });

    // Wire stderr to output channel
    client.onStderr((text) => output!.logStderr(text));
    client.onError((err) => {
      output!.logError(err.message);
    });

    try {
      output.log(`Starting agentao: ${agentCommand} ${agentArgs.join(" ")}`);
      await client.start();
      output.log("ACP initialize handshake successful");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const installHint = /ENOENT|spawn .* ENOENT|Failed to start agentao process/.test(message)
        ? "请先安装 agentao：\n1. git clone https://github.com/jin-bo/agentao\n2. cd agentao\n3. pip install -e \".[cli]\""
        : "";
      const errorText = `Failed to start agentao: ${message}${installHint ? "\n" + installHint : ""}`;

      output.logError(errorText);
      vscode.window.showErrorMessage(errorText);
      client = undefined;
      resolveError = errorText;
    }
  }

  // 创建 ChatViewProvider（在 client 创建之后）
  chatProvider = new ChatViewProvider(
    context.extensionUri,
    client || undefined as unknown as ACPClient,
    store!,
    output!,
    statusBar,
    () => restartClient(),
  );

  viewDisposable = vscode.window.registerWebviewViewProvider(
    "agentao.chat",
    chatProvider,
  );
  context.subscriptions.push(viewDisposable);

  // 如果 agentao 启动失败，显示提示信息到聊天窗口
  if (resolveError) {
    chatProvider.showWelcomeMessage(`⚠️ Agentao 客户端未启动: ${resolveError}\n\n请检查配置或点击右上角「⚙️ 配置」按钮设置正确的 conda 环境后，重启扩展。`);
  }

  // Restore or create session (only if client is available)
  const autoRestore = config.get<boolean>("autoRestoreSession", true);
  const mcpServers = config.get<JsonObject[]>("mcpServers", []);

  if (client) {
    if (autoRestore && store.sessionId) {
      try {
        output.log(`Restoring session ${store.sessionId}`);
        await client.loadSession(store.sessionId, workingDir);
        output.log("Session restored");
      } catch {
        output.log("Session restore failed, creating new session");
        const sid = await client.newSession(workingDir, mcpServers);
        await store.setSessionId(sid);
        output.log(`New session: ${sid}`);
      }
    } else {
      const sid = await client.newSession(workingDir, mcpServers);
      await store.setSessionId(sid);
      output.log(`New session: ${sid}`);
    }

    // Set up tool permission handler
    const permHandler = new ToolPermissionHandler(client, store);

    client.onServerRequest(async (method: string, params: JsonObject) => {
      if (method === "session/request_permission") {
        return permHandler.handlePermission(params as unknown as Record<string, unknown>) as unknown as JsonObject;
      }
      return { result: {} };
    });

    // Model status bar - create after session is established
    statusBar = new ModelStatusBar(client, store);
    
    // Try to refresh with retry logic
    let refreshAttempts = 0;
    const maxAttempts = 3;
    let refreshSuccess = false;
    
    while (refreshAttempts < maxAttempts && !refreshSuccess) {
      try {
        await statusBar.refresh();
        refreshSuccess = true;
        output.log("Status bar model refresh successful");
      } catch (err) {
        refreshAttempts++;
        const errMsg = err instanceof Error ? err.message : String(err);
        output.logWarn(`Status bar refresh attempt ${refreshAttempts} failed: ${errMsg}`);
        
        if (refreshAttempts < maxAttempts) {
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 1000 * refreshAttempts));
        }
      }
    }
    
    if (!refreshSuccess) {
      output.logError("Failed to initialize status bar after multiple attempts");
      // Create status bar but show error state
      statusBar.setStatus("$(symbol-class) error", "Model status unavailable - check configuration");
    }
  }

  // Restore chat history into webview (webview 已提前注册)
  const history = store.chatHistory;
  if (history.length > 0) {
    chatProvider.restoreHistory(history);
  }

  // ── Commands ──────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("agentao.sendMessage", async () => {
      await vscode.commands.executeCommand("agentao.chat.focus");
    }),

    vscode.commands.registerCommand("agentao.cancel", async () => {
      if (client?.sessionId) {
        output!.log("Cancelling current turn...");
        await client.cancel();
      }
    }),

    vscode.commands.registerCommand("agentao.newSession", async () => {
      if (!client) {
        vscode.window.showErrorMessage("Agentao 客户端未初始化，请检查 agentao 是否正确安装和配置。");
        output?.logError("agentao.newSession called but client is not initialized");
        return;
      }

      // Check if conda environment configuration has changed
      const currentConfig = vscode.workspace.getConfiguration("agentao");
      const currentCondaEnv = currentConfig.get<string>("condaEnv", "");
      const currentCommandPath = currentConfig.get<string>("commandPath", "agentao");
      const currentArgs = currentConfig.get<string[]>("args", ["--acp", "--stdio"]);

      // If configuration changed, restart the client
      const needsRestart = currentCondaEnv !== condaEnv || currentCommandPath !== commandPath;
      if (needsRestart) {
        output!.log("Configuration changed, restarting agentao client...");
        try {
          // Close existing client
          if (client) {
            await client.close();
            client = undefined;
          }

          // Re-resolve command with new configuration
          const resolved = await resolveAgentCommand(currentCommandPath, currentArgs, currentCondaEnv, config.get<string>("condaPath", ""), output!);

          // Start new client
          client = new ACPClient({
            command: resolved.command,
            args: resolved.args,
            cwd: workingDir,
            env,
            rpcTimeoutMs: currentConfig.get<number>("rpcTimeoutMs", 60000),
          });

          // Wire stderr to output channel
          client.onStderr((text) => output!.logStderr(text));
          client.onError((err) => {
            output!.logError(err.message);
          });

          output!.log(`Starting agentao: ${resolved.command} ${resolved.args.join(" ")}`);
          await client.start();
          output!.log("ACP initialize handshake successful");

          // Update stored configuration
          condaEnv = currentCondaEnv;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          output!.logError(`Failed to restart agentao: ${message}`);
          vscode.window.showErrorMessage(`Failed to restart agentao: ${message}`);
          return;
        }
      }

      const sid = await client.newSession(workingDir, mcpServers);
      await store!.setSessionId(sid);
      chatProvider?.clearChat();
      output!.log(`New session: ${sid}`);
      vscode.window.showInformationMessage("New session created");
    }),

    vscode.commands.registerCommand("agentao.clearHistory", async () => {
      chatProvider?.clearChat();
      await store!.clearChatHistory();
    }),

    vscode.commands.registerCommand("agentao.switchModel", async () => {
      await statusBar!.switchModel();
    }),

    vscode.commands.registerCommand("agentao.askAboutSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage("Please select some code first");
        return;
      }

      const selectedText = editor.document.getText(editor.selection);
      const filePath = editor.document.fileName;
      const fileName = filePath.split(/[/\\]/).pop() || "unknown file";

      const prompt = `I need help understanding the following code from \`${fileName}\`:\n\n\`\`\`\n${selectedText}\n\`\`\`\n\nCan you explain what this code does?`;

      chatProvider?.sendMessage?.(prompt);
      await vscode.commands.executeCommand("agentao.focusChat");
    }),

    vscode.commands.registerCommand("agentao.explainSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage("Please select some code first");
        return;
      }

      const selectedText = editor.document.getText(editor.selection);
      const filePath = editor.document.fileName;
      const fileName = filePath.split(/[/\\]/).pop() || "unknown file";
      const lineNumber = editor.selection.start.line + 1;

      const prompt = `Please explain the following code from \`${fileName}:${lineNumber}\` in detail:\n\n\`\`\`\n${selectedText}\n\`\`\``;

      chatProvider?.sendMessage?.(prompt);
      await vscode.commands.executeCommand("agentao.focusChat");
    }),
  );

  output.log("Agentao extension ready");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Agentao extension activation failed:", message);
    console.error(err);
    vscode.window.showErrorMessage(`Agentao 扩展激活失败: ${message}`);
  }
}

export function deactivate() {
  if (client) {
    client.close().catch(() => {});
    client = undefined;
  }
}

async function resolveAgentCommand(
  commandPath: string,
  args: string[],
  condaEnv: string,
  condaPath: string,
  output: OutputChannel,
): Promise<{ command: string; args: string[] }> {
  const condaExe = condaPath || "conda";
  const hasConda = commandExists(condaExe);
  const hasUv = commandExists("uv");

  // 如果配置了 conda 环境，优先使用 conda 环境
  if (condaEnv.trim() && hasConda) {
    const envs = listCondaEnvironments(condaExe);
    const envExists = envs.some((env) => env.name === condaEnv);
    if (envExists) {
      output.log(`使用配置的 conda 环境: ${condaEnv}`);
      // 使用 python -m agentao 的方式启动，这是 agentao ACP 模式的正确启动方式
      return {
        command: condaExe,
        args: ["run", "-n", condaEnv, "--no-capture-output", "python", "-m", "agentao", ...args],
      };
    } else {
      output.logWarn(`配置的 conda 环境 "${condaEnv}" 未找到，将尝试其他方式。`);
    }
  }

  // 检查 commandPath 是否是一个有效的文件路径（.exe 文件）
  if (existsSync(commandPath) && commandPath.endsWith(".exe")) {
    output.log(`使用配置的 agentao 路径: ${commandPath}`);
    // 如果是 .exe 文件，直接使用
    return { command: commandPath, args };
  }

  // 检查是否可以在当前环境中运行 python -m agentao
  if (commandPath === "agentao") {
    // 先尝试 uv run agentao（如果安装了 uv）
    if (hasUv) {
      output.log("使用 uv run agentao 方式启动");
      return { command: "uv", args: ["run", "agentao", ...args] };
    }
    output.log("使用 python -m agentao 方式启动");
    return { command: "python", args: ["-m", "agentao", ...args] };
  }

  // 检查 commandPath 是否在 PATH 中
  if (commandExists(commandPath)) {
    return { command: commandPath, args };
  }

  // 如果有 uv，尝试使用 uv run agentao
  if (hasUv) {
    output.log("尝试使用 uv run agentao");
    return { command: "uv", args: ["run", "agentao", ...args] };
  }

  // 如果有 conda 但没有配置或配置的环境不存在，列出可用环境让用户选择
  if (hasConda) {
    const envs = listCondaEnvironments(condaExe);
    if (envs.length > 0) {
      const picks = envs.map((env) => ({
        label: env.name,
        description: env.path,
      }));

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: "未找到 agentao。请选择要用于运行 agentao 的 conda 环境",
        canPickMany: false,
      });

      if (!selected) {
        throw new Error("未选择 conda 环境，无法启动 agentao。");
      }

      output.log(`选择了 conda 环境: ${selected.label}。可在设置中配置 agentao.condaEnv 以避免每次都选择。`);

      // 使用 python -m agentao 的方式启动
      return {
        command: condaExe,
        args: ["run", "-n", selected.label, "--no-capture-output", "python", "-m", "agentao", ...args],
      };
    }
  }

  const envHint = hasUv ? "或使用 uv 安装 agentao" : "";
  throw new Error(`未找到 agentao 命令，且未检测到 conda（${condaExe}）。${envHint}请确保 agentao 已安装或配置正确的环境。`);
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, [], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (result.error) {
    return (result.error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  return true;
}

function listCondaEnvironments(condaExe: string): Array<{ name: string; path: string }> {
  // Try with --json first
  let result = spawnSync(condaExe, ["env", "list", "--json"], {
    encoding: "utf8",
  });

  // If conda.bat fails (common on Windows with "access denied"), retry with conda.exe
  if ((result.status !== 0 || !result.stdout) && condaExe.endsWith(".bat")) {
    const exePath = condaExe.replace(/\.bat$/i, ".exe");
    if (existsSync(exePath)) {
      result = spawnSync(exePath, ["env", "list", "--json"], { encoding: "utf8" });
    }
  }

  if (result.status === 0 && result.stdout) {
    try {
      const data = JSON.parse(result.stdout) as { envs?: string[] };
      const envs = Array.isArray(data.envs) ? data.envs : [];
      return envs.map((prefix) => ({ name: basename(prefix), path: prefix }));
    } catch { /* fall through to text parsing */ }
  }

  // Fallback: parse text output of "conda env list"
  // Format: env_name    /path/to/env  or  * env_name    /path/to/env
  const result2 = spawnSync(condaExe, ["env", "list"], { encoding: "utf8" });
  if (result2.status !== 0 || !result2.stdout) {
    // Last resort: try conda.exe if .bat failed
    if (condaExe.endsWith(".bat")) {
      const exePath = condaExe.replace(/\.bat$/i, ".exe");
      if (existsSync(exePath)) {
        const result3 = spawnSync(exePath, ["env", "list"], { encoding: "utf8" });
        return parseCondaEnvListText(result3.stdout || "");
      }
    }
    return [];
  }
  return parseCondaEnvListText(result2.stdout);
}

function parseCondaEnvListText(stdout: string): Array<{ name: string; path: string }> {
  const envs: Array<{ name: string; path: string }> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes(" ")) continue;
    const parts = trimmed.split(/\s+/);
    // Handle "* name" prefix for active env
    const nameIdx = parts[0] === "*" ? 1 : 0;
    if (nameIdx + 1 >= parts.length) continue;
    const name = parts[nameIdx];
    const path = parts[nameIdx + 1];
    if (path && !path.startsWith("#")) {
      envs.push({ name, path });
    }
  }
  return envs;
}

function resolveWorkspaceFolder(path: string): string {
  if (!path.includes("${workspaceFolder}")) return path;
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return path.replace("${workspaceFolder}", folders[0].uri.fsPath);
  }
  // No workspace — use home directory
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return path.replace("${workspaceFolder}", home);
}

/** Auto-detect conda executable path. Returns empty string if not found. */
export function autoDetectCondaPath(): string {
  // On Windows, prefer conda.exe over conda.bat (bat files can fail with "access denied")
  const isWin = process.platform === "win32";
  const candidates = isWin
    ? [
        // Scripts/conda.exe (standalone/miniforge)
        `${process.env.USERPROFILE}\\Anaconda3\\Scripts\\conda.exe`,
        `${process.env.USERPROFILE}\\miniconda3\\Scripts\\conda.exe`,
        `${process.env.USERPROFILE}\\miniconda\\Scripts\\conda.exe`,
        // condabin/conda.bat (full anaconda)
        `${process.env.USERPROFILE}\\Anaconda3\\condabin\\conda.bat`,
        `${process.env.USERPROFILE}\\miniconda3\\condabin\\conda.bat`,
        `${process.env.USERPROFILE}\\miniconda\\condabin\\conda.bat`,
        // System-wide installs
        `${process.env.ProgramData}\\conda\\Scripts\\conda.exe`,
        `${process.env.ProgramData}\\conda\\condabin\\conda.bat`,
        `${process.env.ProgramData}\\miniconda3\\Scripts\\conda.exe`,
        `${process.env.ProgramData}\\miniconda3\\condabin\\conda.bat`,
        "C:\\Anaconda3\\Scripts\\conda.exe",
        "C:\\Anaconda3\\condabin\\conda.bat",
        "C:\\miniconda3\\Scripts\\conda.exe",
        "C:\\miniconda3\\condabin\\conda.bat",
      ]
    : [
        "/opt/conda/bin/conda",
        "/usr/local/conda/bin/conda",
        `${process.env.HOME}/anaconda3/bin/conda`,
        `${process.env.HOME}/miniconda3/bin/conda`,
      ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  if (commandExists("conda")) return "conda";
  return "";
}

/** Search conda environments for the agentao executable. */
export function autoDetectAgentaoPath(condaExe?: string): string {
  const exeName = process.platform === "win32" ? "agentao.exe" : "agentao";
  // First check PATH
  if (commandExists(exeName)) return exeName;

  // Check uv environment
  if (commandExists("uv")) {
    // uv run agentao should work if agentao is installed via uv
    return "agentao";
  }

  const conda = condaExe || autoDetectCondaPath() || "conda";
  const envs = listCondaEnvironments(conda);
  for (const env of envs) {
    const candidate = `${env.path}\\Scripts\\${exeName}`;
    if (existsSync(candidate)) {
      return `${env.path}\\Scripts\\${exeName}`;
    }
    const candidate2 = `${env.path}\\bin\\${exeName}`;
    if (existsSync(candidate2)) {
      return candidate2;
    }
  }
  return "";
}
