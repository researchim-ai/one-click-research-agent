# One-Click Research Agent

`one-click-research-agent` is a local-first research agent built on open-source models and packaged as an Electron app.

The project started from the `one-click-coding-agent` foundation, but is being refocused into a private research workspace that can inspect files, analyze repositories, search papers, run tools, and synthesize findings without sending user data to external AI APIs.

## Core Idea

The goal is not to build "just another chat UI".

The goal is to build a local research runtime that can:

- investigate topics and source material;
- inspect local files and repositories;
- run commands and collect artifacts;
- compare findings across sources;
- support domain presets such as paper analysis or open-source app analysis;
- keep data on the user's machine.

## Product Direction

This app is built around three product principles:

- `Local-first`: files, notes, outputs, and research artifacts stay on the user's machine.
- `Open-source-only`: the agent is intended to run on open-source models via `llama.cpp`, not proprietary hosted APIs.
- `Agentic workflows`: the system can read, run, inspect, and synthesize instead of only generating text.

## Current State

The project already includes:

- Electron desktop shell
- React renderer
- local model/server setup via `llama.cpp`
- agent runtime with tool execution
- file tree, editor, terminal, chat, and session management
- configurable agent settings and prompts
- preset selection for specialized research modes

Current research-oriented presets include:

- `Universal Research`
- `Arxiv Papers`
- `Open Source App Analysis`
- `Biology Research`
- `Math Research`
- `Finance Research`
- `Paper Reproduction`

## What Works Right Now

Already implemented:

- default `Universal Research` mode
- selectable research presets in the settings panel
- research-oriented system prompts instead of coding-only defaults
- web search through `SearXNG` (`search_web`) with `disabled`, `managed local`, and `custom URL` modes
- arXiv search through `search_arxiv`
- Hugging Face Papers search through `search_huggingface_papers`
- academic paper search through `search_openalex`
- arXiv HTML download through `download_arxiv_html`
- arXiv PDF download through `download_arxiv_pdf`
- sidebar refresh after agent file tools, commands, and custom tools

Recommended arXiv flow is now:

1. search papers
2. prefer arXiv HTML when available
3. use PDF as fallback

## Development

Install dependencies:

```bash
npm install
```

Run in development mode:

```bash
npm run dev
```

Build the app:

```bash
npm run build
```

Package for Linux:

```bash
npm run package:linux
```

## First Run

Typical first-run flow:

1. Start the app with `npm run dev`
2. Let the setup wizard prepare the local model/server
3. Open a workspace folder
4. Open `Settings -> Agent`
5. Keep `Universal Research` or switch to a preset like `Arxiv Papers`
6. Start working from the chat panel

## Example Prompts

### Universal Research

- `Study the project and describe its architecture`
- `Create a short research brief about browser agents`
- `Compare several approaches and highlight risks`

### Arxiv Papers

- `Find the best arXiv papers about reinforcement learning`
- `Compare 5 papers about small language models for agents`
- `Download HTML versions of the best papers and extract the main claims`
- `Find a paper, then use web search to locate its GitHub repo and dataset`

## Web Search via SearXNG

The project supports web search through `SearXNG` in two working modes:

- `Managed local SearXNG`: the app auto-starts a local Docker container on first search
- `Existing SearXNG URL`: use an already running compatible instance

How to enable it:

1. Open `Settings -> Agent`
2. Find the `Web search via SearXNG` section
3. Choose one of the modes:
4. `Managed local SearXNG` for an automatic local Docker-backed backend
5. or `Existing SearXNG URL` and enter a base URL such as `http://127.0.0.1:8080`
6. After saving, the agent gets the built-in `search_web` tool when the backend is available

This is useful for:

- finding GitHub / Hugging Face / Papers With Code links
- locating docs and benchmark pages
- finding code / dataset links around a paper
- broad web research outside arXiv

### Open Source App Analysis

- `Run the project and explain how it works`
- `Analyze this app's extension points`
- `Compare the app behavior with its documentation`

## arXiv Notes

The project currently uses arXiv in an `HTML-first, PDF-fallback` way.

Why:

- HTML is easier to parse and analyze than PDF
- HTML is better for section-aware extraction
- not every paper has a usable HTML version
- PDF remains the reliable fallback

Implemented arXiv tools:

- `search_arxiv`
- `download_arxiv_html`
- `download_arxiv_pdf`

Additional research tools:

- `search_huggingface_papers`
- `search_openalex`
- `search_web`

## Architecture Overview

High-level structure:

- `electron/`: main process, agent runtime, tools, model/server integration
- `src/`: React renderer UI
- `research-presets.ts`: preset registry and preset prompt add-ons
- `dist/`: built renderer output
- `dist-electron/`: built Electron output

Conceptually the app is organized as:

- shared runtime
- default universal agent
- optional domain presets
- toolpacks and reproducible workflows

## Privacy

This project is intentionally being shaped around privacy-sensitive use cases.

That means:

- local files are the default source of truth
- research artifacts stay local unless the user exports them
- the app is designed around open-source local model execution
- no ChatGPT-only product dependency is assumed in the core design

## Near-Term Roadmap

Planned near-term improvements:

- richer arXiv workflow with metadata artifacts and saved paper sessions
- HTML-first paper ingestion and structured extraction
- better research artifact storage inside `.research/`
- stronger preset-specific toolpacks
- improved "paper -> code -> reproduction" flow

## Status

This project is under active development and the README will evolve alongside the research runtime.
