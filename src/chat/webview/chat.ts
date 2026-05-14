import { marked } from "marked";
import hljs from "highlight.js";

declare const acquireVsCodeApi: () => {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

const messagesEl = document.getElementById("messages")!;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send-btn")!;
const cancelBtn = document.getElementById("cancel-btn")!;
const welcomeEl = document.getElementById("welcome")!;
const searchBar = document.getElementById("search-bar")!;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const searchClose = document.getElementById("search-close")!;
const configWarningEl = document.getElementById("config-warning");
let hasApiKey = false;

let isStreaming = false;
let lastMessageTime = 0;
let commandMenuVisible = false;
const TIME_SEPARATOR_MS = 5 * 60 * 1000; // 5 minutes

const QUICK_COMMANDS = [
  { name: "/help", description: "Show help information" },
  { name: "/clear", description: "Clear chat history" },
  { name: "/export", description: "Export current session" },
  { name: "/status", description: "Show session status" },
  { name: "/configure", description: "Configure API key, model, conda" },
  { name: "/settings", description: "Open settings" },
  { name: "/models", description: "Show available models" },
];

interface MsgData {
  id: string;
  role: string;
  content: string;
  timestamp?: number;
  status?: string;
  toolCalls?: Array<{ id: string; tool: string; args: string; result?: string }>;
  thinking?: string;
}

// ── Configuration for marked ────────────────────────────────────────

const markedOptions = {
  breaks: true,
  gfm: true,
};
marked.setOptions(markedOptions);

// ── Send ────────────────────────────────────────────────────────────

function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || isStreaming) return;
  isStreaming = true;
  updateButtons();
  inputEl.value = "";
  inputEl.style.height = "auto";
  vscode.postMessage({ type: "sendMessage", text });
}

sendBtn.addEventListener("click", sendMessage);

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
  if (e.key === "f" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    showSearchBar();
  }
});

inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";

  // Quick command menu
  const text = inputEl.value;
  if (text.startsWith("/") && !text.includes(" ")) {
    showCommandMenu(text);
  } else if (text.includes("@")) {
    // Show @mention menu for files
    const atIndex = text.lastIndexOf("@");
    const afterAt = text.substring(atIndex + 1).split(/\s/)[0];
    if (afterAt && !afterAt.includes(" ")) {
      showFileMentionMenu(afterAt);
    } else {
      hideMentionMenu();
    }
  } else if (text.includes("#")) {
    // Show #mention menu for symbols
    const hashIndex = text.lastIndexOf("#");
    const afterHash = text.substring(hashIndex + 1).split(/\s/)[0];
    if (afterHash && !afterHash.includes(" ")) {
      showSymbolMentionMenu(afterHash);
    } else {
      hideMentionMenu();
    }
  } else {
    hideCommandMenu();
    hideMentionMenu();
  }
});

cancelBtn.addEventListener("click", () => {
  isStreaming = false;
  updateButtons();
  vscode.postMessage({ type: "cancelMessage" });
});

// Toolbar buttons
document.getElementById("toolbar-configure")?.addEventListener("click", () => {
  vscode.postMessage({ type: "openConfigure" });
});
document.getElementById("toolbar-model")?.addEventListener("click", () => {
  vscode.postMessage({ type: "switchModel" });
});
document.getElementById("toolbar-new-session")?.addEventListener("click", () => {
  vscode.postMessage({ type: "newSession" });
});
document.getElementById("toolbar-clear")?.addEventListener("click", () => {
  vscode.postMessage({ type: "clearHistory" });
});
document.getElementById("toolbar-export")?.addEventListener("click", () => {
  vscode.postMessage({ type: "exportSession" });
});
configWarningEl?.addEventListener("click", () => {
  vscode.postMessage({ type: "openConfigure" });
});

// ── Message from extension ──────────────────────────────────────────

