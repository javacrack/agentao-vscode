import * as vscode from "vscode";

export class OutputChannel {
  private readonly channel: vscode.OutputChannel;
  private readonly logLevel: string;

  constructor(context: vscode.ExtensionContext) {
    this.channel = vscode.window.createOutputChannel("Agentao");
    context.subscriptions.push(this.channel);
    this.logLevel = vscode.workspace.getConfiguration("agentao").get("logLevel", "info");
  }

  log(msg: string): void {
    if (["debug", "info", "warn", "error"].includes(this.logLevel)) {
      this.append(`[info] ${msg}`);
    }
  }

  logDebug(msg: string): void {
    if (this.logLevel === "debug") {
      this.append(`[debug] ${msg}`);
    }
  }

  logWarn(msg: string): void {
    if (["debug", "info", "warn"].includes(this.logLevel)) {
      this.append(`[warn] ${msg}`);
    }
  }

  logError(msg: string): void {
    this.append(`[error] ${msg}`);
  }

  logStderr(text: string): void {
    if (this.logLevel === "debug") {
      for (const line of text.trim().split("\n")) {
        if (line.trim()) this.append(`[stderr] ${line.trim()}`);
      }
    }
  }

  show(): void {
    this.channel.show();
  }

  private append(msg: string): void {
    const ts = new Date().toISOString().substring(11, 23);
    this.channel.appendLine(`${ts} ${msg}`);
  }
}
