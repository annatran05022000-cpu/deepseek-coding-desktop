# DeepSeek Coding Desktop

A Windows desktop AI coding assistant built with Electron, React, and TypeScript. It connects to a DeepSeek or other OpenAI-compatible API and gives the model a controlled set of local project tools.

## What it demonstrates

- A multi-step tool-calling agent with validated tool names and arguments.
- File reading, searching, editing, and command execution with previews and user approval controls.
- Electron IPC boundaries, context isolation, local settings, and encrypted API-key storage through Electron `safeStorage`.
- Context usage estimates, chat history compaction, streamed responses, and a verified tool-result journal.
- Optional web, HTTP, recon, and scan-output utilities. Network testing must be limited to systems you own or are explicitly authorized to assess; configure project scope before using those features.

## Stack

Electron · React · TypeScript · Vite · Node.js

## Run locally

Requirements: Node.js 22.12 or newer.

```bash
npm install
npm run dev
```

To build:

```bash
npm run build
```

Open the app's settings and enter your own provider URL, model, and API key. No API key is included in this repository.

## Safety notes

File changes and shell commands show a preview and require approval by default. Auto-approve is optional. Commands and network requests can still change files or affect external systems; review each action and use only authorized targets. Keep API keys private and never commit local settings or credentials.
