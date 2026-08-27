# AI Proxy Manager 🚀

A highly modular, production-ready "Smart Router" that allows you to seamlessly manage multiple API providers (GoRouter, Tabitoken, OpenRouter, etc.) across multiple local AI tools (Claude Code, VS Code, Opencode) simultaneously.

---

## 🌟 Why this exists?
Normally, switching API keys or base URLs means manually editing `.bashrc` files, restarting proxy servers, or fighting with VS Code configuration files. 

**AI Proxy Manager** solves this by acting as a central daemon running in the background. It dynamically routes your AI requests based on the API key you provide!

If you provide the key `gorouter:sk-123`, the proxy instantly forwards the request to GoRouter. 
If you provide `tabitoken:sk-456`, it forwards it to Tabitoken. 
**No restarts required. No `.bashrc` editing.**

---

## 📦 Installation

Since this is a standard Node.js package, you can install it globally on your system.

```bash
cd /home/marajul/Web_Development_Workspace/ai-proxy-manager
npm install -g .
```

---

## 🛠️ Configuration Tutorial

### 1. Register your Providers
First, add your favorite providers into the database:
```bash
# Add GoRouter
ai-proxy add-provider gorouter https://gorouter.app/v1
ai-proxy set-key gorouter sk-your-gorouter-key...

# Add Tabitoken
ai-proxy add-provider tabitoken https://tabitoken.com/v1
ai-proxy set-key tabitoken sk-your-tabitoken-key...
```

### 2. View your Database
You can check your configurations at any time beautifully formatted:
```bash
ai-proxy list
```

### 3. Start the Daemon
Start the proxy engine. It will listen on `http://127.0.0.1:8319` by default.
*(Pro tip: Open a new terminal tab and run this so it stays in the background!)*
```bash
ai-proxy start
```

---

## 🚀 Integrating with your Tools

The true power of this tool is how easily it injects itself into your workflow.

### For Claude Code
Run the setup command once:
```bash
ai-proxy setup-terminal
```
This adds a single block to your `~/.bashrc`. From now on, Claude Code will automatically talk to the AI Proxy Manager. 

**How to switch providers in Claude Code?**
Simply set the active provider using the CLI! The background daemon instantly applies it.
```bash
ai-proxy use gorouter
# or
ai-proxy use tabitoken
```

### For VS Code
Run the sync command:
```bash
ai-proxy sync-vscode
```
This instantly injects all your configured providers directly into VS Code's `chatLanguageModels.json`. You will immediately see `ai-proxy:gorouter` and `ai-proxy:tabitoken` appear in the VS Code Copilot dropdown!

### For Opencode
Open the Opencode GUI and enter these settings:
- **Base URL**: `http://127.0.0.1:8319`
- **API Key**: `gorouter:sk-your-key-here` (or just `gorouter:dummy` to use the one saved in your database!)

The proxy will detect the `gorouter:` prefix and route Opencode perfectly!

---

## 🏗️ Architecture for Future Developers

If you wish to contribute or resolve issues, the codebase is modularized:
- **`src/cli.js`**: Command line argument parsing and routing.
- **`src/core/proxyServer.js`**: The `http`/`https` daemon. Contains the core logic for intercepting headers, overriding models, and smart routing.
- **`src/core/configManager.js`**: Handles saving/loading the JSON database at `~/.config/ai-proxy-manager/config.json`.
- **`src/controllers/`**: Business logic for providers and tool integrations (VS Code/Bashrc).

---
*Built with ❤️ following proper SDLC principles.*