window.addEventListener("message", (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "sync":
      renderAllMessages(msg.messages as MsgData[]);
      break;
    case "append":
      appendToAssistant(msg.id, msg.text);
      break;
    case "tool_call":
      appendToolCall(msg.toolCallId, msg.tool, msg.args);
      break;
    case "tool_result":
      updateToolResult(msg.toolCallId, msg.result);
      break;
    case "thinking":
      renderThinking(msg.text);
      break;
    case "complete":
      isStreaming = false;
      updateButtons();
      break;
    case "error":
      isStreaming = false;
      updateButtons();
      if (msg.message) {
        appendErrorMessage(msg.message as string, msg.showReconnect as boolean);
      }
      break;
    case "clear":
      messagesEl.innerHTML = "";
      showWelcome();
      break;
    case "insertMention":
      insertMentionText(msg.text as string);
      break;
    case "configStatus":
      hasApiKey = msg.hasApiKey as boolean;
      updateConfigWarning();
      break;
    case "reconnectResult":
      if (!msg.success) {
        appendErrorMessage("重新连接失败，请检查配置后重试。", false);
      }
      break;
    case "welcomeMessage":
      showWelcome();
      if (msg.message && welcomeEl) {
        welcomeEl.innerHTML = `<div style="color: var(--warning); padding: 10px;">${msg.message.replace(/\n/g, "<br>")}</div>`;
      }
      break;
  }
});

// ── Rendering ───────────────────────────────────────────────────────

function showWelcome() {
  if (messagesEl.children.length === 0) {
    messagesEl.appendChild(welcomeEl);
  }
}

function hideWelcome() {
  if (welcomeEl.parentElement) {
    welcomeEl.remove();
  }
}

function renderAllMessages(messages: MsgData[]) {
  const existing = new Set<string>();
  for (const child of Array.from(messagesEl.children)) {
    const id = child.getAttribute("data-msg-id");
    if (id) existing.add(id);
  }

  // Remove old messages
  for (const child of Array.from(messagesEl.children)) {
    if (child.id === "welcome") continue;
    const id = child.getAttribute("data-msg-id");
    if (id && !messages.find((m) => m.id === id)) {
      child.remove();
    }
  }

  lastMessageTime = 0;

  for (const m of messages) {
    // Insert time separator if needed (only for new messages)
    if (!existing.has(m.id) && lastMessageTime > 0) {
      const timeDiff = (m.timestamp || Date.now()) - lastMessageTime;
      if (timeDiff > TIME_SEPARATOR_MS) {
        insertTimeSeparator((m.timestamp || Date.now()) - timeDiff / 2);
      }
    }
    lastMessageTime = m.timestamp || Date.now();

    let el = messagesEl.querySelector(`[data-msg-id="${m.id}"]`) as HTMLElement;
    if (!el) {
      el = createMessageEl(m);
      messagesEl.appendChild(el);
    } else {
      updateMessageEl(el, m);
    }
  }

  if (messages.length > 0) hideWelcome();
  scrollToBottom();
}

function insertTimeSeparator(timestamp: number) {
  const sep = document.createElement("div");
  sep.className = "time-separator";
  sep.setAttribute("data-time-separator", timestamp.toString());
  const span = document.createElement("span");
  span.textContent = formatTime(timestamp);
  sep.appendChild(span);
  messagesEl.appendChild(sep);
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } else if (date.toDateString() === yesterday.toDateString()) {
    return "Yesterday";
  } else {
    return date.toLocaleDateString();
  }
}

function createMessageEl(m: MsgData) {
  const div = document.createElement("div");
  div.className = `msg ${m.role}`;
  div.setAttribute("data-msg-id", m.id);

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  const contentDiv = document.createElement("div");
  contentDiv.className = "msg-content";
  contentDiv.innerHTML = renderMarkdown(m.content);
  bubble.appendChild(contentDiv);

  // Render tool calls
  if (m.toolCalls && m.toolCalls.length > 0) {
    for (const tc of m.toolCalls) {
      const toolEl = createToolCallEl(tc);
      bubble.appendChild(toolEl);
    }
  }

  div.appendChild(bubble);

  // Add timestamp
  const ts = document.createElement("div");
  ts.className = "msg-time";
  const d = new Date(m.timestamp || Date.now());
  ts.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  div.appendChild(ts);

  return div;
}

