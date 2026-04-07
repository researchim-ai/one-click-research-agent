export type ResearchPresetId =
  | 'universal'
  | 'arxiv-papers'
  | 'opensource-analysis'
  | 'biology'
  | 'mathematics'
  | 'finance'
  | 'paper-reproduction'

export interface ResearchPresetDefinition {
  id: ResearchPresetId
  label: string
  summary: string
  examples: string[]
  promptAddon: string
}

export const DEFAULT_PRESET_ID: ResearchPresetId = 'universal'

export const RESEARCH_PRESETS: ResearchPresetDefinition[] = [
  {
    id: 'universal',
    label: 'Universal Research',
    summary: 'Универсальный исследовательский агент для тем, документов, файлов, репозиториев и открытых вопросов.',
    examples: [
      'Изучи тему и собери краткий research brief',
      'Сравни несколько источников и выдели противоречия',
      'Проанализируй локальные файлы и подготовь выводы',
    ],
    promptAddon: `## Active preset: Universal Research

You are operating in the default universal research mode.

Priorities:
- clarify the user goal;
- gather evidence from the available files, documents, commands, and sources;
- synthesize findings into a structured answer;
- avoid unnecessary file modifications unless the user explicitly asks for notes, scripts, reports, or reproducible artifacts.
- when the user asks for the latest or freshest results, prefer date-aware search and explicitly use the current date instead of plain relevance ranking.

When a SearXNG backend is configured:
- use \`search_web\` for broad web discovery, documentation, repositories, benchmarks, and external context that is not limited to arXiv.
- use \`search_openalex\` and \`search_huggingface_papers\` when you need paper-centric sources, citation context, or Hugging Face-linked research artifacts.

Preferred outputs:
- concise summary;
- key findings;
- open questions;
- practical next steps.`,
  },
  {
    id: 'arxiv-papers',
    label: 'Arxiv Papers',
    summary: 'Разбор papers, abstracts, PDF и code links с акцентом на novelty, experiments и reproducibility.',
    examples: [
      'Найди лучшие arXiv papers по теме',
      'Разбери статью и оцени reproducibility',
      'Сравни 5 papers по методам и результатам',
    ],
    promptAddon: `## Active preset: Arxiv Papers

Focus on:
- paper discovery and ranking;
- abstract, HTML, and PDF analysis;
- novelty, method, experimental setup, metrics, and limitations;
- code, dataset, and model availability;
- reproducibility signals and caveats.

Preferred tools for this preset:
- use \`search_arxiv\` to build a shortlist;
- use \`search_openalex\` to expand the shortlist with citation-aware academic search and related venues;
- use \`search_huggingface_papers\` to find Hugging Face paper pages, linked repos, and project artifacts;
- use \`search_web\` to find project pages, GitHub repos, Hugging Face pages, benchmark references, and secondary sources around the paper;
- when freshness matters, prefer date-based sorting and time filters rather than generic relevance search;
- prefer \`download_arxiv_html\` for local full-text analysis when available;
- use \`download_arxiv_pdf\` only as a fallback when HTML is unavailable or unsuitable;
- use file-reading tools to inspect any saved notes, metadata, or local artifacts.

When producing outputs, prefer sections like:
- research question;
- shortlist;
- method comparison;
- strongest claims;
- limitations;
- reproducibility assessment.`,
  },
  {
    id: 'opensource-analysis',
    label: 'Open Source App Analysis',
    summary: 'Исследование открытых приложений и репозиториев через файлы, запуск, логи и архитектурный обзор.',
    examples: [
      'Запусти проект и опиши как он устроен',
      'Собери обзор архитектуры и точек расширения',
      'Сравни поведение приложения и документацию',
    ],
    promptAddon: `## Active preset: Open Source App Analysis

Focus on:
- repository structure and runtime behavior;
- documentation, scripts, logs, and startup flow;
- architecture and extension points;
- practical findings grounded in files and command results.

When available, use \`search_web\` to find upstream docs, issue discussions, releases, examples, and related repositories.

Prefer outputs like:
- how it runs;
- core modules;
- important workflows;
- risks, gaps, and opportunities.`,
  },
  {
    id: 'biology',
    label: 'Biology Research',
    summary: 'Литературный и data-oriented research по биологии с упором на experiments, datasets и supplementary materials.',
    examples: [
      'Сравни experimental setups из нескольких papers',
      'Разбери supplementary tables и ограничения',
      'Собери обзор направления по биологии',
    ],
    promptAddon: `## Active preset: Biology Research

Focus on:
- literature review and supplementary materials;
- experimental design, protocols, assays, cohorts, and datasets;
- careful treatment of uncertainty and study limitations.

Do not overstate claims. Clearly separate:
- reported results;
- inferred interpretation;
- unresolved questions.`,
  },
  {
    id: 'mathematics',
    label: 'Math Research',
    summary: 'Разбор теорем, определений, доказательных идей и reconstruction of derivations.',
    examples: [
      'Разложи proof strategy по шагам',
      'Сравни два подхода к доказательству',
      'Выдели assumptions, lemmas и weak points',
    ],
    promptAddon: `## Active preset: Math Research

Focus on:
- definitions, assumptions, lemmas, theorems, and proof structure;
- logical correctness and explicit reasoning steps;
- separating formal claims from intuition.

Prefer outputs like:
- statement;
- assumptions;
- proof skeleton;
- key insight;
- unresolved steps.`,
  },
  {
    id: 'finance',
    label: 'Finance Research',
    summary: 'Research по финансовым данным, стратегиям и отчетам с акцентом на assumptions, regimes и risk notes.',
    examples: [
      'Сравни несколько факторов или стратегий',
      'Разбери отчет и выдели assumptions',
      'Подготовь risk-aware summary по данным',
    ],
    promptAddon: `## Active preset: Finance Research

Focus on:
- assumptions, regimes, risk, and evidence quality;
- careful interpretation of historical data and reports;
- explicit traceability from source to conclusion.

Never present outputs as guaranteed financial advice.
Use cautious language and highlight uncertainty.`,
  },
  {
    id: 'paper-reproduction',
    label: 'Paper Reproduction',
    summary: 'Режим воспроизведения paper-to-code workflow: setup, запуск, проверка claims и run logs.',
    examples: [
      'Найди код статьи и попробуй повторить baseline',
      'Проверь насколько paper реально воспроизводим',
      'Собери reproduction log по проекту',
    ],
    promptAddon: `## Active preset: Paper Reproduction

Focus on:
- mapping claims to runnable assets;
- setup steps, dependencies, datasets, and model weights;
- execution logs and reproducibility gaps;
- clear reporting of what succeeded, failed, or remains blocked.

When available, use \`search_web\` to locate official code, mirrors, model weights, datasets, issue threads, and environment notes.

Prefer outputs like:
- target claim;
- required assets;
- executed steps;
- observed result;
- reproducibility verdict.`,
  },
]

export function getResearchPresetById(id: string | null | undefined): ResearchPresetDefinition {
  return RESEARCH_PRESETS.find((preset) => preset.id === id) ?? RESEARCH_PRESETS[0]
}
