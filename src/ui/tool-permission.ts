import * as vscode from "vscode";
import { ACPClient } from "../acp/client";
import { SessionStore } from "../persistence/session-store";

const TOOL_DESCRIPTIONS: Record<string, string> = {
  read_file: "读取文件内容",
  write_file: "写入文件内容",
  edit_file: "编辑文件内容",
  bash: "执行 shell 命令",
  grep: "搜索文件内容",
  glob: "查找匹配模式的文件",
  web_fetch: "从 URL 获取内容",
  web_search: "执行网络搜索",
};

const TOOL_RISK_LEVELS: Record<string, "safe" | "caution" | "dangerous"> = {
  read_file: "safe",
  grep: "safe",
  glob: "safe",
  write_file: "caution",
  edit_file: "caution",
  bash: "dangerous",
  web_fetch: "caution",
  web_search: "safe",
};

export class ToolPermissionHandler {
  constructor(
    private readonly client: ACPClient,
    private readonly store: SessionStore,
  ) {}

  async handlePermission(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const toolCall = params.toolCall as { toolCallId?: string; tool?: string; title?: string; args?: string } | undefined;
    const tool = toolCall?.tool ?? "unknown";
    const title = toolCall?.title ?? tool;
    const args = toolCall?.args ?? "";

    // Check always-allowed list
    if (this.store.allowedTools.has(tool)) {
      return { outcome: { optionId: "allow_once" } };
    }

    const description = TOOL_DESCRIPTIONS[tool] || `执行 ${tool} 操作`;
    const riskLevel = TOOL_RISK_LEVELS[tool] ?? "caution";

    const preview = this.formatArgsPreview(args);
    const riskIcon = riskLevel === "dangerous" ? "⚠️" : riskLevel === "caution" ? "ℹ️" : "✅";
    const riskText = riskLevel === "dangerous" ? "高风险" : riskLevel === "caution" ? "需谨慎" : "安全";

    const message = `${riskIcon} ${description}\n\n工具: ${title}\n风险级别: ${riskText}${preview ? "\n\n参数预览:\n${preview}" : ""}`;

    // Use a timeout for permission requests
    const choice = await vscode.window.showWarningMessage(
      message,
      { modal: true, detail: args.length > 500 ? "完整参数较长，请仔细审查后再决定是否允许。" : undefined },
      "允许一次",
      "总是允许",
      "拒绝",
    );

    switch (choice) {
      case "允许一次":
        return { outcome: { optionId: "allow_once" } };
      case "总是允许":
        await this.store.allowTool(tool);
        return { outcome: { optionId: "allow_once" } };
      case "拒绝":
      default:
        return { outcome: { optionId: "reject" } };
    }
  }

  private formatArgsPreview(args: string): string {
    try {
      // Try to parse as JSON and format
      const parsed = JSON.parse(args);
      const formatted = JSON.stringify(parsed, null, 2);
      return formatted.length > 300 ? formatted.substring(0, 300) + "\n..." : formatted;
    } catch {
      // If not JSON, show raw preview
      return args.length > 300 ? args.substring(0, 300) + "..." : args;
    }
  }
}
