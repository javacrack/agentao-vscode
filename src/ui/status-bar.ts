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
    if (saved) return;

    try {
      const result = await this.client.listModels();
      if (result.models && result.models.length > 0) {
        const first = result.models[0].name;
        this.item.text = `$(symbol-class) ${first}`;
        await this.store.setSelectedModel(first);
      }
    } catch {
      this.item.text = "$(symbol-class) default";
    }
  }

  async switchModel(): Promise<void> {
    try {
      const result = await this.client.listModels();
      if (!result.models || result.models.length === 0) {
        vscode.window.showInformationMessage("No models available");
        return;
      }

      const items = result.models.map((m) => ({
        label: m.name,
        description: m.description ?? "",
      }));

      const chosen = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a model",
      });

      if (chosen) {
        await this.client.setModel(chosen.label);
        await this.store.setSelectedModel(chosen.label);
        this.item.text = `$(symbol-class) ${chosen.label}`;
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to list models: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
