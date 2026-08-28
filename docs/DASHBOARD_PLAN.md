# Web Dashboard MVP — Implementation Plan

## Scope
Build a browser-based management dashboard served directly from the existing proxy server (`http://127.0.0.1:8319`).

**MVP Target:** Claude Code CLI only. Once stable, we expand to VS Code, Opencode, and others.

---

## Architecture Overview

```
Browser (http://127.0.0.1:8319)
        │
        ▼
┌─────────────────────────────────┐
│     Node.js Proxy Server        │
│                                 │
│  /              → Web Dashboard │
│  /api/*         → REST API      │
│  /v1/messages   → Proxy Engine  │
│  /v1/chat/*     → Proxy Engine  │
└─────────────────────────────────┘
        │
        ▼
  ~/.config/ai-proxy-manager/config.json
```

The same server handles everything — dashboard pages, internal API calls, and proxy traffic.

---

## What Will Be Built

### 1. Internal REST API (`src/core/apiRoutes.js`)
A set of JSON endpoints that both the CLI and the web dashboard share:

| Method | Endpoint | Description |
|:---|:---|:---|
| `GET` | `/api/providers` | List all providers with status |
| `POST` | `/api/providers` | Add a new provider |
| `PUT` | `/api/providers/:name` | Update provider (URL, key, model) |
| `DELETE` | `/api/providers/:name` | Remove a provider |
| `POST` | `/api/providers/:name/activate` | Set as active provider |
| `GET` | `/api/status` | Proxy status, active provider, uptime |
| `GET` | `/api/logs` | Recent request log (last 50 entries) |

### 2. Web Dashboard UI (`src/dashboard/`)
A single-page application using plain HTML, CSS, and vanilla JavaScript (no React, no build tools, no npm dependencies). Fast, lightweight, and zero-config.

**Pages / Sections:**

#### a) Dashboard Home (`/`)
- Current active provider (highlighted card).
- Proxy status indicator (🟢 Running).
- Quick stats: total providers, total requests routed.

#### b) Provider Manager
- Card grid showing all providers.
- Each card shows: Name, Base URL, Model, Key status (✅ Set / ❌ Missing), Active badge.
- **"Add Provider"** button → opens a form modal:
  - Provider Name (text input)
  - Base URL (text input)
  - API Key (password input)
  - Default Model (text input, optional — leave empty for pass-through mode)
- **"Edit"** button on each card → same form, pre-filled.
- **"Delete"** button on each card → confirmation dialog.
- **"Use This"** button → instantly switches the active provider.

#### c) Live Request Log
- Real-time scrolling list of proxied requests.
- Each entry shows: Timestamp, Method, Target Provider, Model Swap info, Response Status (color-coded: 🟢 200, 🔴 401/500).
- Auto-scrolls to latest. Max 50 entries in memory.

#### d) Claude Code Setup Helper
- Shows current terminal configuration status.
- One-click "Setup Terminal" button (calls `POST /api/setup-terminal`).
- Displays the exact commands the user needs to run (`source ~/.bashrc`).

### 3. Model Pass-Through Feature
As discussed, we fix the model limitation:
- If a provider has `defaultModel` set → proxy rewrites the model (current behavior).
- If `defaultModel` is empty/null → proxy passes the model through untouched (new behavior).
- The dashboard form will have a placeholder hint: *"Leave empty to use whatever model your tool sends"*.

### 4. Request Logger Module (`src/core/requestLogger.js`)
- In-memory circular buffer (last 50 requests).
- Each log entry: `{ timestamp, method, provider, originalModel, swappedModel, statusCode }`.
- Exposed via `GET /api/logs` for the dashboard to poll.

---

## File Structure After Implementation

```
ai-proxy-manager/
├── docs/
│   ├── SRS.md
│   ├── ROADMAP.md
│   ├── SETUP_GUIDE.md
│   └── DASHBOARD_PLAN.md    ← This file
├── src/
│   ├── cli.js                ← Existing CLI (unchanged)
│   ├── index.js              ← Module exports
│   ├── core/
│   │   ├── configManager.js  ← Existing (unchanged)
│   │   ├── proxyServer.js    ← Modified (add routing for / and /api/*)
│   │   ├── apiRoutes.js      ← NEW: REST API handler
│   │   └── requestLogger.js  ← NEW: In-memory request log
│   ├── controllers/
│   │   ├── providerController.js   ← Existing (unchanged)
│   │   └── integrationController.js ← Existing (unchanged)
│   ├── dashboard/
│   │   ├── index.html        ← NEW: Main dashboard page
│   │   ├── style.css         ← NEW: Dashboard styles
│   │   └── app.js            ← NEW: Dashboard client-side logic
│   └── utils/
│       └── logger.js         ← Existing (unchanged)
├── package.json
└── README.md
```

---

## Implementation Order

### Step 1: Request Logger Module
Create `requestLogger.js` — a simple in-memory circular buffer. This is a dependency for both the proxy and the dashboard.

### Step 2: REST API Routes
Create `apiRoutes.js` — all `/api/*` endpoints. This bridges the config database to the web UI.

### Step 3: Model Pass-Through
Modify `proxyServer.js` to skip model rewriting when `defaultModel` is empty. Also integrate the request logger.

### Step 4: Update Proxy Server Routing
Modify `proxyServer.js` to serve the dashboard on `/` and route `/api/*` to the API handler. Proxy routes (`/v1/*`) remain untouched.

### Step 5: Build the Dashboard UI
Create `index.html`, `style.css`, and `app.js`. Wire everything up to the REST API.

### Step 6: Test End-to-End with Claude Code
- Add a provider via the dashboard.
- Switch active provider via the dashboard.
- Verify Claude Code routes correctly.
- Verify live logs appear in the dashboard.

### Step 7: Git Commit & Push

---

## What Will NOT Be Built in MVP
- VS Code sync from dashboard (CLI only for now).
- Opencode integration.
- User authentication for the dashboard (localhost only, no auth needed).
- Persistent log storage (logs are in-memory only, cleared on restart).
- WebSocket for real-time logs (we use simple polling in MVP; can upgrade later).

---

## Tech Stack
- **Backend:** Pure Node.js (`http` module, zero dependencies).
- **Frontend:** Vanilla HTML + CSS + JavaScript (zero build tools, zero frameworks).
- **Storage:** JSON file (`config.json`).
- **No `npm install` required.** The entire project remains dependency-free.
