import type { StoredMessage } from "../persistence/session-store";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  status: "pending" | "streaming" | "complete" | "error";
  toolCalls: { id: string; tool: string; args: string; result?: string }[];
  thinking?: string;
}

export class MessageList {
  private messages: ChatMessage[] = [];
  private _onChange?: () => void;

  set onChange(fn: () => void) {
    this._onChange = fn;
  }

  get all(): ChatMessage[] {
    return this.messages;
  }

  add(role: "user" | "assistant", content = ""): ChatMessage {
    const msg: ChatMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role,
      content,
      timestamp: Date.now(),
      status: role === "user" ? "complete" : "streaming",
      toolCalls: [],
    };
    this.messages.push(msg);
    this._onChange?.();
    return msg;
  }

  appendToAssistant(text: string): ChatMessage | null {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "assistant") {
      if (last.content === "_思考中..._" || last.content.startsWith("_思考中..._")) {
        last.content = text;
      } else {
        last.content += text;
      }
      last.status = "streaming";
      this._onChange?.();
      return last;
    }
    return null;
  }

  addToolCall(id: string, tool: string, args: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "assistant") {
      last.toolCalls.push({ id, tool, args });
      this._onChange?.();
    }
  }

  updateToolResult(id: string, result: string): void {
    for (const msg of this.messages) {
      for (const tc of msg.toolCalls) {
        if (tc.id === id) {
          tc.result = result;
          this._onChange?.();
          return;
        }
      }
    }
  }

  completeLast(): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "assistant" && last.status === "streaming") {
      last.status = "complete";
      this._onChange?.();
    }
  }

  markError(): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "assistant") {
      last.status = "error";
      this._onChange?.();
    }
  }

  clear(): void {
    this.messages = [];
    this._onChange?.();
  }

  toStoredMessages(): StoredMessage[] {
    return this.messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls.map((tc) => ({
        tool: tc.tool,
        args: tc.args,
        result: tc.result,
      })),
      timestamp: m.timestamp,
    }));
  }

  restoreFromStored(messages: StoredMessage[]): void {
    this.messages = messages.map((m) => ({
      id: `msg_${m.timestamp}_${Math.random().toString(36).slice(2, 8)}`,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      status: "complete",
      toolCalls: m.toolCalls?.map((tc) => ({
        id: `tc_${Math.random().toString(36).slice(2, 8)}`,
        tool: tc.tool,
        args: tc.args,
        result: tc.result,
      })) ?? [],
    }));
    this._onChange?.();
  }
}
