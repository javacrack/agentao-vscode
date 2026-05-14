import * as vscode from "vscode";
import { ACPClient } from "../acp/client";
import { SessionStore } from "../persistence/session-store";

export class ModelStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(
    private readonly client: ACPClient,
    private readonly store: SessionStore,
  ) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = "agentao.switchModel";
    this.item.tooltip = "Switch Agentao Model";
    this.item.show();
  }

  async refresh(): Promise<void> {
    const saved = this.store.selectedModel;
    this.item.text = `$(symbol-class) ${saved ?? "loading..."}`;
    
    if (saved) {
      try {
        await this.client.setModel(saved);
        this.item.text = `$(symbol-class) ${saved}`;
      } catch {
        // Ignore setModel error, will try to get models
      }
      return;
    }

    try {
      if (!this.client.sessionId) {
        this.item.text = "$(symbol-class) no-session";
        return;
      }

      const result = await this.client.listModels();
      if (result.models && result.models.length > 0) {
        const first = result.models[0].name;
        this.item.text = `$(symbol-class) ${first}`;
        await this.store.setSelectedModel(first);
        try {
          await this.client.setModel(first);
        } catch {
          // Ignore setModel error
        }
      } else {
        this.item.text = "$(symbol-class) no-models";
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`Failed to refresh models: ${errMsg}`);
      this.item.text = "$(symbol-class) default";
    }
  }

  async switchModel(): Promise<void> {
    try {
      if (!this.client.sessionId) {
        const action = await vscode.window.showErrorMessage(
          "Agentao 客户端未连接，请先连接客户端",
          "重新连接",
          "检查配置"
        );
        
        if (action === "重新连接") {
          vscode.window.showInformationMessage("请手动重新启动 Agentao 扩展或检查配置");
        } else if (action === "检查配置") {
          vscode.commands.executeCommand("agentao.configure");
        }
        return;
      }

      const result = await Promise.race([
        this.client.listModels(),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error("timeout")), 10000)
        )
      ]);

      if (!result || !result.models || result.models.length === 0) {
        const action = await vscode.window.showErrorMessage(
          "无法获取可用模型列表",
          "重试",
          "检查配置",
          "查看日志"
        );
        
        if (action === "重试") {
          await this.switchModel();
          return;
        } else if (action === "检查配置") {
          vscode.commands.executeCommand("agentao.configure");
        } else if (action === "查看日志") {
          vscode.commands.executeCommand("agentao.showOutput");
        }
        return;
      }

      const items = result.models.map((m) => ({
        label: m.name,
        description: m.description ?? "",
      }));

      const chosen = await vscode.window.showQuickPick(items, {
        placeHolder: "选择模型",
      });

      if (chosen) {
        await this.client.setModel(chosen.label);
        await this.store.setSelectedModel(chosen.label);
        this.item.text = `$(symbol-class) ${chosen.label}`;
        vscode.window.showInformationMessage(`已切换到模型: ${chosen.label}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      
      if (errMsg.includes("timeout")) {
        vscode.window.showErrorMessage("获取模型列表超时，请检查网络连接或稍后重试");
      } else if (errMsg.includes("sessionId") || errMsg.includes("No active session")) {
        vscode.window.showErrorMessage("Agentao 客户端会话已断开，请重新连接");
      } else {
        vscode.window.showErrorMessage(`获取模型列表失败: ${errMsg}`);
      }
      
      vscode.commands.executeCommand("agentao.showOutput");
    }
  }

  setStatus(text: string, tooltip?: string): void {
    this.item.text = text;
    if (tooltip) {
      this.item.tooltip = tooltip;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
