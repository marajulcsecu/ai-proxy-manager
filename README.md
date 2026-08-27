# AI Proxy Manager

A smart, unified local proxy designed to seamlessly route requests from multiple AI coding tools (Claude Code, VS Code, Opencode) to multiple API providers simultaneously.

## Core Value
Instead of manually restarting local proxy servers to switch API keys or managing dozens of environment variables, `ai-proxy-manager` runs natively as a background daemon. By simply passing a specific provider tag, tools can utilize completely isolated providers and API keys concurrently.

## Documentation Overview
- [System Requirements Specification (SRS)](./docs/SRS.md) - Architectural decisions and feature requirements.
- [Roadmap](./docs/ROADMAP.md) - Step-by-step implementation phases.

## Installation (Planned)
When finished, you can install this tool globally using:
```bash
npm install -g .
```

## Quick Start (Planned)
```bash
ai-proxy add-provider gorouter https://gorouter.app
ai-proxy set-key gorouter sk-yourkey...
ai-proxy start
```
