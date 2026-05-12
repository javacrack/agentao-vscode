import * as vscode from "vscode";
import { SessionStore } from "../persistence/session-store";
import https from "node:https";
import http from "node:http";
import { URL } from "node:url";

interface CondaEnv { name: string; path: string }

export class ConfigPanel {
  private static currentPanel: ConfigPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    extensionUri: vscode.Uri,
    private store: SessionStore,
    private output: { log: (msg: string) => void; logError: (msg: string) => void },
    private onRestart: () => Promise<boolean>,
    private listCondaEnvs: () => CondaEnv[],
    private detectedCondaPath: string,
    private detectedAgentaoPath: string,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "agentaoConfig",
      "Agentao 配置",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [extensionUri],
      },
    );
    this.panel.onDidDispose(() => {
      ConfigPanel.currentPanel = undefined;
    }, undefined, this.disposables);

    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage(
      async (msg) => this.handleMessage(msg),
      undefined,
      this.disposables,
    );
  }

  static render(
    extensionUri: vscode.Uri,
    store: SessionStore,
    output: { log: (msg: string) => void; logError: (msg: string) => void },
    onRestart: () => Promise<boolean>,
    listCondaEnvs: () => CondaEnv[],
    detectedCondaPath: string,
    detectedAgentaoPath: string,
  ): void {
    if (ConfigPanel.currentPanel) {
      ConfigPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      ConfigPanel.currentPanel.panel.webview.postMessage({ type: "refresh" });
      return;
    }

    const panel = new ConfigPanel(
      extensionUri,
      store,
      output,
      onRestart,
      listCondaEnvs,
      detectedCondaPath,
      detectedAgentaoPath,
    );
    ConfigPanel.currentPanel = panel;
  }

  private async handleMessage(msg: {
    type: string;
    key?: string;
    value?: string;
    values?: Record<string, string>;
  }): Promise<void> {
    const config = vscode.workspace.getConfiguration("agentao");

    switch (msg.type) {
      case "getConfig": {
        const envs = this.listCondaEnvs();
        this.panel.webview.postMessage({
          type: "configData",
          values: {
            openaiApiKey: "********",
            openaiBaseUrl: config.get<string>("openaiBaseUrl", ""),
            openaiModel: config.get<string>("openaiModel", ""),
            condaPath: config.get<string>("condaPath", this.detectedCondaPath),
            condaEnv: config.get<string>("condaEnv", ""),
            commandPath: config.get<string>("commandPath", "") || this.detectedAgentaoPath || "agentao",
            hasStoredApiKey: !!(await this.store.getApiKey()),
            condaEnvs: JSON.stringify(envs.map((e) => ({ label: e.name, description: e.path }))),
            detectedCondaPath: this.detectedCondaPath,
            detectedAgentaoPath: this.detectedAgentaoPath,
          },
        });
        break;
      }

      case "saveAll": {
        const values = msg.values!;
        if (values.openaiApiKey && values.openaiApiKey !== "********") {
          await this.store.setApiKey(values.openaiApiKey);
        }
        await config.update("openaiBaseUrl", values.openaiBaseUrl || "", vscode.ConfigurationTarget.Global);
        await config.update("openaiModel", values.openaiModel || "", vscode.ConfigurationTarget.Global);
        await config.update("condaPath", values.condaPath || "", vscode.ConfigurationTarget.Global);
        await config.update("condaEnv", values.condaEnv || "", vscode.ConfigurationTarget.Global);
        await config.update("commandPath", values.commandPath || this.detectedAgentaoPath || "agentao", vscode.ConfigurationTarget.Global);
        this.panel.webview.postMessage({ type: "saved" });

        // Ask user if they want to restart now
        const restart = await vscode.window.showInformationMessage(
          "配置已保存。是否立即重启 Agentao 客户端以应用新配置？",
          "立即重启",
          "稍后重启",
        );
        if (restart === "立即重启") {
          vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "正在重启 Agentao 客户端..." },
            async () => {
              const ok = await this.onRestart();
              if (ok) {
                vscode.window.showInformationMessage("Agentao 客户端已重启");
              }
            },
          );
        }
        break;
      }

      case "testConnection": {
        const values = msg.values!;
        const apiKey = values.openaiApiKey && values.openaiApiKey !== "********"
          ? values.openaiApiKey
          : await this.store.getApiKey();
        const baseUrl = values.openaiBaseUrl || "";
        const model = values.openaiModel || "gpt-4o-mini";

        if (!apiKey) {
          this.panel.webview.postMessage({ type: "testResult", success: false, message: "未配置 API Key" });
          return;
        }

        let fullUrl = baseUrl || "https://api.openai.com";
        if (!fullUrl.includes("/v")) {
          fullUrl += "/v1";
        }
        if (!fullUrl.endsWith("/chat/completions")) {
          fullUrl += "/chat/completions";
        }
        
        const baseUrlObj = new URL(fullUrl);
        this.output.log(`测试 API 连接: ${baseUrlObj.origin}${baseUrlObj.pathname} (model: ${model})`);

        try {
          const result = await testApiConnection(baseUrlObj.origin, baseUrlObj.pathname, apiKey, model);
          if (result.success) {
            this.panel.webview.postMessage({ type: "testResult", success: true, message: `连接成功: ${result.message}` });
          } else {
            this.panel.webview.postMessage({ type: "testResult", success: false, message: result.message });
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.output.logError(`API 测试异常: ${message}`);
          this.panel.webview.postMessage({ type: "testResult", success: false, message: `测试异常: ${message}` });
        }
        break;
      }
    }
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
      --border: var(--vscode-panel-border, #00000020);
      --error: var(--vscode-errorForeground);
      --success: var(--vscode-terminal-ansiGreen, #4ec9b0);
      --warning: var(--vscode-terminal-ansiYellow, #dcdcaa);
      --description: var(--vscode-descriptionForeground);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--fg);
      background: var(--bg);
      padding: 20px;
      max-width: 640px;
      margin: 0 auto;
    }
    h2 { margin-bottom: 4px; font-size: 1.3em; }
    .subtitle { color: var(--description); margin-bottom: 20px; font-size: 0.9em; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-weight: 600; margin-bottom: 4px; }
    .form-group .description { color: var(--description); font-size: 0.85em; margin-bottom: 6px; }
    .form-group input, .form-group select {
      width: 100%;
      padding: 6px 8px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .form-group input:focus, .form-group select:focus { outline: 1px solid var(--vscode-focusBorder); }
    .form-row { display: flex; gap: 8px; }
    .form-row input { flex: 1; }
    .btn {
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: var(--vscode-font-size);
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.9; }
    .btn-primary { background: var(--btn-primary); color: var(--btn-primary-fg); }
    .btn-secondary { background: var(--btn-secondary); color: var(--btn-secondary-fg); }
    .btn-group { display: flex; gap: 8px; margin-top: 20px; }
    #test-result {
      margin-top: 8px;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 0.9em;
      display: none;
    }
    #test-result.success { display: block; background: var(--success); color: #000; }
    #test-result.error { display: block; color: var(--error); border: 1px solid var(--error); }
    #save-notification {
      position: fixed; bottom: 20px; right: 20px;
      padding: 10px 16px; background: var(--success); color: #000;
      border-radius: 4px; font-size: 0.9em; display: none;
      animation: fadeIn 0.3s ease;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    .section-divider { border-top: 1px solid var(--border); margin: 20px 0; }
    .section-title { font-size: 1em; font-weight: 600; margin-bottom: 12px; color: var(--fg); }
    .auto-hint { color: var(--success); font-size: 0.8em; margin-left: 8px; }
    .auto-hint.warn { color: var(--warning); }
    .loading { color: var(--warning); font-size: 0.85em; display: inline-flex; align-items: center; gap: 6px; }
    .loading::before {
      content: "";
      display: inline-block;
      width: 12px; height: 12px;
      border: 2px solid var(--warning);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <h2>Agentao 配置</h2>
  <p class="subtitle">配置多个设置后一次性保存，保存后可选择立即重启客户端</p>

  <div class="section-title">API 设置</div>

  <div class="form-group">
    <label>API Key</label>
    <div class="description">OpenAI 兼容 API 的密钥 (OPENAI_API_KEY)</div>
    <div class="form-row">
      <input type="password" id="openaiApiKey" placeholder="sk-..." />
      <button class="btn btn-secondary" onclick="toggleKeyVisibility()" id="toggleKeyBtn" style="white-space:nowrap;">显示</button>
    </div>
  </div>

  <div class="form-group">
    <label>Base URL</label>
    <div class="description">API 基础地址，留空使用 OpenAI 默认地址 (OPENAI_BASE_URL)</div>
    <input type="text" id="openaiBaseUrl" placeholder="https://api.openai.com/v1" />
  </div>

  <div class="form-group">
    <label>Model</label>
    <div class="description">模型名称，留空使用默认模型 (OPENAI_MODEL)</div>
    <input type="text" id="openaiModel" placeholder="gpt-4o" />
  </div>

  <div class="form-group">
    <button class="btn btn-secondary" onclick="testConnection()">测试 API 连接</button>
    <div id="test-result"></div>
  </div>

  <div class="section-divider"></div>
  <div class="section-title">Conda 设置</div>

  <div class="form-group">
    <label>Conda Path <span id="conda-hint" class="auto-hint"></span></label>
    <div class="description">Conda 可执行文件路径，留空自动检测</div>
    <input type="text" id="condaPath" placeholder="自动检测..." />
  </div>

  <div class="form-group">
    <label>Conda Env <span id="env-hint" class="auto-hint"></span></label>
    <div class="description">Conda 环境名称，从下拉列表中选择或手动输入</div>
    <input type="text" id="condaEnv" placeholder="选择或输入环境名称..." list="condaEnvList" />
    <datalist id="condaEnvList"></datalist>
    <div id="env-loading" class="loading">正在检测 conda 环境...</div>
  </div>

  <div class="section-divider"></div>
  <div class="section-title">其他设置</div>

  <div class="form-group">
    <label>Agentao 可执行文件路径 <span id="agentao-hint" class="auto-hint"></span></label>
    <div class="description">留空使用 PATH 中的 agentao 命令</div>
    <input type="text" id="commandPath" placeholder="自动检测..." />
  </div>

  <div class="btn-group">
    <button class="btn btn-primary" onclick="saveAll()">保存并重启</button>
    <button class="btn btn-secondary" onclick="saveOnly()">仅保存</button>
    <button class="btn btn-secondary" onclick="resetAll()">重置默认值</button>
  </div>

  <div id="save-notification">配置已保存 ✓</div>

  <script>
    const vscode = acquireVsCodeApi();
    let condaEnvs = [];
    let detectedAgentaoPath = "";

    function toggleKeyVisibility() {
      const input = document.getElementById("openaiApiKey");
      const btn = document.getElementById("toggleKeyBtn");
      if (input.type === "password") {
        input.type = "text";
        btn.textContent = "隐藏";
      } else {
        input.type = "password";
        btn.textContent = "显示";
      }
    }

    function testConnection() {
      const result = document.getElementById("test-result");
      result.className = "";
      result.textContent = "正在测试...";
      result.style.display = "block";
      result.style.color = "var(--description)";
      result.style.background = "transparent";

      const values = gatherValues();
      vscode.postMessage({ type: "testConnection", values });

      const timeout = setTimeout(() => {
        result.className = "error";
        result.textContent = "测试超时 (30s)，请检查网络或 Base URL";
      }, 30000);

      window.addEventListener("message", function handler(e) {
        if (e.data.type === "testResult") {
          clearTimeout(timeout);
          result.className = e.data.success ? "success" : "error";
          result.textContent = e.data.message;
          window.removeEventListener("message", handler);
        }
      });
    }

    function gatherValues() {
      return {
        openaiApiKey: document.getElementById("openaiApiKey").value,
        openaiBaseUrl: document.getElementById("openaiBaseUrl").value,
        openaiModel: document.getElementById("openaiModel").value,
        condaPath: document.getElementById("condaPath").value,
        condaEnv: document.getElementById("condaEnv").value,
        commandPath: document.getElementById("commandPath").value,
      };
    }

    function saveAll() {
      const values = gatherValues();
      vscode.postMessage({ type: "saveAll", values });
    }

    function saveOnly() {
      const values = gatherValues();
      vscode.postMessage({ type: "saveAll", values });
    }

    function resetAll() {
      document.getElementById("openaiApiKey").value = "";
      document.getElementById("openaiBaseUrl").value = "";
      document.getElementById("openaiModel").value = "";
      document.getElementById("condaPath").value = "";
      document.getElementById("condaEnv").value = "";
      document.getElementById("commandPath").value = detectedAgentaoPath || "agentao";
    }

    window.addEventListener("message", (e) => {
      if (e.data.type === "configData") {
        const v = e.data.values;
        detectedAgentaoPath = v.detectedAgentaoPath || "";
        document.getElementById("openaiBaseUrl").value = v.openaiBaseUrl || "";
        document.getElementById("openaiModel").value = v.openaiModel || "";

        // Conda path
        const condaPathInput = document.getElementById("condaPath");
        condaPathInput.value = v.condaPath || "";
        const condaHint = document.getElementById("conda-hint");
        if (v.detectedCondaPath) {
          condaHint.textContent = "(已自动检测: " + v.detectedCondaPath + ")";
          if (!v.condaPath) condaPathInput.placeholder = v.detectedCondaPath;
        } else {
          condaHint.textContent = "(未检测到 conda)";
          condaHint.classList.add("warn");
        }

        // Conda env datalist (replaces select)
        const envInput = document.getElementById("condaEnv");
        const envList = document.getElementById("condaEnvList");
        const envHint = document.getElementById("env-hint");
        const envLoading = document.getElementById("env-loading");
        if (envLoading) envLoading.style.display = "none";
        envInput.value = v.condaEnv || "";
        envList.innerHTML = "";
        if (v.condaEnvs) {
          try {
            condaEnvs = JSON.parse(v.condaEnvs);
            for (const env of condaEnvs) {
              const opt = document.createElement("option");
              opt.value = env.label;
              envList.appendChild(opt);
            }
            envHint.textContent = "(共 " + condaEnvs.length + " 个环境，可直接输入)";
          } catch {}
        }
        if (condaEnvs.length === 0) {
          envHint.textContent = "(未检测到环境，可手动输入名称)";
          envHint.classList.add("warn");
        }

        // Command path
        const cmdInput = document.getElementById("commandPath");
        cmdInput.value = v.commandPath || v.detectedAgentaoPath || "agentao";
        const cmdHint = document.getElementById("agentao-hint");
        if (v.detectedAgentaoPath) {
          cmdHint.textContent = "(已自动检测: " + v.detectedAgentaoPath + ")";
        } else {
          cmdHint.textContent = "(未在 PATH 中找到 agentao)";
          cmdHint.classList.add("warn");
        }

        // API key placeholder
        if (v.hasStoredApiKey) {
          document.getElementById("openaiApiKey").value = "********";
          document.getElementById("openaiApiKey").placeholder = "(已配置)";
        }
      }
      if (e.data.type === "saved") {
        const notif = document.getElementById("save-notification");
        notif.style.display = "block";
        setTimeout(() => { notif.style.display = "none"; }, 2000);
      }
    });

    // Fallback: if configData doesn't arrive within 5s, still enable the input
    setTimeout(() => {
      const envLoading = document.getElementById("env-loading");
      if (envLoading) envLoading.style.display = "none";
    }, 5000);

    vscode.postMessage({ type: "getConfig" });
  </script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/** Make an actual HTTPS/HTTP request to test the API connection. */
function testApiConnection(
  origin: string,
  path: string,
  apiKey: string,
  model: string = "gpt-4o-mini",
): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    const url = `${origin}${path}`;
    const parsed = new URL(url);
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    });

    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 30000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, message: `HTTP ${res.statusCode} — API 正常响应` });
          } else {
            const snippet = data.slice(0, 300);
            resolve({ success: false, message: `HTTP ${res.statusCode}: ${snippet}` });
          }
        });
      },
    );

    req.on("error", (err) => {
      resolve({ success: false, message: `连接失败: ${err.message}` });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ success: false, message: "连接超时 (30s)" });
    });

    req.write(body);
    req.end();
  });
}
