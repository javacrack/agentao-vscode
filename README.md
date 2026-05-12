# Agentao VS Code Extension

ACP-powered AI agent chat panel for VS Code. Connect to [agentao](https://github.com/jin-bo/chatagent) via the Agent Client Protocol.

## Features

- **Sidebar Chat Panel** — Interactive chat with markdown rendering, streaming responses, and conversation history
- **Syntax Highlighting** — Code blocks with full syntax highlighting via highlight.js
- **File Path Links** — Click file paths in responses to open them directly in the editor
- **@File Mentions** — Type `@` to search and reference workspace files
- **#Symbol Mentions** — Type `#` to search and reference workspace symbols
- **Tool Permission Dialogs** — Modal prompts when the agent wants to run tools (Allow Once / Allow Always / Reject)
- **Session Persistence** — Conversations survive VS Code restarts
- **Model Switching** — Status bar item to change the LLM model on the fly
- **Output Channel** — Debug logging for ACP traffic (View → Output → Agentao)
- **Keyboard Shortcuts** — Quick access to chat, new session, and more
- **Chat Search** — Press `Ctrl+F` in chat to search conversation history
- **Quick Commands** — Type `/` for command menu (`/help`, `/clear`, `/export`, `/settings`, `/models`)

## Requirements

- [agentao](https://github.com/jin-bo/chatagent) installed and available on PATH, or configure the path in settings
- An LLM API key (set via `OPENAI_API_KEY` environment variable or Agentao's own config)

## Installation

### From VSIX

```bash
code --install-extension agentao-0.1.0.vsix
```

### From Source

```bash
git clone https://github.com/jin-bo/chatagent
cd chatagent
npm install
npm run build
code --install-extension agentao-0.1.0.vsix
```

## Configuration

Open VS Code Settings (`Ctrl+,`) and search for "Agentao":

| Setting | Default | Description |
|---------|---------|-------------|
| `agentao.commandPath` | `agentao` | Path to the agentao executable |
| `agentao.args` | `["--acp", "--stdio"]` | Additional CLI arguments |
| `agentao.workingDirectory` | `${workspaceFolder}` | Working directory for the agent |
| `agentao.env` | `{}` | Extra environment variables |
| `agentao.rpcTimeoutMs` | `60000` | RPC call timeout (ms) |
| `agentao.autoRestoreSession` | `true` | Restore session on startup |
| `agentao.logLevel` | `info` | Logging verbosity (debug/info/warn/error/off) |
| `agentao.mcpServers` | `[]` | MCP server configurations |
| `agentao.condaEnv` | `""` | Conda environment name for running agentao |

## Usage

1. Open the Agentao activity bar icon (left sidebar)
2. Type a message in the chat input
3. Press Enter or click Send
4. Watch the agent response stream in real-time
5. Approve or reject tool calls when prompted

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+A` / `Cmd+Shift+A` | Focus chat panel |
| `Ctrl+Shift+N` / `Cmd+Shift+N` | New session |
| `Ctrl+Shift+/` / `Cmd+Shift+/` | Ask about selected code |
| `Ctrl+F` / `Cmd+F` (in chat) | Search chat history |

### Commands

- `Agentao: Send Message` — Focus chat panel
- `Agentao: Cancel` — Cancel current agent turn
- `Agentao: New Session` — Start fresh conversation
- `Agentao: Clear History` — Clear chat display
- `Agentao: Switch Model` — Change LLM model
- `Agentao: Focus Chat` — Focus chat panel
- `Agentao: Ask About Selection` — Chat about selected code
- `Agentao: Explain Selection` — Explain selected code
- `Agentao: Configure Environment` — Configure conda environment

### Mentions

- **@file** — Type `@` followed by a filename to search and reference workspace files
- **#symbol** — Type `#` followed by a symbol name to search and reference workspace symbols

### Quick Commands

Type `/` in the chat input for the command menu:

- `/help` — Show help information
- `/clear` — Clear chat history
- `/export` — Export current session as JSON
- `/settings` — Open Agentao settings
- `/models` — Show available models

## Architecture

This extension communicates with agentao via the **Agent Client Protocol (ACP)** v1 — a stdio-based JSON-RPC 2.0 protocol. The extension spawns `agentao --acp --stdio` as a subprocess and exchanges NDJSON messages over stdin/stdout.

### Project Structure

```
src/
├── acp/
│   ├── client.ts          # ACP client implementation
│   ├── types.ts           # ACP type definitions
│   └── json-types.ts      # JSON-RPC base types
├── chat/
│   ├── chat-view-provider.ts  # Webview provider
│   ├── message-list.ts    # Message list management
│   └── webview/
│       └── chat.ts        # Webview frontend code
├── persistence/
│   └── session-store.ts   # Session and state persistence
├── ui/
│   ├── output-channel.ts  # Output channel logging
│   ├── status-bar.ts      # Model status bar item
│   └── tool-permission.ts # Tool permission handling
└── extension.ts           # Main extension entry point
```

## License

MIT