function createToolCallEl(tc: { id: string; tool: string; args: string; result?: string }): HTMLElement {
  const div = document.createElement("div");
  div.className = "tool-call";
  div.setAttribute("data-toolcall-id", tc.id);

  const header = document.createElement("div");
  header.className = "tool-header";

  const nameSpan = document.createElement("span");
  nameSpan.className = "tool-name";
  nameSpan.textContent = tc.tool;
  header.appendChild(nameSpan);

  const statusSpan = document.createElement("span");
  statusSpan.className = "tool-status";
  statusSpan.textContent = tc.result ? "✓ Done" : "⏳ Running";
  if (tc.result) {
    statusSpan.classList.add("success");
  }
  header.appendChild(statusSpan);

  header.addEventListener("click", () => {
    const argsEl = div.querySelector(".tool-args") as HTMLElement;
    const resultEl = div.querySelector(".tool-result") as HTMLElement;
    if (argsEl) argsEl.classList.toggle("hidden");
    if (resultEl) resultEl.classList.toggle("hidden");
  });

  div.appendChild(header);

  const argsEl = document.createElement("div");
  argsEl.className = "tool-args";
  try {
    const parsed = JSON.parse(tc.args);
    argsEl.innerHTML = "<strong>Args:</strong>\n" + JSON.stringify(parsed, null, 2);
  } catch {
    argsEl.textContent = "Args: " + tc.args;
  }
  div.appendChild(argsEl);

  if (tc.result) {
    const resultEl = document.createElement("div");
    resultEl.className = "tool-result";
    try {
      const parsed = JSON.parse(tc.result);
      resultEl.innerHTML = "<strong>Result:</strong>\n" + JSON.stringify(parsed, null, 2);
    } catch {
      resultEl.textContent = tc.result;
    }
    div.appendChild(resultEl);
  }

  return div;
}

function updateMessageEl(el: HTMLElement, m: MsgData) {
  const bubble = el.querySelector(".msg-bubble") as HTMLElement;
  if (!bubble) return;

  const contentDiv = bubble.querySelector(".msg-content");
  if (contentDiv) {
    contentDiv.innerHTML = renderMarkdown(m.content);
  }

  // Update tool calls
  if (m.toolCalls && m.toolCalls.length > 0) {
    for (const tc of m.toolCalls) {
      let tcEl = bubble.querySelector(`[data-toolcall-id="${tc.id}"]`) as HTMLElement;
      if (!tcEl) {
        tcEl = createToolCallEl(tc);
        bubble.appendChild(tcEl);
      } else {
        // Update result if exists
        if (tc.result) {
          const resultEl = tcEl.querySelector(".tool-result") as HTMLElement;
          if (!resultEl) {
            const newResultEl = document.createElement("div");
            newResultEl.className = "tool-result";
            try {
              const parsed = JSON.parse(tc.result);
              newResultEl.innerHTML = "<strong>Result:</strong>\n" + JSON.stringify(parsed, null, 2);
            } catch {
              newResultEl.textContent = tc.result;
            }
            tcEl.appendChild(newResultEl);
          } else {
            try {
              const parsed = JSON.parse(tc.result);
              resultEl.innerHTML = "<strong>Result:</strong>\n" + JSON.stringify(parsed, null, 2);
            } catch {
              resultEl.textContent = tc.result;
            }
          }
          const statusSpan = tcEl.querySelector(".tool-status");
          if (statusSpan) {
            statusSpan.classList.remove("pending");
            statusSpan.classList.add("success");
            statusSpan.textContent = "✓ Done";
          }
        }
      }
    }
  }

  if (m.status === "error") {
    bubble.style.color = "var(--error)";
  } else {
    bubble.style.color = "inherit";
  }

  scrollToBottom();
}

function appendToAssistant(msgId: string, text: string) {
  hideWelcome();
  let el = messagesEl.querySelector(`[data-msg-id="${msgId}"]`) as HTMLElement;
  if (!el) {
    const msgData: MsgData = {
      id: msgId,
      role: "assistant",
      content: text,
      timestamp: Date.now(),
      status: "streaming",
      toolCalls: [],
    };
    el = createMessageEl(msgData);
    messagesEl.appendChild(el);
    el.setAttribute("data-accumulated-content", text);
  } else {
    const bubble = el.querySelector(".msg-bubble") as HTMLElement;
    if (bubble) {
      const contentDiv = bubble.querySelector(".msg-content");
      if (contentDiv) {
        const prevContent = el.getAttribute("data-accumulated-content") || "";
        const newContent = prevContent + text;
        el.setAttribute("data-accumulated-content", newContent);
        contentDiv.innerHTML = renderMarkdown(newContent);
      }
    }
  }

  scrollToBottom();
}

