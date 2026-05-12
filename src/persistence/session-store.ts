import type { Memento, SecretStorage } from "vscode";

const KEY_SESSION_ID = "agentao.sessionId";
const KEY_API_KEY = "agentao.apiKey";
const KEY_SELECTED_MODEL = "agentao.selectedModel";
const KEY_ALLOWED_TOOLS = "agentao.allowedTools";
const KEY_CHAT_HISTORY = "agentao.chatHistory";

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: { tool: string; args: string; result?: string }[];
  timestamp: number;
}

export class SessionStore {
  constructor(
    private readonly globalState: Memento,
    private readonly secrets: SecretStorage,
  ) {}

  get sessionId(): string | undefined {
    return this.globalState.get<string>(KEY_SESSION_ID);
  }

  async setSessionId(id: string): Promise<void> {
    await this.globalState.update(KEY_SESSION_ID, id);
  }

  async clearSessionId(): Promise<void> {
    await this.globalState.update(KEY_SESSION_ID, undefined);
  }

  async getApiKey(): Promise<string | undefined> {
    return this.secrets.get(KEY_API_KEY);
  }

  async setApiKey(key: string): Promise<void> {
    await this.secrets.store(KEY_API_KEY, key);
  }

  get selectedModel(): string | undefined {
    return this.globalState.get<string>(KEY_SELECTED_MODEL);
  }

  async setSelectedModel(model: string): Promise<void> {
    await this.globalState.update(KEY_SELECTED_MODEL, model);
  }

  get allowedTools(): Set<string> {
    const arr = this.globalState.get<string[]>(KEY_ALLOWED_TOOLS, []);
    return new Set(arr);
  }

  async allowTool(tool: string): Promise<void> {
    const tools = this.allowedTools;
    tools.add(tool);
    await this.globalState.update(KEY_ALLOWED_TOOLS, [...tools]);
  }

  async disallowTool(tool: string): Promise<void> {
    const tools = this.allowedTools;
    tools.delete(tool);
    await this.globalState.update(KEY_ALLOWED_TOOLS, [...tools]);
  }

  get chatHistory(): StoredMessage[] {
    return this.globalState.get<StoredMessage[]>(KEY_CHAT_HISTORY, []);
  }

  async setChatHistory(messages: StoredMessage[]): Promise<void> {
    // Cap at 200 messages to avoid exceeding state size limits
    const capped = messages.slice(-200);
    await this.globalState.update(KEY_CHAT_HISTORY, capped);
  }

  async appendToHistory(message: StoredMessage): Promise<void> {
    const history = this.chatHistory;
    history.push(message);
    await this.setChatHistory(history);
  }

  async clearChatHistory(): Promise<void> {
    await this.globalState.update(KEY_CHAT_HISTORY, undefined);
  }
}
