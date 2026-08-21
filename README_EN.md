# One-Click Research Agent

Russian version: [`README.md`](README.md)

`one-click-research-agent` is a desktop app (Electron + React) with an autonomous AI agent and a local LLM (via `llama.cpp`) for research work. It is a general-purpose agent: it works with your files, runs commands, searches the web and scholarly indexes, reads documents, and helps you dig into a topic — entirely on your machine, without sending data to external AI APIs.

One of its key functions is a **managed deep-research workflow**: the agent plans, searches for sources, reads full texts, extracts quote-backed evidence, runs quality gates, and assembles a final report end to end.

![One-Click Research Agent — launch screen: set up llama.cpp, the model, and the server in one click](docs/images/starting.png)

## What it is

This is not "just another chat UI" — it is a local agentic runtime. Beyond regular agent work (reading and editing files, running commands, searching), its flagship function is a managed **deep-research** workflow that can:

- run a topic investigation as a managed pipeline, not a single model answer;
- search scholarly indexes (arXiv, OpenAlex, PubMed, and more) and the web;
- read full paper texts (HTML/PDF) and extract evidence with exact quotes;
- verify output quality through a set of quality gates;
- assemble a structured report with an evidence matrix and links;
- keep every artifact local inside a `.research/` folder.

Three product principles:

- **Local-first** — files, sources, evidence, and reports stay on your machine.
- **Open-source-only** — runs on a local `llama.cpp`, no dependency on proprietary APIs.
- **Agentic workflows** — the system reads, runs, verifies, and synthesizes instead of only generating text.

## Screenshots

| New research | Research in progress |
|---|---|
| ![New research dialog: LLM intake, run parameters, and the search-source picker](docs/images/new-research-dialog.png) | ![Live run progress: stages, metrics, quality gates, and reasoning trace](docs/images/deep-research-progress.png) |

| Final report | Research library |
|---|---|
| ![report.md: summary, key findings, evidence matrix](docs/images/report.png) | !["My research": list of past runs with open-report and delete](docs/images/research-library.png) |

## Key features

- **Managed deep-research workflow** (`managed-deep-v1`): a state machine with `INIT → PLANNED → CORPUS_READY → READING → EVIDENCE → GATES → REPORT_READY`.
- **New-research dialog with LLM intake**: describe the task in plain text (topic, date range, language, depth, constraints) and the model fills the run parameters; a manual form is also available.
- **Quality gates**: before the report the run checks plan/source coverage, recency, date-range compliance, topical precision, review coverage, evidence-to-corpus linkage, citation coverage, and more.
- **Evidence-grounded report**: every claim is backed by a read source and a quote; evidence strength is labeled (`strong` / `quote-backed` / `limited`).
- **Source selection & restriction**: allow only the engines you want (e.g. "arXiv only") — the restriction is hard-enforced at the level of tools the agent can even call.
- **Full-text reading**: HTML/PDF parsed to markdown, with fallback to open-access versions (arXiv/OpenAlex OA) for closed DOIs.
- **Language-agnostic**: the agent reads sources in any language and writes the report in the language you choose.
- **Research library**: browse past runs, open reports, delete them from disk.
- **Message queue**: while the agent is working you can keep typing follow-up tasks — they stack up and run one by one.
- **Editable prompts**: all system prompts live in `prompts/*.md` and can be overridden by the user.
- **Local server management**: model setup, one-click `llama.cpp` update, and server restart.

## How the managed research runs

1. **Plan** — the agent states the main question and sub-questions, saves `plan.md`, and (by default) stops for approval.
2. **Search & corpus** — runs several targeted queries over the allowed sources, builds `corpus.jsonl`, and ranks candidates.
3. **Screening** — semantic (LLM) + deterministic selection by relevance, dates, and source type; strict date windows are enforced at day precision.
4. **Reading** — downloads full texts of selected papers (into `fulltext/`).
5. **Evidence** — extracts quote-backed claims into `evidence.jsonl` and links them to plan items.
6. **Quality gates** — runs the checks and repairs targeted gaps (gather more sources, read more, extract more evidence). A loop guard downgrades genuinely unreachable coverage gates to warnings so a run always terminates.
7. **Report** — generates `report.md`: executive summary, key findings, a coverage/evidence-strength matrix, and the evidence base with links.

## Search sources

Scholarly indexes and the web:

- `search_arxiv`, `search_openalex`, `search_semantic_scholar`, `search_crossref`, `search_pubmed`, `search_biorxiv`, `search_huggingface_papers`, `search_web` (via SearXNG).

In the new-research dialog you can choose which sources to use. If you leave out some, the agent physically cannot reach the others (hard restriction) and will broaden queries / shift the date window within the allowed sources instead.

## Privacy

- local files are the default source of truth;
- research artifacts stay local until you export them;
- inference runs on a local open-source model via `llama.cpp`;
- no cloud AI API dependency in the core design.

## Install & run

Prebuilt Linux binaries (AppImage / .deb) are on the [Releases](../../releases) page.

From source:

```bash
npm install      # install dependencies
npm run dev      # run in development mode
npm run build    # build renderer + electron
npm run package:linux  # package for Linux (AppImage + deb)
```

## First run

1. Start the app (`npm run dev` or a prebuilt binary).
2. Let the setup wizard prepare the local model and `llama.cpp` server.
3. Open a workspace folder.
4. Click "New research" and describe the task in plain text — the model fills the parameters.
5. Review the summary (topic, date range, language, sources), optionally restrict the sources, and click "Start research".
6. Approve the plan — the agent then runs autonomously through to `report.md`.

## Settings

The settings panel includes:

- model and GPU mode selection, `llama.cpp` update and server restart;
- **AI source-screening budget** — how long to give the LLM for semantic screening;
- web search via `SearXNG`: `disabled` / `managed local` (Docker) / `custom URL`;
- research presets and profiles (`Universal`, `ML/AI`, `Biology`, `Math`, `Finance`, `Paper Reproduction`, etc.);
- editing of system prompts.

## `.research/` artifacts

Each run is its own folder under `.research/<timestamp>_<slug>/`:

- `plan.md` — the research plan;
- `corpus.jsonl` — discovered sources and their screening;
- `fulltext/` — saved full texts;
- `evidence.jsonl`, `claims.jsonl` — evidence and claims;
- `quality-gates.json` — gate results;
- `report.md` — the final report;
- `run.json` — managed-run state;
- `reasoning-trace.jsonl` — the agent's reasoning/action trace.

## Project map

Detailed architecture map (mermaid diagrams, modules, tools, IPC, `.research/` artifacts, extension points):

→ [`docs/PROJECT_MAP.md`](docs/PROJECT_MAP.md)

High-level structure:

- `electron/` — main process, agent runtime, tools, model/server integration;
- `src/` — React renderer UI;
- `prompts/` — editable prompts;
- `research-presets.ts`, `research-profiles.ts`, `search-sources.ts` — registries of presets, profiles, and search sources.

## Status

The project is under active development. The README evolves alongside the research runtime.