function appendToolCall(toolCallId: string, tool: string, args: string) {
  hideWelcome();
  // Find or create the last assistant message bubble
  let lastAssistant = messagesEl.querySelector("[data-msg-id]:last-of-type") as HTMLElement;
  if (!lastAssistant || !lastAssistant.classList.contains("assistant")) {
    // Create a new assistant message
    const msgData: MsgData = { id: `msg_${Date.now()}`, role: "assistant", content: "", timestamp: Date.now(), toolCalls: [] };
    lastAssistant = createMessageEl(msgData);
    messagesEl.appendChild(lastAssistant);
  }
  const bubble = lastAssistant.querySelector(".msg-bubble") as HTMLElement;
  if (!bubble) return;
  const tc = { id: toolCallId, tool, args, result: "" };
  const tcEl = createToolCallEl(tc);
  bubble.appendChild(tcEl);
  scrollToBottom();
}

function updateToolResult(toolCallId: string, result: string) {
  const tcEl = document.querySelector(`[data-toolcall-id="${toolCallId}"]`) as HTMLElement;
  if (!tcEl) return;
  // Update status
  const statusSpan = tcEl.querySelector(".tool-status");
  if (statusSpan) {
    statusSpan.classList.add("success");
    statusSpan.textContent = "Done";
  }
  // Add result section if not exists
  let resultEl = tcEl.querySelector(".tool-result") as HTMLElement;
  if (!resultEl) {
    resultEl = document.createElement("div");
    resultEl.className = "tool-result";
    tcEl.appendChild(resultEl);
  }
  try {
    const parsed = JSON.parse(result);
    resultEl.innerHTML = "<strong>Result:</strong>\n" + JSON.stringify(parsed, null, 2);
  } catch {
    resultEl.textContent = result;
  }
  scrollToBottom();
}

function renderThinking(text: string) {
  hideWelcome();
  const div = document.createElement("div");
  div.className = "thinking collapsed";
  div.innerHTML = text;
  div.addEventListener("click", (e) => {
    if (e.target === div) {
      div.classList.toggle("collapsed");
    }
  });
  messagesEl.appendChild(div);
  scrollToBottom();
}

function renderMarkdown(text: string): string {
  try {
    let html = marked.parse(text);
    if (typeof html !== "string") {
      html = text.replace(/\n/g, "<br>");
    }

    // Replace code blocks with enhanced version
    html = html.replace(/<pre><code class="language-([^"]*)">([\s\S]*?)<\/code><\/pre>/g, (match, lang, code) => {
      const decodedCode = decodeHtml(code);
      const lines = decodedCode.split("\n");
      const isLong = lines.length > 20;

      let html = '<div class="code-block-container">';
      html += '<div class="code-block-header">';
      html += `<span class="code-lang">${lang || "text"}</span>`;
      html += `<button class="code-copy-btn" data-code="${encodeURIComponent(decodedCode)}">Copy</button>`;
      html += "</div>";
      html += `<pre class="${isLong ? "collapsible" : ""}"><code>${highlightCode(decodedCode, lang)}</code></pre>`;
      html += "</div>";
      return html;
    });

    // Detect and convert file paths to links
    html = html.replace(/([a-zA-Z0-9._\-/\\]+\.(ts|tsx|js|jsx|py|java|c|cpp|h|css|html|md|json|yaml|yml|xml|sql|sh|bash|go|rs|php|rb|swift))(:\d+)?(:\d+)?/g, (match) => {
      return `<a class="file-link" href="#" data-file-path="${match}" title="Click to open">${match}</a>`;
    });

    // Also detect relative paths in markdown links format
    html = html.replace(/\[([^\]]+)\]\(([^)]+\.(ts|tsx|js|jsx|py|java|c|cpp|h|css|html|md|json|yaml|yml|xml|sql|sh|bash|go|rs|php|rb|swift))\)/g, (match, text, path) => {
      return `<a class="file-link" href="#" data-file-path="${path}" title="Click to open">${text}</a>`;
    });

    return html;
  } catch {
    return escapeHtml(text).replace(/\n/g, "<br>");
  }
}

