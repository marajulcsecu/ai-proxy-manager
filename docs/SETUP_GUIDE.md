# Step-by-Step Provider Setup Guide

This guide will walk you through setting up a new provider (we will use **Tabitoken** as an example) from scratch.

## Step 1: Add the Provider and Base URL
The Base URL is the root URL of the API. Do **not** include the `/chat/completions` or `/messages` part at the end.
```bash
ai-proxy add-provider tabitoken https://tabitoken.com/v1
```

## Step 2: Set your API Key
Add the secret API key provided to you by Tabitoken (or whichever provider you are using).
```bash
ai-proxy set-key tabitoken sk-your-secret-api-key-here...
```

## Step 3: Set the Target Model
Tell the proxy which model you want this provider to default to (e.g., `claude-opus-5-thinking`).
```bash
ai-proxy set-model tabitoken claude-opus-5-thinking
```

## Step 4: Make it the Active Provider
Tell the proxy that you want to route all default traffic to Tabitoken.
```bash
ai-proxy use tabitoken
```
*(You can verify everything was saved correctly by running `ai-proxy list`)*

---

## Step 5: Start the Proxy Server
Open a **new terminal tab** (or split your terminal), and start the proxy. Leave this tab open so it can route traffic in the background.
```bash
ai-proxy start
```

---

## Step 6: Connect Your Tools

### For Claude Code:
1. In your main terminal, run: `ai-proxy setup-terminal`
2. **IMPORTANT**: Close your terminal and open it again (or run `source ~/.bashrc`) to load the new settings.
3. Run `claude`. It will now magically route through Tabitoken!

### For VS Code:
1. Run: `ai-proxy sync-vscode`
2. Open VS Code, open the AI chat, and click the model dropdown menu.
3. Select `ai-proxy:tabitoken` from the list.

---

## 🛑 Troubleshooting API Errors
If you follow these steps and face an API error:

**Look at the proxy logs:** 
Go to the terminal tab where `ai-proxy start` is running. When you make a request, it prints out exactly where it is routing the traffic (e.g., `Routing POST request to [TABITOKEN] -> tabitoken.com`) along with the HTTP response codes (`⬅️ Response Status: 401`). 

If you get an error, check those logs to see if it's an authorization issue, a bad URL, or a network timeout!
