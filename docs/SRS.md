# System Requirements Specification (SRS)

## 1. Introduction
The **AI Proxy Manager** is a Node.js-based CLI tool and Daemon server designed to act as a "Smart Router" between local AI development tools (like Claude Code, VS Code, and Opencode) and third-party AI Model Providers (like GoRouter, Tabitoken, OpenRouter, etc.). 

## 2. Problem Statement
Developers working with multiple local AI tools often hit rate limits on single API keys or need to switch providers depending on the task. Manually editing configuration files (`.bashrc`, `chatLanguageModels.json`) and restarting proxies interrupts the workflow. Furthermore, it is currently difficult to run two separate coding sessions using completely different API keys simultaneously.

## 3. Core Architecture
The system utilizes a **Smart Router pattern**:
1. **The Daemon**: A single Node.js HTTP server runs in the background on a static port (e.g., `8319`).
2. **The Database**: A local JSON config file (`~/.config/ai-proxy-manager/config.json`) securely stores provider profiles (Name, Base URL, API Key, Available Models).
3. **The Routing Logic**: 
   - When a client sends a request to the proxy, they pass a special authentication string, for example: `Bearer gorouter-key` (or just set the key in the CLI tool to the active profile).
   - Alternatively, for tools that don't allow custom headers, the CLI can dynamically inject the active provider's environment variables.
4. **The Interceptor**: The proxy parses the request body (JSON), overrides the target model if necessary, swaps the internal API key with the real provider's key, and forwards it to the provider's upstream base URL.

## 4. Key Requirements
- **Req-1: Multi-Tenant Setup:** A user must be able to define infinite providers.
- **Req-2: Dynamic Model Switching:** A user can configure one or more models per provider.
- **Req-3: Unified CLI Management:** The `ai-proxy` command must expose methods for CRUD (Create, Read, Update, Delete) operations on providers and API keys.
- **Req-4: Tool Integration:** 
   - Expose helper scripts to set temporary shell environment variables for Claude Code.
   - (Optional Future) Provide commands to dynamically rewrite VS Code's `chatLanguageModels.json` for seamless GUI integration.
- **Req-5: Global Accessibility:** The tool must be packaged as an NPM binary (`npm install -g .`) for universal terminal access.