function highlightCode(code: string, lang: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    // Auto-detect language if no lang specified
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

function decodeHtml(html: string): string {
  const txt = document.createElement("textarea");
  txt.innerHTML = html;
  return txt.value;
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function scrollToBottom() {
  setTimeout(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }, 0);
}

function showCommandMenu(filter: string) {
  let menu = document.getElementById("command-menu") as HTMLElement;
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "command-menu";
    menu.style.position = "absolute";
    menu.style.bottom = "50px";
    menu.style.left = "8px";
    menu.style.right = "8px";
    menu.style.background = "var(--vscode-dropdown-background, #252526)";
    menu.style.border = "1px solid var(--vscode-dropdown-border, #3e3e42)";
    menu.style.borderRadius = "4px";
    menu.style.maxHeight = "200px";
    menu.style.overflowY = "auto";
    menu.style.zIndex = "100";
    document.body.appendChild(menu);
  }

  menu.innerHTML = "";
  const filtered = QUICK_COMMANDS.filter((cmd) => cmd.name.includes(filter));

  for (const cmd of filtered) {
    const item = document.createElement("div");
    item.style.padding = "8px 10px";
    item.style.cursor = "pointer";
    item.style.display = "flex";
    item.style.justifyContent = "space-between";
    item.style.borderBottom = "1px solid var(--vscode-dropdown-border, #3e3e42)";
    item.style.fontSize = "0.9em";

    const nameEl = document.createElement("span");
    nameEl.style.fontWeight = "600";
    nameEl.style.color = "var(--vscode-textLink-foreground)";
    nameEl.textContent = cmd.name;

    const descEl = document.createElement("span");
    descEl.style.color = "var(--fg)";
    descEl.style.opacity = "0.6";
    descEl.style.fontSize = "0.8em";
    descEl.style.marginLeft = "10px";
    descEl.textContent = cmd.description;

    item.appendChild(nameEl);
    item.appendChild(descEl);

    item.addEventListener("click", () => {
      handleQuickCommand(cmd.name);
    });

    item.addEventListener("mouseover", () => {
      item.style.background = "var(--vscode-list-hoverBackground, #2d2d30)";
    });

    item.addEventListener("mouseout", () => {
      item.style.background = "transparent";
    });

    menu.appendChild(item);
  }

  commandMenuVisible = true;
}

function hideCommandMenu() {
  const menu = document.getElementById("command-menu");
  if (menu) {
    menu.remove();
  }
  commandMenuVisible = false;
}

function showFileMentionMenu(query: string) {
  vscode.postMessage({ type: "searchFiles", query });
}

function showSymbolMentionMenu(query: string) {
  vscode.postMessage({ type: "searchSymbols", query });
}

function hideMentionMenu() {
  const menu = document.getElementById("mention-menu");
  if (menu) {
    menu.remove();
  }
}

function insertMentionText(text: string) {
  inputEl.value += text;
  inputEl.focus();
  hideMentionMenu();
  hideCommandMenu();
}

function handleQuickCommand(cmd: string) {
  switch (cmd) {
    case "/help":
      inputEl.value = "";
      hideCommandMenu();
      showHelpMessage();
      break;
    case "/clear":
      inputEl.value = "";
      hideCommandMenu();
      vscode.postMessage({ type: "clearHistory" });
      break;
    case "/export":
      inputEl.value = "";
      hideCommandMenu();
      vscode.postMessage({ type: "exportSession" });
      break;
    case "/status":
      inputEl.value = "";
      hideCommandMenu();
      showStatusMessage();
      break;
    case "/configure":
      inputEl.value = "";
      hideCommandMenu();
      vscode.postMessage({ type: "openConfigure" });
      break;
    case "/settings":
      inputEl.value = "";
      hideCommandMenu();
      vscode.postMessage({ type: "openSettings" });
      break;
    case "/models":
      inputEl.value = "";
      hideCommandMenu();
      vscode.postMessage({ type: "switchModel" });
      break;
    default:
      inputEl.value = cmd + " ";
      inputEl.focus();
  }
}

function showHelpMessage() {
  hideWelcome();
  isStreaming = true;
  updateButtons();
  const helpText = `## Agentao — AI Chat Assistant

**Commands:**
- \`/help\` — Show this help
- \`/clear\` — Clear chat history
- \`/export\` — Export session to file
- \`/status\` — Show session status
- \`/settings\` — Open VS Code settings
- \`/models\` — Switch LLM model

**Mentions:**
- \`@file\` — Search and reference files
- \`#symbol\` — Search and reference symbols

**Shortcuts:**
- \`Ctrl+Shift+A\` — Focus chat
- \`Ctrl+Shift+N\` — New session
- \`Ctrl+Shift+/\` — Ask about selection
- \`Ctrl+F\` — Search in chat
- \`Enter\` — Send message
- \`Shift+Enter\` — New line`;

  const msgData: MsgData = {
    id: `help_${Date.now()}`,
    role: "assistant",
    content: helpText,
    timestamp: Date.now(),
    status: "complete",
  };
  const el = createMessageEl(msgData);
  messagesEl.appendChild(el);
  isStreaming = false;
  updateButtons();
  scrollToBottom();
}

function showStatusMessage() {
  hideWelcome();
  const state = vscode.getState() as Record<string, unknown> | undefined;
  const msgCount = messagesEl.querySelectorAll("[data-msg-id]").length;
  const statusText = `## Session Status

- **Messages:** ${msgCount}
- **Model:** ${state?.model || "default"}
- **Status:** ${isStreaming ? "Running" : "Idle"}`;

  const msgData: MsgData = {
    id: `status_${Date.now()}`,
    role: "assistant",
    content: statusText,
    timestamp: Date.now(),
    status: "complete",
  };
  const el = createMessageEl(msgData);
  messagesEl.appendChild(el);
  scrollToBottom();
}

function updateButtons() {
  if (isStreaming) {
    sendBtn.classList.add("hidden");
    cancelBtn.classList.remove("hidden");
  } else {
    sendBtn.classList.remove("hidden");
    cancelBtn.classList.add("hidden");
  }
}

function updateConfigWarning() {
  if (configWarningEl) {
    if (!hasApiKey) {
      configWarningEl.classList.remove("hidden");
    } else {
      configWarningEl.classList.add("hidden");
    }
  }
}

function appendErrorMessage(message: string, showReconnect = true) {
  hideWelcome();
  const reconnectLink = showReconnect
    ? '\n\n<span class="reconnect-link" style="color:var(--accent);text-decoration:underline;cursor:pointer;">重新连接</span>'
    : '';
  const msgData: MsgData = {
    id: `error_${Date.now()}`,
    role: "assistant",
    content: `**请求失败**: \n\n${message}${reconnectLink}`,
    timestamp: Date.now(),
    status: "error",
  };
  const el = createMessageEl(msgData);
  messagesEl.appendChild(el);
  scrollToBottom();
}

// ── Search ────────────────────────────────────────────────────────────

function showSearchBar() {
  searchBar.classList.remove("hidden");
  searchInput.value = "";
  searchInput.focus();
  clearHighlights();
}

function hideSearchBar() {
  searchBar.classList.add("hidden");
  clearHighlights();
}

searchClose.addEventListener("click", hideSearchBar);

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideSearchBar();
  }
});

searchInput.addEventListener("input", () => {
  const query = searchInput.value.trim();
  if (!query) {
    clearHighlights();
    return;
  }
  highlightAndScroll(query);
});

function highlightAndScroll(query: string) {
  clearHighlights();

  const messages = messagesEl.querySelectorAll("[data-msg-id]");
  let firstMatch: HTMLElement | null = null;

  for (const msg of Array.from(messages)) {
    const contentEl = msg.querySelector(".msg-content");
    if (!contentEl) continue;

    const html = contentEl.innerHTML;
    const text = contentEl.textContent || "";

    if (text.toLowerCase().includes(query.toLowerCase())) {
      const regex = new RegExp(`(${escapeRegex(query)})`, "gi");
      contentEl.innerHTML = html.replace(/(<[^>]+>)|([^<]+)/g, (match, tag, textContent) => {
        if (tag) return tag;
        return textContent.replace(regex, '<mark class="search-highlight">$1</mark>');
      });

      if (!firstMatch) {
        firstMatch = msg as HTMLElement;
      }
    }
  }

  if (firstMatch) {
    firstMatch.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function clearHighlights() {
  const marks = messagesEl.querySelectorAll("mark.search-highlight");
  for (const mark of Array.from(marks)) {
    const parent = mark.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
      parent.normalize();
    }
  }
}

function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Delegate copy button clicks and file link clicks
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains("code-copy-btn")) {
    const code = decodeURIComponent(target.getAttribute("data-code") || "");
    navigator.clipboard.writeText(code).then(() => {
      const original = target.textContent;
      target.textContent = "Copied!";
      setTimeout(() => {
        target.textContent = original;
      }, 2000);
    });
  } else if (target.classList.contains("file-link")) {
    e.preventDefault();
    const filePath = target.getAttribute("data-file-path");
    if (filePath) {
      vscode.postMessage({ type: "openFile", path: filePath });
    }
  } else if (target.classList.contains("reconnect-link")) {
    e.preventDefault();
    vscode.postMessage({ type: "reconnect" });
  }
});

inputEl.focus();

// Request initial config status
vscode.postMessage({ type: "getConfigStatus" });
