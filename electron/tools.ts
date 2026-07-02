import { execFileSync, execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AppConfig, CustomTool } from './config'
import { getWebSearchStatus, loadWebSearchConfig, resolveWebSearchBaseUrl, shouldEnableWebSearchTool } from './searxng'
import { saveFinding, recallFindings } from './memory'
import { getSourceTracker, extractSourcesFromToolResult } from './sources'
import * as searchCache from './search-cache'
import { HostBreaker, AdaptiveThrottle } from './host-resilience'
import * as cfg from './config'
import { parseDocument, summarizeParsedForPrompt, isDocumentExtension } from './document-parser'
import { checkUrlHealth, formatHealthBadge } from './url-health'
import { fetchUrl as fetchUrlImpl, classifyUrl as classifyUrlImpl, extractArxivId } from './url-fetch'
import { classifyQuery } from './query-router'
import { writePlan, parsePlan, updatePlanItem, planProgress, planQuestion } from './planner'
import { runSubResearcher, canSpawnMore } from './sub-researcher'
import { searchHybrid, indexStats, rebuildIndex, indexText as indexTextHybrid } from './knowledge-index'
import { exportPdf, exportDocx, exportBibTex } from './export-report'
import { screenshotPage } from './screenshot'
import {
  addSourcesToCorpus, assignCorpusToPlan, fullTextStatus, listCorpus, listSelectedCorpus, loadCorpus, markCorpusItemRead,
  queueFullText, rankCorpus, rejectCorpusItems, screenCorpus, selectFullTextBatch, corpusStats, saveCorpus,
  type CorpusEntry,
} from './corpus'
import { evidenceCoverageByPlan, evidenceMatrix, evidenceStats, listEvidence, loadEvidence, recordEvidence, repairEvidenceQuotes, verifyClaims } from './evidence'
import { formatGateReport, formatGateResults, latestQualityGateFailure, readQualityGateSnapshot, runQualityGates, writeQualityGateSnapshot } from './quality-gates'
import { applyGateEscapeValve, ensureResearchRunSpec } from './research-workflow'
import { auditResearchRun, formatAuditResult } from './research-audit'
import { listResearchSkills, loadResearchSkill, recommendSkills } from './research-skills'
import { prioritizeIdeas, saveIdea, scoutIdeas } from './idea-scout'
import { RESEARCH_PROFILES, getResearchProfileByPresetId } from '../research-profiles'
import { canonicalResearchOutputDir } from '../research-paths'

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the full contents of a file. Always read before editing. Returns line-numbered content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative or absolute file path.' },
          offset: { type: 'number', description: 'Start reading from this line (1-based). Omit to read from beginning.' },
          limit: { type: 'number', description: 'Maximum number of lines to return. Omit to read entire file.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_arxiv',
      description:
        'Search arXiv papers by topic and return structured metadata including title, authors, summary, published date, abstract URL, HTML URL, and PDF URL.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query for arXiv, such as "browser agents" or "protein folding".' },
          max_results: { type: 'number', description: 'Maximum number of papers to return (default: 5, max: 10).' },
          from_date: { type: 'string', description: 'Optional lower bound for submission date, for example "2024-01-01" or "20240101".' },
          to_date: { type: 'string', description: 'Optional upper bound for submission date, for example "2024-12-31" or "20241231".' },
          sort_by: { type: 'string', description: 'Optional sort field: "relevance", "submittedDate", or "lastUpdatedDate".' },
          sort_order: { type: 'string', description: 'Optional sort order: "descending" or "ascending".' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_huggingface_papers',
      description:
        'Search Hugging Face Papers and return paper cards with title, paper URL, arXiv URL, summary, organization, project page, GitHub repo, and popularity signals when available.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query for Hugging Face Papers, such as "agent memory" or "protein language model".' },
          max_results: { type: 'number', description: 'Maximum number of papers to return (default: 5, max: 10).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_openalex',
      description:
        'Search OpenAlex works and return structured academic results with title, authors, year, venue, citation count, abstract, DOI, and open-access links when available.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Academic search query, such as "in-context reinforcement learning agents" or "diffusion protein design".' },
          max_results: { type: 'number', description: 'Maximum number of papers to return (default: 5, max: 10).' },
          year_from: { type: 'number', description: 'Optional lower bound for publication year.' },
          year_to: { type: 'number', description: 'Optional upper bound for publication year.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'download_arxiv_html',
      description:
        'Download an arXiv paper HTML page into the workspace for local analysis. Prefer this when available; use PDF as fallback.',
      parameters: {
        type: 'object',
        properties: {
          arxiv_id: { type: 'string', description: 'arXiv identifier, for example "2401.01234" or "cs/9308101v1".' },
          output_path: { type: 'string', description: 'Optional relative or absolute output path inside the workspace.' },
        },
        required: ['arxiv_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'download_arxiv_pdf',
      description:
        'Download an arXiv paper PDF into the workspace for local analysis. Use this as a fallback when HTML is unavailable or unsuitable.',
      parameters: {
        type: 'object',
        properties: {
          arxiv_id: { type: 'string', description: 'arXiv identifier, for example "2401.01234" or "cs/9308101v1".' },
          output_path: { type: 'string', description: 'Optional relative or absolute output path inside the workspace.' },
        },
        required: ['arxiv_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        'Search the web through a configured SearXNG instance and return structured results with titles, URLs, snippets, engines, and optional dates.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Web search query, such as "Qwen3.5-35B-A3B github repo" or "browser agents benchmark".' },
          max_results: { type: 'number', description: 'Maximum number of results to return (default: 5, max: 10).' },
          categories: { type: 'string', description: 'Optional SearXNG categories, for example "general", "science", "it", or comma-separated values.' },
          language: { type: 'string', description: 'Optional search language, for example "en" or "ru".' },
          time_range: { type: 'string', description: 'Optional time range such as "day", "month", or "year".' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reflect',
      description: 'Critically self-evaluate your current findings and reasoning. Call this after synthesizing search results to check for gaps, contradictions, unsupported claims, and missing perspectives before presenting conclusions to the user.',
      parameters: {
        type: 'object',
        properties: {
          findings: { type: 'string', description: 'Your current findings or conclusions to evaluate.' },
          criteria: {
            type: 'string',
            description: 'Comma-separated evaluation criteria. Options: completeness, accuracy, contradictions, gaps, bias, recency. Default: all.',
          },
        },
        required: ['findings'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_finding',
      description: 'Save a key research finding to persistent memory. Findings persist across sessions and can be recalled later. Use this to preserve important conclusions, discovered facts, or insights.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Short topic title for this finding, e.g. "SOTA protein language models 2025".' },
          content: { type: 'string', description: 'The finding content — key facts, conclusions, or insights to remember.' },
          tags: { type: 'string', description: 'Optional comma-separated tags for categorization, e.g. "ml,proteins,survey".' },
        },
        required: ['topic', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_findings',
      description: 'Search persistent memory for previously saved research findings. Returns matching findings from prior sessions ranked by relevance.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query to find relevant past findings.' },
          max_results: { type: 'number', description: 'Maximum results to return (default: 10, max: 20).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_report',
      description: 'Generate a general Markdown report outside the managed research pipeline. Do NOT use for managed research .research/YYYY.../report.md; use generate_evidence_report instead.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Report title.' },
          content: { type: 'string', description: 'Full report body in Markdown. Use [1], [2] etc. to cite collected sources — they will be resolved automatically in the References section.' },
          output_path: { type: 'string', description: 'Output file path relative to workspace (default: .research/report.md).' },
          session_id: { type: 'string', description: 'Internal: session ID for source tracker. Passed automatically.' },
        },
        required: ['title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or completely overwrite an existing one. For partial edits, use edit_file instead. Do NOT use this to create or overwrite managed research report.md; use generate_evidence_report.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          content: { type: 'string', description: 'Full file content.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Make a targeted edit to a file by replacing an exact string match. ' +
        'You MUST read the file first to know the exact content. ' +
        'Provide old_string (the exact text to find) and new_string (the replacement). ' +
        'old_string must match EXACTLY including whitespace and indentation. ' +
        'For multiple edits in one file, call this tool multiple times.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          old_string: { type: 'string', description: 'The exact string to find and replace. Must be unique in the file.' },
          new_string: { type: 'string', description: 'The replacement string. Use empty string to delete.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description:
        'List files and directories in a tree-like format. ' +
        'Shows directory structure up to specified depth. Ignores node_modules, .git, __pycache__, dist, build by default.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path. Defaults to workspace root.' },
          depth: { type: 'number', description: 'Max recursion depth (default: 3).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find files by name pattern (glob) or content (regex). Returns matching file paths.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern for filenames (e.g. "*.tsx", "src/**/*.py") or text to search inside files.' },
          type: {
            type: 'string',
            enum: ['name', 'content'],
            description: '"name" to match file names, "content" to search inside files (using ripgrep).',
          },
          path: { type: 'string', description: 'Directory to search in. Defaults to workspace root.' },
        },
        required: ['pattern', 'type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description:
        'Run a shell command and return stdout + stderr. ' +
        'Use for: running tests, installing dependencies, git operations, build commands, etc. ' +
        'Commands run in the workspace directory by default. Timeout: 120 seconds. ' +
        'IMPORTANT: Use OS-appropriate commands (see system prompt for current OS).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          working_directory: { type: 'string', description: 'Working directory (relative to workspace). Defaults to workspace root.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_directory',
      description: 'Create a directory (and any parent directories).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to create.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description:
        'Append content to the end of an existing file. Use this to build large files incrementally: ' +
        'first create the file skeleton with write_file, then append sections with this tool. ' +
        'If the file does not exist, it will be created.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          content: { type: 'string', description: 'Content to append.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a single file. Cannot delete directories — use execute_command to remove directories.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to delete.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'parse_document',
      description:
        'Parse a PDF or DOCX file into plain text and metadata. Use for any binary research document (downloaded arXiv PDFs, attached DOCX reports, etc.). For plain text or markdown use read_file instead.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative or absolute path to the document inside the workspace.' },
          max_pages: { type: 'number', description: 'Optional: only extract the first N pages of a PDF.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_sources',
      description:
        'Verify that URLs collected in the current research session are still live. Returns a status (live / archived / dead / hallucinated) for each source and attaches the Wayback Machine snapshot when the original page is unreachable. Use this before producing a final report.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Internal: session id. Passed automatically.' },
          max_sources: { type: 'number', description: 'Optional: only verify the first N sources (default: all).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_crossref',
      description:
        'Search the Crossref bibliographic database by keyword, returning scholarly works with DOI, authors, venue and publication date. Complements arXiv/OpenAlex for published articles and citation-grade metadata.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          max_results: { type: 'number', description: 'Maximum number of works to return (default: 5, max: 10).' },
          year_from: { type: 'number', description: 'Optional lower bound for publication year.' },
          year_to: { type: 'number', description: 'Optional upper bound for publication year.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_semantic_scholar',
      description:
        'Search the Semantic Scholar academic graph for papers. Returns titles, authors, venue, year, citation count, and abstract. Good for citation-centric discovery beyond arXiv.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          max_results: { type: 'number', description: 'Maximum number of papers to return (default: 5, max: 10).' },
          year_from: { type: 'number', description: 'Optional lower bound for publication year.' },
          year_to: { type: 'number', description: 'Optional upper bound for publication year.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_pubmed',
      description:
        'Search Europe PMC / PubMed for biomedical literature. Returns title, authors, journal, and abstract with open-access PDF links when available.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Biomedical query, for example "CRISPR off-target review".' },
          max_results: { type: 'number', description: 'Maximum number of papers to return (default: 5, max: 10).' },
          year_from: { type: 'number', description: 'Optional lower bound for publication year.' },
          year_to: { type: 'number', description: 'Optional upper bound for publication year.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'smart_search',
      description:
        'Route a query to the most relevant sources automatically (academic / web / biomed / code). Fans out to 2–3 search engines in parallel, deduplicates by URL, and returns a merged result set. Prefer this when you are unsure which specific search tool to call.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          max_per_source: { type: 'number', description: 'Maximum results per source (default: 4, max: 6).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'build_corpus',
      description: 'Build or update .research/corpus.jsonl from the current session sources. Deduplicates by DOI/arXiv/PMID/URL/title and ranks entries for full-text reading.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Internal: session id. Passed automatically.' },
          output_dir: { type: 'string', description: 'Optional research artifact directory, for example ".research/2026-05-25_20-38_topic".' },
          tags: { type: 'string', description: 'Optional comma-separated tags for the corpus entries.' },
          queue_full_text: { type: 'boolean', description: 'If true, mark added corpus items as queued for full-text reading.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_corpus',
      description: 'List the ranked research corpus from .research/corpus.jsonl, including IDs, scores, identifiers, URLs, and full-text status.',
      parameters: { type: 'object', properties: { max_items: { type: 'number', description: 'Maximum items to show (default: 20).' }, output_dir: { type: 'string', description: 'Optional research artifact directory.' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'queue_full_text',
      description: 'Mark corpus items as queued for full-text reading. Omit ids to queue all candidate items.',
      parameters: { type: 'object', properties: { ids: { type: 'string', description: 'Optional comma-separated corpus IDs.' }, output_dir: { type: 'string', description: 'Optional research artifact directory.' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'audit_research_run',
      description: 'Audit a research run for corpus screening, full-text coverage, evidence linkage, report claims, and blockers. Writes audit.md and audit.json.',
      parameters: { type: 'object', properties: { output_dir: { type: 'string', description: 'Optional research artifact directory.' }, year_from: { type: 'number' }, year_to: { type: 'number' }, min_selected: { type: 'number' }, min_read: { type: 'number' }, min_evidence: { type: 'number' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screen_corpus',
      description: 'Screen raw corpus into selected / rejected / needs_review using relevance, date compliance, authority, and plan sub-question coverage. max_selected caps how many are selected; min_selected sets a floor — pass the run\'s minimum-selected target so the best on-topic items are promoted to reach it (off-topic items are never promoted).',
      parameters: { type: 'object', properties: { question: { type: 'string' }, sub_questions: { type: 'array', items: { type: 'string' } }, year_from: { type: 'number' }, year_to: { type: 'number' }, max_selected: { type: 'number' }, min_selected: { type: 'number' }, strict_date_range: { type: 'boolean' }, research_kind: { type: 'string', enum: ['academic', 'general'], description: "Relevance strategy. 'academic' (default) keeps the ML/RL-aware precision; 'general' judges relevance generically from query-term coverage for non-academic web research. Pass the value given in the run parameters." }, output_dir: { type: 'string' } }, required: ['question'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_selected_corpus',
      description: 'List selected/high-priority corpus items that should drive full-text reading and evidence extraction.',
      parameters: { type: 'object', properties: { max_items: { type: 'number' }, output_dir: { type: 'string' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reject_corpus_items',
      description: 'Reject irrelevant/noisy corpus items by stable corpus ID with a reason.',
      parameters: { type: 'object', properties: { ids: { type: 'string' }, reason: { type: 'string' }, output_dir: { type: 'string' } }, required: ['ids'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'assign_corpus_to_plan',
      description: 'Assign selected corpus IDs to a plan item such as Q1/Q2 for section-level coverage gates.',
      parameters: { type: 'object', properties: { ids: { type: 'string' }, plan_item_id: { type: 'string' }, output_dir: { type: 'string' } }, required: ['ids', 'plan_item_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_full_text_batch',
      description: 'Select top selected corpus items that still need full-text reading, prioritized by readPriority and score.',
      parameters: { type: 'object', properties: { limit: { type: 'number' }, output_dir: { type: 'string' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_corpus_item',
      description: 'Read/download one corpus item by stable corpus ID and update localPath/readStatus/readAt.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, output_dir: { type: 'string' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_full_text_batch',
      description: 'Batch wrapper that reads/downloads selected corpus items up to the requested limit and updates readStatus/localPath.',
      parameters: { type: 'object', properties: { limit: { type: 'number' }, output_dir: { type: 'string' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'full_text_status',
      description: 'Show selected/read/failed full-text coverage, including high-priority unread sources.',
      parameters: { type: 'object', properties: { output_dir: { type: 'string' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_references',
      description: 'Use OpenAlex to retrieve references cited by a paper/work. Input can be a DOI, OpenAlex URL/ID, arXiv URL/ID, or paper title.',
      parameters: { type: 'object', properties: { work: { type: 'string', description: 'DOI, OpenAlex ID/URL, arXiv ID/URL, or title.' }, max_results: { type: 'number', description: 'Max references (default 10).' } }, required: ['work'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_citations',
      description: 'Use OpenAlex to retrieve works citing a paper/work. Input can be a DOI, OpenAlex URL/ID, arXiv URL/ID, or paper title.',
      parameters: { type: 'object', properties: { work: { type: 'string', description: 'DOI, OpenAlex ID/URL, arXiv ID/URL, or title.' }, max_results: { type: 'number', description: 'Max citing works (default 10).' } }, required: ['work'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_evidence',
      description: 'Persist a claim-evidence row to .research/evidence.jsonl. Use this for every important research claim before final synthesis.',
      parameters: {
        type: 'object',
        properties: {
          claim: { type: 'string', description: 'Atomic claim or finding.' },
          sources: { type: 'string', description: 'Citation/source ids, e.g. "1,2".' },
          corpus_ids: { type: 'string', description: 'Stable corpus IDs supporting the claim, comma-separated.' },
          source_urls: { type: 'string', description: 'Source URLs supporting the claim, comma-separated.' },
          local_path: { type: 'string', description: 'Local full-text file path used for the quote/passage.' },
          passage_id: { type: 'string', description: 'Optional passage/chunk id.' },
          plan_item_id: { type: 'string', description: 'Plan section id such as Q1/Q2.' },
          evidence_type: { type: 'string', enum: ['primary_result', 'survey_statement', 'benchmark', 'safety_claim', 'background'], description: 'Type of evidence.' },
          quote: { type: 'string', description: 'Optional exact supporting quote or passage.' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low', 'speculative'], description: 'Confidence level.' },
          support: { type: 'string', enum: ['supports', 'contradicts', 'background', 'weak'], description: 'Relationship between source(s) and claim.' },
          topic: { type: 'string', description: 'Optional topic/plan item.' },
          notes: { type: 'string', description: 'Optional caveats.' },
          session_id: { type: 'string', description: 'Internal: session id. Passed automatically.' },
          output_dir: { type: 'string', description: 'Optional research artifact directory for evidence.jsonl.' },
        },
        required: ['claim'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_evidence',
      description: 'List recorded claim-evidence rows from .research/evidence.jsonl.',
      parameters: { type: 'object', properties: { status: { type: 'string', description: 'Optional status filter: supported, contested, unsupported, needs_review.' }, max_items: { type: 'number', description: 'Maximum rows (default 30).' }, output_dir: { type: 'string', description: 'Optional research artifact directory.' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'evidence_matrix',
      description: 'Render the current claim-evidence graph as a Markdown evidence matrix.',
      parameters: { type: 'object', properties: { output_dir: { type: 'string', description: 'Optional research artifact directory.' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_evidence_from_corpus_item',
      description: 'Create corpus-linked evidence rows from a read corpus item using a provided claim/quote. Use after reading full text.',
      parameters: { type: 'object', properties: { corpus_id: { type: 'string' }, claim: { type: 'string' }, quote: { type: 'string' }, plan_item_id: { type: 'string' }, evidence_type: { type: 'string', enum: ['primary_result', 'survey_statement', 'benchmark', 'safety_claim', 'background'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low', 'speculative'] }, output_dir: { type: 'string' }, session_id: { type: 'string' } }, required: ['corpus_id', 'claim'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_evidence_batch',
      description: 'Return a checklist of read selected corpus items that need evidence extraction. Use it to record evidence rows section by section.',
      parameters: { type: 'object', properties: { output_dir: { type: 'string' }, max_items: { type: 'number' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'evidence_coverage_by_plan',
      description: 'Summarize evidence coverage by plan item, including corpus-linked and quoted claim counts.',
      parameters: { type: 'object', properties: { output_dir: { type: 'string' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repair_evidence_quotes',
      description: 'Batch repair for report_citation_coverage blockers. Fills missing evidence quotes/caveats from linked read corpus full-text or metadata/snippets. Use this instead of many repeated record_evidence calls when many claims lack quotes.',
      parameters: { type: 'object', properties: { output_dir: { type: 'string' }, max_items: { type: 'number', description: 'Maximum missing-quote claims to repair in this batch (default 40).' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_claims',
      description: 'Check recorded evidence claims for missing citations, weak support, unsupported/contested status, and unresolved source ids.',
      parameters: { type: 'object', properties: { session_id: { type: 'string', description: 'Internal: session id. Passed automatically.' }, output_dir: { type: 'string', description: 'Optional research artifact directory.' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_quality_gates',
      description: 'Run quality gates before final synthesis/report: source coverage, evidence coverage, claim support, plan progress, and recency.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Internal: session id. Passed automatically.' },
          min_sources: { type: 'number', description: 'Minimum number of sources expected (default 5).' },
          min_evidence: { type: 'number', description: 'Minimum evidence claims expected (default 3).' },
          min_selected: { type: 'number', description: 'Minimum selected corpus items expected.' },
          min_full_text_reads: { type: 'number', description: 'Minimum selected corpus items that must be read before final report.' },
          evidence_per_section: { type: 'number', description: 'Minimum evidence rows per plan section.' },
          require_plan_completion: { type: 'boolean', description: 'If true, fail when plan progress is under 80%.' },
          output_dir: { type: 'string', description: 'Optional research artifact directory for quality-gates.json.' },
          research_kind: { type: 'string', enum: ['academic', 'general'], description: "Research kind. 'academic' (default) enforces survey/review coverage and recency. 'general' is for non-academic web research and relaxes those academic-only gates. Pass the value given in the run parameters." },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gate_report',
      description: 'Return the latest research quality gate report as Markdown.',
      parameters: { type: 'object', properties: { session_id: { type: 'string', description: 'Internal: session id. Passed automatically.' }, output_dir: { type: 'string', description: 'Optional research artifact directory.' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_evidence_report',
      description: 'The ONLY valid final-report tool for managed research runs. Generates narrative report.md from selected corpus/evidence and a separate evidence-report.md appendix with matrix, coverage, and quality gates. Use this to create or repair .research/YYYY.../report.md after gates are ready; do not use write_file or generate_report for that.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          output_path: { type: 'string' },
          output_dir: { type: 'string' },
          session_id: { type: 'string' },
          report_language: { type: 'string', enum: ['ru', 'en'], description: 'Language for all user-facing report sections and generated Markdown artifacts.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_research_skills',
      description: 'List built-in and workspace .research/skills/*.md research skills, with triggers and required tools.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Optional query to recommend matching skills.' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'load_research_skill',
      description: 'Load full instructions for a research skill just-in-time instead of bloating the system prompt.',
      parameters: { type: 'object', properties: { skill_id: { type: 'string', description: 'Skill id, e.g. literature-review or proof-map.' } }, required: ['skill_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_domain_connectors',
      description: 'List domain-specific source connectors/tools for a research profile (biology, ML/AI, math, finance, etc.).',
      parameters: { type: 'object', properties: { profile_id: { type: 'string', description: 'Optional profile id or current preset id.' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scout_ideas',
      description: 'Generate research idea cards from the current corpus/evidence and a topic. Saves them to .research/ideas.jsonl.',
      parameters: { type: 'object', properties: { topic: { type: 'string', description: 'Research area or problem.' }, max_ideas: { type: 'number', description: 'Maximum idea cards (default 5).' }, output_dir: { type: 'string', description: 'Optional research artifact directory.' } }, required: ['topic'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'prioritize_ideas',
      description: 'Rank saved idea cards by novelty + feasibility + impact.',
      parameters: { type: 'object', properties: { output_dir: { type: 'string', description: 'Optional research artifact directory.' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_idea',
      description: 'Save a manually synthesized idea card to .research/ideas.jsonl.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          hypothesis: { type: 'string' },
          rationale: { type: 'string' },
          sources: { type: 'string', description: 'Optional comma-separated corpus/source IDs.' },
          novelty: { type: 'number' },
          feasibility: { type: 'number' },
          impact: { type: 'number' },
          next_steps: { type: 'string', description: 'Optional semicolon-separated next steps.' },
          output_dir: { type: 'string', description: 'Optional research artifact directory.' },
        },
        required: ['title', 'hypothesis', 'rationale'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description:
        'Hybrid BM25 + vector search over the local research knowledge index (notes, saved findings, downloaded papers). Use this to quickly recall what you already researched before launching fresh web searches.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language question or keywords.' },
          k: { type: 'number', description: 'Maximum passages to return (default: 8, max: 20).' },
          rebuild: { type: 'boolean', description: 'If true, rebuilds the index from scratch before searching. Slow but ensures freshness.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plan_research',
      description:
        'Decompose a broad research question into 3–7 focused sub-questions and persist them to .research/plan.md as a checklist. Call this once at the start of a deep investigation; the file is re-read automatically on every iteration to track progress.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The top-level research question.' },
          sub_questions: { type: 'array', items: { type: 'string' }, description: 'Array of specific sub-questions (3–7 recommended).' },
          output_dir: { type: 'string', description: 'Optional research artifact directory, for example ".research/2026-05-25_20-38_topic".' },
          session_id: { type: 'string', description: 'Internal: session id. Passed automatically.' },
        },
        required: ['question', 'sub_questions'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_plan_status',
      description: 'Mark a plan item as done or not done. Item ids are the "Q1", "Q2", "Q1.1" prefixes defined in plan.md.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'Plan item id, for example "Q2" or "Q1.3".' },
          done: { type: 'boolean', description: 'New checkbox state.' },
          output_dir: { type: 'string', description: 'Optional research artifact directory containing plan.md.' },
        },
        required: ['item_id', 'done'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spawn_sub_researcher',
      description:
        'Delegate a focused sub-question to an isolated sub-researcher agent. Returns a short synthesized report and automatically feeds discovered sources into the parent session. Max 3 concurrent sub-researchers — use sparingly for independent branches of the plan.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Well-scoped sub-question for the sub-researcher.' },
          max_iters: { type: 'number', description: 'Maximum tool-call iterations the sub-agent can perform (default: 6).' },
          session_id: { type: 'string', description: 'Internal: parent session id. Passed automatically.' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description:
        'Fetch a web page and return readable markdown via Mozilla Readability. Automatically handles arXiv abstract/PDF URLs. For binary PDF responses the returned result instructs you to use download_arxiv_pdf + parse_document.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full https(s):// URL.' },
          format: { type: 'string', description: 'Output format: "markdown" (default), "text", or "html".' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot_page',
      description:
        'Render a URL in a headless browser and save a PNG screenshot to .research/screenshots/. Useful for SPA pages, figures, dashboards, or visual evidence. Does NOT require external Playwright; uses the built-in Electron BrowserWindow.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL to capture.' },
          output_path: { type: 'string', description: 'Optional path inside the workspace. Default: .research/screenshots/<slug>.png' },
          full_page: { type: 'boolean', description: 'If true, resize window to capture the full page height.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'export_report',
      description:
        'Export a report markdown file into PDF, DOCX, or BibTeX. PDF renders via the built-in Chromium engine; DOCX uses a pure-JS writer; BibTeX is built from collected session sources.',
      parameters: {
        type: 'object',
        properties: {
          markdown_path: { type: 'string', description: 'Path to the source .md (default: .research/report.md).' },
          format: { type: 'string', enum: ['pdf', 'docx', 'bibtex'], description: 'Output format.' },
          output_path: { type: 'string', description: 'Optional output path.' },
          session_id: { type: 'string', description: 'Internal: session id. Passed automatically for bibtex.' },
        },
        required: ['format'],
      },
    },
  },
]

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.next', '.nuxt',
  'dist', 'build', '.cache', '.venv', 'venv', 'env',
  '.tox', 'coverage', '.nyc_output', '.turbo', 'target',
])

function resolvePath(raw: string | undefined, workspace: string): string {
  if (!raw) return workspace
  const p = path.isAbsolute(raw) ? raw : path.join(workspace, raw)
  return path.resolve(p)
}

function resolveResearchOutputPath(raw: string | undefined, workspace: string, fallback: string): string {
  const value = String(raw || fallback).replace(/\\/g, '/')
  if (path.isAbsolute(value)) {
    const absolute = resolvePath(value, workspace)
    const rel = path.relative(workspace, absolute).replace(/\\/g, '/')
    if (rel === '.research' || rel.startsWith('.research/')) {
      const dir = path.dirname(rel)
      const file = path.basename(rel)
      return resolvePath(path.join(canonicalResearchOutputDir(dir), file), workspace)
    }
    return absolute
  }
  if (value === '.research' || value.startsWith('.research/')) {
    const dir = path.dirname(value)
    const file = path.basename(value)
    return resolvePath(path.join(canonicalResearchOutputDir(dir), file), workspace)
  }
  return resolvePath(value, workspace)
}

function assertInWorkspace(resolved: string, workspace: string): void {
  const ws = path.resolve(workspace)
  if (!resolved.startsWith(ws) && !resolved.startsWith(ws + path.sep)) {
    throw new Error(`Access denied: ${resolved} is outside workspace ${ws}`)
  }
}

export function executeTool(name: string, args: Record<string, any>, workspace: string): string {
  if (!workspace) return 'Error: workspace not set. Please set a workspace directory first.'
  try {
    switch (name) {
      case 'read_file':
        return readFile(args.path, workspace, args.offset, args.limit)
      case 'write_file':
        return writeFile(args.path, args.content, workspace)
      case 'search_arxiv':
        return searchArxiv(args.query, args.max_results, args.from_date, args.to_date, args.sort_by, args.sort_order, args.start)
      case 'search_huggingface_papers':
        return searchHuggingFacePapers(args.query, args.max_results)
      case 'search_openalex':
        return searchOpenAlex(args.query, args.max_results, args.year_from, args.year_to)
      case 'search_web':
        return searchWeb(args.query, args.max_results, args.categories, args.language, args.time_range)
      case 'search_crossref':
        return searchCrossref(args.query, args.max_results, args.year_from, args.year_to)
      case 'search_semantic_scholar':
        return searchSemanticScholar(args.query, args.max_results, args.year_from, args.year_to)
      case 'search_pubmed':
        return searchPubMed(args.query, args.max_results, args.year_from, args.year_to)
      case 'smart_search':
        return smartSearch(args.query, args.max_per_source, workspace)
      case 'build_corpus':
        return buildCorpusTool(args.session_id, args.tags, args.queue_full_text, workspace, args.output_dir)
      case 'list_corpus':
        return listCorpus(workspace, args.max_items, args.output_dir)
      case 'queue_full_text':
        return queueFullText(workspace, String(args.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean), args.output_dir)
      case 'audit_research_run':
        return formatAuditResult(auditResearchRun(workspace, { outputDir: args.output_dir, yearFrom: args.year_from, yearTo: args.year_to, minSelected: args.min_selected, minRead: args.min_read, minEvidence: args.min_evidence }))
      case 'screen_corpus': {
        const storedKind = args.output_dir ? (ensureResearchRunSpec(workspace, args.output_dir).thresholds?.researchKind as string | undefined) : undefined
        const screenKind = (args.research_kind === 'general' || args.research_kind === 'academic') ? args.research_kind : (storedKind || 'academic')
        // Capture the screening contract so build_corpus can re-apply it automatically and
        // never leave a backlog of unscreened raw items (the root cause of search loops).
        if (args.output_dir && args.question) {
          try {
            ensureResearchRunSpec(workspace, args.output_dir, {
              screenParams: {
                question: String(args.question),
                subQuestions: Array.isArray(args.sub_questions) ? args.sub_questions.map(String) : undefined,
                yearFrom: args.year_from,
                yearTo: args.year_to,
                maxSelected: args.max_selected,
                minSelected: args.min_selected,
                strictDateRange: args.strict_date_range,
                researchKind: screenKind,
              },
            })
          } catch {}
        }
        return screenCorpus(workspace, { question: args.question, subQuestions: args.sub_questions, yearFrom: args.year_from, yearTo: args.year_to, maxSelected: args.max_selected, minSelected: args.min_selected, strictDateRange: args.strict_date_range, researchKind: screenKind }, args.output_dir)
      }
      case 'list_selected_corpus':
        return listSelectedCorpus(workspace, args.max_items, args.output_dir)
      case 'reject_corpus_items':
        return rejectCorpusItems(workspace, args.ids, args.reason, args.output_dir)
      case 'assign_corpus_to_plan':
        return assignCorpusToPlan(workspace, args.ids, args.plan_item_id, args.output_dir)
      case 'select_full_text_batch':
        return selectFullTextBatchTool(workspace, args.limit, args.output_dir)
      case 'read_corpus_item':
        return readCorpusItemTool(workspace, args.id, args.output_dir)
      case 'read_full_text_batch':
        return readFullTextBatchTool(workspace, args.limit, args.output_dir)
      case 'full_text_status':
        return fullTextStatus(workspace, args.output_dir)
      case 'get_references':
        return openAlexSnowballTool(args.work, args.max_results, 'references')
      case 'get_citations':
        return openAlexSnowballTool(args.work, args.max_results, 'citations')
      case 'record_evidence':
        return recordEvidence(workspace, args.claim, args.sources, { quote: args.quote, confidence: args.confidence, support: args.support, topic: args.topic, notes: args.notes, sessionId: args.session_id, outputDir: args.output_dir, corpusIds: args.corpus_ids, sourceUrls: args.source_urls, localPath: args.local_path, passageId: args.passage_id, planItemId: args.plan_item_id, evidenceType: args.evidence_type } as any)
      case 'list_evidence':
        return listEvidence(workspace, args.status, args.max_items, args.output_dir)
      case 'evidence_matrix':
        return evidenceMatrix(workspace, args.output_dir)
      case 'extract_evidence_from_corpus_item':
        return extractEvidenceFromCorpusItemTool(workspace, args)
      case 'extract_evidence_batch':
        return extractEvidenceBatchTool(workspace, args.output_dir, args.max_items)
      case 'evidence_coverage_by_plan':
        return evidenceCoverageByPlan(workspace, args.output_dir)
      case 'repair_evidence_quotes':
        return repairEvidenceQuotes(workspace, args.output_dir, args.max_items)
      case 'verify_claims':
        return verifyClaims(workspace, args.session_id, args.output_dir)
      case 'run_quality_gates':
        return runQualityGatesTool(workspace, args.session_id, args.min_sources, args.min_evidence, args.require_plan_completion, args.output_dir, args.min_selected, args.min_full_text_reads, args.evidence_per_section, args.research_kind)
      case 'gate_report':
        return formatGateReport(workspace, args.session_id, args.output_dir)
      case 'generate_evidence_report':
        return generateEvidenceReportTool(workspace, args.title, args.output_path, args.output_dir, args.session_id, args.report_language)
      case 'list_research_skills':
        return listResearchSkillsTool(workspace, args.query)
      case 'load_research_skill':
        return loadResearchSkill(args.skill_id, workspace)
      case 'list_domain_connectors':
        return listDomainConnectorsTool(args.profile_id)
      case 'scout_ideas':
        return scoutIdeas(workspace, args.topic, args.max_ideas, args.output_dir)
      case 'prioritize_ideas':
        return prioritizeIdeas(workspace, args.output_dir)
      case 'save_idea':
        return saveIdeaTool(workspace, args)
      case 'download_arxiv_html':
        return downloadArxivHtml(args.arxiv_id, args.output_path, workspace)
      case 'download_arxiv_pdf':
        return downloadArxivPdf(args.arxiv_id, args.output_path, workspace)
      case 'parse_document':
        return parseDocumentTool(args.path, workspace, args.max_pages)
      case 'verify_sources':
        return verifySources(args.session_id, args.max_sources)
      case 'plan_research':
        return planResearch(args.question, args.sub_questions, workspace, args.session_id, args.output_dir)
      case 'update_plan_status':
        return updatePlanStatus(args.item_id, args.done, workspace, args.output_dir)
      case 'fetch_url':
        return fetchUrlTool(args.url, args.format, workspace)
      case 'edit_file':
        return editFile(args.path, args.old_string, args.new_string, workspace)
      case 'append_file':
        return appendFile(args.path, args.content, workspace)
      case 'list_directory':
        return listDir(args.path, workspace, args.depth ?? 3)
      case 'find_files':
        return findFiles(args.pattern, args.type ?? 'name', args.path, workspace)
      case 'execute_command':
        return execCommand(args.command, args.working_directory, workspace)
      case 'create_directory':
        return createDir(args.path, workspace)
      case 'delete_file':
        return deleteFile(args.path, workspace)
      case 'reflect':
        return reflectOnFindings(args.findings, args.criteria, args.session_id)
      case 'save_finding':
        return saveFindingWithIndex(workspace, args.topic, args.content, args.tags, args.session_id)
      case 'recall_findings':
        return recallFindingsHybrid(workspace, args.query, args.max_results)
      case 'generate_report':
        return generateReport(args.title, args.content, args.output_path, args.session_id, workspace)
      default:
        return `Tool "${name}" is async-only; call executeToolAsync instead, or this tool does not exist.`
    }
  } catch (e: any) {
    return `Error: ${e.message}`
  }
}

const ASYNC_ONLY_TOOLS = new Set([
  'search_knowledge',
  'spawn_sub_researcher',
  'screenshot_page',
  'export_report',
  'recall_findings',
])

export function isAsyncTool(name: string): boolean {
  return ASYNC_ONLY_TOOLS.has(name)
}

export async function executeToolAsync(name: string, args: Record<string, any>, workspace: string, ctx?: { apiUrl?: string; temperature?: number }): Promise<string> {
  if (!workspace) return 'Error: workspace not set. Please set a workspace directory first.'
  try {
    switch (name) {
      case 'search_knowledge':
        return await searchKnowledgeTool(args.query, args.k, args.rebuild, workspace)
      case 'spawn_sub_researcher':
        return await spawnSubResearcherTool(args.task, args.max_iters, args.session_id, ctx?.apiUrl, ctx?.temperature, workspace)
      case 'screenshot_page':
        return await screenshotPageTool(args.url, args.output_path, args.full_page, workspace)
      case 'export_report':
        return await exportReportTool(args.markdown_path, args.format, args.output_path, args.session_id, workspace)
      case 'recall_findings':
        return await recallFindingsAsync(workspace, args.query, args.max_results)
      default:
        // Fallback to synchronous executor
        return executeTool(name, args, workspace)
    }
  } catch (e: any) {
    return `Error: ${e.message}`
  }
}

function saveFindingWithIndex(workspace: string, topic: string, content: string, tags: string | undefined, _sessionId: string | undefined): string {
  const result = saveFinding(workspace, topic, content, tags)
  try {
    if (!result.startsWith('Error')) {
      indexTextHybrid(workspace, `finding:${Date.now()}`, `${topic}\n\n${content}`).catch(() => {})
    }
  } catch {}
  return result
}

/**
 * Hybrid recall (async): query both the plain findings log and the workspace
 * knowledge index (BM25 + optional vectors), fuse results via Reciprocal Rank
 * Fusion inside `searchHybrid` and present a single ranked list.
 */
async function recallFindingsAsync(workspace: string, query: string, maxResults?: number): Promise<string> {
  const keywordResult = recallFindings(workspace, query, maxResults)
  try {
    const stats = indexStats(workspace)
    if (stats.chunks === 0) return keywordResult

    const k = Math.max(1, Math.min(20, Number(maxResults) || 10))
    const hits = await searchHybrid(workspace, query, k)
    if (hits.length === 0) return keywordResult

    const lines: string[] = ['', '--- Hybrid index hits (BM25 + vectors) ---']
    hits.forEach((h, i) => {
      const src = String((h.chunk as any).doc ?? (h.chunk as any).docId ?? '').replace(/^.*\//, '')
      const snippet = h.chunk.text.slice(0, 280).replace(/\s+/g, ' ')
      lines.push(`${i + 1}. [${src}] ${snippet}${h.chunk.text.length > 280 ? '…' : ''}`)
    })
    return `${keywordResult}\n${lines.join('\n')}`
  } catch {
    return keywordResult
  }
}

function recallFindingsHybrid(workspace: string, query: string, maxResults?: number): string {
  return recallFindings(workspace, query, maxResults)
}

function buildCorpusTool(sessionId: string | undefined, tagsRaw: string | undefined, queue: boolean | undefined, workspace: string, outputDir?: string): string {
  if (!sessionId) return 'Error: session id missing; build_corpus must be called from an agent session.'
  const sources = getSourceTracker(sessionId).getAll()
  if (sources.length === 0) return 'No collected sources in this session yet. Run search tools first.'
  const tags = String(tagsRaw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const merged = addSourcesToCorpus(workspace, sources, tags, outputDir)

  // Root-cause guard against search loops: once the model has screened at least once, a
  // screening contract is stored on the run spec. Re-apply it to the freshly merged corpus
  // so newly gathered items are screened immediately and an unscreened `raw` backlog can
  // never accumulate (that backlog is what made the agent search forever instead of
  // screening). Before the first screen there is no contract yet → leave items raw so the
  // model performs the first screen with its own tuned arguments (year bounds, etc.).
  let autoScreenNote = ''
  if (outputDir) {
    try {
      const sp = ensureResearchRunSpec(workspace, outputDir).screenParams
      if (sp?.question) {
        const rawCount = loadCorpus(workspace, outputDir).filter((e) => !e.screeningStatus || e.screeningStatus === 'raw').length
        if (rawCount > 0) {
          screenCorpus(workspace, {
            question: sp.question,
            subQuestions: sp.subQuestions,
            yearFrom: sp.yearFrom,
            yearTo: sp.yearTo,
            maxSelected: sp.maxSelected,
            minSelected: sp.minSelected,
            strictDateRange: sp.strictDateRange,
            researchKind: sp.researchKind,
          }, outputDir)
          autoScreenNote = `Auto-screened ${rawCount} newly added item(s) with the saved screening contract — no unscreened backlog remains. Do NOT keep searching to raise "selected"; read the selected items and extract evidence.`
        }
      }
    } catch {}
  }

  if (queue) queueFullText(workspace, undefined, outputDir)
  const stats = corpusStats(workspace, outputDir)
  return [
    `Corpus updated: ${merged.added} added, ${merged.updated} merged.`,
    `Stats: ${stats.total} total, ${stats.primary} primary, ${stats.withDoi} DOI, ${stats.withArxiv} arXiv, ${stats.queuedFullText} queued full text.`,
    autoScreenNote,
    '',
    rankCorpus(workspace, outputDir),
  ].filter(Boolean).join('\n')
}

function openAlexSnowballTool(work: string, maxResults: number | undefined, mode: 'references' | 'citations'): string {
  const input = String(work ?? '').trim()
  if (!input) return 'Error: work is required.'
  const limit = Math.max(1, Math.min(25, Number(maxResults) || 10))
  const script = `
${httpGetSnippet()}
const input = process.argv[1]
const mode = process.argv[2]
const limit = Number(process.argv[3] || '10')
function cleanDoi(s) {
  const m = String(s).match(/10\\.\\d{4,9}\\/[-._;()/:A-Z0-9]+/i)
  return m ? m[0].replace(/[.,;)\\]]+$/, '') : ''
}
async function j(url) {
  const r = await __httpGet(url, { headers: { 'User-Agent': 'one-click-research-agent/0.1', Accept: 'application/json' } }, { timeoutMs: 20000 })
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url)
  return JSON.parse(r.text)
}
async function resolveWork(s) {
  const doi = cleanDoi(s)
  if (doi) return await j('https://api.openalex.org/works/https://doi.org/' + encodeURIComponent(doi))
  const open = String(s).match(/openalex\\.org\\/(W\\d+)/i)?.[1] || String(s).match(/\\bW\\d{6,}\\b/)?.[0]
  if (open) return await j('https://api.openalex.org/works/' + open)
  const search = await j('https://api.openalex.org/works?per-page=1&search=' + encodeURIComponent(s))
  if (search.results && search.results[0]) return search.results[0]
  return null
}
function line(w, i) {
  const authors = (w.authorships || []).slice(0, 6).map(a => a.author?.display_name).filter(Boolean).join(', ')
  const doi = w.doi || ''
  const url = doi || w.primary_location?.landing_page_url || w.id || ''
  const abstract = w.abstract_inverted_index ? Object.entries(w.abstract_inverted_index).sort((a,b)=>a[1][0]-b[1][0]).map(([k])=>k).join(' ').slice(0, 350) : ''
  return [String(i+1)+'. '+(w.title || 'Untitled'), w.publication_year ? '   Year: '+w.publication_year : '', authors ? '   Authors: '+authors : '', w.cited_by_count != null ? '   Citations: '+w.cited_by_count : '', doi ? '   DOI: '+doi : '', url ? '   URL: '+url : '', abstract ? '   Abstract: '+abstract : ''].filter(Boolean).join('\\n')
}
(async () => {
  const root = await resolveWork(input)
  if (!root) { console.log('No OpenAlex work found for "' + input + '".'); return }
  let works = []
  if (mode === 'citations') {
    const url = (root.cited_by_api_url || ('https://api.openalex.org/works?filter=cites:' + root.id.split('/').pop())) + '&per-page=' + limit
    works = (await j(url)).results || []
  } else {
    const refs = (root.referenced_works || []).slice(0, limit)
    for (const ref of refs) {
      try { works.push(await j(ref)) } catch {}
    }
  }
  console.log(JSON.stringify({ root, works }))
})().catch((err) => { console.error(String(err?.message || err)); process.exit(1) })
`
  try {
    const payload = JSON.parse(runNodeScript(script, [input, mode, String(limit)]))
    const root = payload.root
    const works = Array.isArray(payload.works) ? payload.works : []
    if (!root) return `No OpenAlex work found for "${input}".`
    const title = root.title || input
    if (works.length === 0) return `No ${mode} found for "${title}" via OpenAlex.`
    const lines = works.map((w: any, i: number) => {
      const authors = (w.authorships || []).slice(0, 6).map((a: any) => a.author?.display_name).filter(Boolean).join(', ')
      const doi = w.doi || ''
      const url = doi || w.primary_location?.landing_page_url || w.id || ''
      const abstract = w.abstract_inverted_index
        ? Object.entries(w.abstract_inverted_index).sort((a: any, b: any) => a[1][0] - b[1][0]).map(([k]) => k).join(' ').slice(0, 350)
        : ''
      return [
        `${i + 1}. ${w.title || 'Untitled'}`,
        w.publication_year ? `   Year: ${w.publication_year}` : null,
        authors ? `   Authors: ${authors}` : null,
        w.cited_by_count != null ? `   Citations: ${w.cited_by_count}` : null,
        doi ? `   DOI: ${doi}` : null,
        url ? `   URL: ${url}` : null,
        abstract ? `   Abstract: ${abstract}` : null,
      ].filter(Boolean).join('\n')
    })
    return `Found ${works.length} ${mode} for "${title}" via OpenAlex:\n\n${lines.join('\n\n')}`
  } catch (e: any) {
    return `Error: OpenAlex ${mode} lookup failed. ${String(e?.stderr || e?.message || e).trim()}`
  }
}

function runQualityGatesTool(
  workspace: string,
  sessionId: string | undefined,
  minSources?: number,
  minEvidence?: number,
  requirePlanCompletion?: boolean,
  outputDir?: string,
  minSelected?: number,
  minFullTextReads?: number,
  evidencePerSection?: number,
  researchKind?: string,
): string {
  // Resolve the research kind: explicit arg wins, otherwise reuse what was stored
  // on the run (so the post-report refresh keeps the same relaxation). Defaults to
  // 'academic' — the science pipeline is unaffected.
  const storedKind = outputDir ? (ensureResearchRunSpec(workspace, outputDir).thresholds?.researchKind as string | undefined) : undefined
  const kind = (researchKind === 'general' || researchKind === 'academic') ? researchKind : (storedKind || 'academic')
  const { results: rawResults } = runQualityGates(workspace, sessionId, { minSources, minEvidence, requirePlanCompletion, outputDir, minSelected, minFullTextReads, evidencePerSection, researchKind: kind } as any)

  // No managed run directory → no escape valve / run.json bookkeeping.
  if (!outputDir) {
    const passed = rawResults.filter((r) => r.passed).length
    return formatGateResults(workspace, sessionId, outputDir, rawResults, `Quality gates: ${passed}/${rawResults.length} passed.`)
  }

  // Persist the thresholds used so the run is reproducible / inspectable.
  const thresholds: Record<string, number | boolean | string> = {}
  if (minSources != null) thresholds.minSources = Number(minSources)
  if (minEvidence != null) thresholds.minEvidence = Number(minEvidence)
  if (minSelected != null) thresholds.minSelected = Number(minSelected)
  if (minFullTextReads != null) thresholds.minFullTextReads = Number(minFullTextReads)
  if (evidencePerSection != null) thresholds.evidencePerSection = Number(evidencePerSection)
  if (requirePlanCompletion != null) thresholds.requirePlanCompletion = Boolean(requirePlanCompletion)
  thresholds.researchKind = kind
  if (Object.keys(thresholds).length) ensureResearchRunSpec(workspace, outputDir, { thresholds })

  // Escape valve: structural gates that have failed repeated honest repair
  // attempts are downgraded to warnings so the run can finish with a documented
  // limitation instead of looping. The downgraded snapshot is what downstream
  // (report generation, FSM) reads.
  const { results, downgraded } = applyGateEscapeValve(workspace, outputDir, rawResults)
  if (downgraded.length) writeQualityGateSnapshot(workspace, outputDir, results)

  const passed = results.filter((r) => r.passed).length
  const summary = downgraded.length
    ? `Quality gates: ${passed}/${results.length} passed. Downgraded to warnings (structural limitation after repeated repair attempts): ${downgraded.join(', ')}.`
    : `Quality gates: ${passed}/${results.length} passed.`
  return formatGateResults(workspace, sessionId, outputDir, results, summary)
}

function selectFullTextBatchTool(workspace: string, limit: number | undefined, outputDir?: string): string {
  const batch = selectFullTextBatch(workspace, limit, outputDir)
  if (batch.length === 0) {
    return 'No-op: no selected corpus items are queued for full-text batch reading. Call full_text_status to inspect failed/unread items; if a high-priority item failed, call read_corpus_item with that specific id once, then run_quality_gates.'
  }
  return batch.map((e, i) => [
    `${i + 1}. ${e.id}: ${e.title}`,
    `   Priority: ${e.readPriority ?? 'low'} | score=${e.score} | year=${e.year ?? 'unknown'}`,
    e.arxivId ? `   arXiv: ${e.arxivId}` : null,
    `   URL: ${e.url}`,
  ].filter(Boolean).join('\n')).join('\n\n')
}

function readCorpusItemTool(workspace: string, id: string | undefined, outputDir?: string): string {
  const corpusId = String(id ?? '').trim()
  if (!corpusId) return 'Error: id is required.'
  const entry = loadCorpus(workspace, outputDir).find((e) => e.id === corpusId)
  if (!entry) return `Error: corpus item not found: ${corpusId}`
  if (entry.readStatus === 'read') {
    return `No-op: corpus item ${corpusId} is already marked read${entry.localPath ? ` at ${entry.localPath}` : ''}. Do not call read_corpus_item for this id again; continue with full_text_status or run_quality_gates.`
  }
  // Reconcile inconsistent state after a corpus rebuild: `status` (or an existing
  // downloaded file) can say "read" while `readStatus` was reset to not_read. That
  // mismatch makes full_text_status report the item as unread forever, so the agent
  // loops on read_full_text_batch. Re-mark it read from the existing file instead of
  // re-downloading or looping.
  if (entry.localPath && fs.existsSync(entry.localPath)) {
    markCorpusItemRead(workspace, corpusId, entry.localPath, 'read', entry.readReason ?? 'reconciled from existing full-text file after rebuild', outputDir)
    return `Reconciled corpus ${corpusId}: existing full text at ${entry.localPath} re-marked as read (read state was out of sync after a corpus rebuild). Do not read it again; continue with full_text_status or run_quality_gates.`
  }
  if (entry.readStatus === 'failed' && /\bHTTP\s*(?:403|404|410|451)\b/i.test(entry.readReason ?? '')) {
    return `Error: corpus item ${corpusId} already failed with a non-retriable fetch error (${entry.readReason}). Do not retry this id again; treat it as unavailable, run full_text_status, then run_quality_gates so the limitation is recorded.`
  }
  const baseDir = canonicalResearchOutputDir(outputDir)
  const safeId = corpusId.replace(/[^a-z0-9_-]+/gi, '_')
  const fullTextDir = path.join(baseDir, 'fulltext')

  if (entry.arxivId) {
    const htmlPath = path.join(fullTextDir, `${safeId}.html`)
    const html = downloadArxivHtml(entry.arxivId, htmlPath, workspace)
    if (!html.startsWith('Error:')) {
      markCorpusItemRead(workspace, corpusId, htmlPath, 'read', 'arXiv HTML downloaded', outputDir)
      return `${html}\nUpdated corpus ${corpusId}: read.`
    }
    const pdfPath = path.join(fullTextDir, `${safeId}.pdf`)
    const pdf = downloadArxivPdf(entry.arxivId, pdfPath, workspace)
    if (!pdf.startsWith('Error:')) {
      markCorpusItemRead(workspace, corpusId, pdfPath, 'read', 'arXiv PDF downloaded; parse_document recommended', outputDir)
      return `${html}\n${pdf}\nUpdated corpus ${corpusId}: read via PDF fallback.`
    }
    markCorpusItemRead(workspace, corpusId, undefined, 'failed', `${html} ${pdf}`.slice(0, 500), outputDir)
    return `${html}\n${pdf}\nUpdated corpus ${corpusId}: failed.`
  }

  const fetched = fetchUrlTool(entry.url, 'markdown', workspace)
  if (fetched.startsWith('Error:')) {
    markCorpusItemRead(workspace, corpusId, undefined, 'failed', fetched.slice(0, 500), outputDir)
    return `${fetched}\nUpdated corpus ${corpusId}: failed.`
  }
  const target = resolvePath(path.join(fullTextDir, `${safeId}.md`), workspace)
  assertInWorkspace(target, workspace)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, fetched, 'utf-8')
  const rel = path.relative(workspace, target)
  markCorpusItemRead(workspace, corpusId, rel, 'read', 'URL fetched as markdown', outputDir)
  return `Fetched ${entry.url} to ${rel} (${fetched.length} chars).\nUpdated corpus ${corpusId}: read.`
}

function readFullTextBatchTool(workspace: string, limit: number | undefined, outputDir?: string): string {
  const batch = selectFullTextBatch(workspace, limit, outputDir)
  if (batch.length === 0) {
    return 'Error: no selected corpus items are queued for full-text batch reading. Do not call read_full_text_batch again with the same arguments. Call full_text_status to inspect failed/unread items; if a high-priority item failed, call read_corpus_item with that specific id once, then run_quality_gates.'
  }
  const lines = [`Reading ${batch.length} selected corpus item(s):`, '']
  for (const item of batch) {
    const result = readCorpusItemTool(workspace, item.id, outputDir)
    lines.push(`## ${item.id}: ${item.title}`, result, '')
  }
  lines.push(fullTextStatus(workspace, outputDir))
  return lines.join('\n')
}

function extractEvidenceFromCorpusItemTool(workspace: string, args: Record<string, any>): string {
  const corpusId = String(args.corpus_id ?? '').trim()
  if (!corpusId) return 'Error: corpus_id is required.'
  const item = loadCorpus(workspace, args.output_dir).find((e) => e.id === corpusId)
  if (!item) return `Error: corpus item not found: ${corpusId}`
  return recordEvidence(workspace, args.claim, args.sources, {
    quote: args.quote,
    confidence: args.confidence || 'medium',
    support: args.support || 'supports',
    topic: args.plan_item_id,
    notes: item.readStatus === 'read' ? args.notes : `Metadata/abstract-only evidence; full text status=${item.readStatus ?? 'not_read'}. ${args.notes ?? ''}`.trim(),
    sessionId: args.session_id,
    outputDir: args.output_dir,
    corpusIds: corpusId,
    sourceUrls: item.url,
    localPath: item.localPath,
    planItemId: args.plan_item_id,
    evidenceType: args.evidence_type,
  } as any)
}

function extractEvidenceBatchTool(workspace: string, outputDir?: string, maxItems?: number): string {
  const limit = Math.max(1, Math.min(50, Number(maxItems) || 20))
  const items = loadCorpus(workspace, outputDir)
    .filter((e) => e.screeningStatus === 'selected' && (e.readStatus === 'read' || e.status === 'read'))
    .slice(0, limit)
  if (items.length === 0) return 'No read selected corpus items. Run read_full_text_batch first.'
  return [
    'Use extract_evidence_from_corpus_item or record_evidence for each relevant claim below. Include corpus_ids, plan_item_id and quote whenever possible.',
    '',
    ...items.map((e, i) => `${i + 1}. ${e.id} [${e.subQuestions?.join(', ') || 'unassigned'}] ${e.title}\n   Local: ${e.localPath ?? 'none'}\n   URL: ${e.url}`),
  ].join('\n\n')
}

function generateEvidenceReportTool(workspace: string, title: string, outputPath: string | undefined, outputDir: string | undefined, sessionId: string | undefined, reportLanguage?: string): string {
  const snap = readQualityGateSnapshot(workspace, outputDir)
  if (!snap) return 'Error: quality gates have not been run yet. Run run_quality_gates before generate_evidence_report.'
  const blocker = latestQualityGateFailure(workspace, outputDir, { ignoreGates: ['final_report_structure'] })
  if (blocker) return `Error: quality gates are failing. Do not generate final report yet.\n${blocker}\n\nRun read_full_text_batch / extract_evidence_batch and then run_quality_gates again.`
  const language = reportLanguage === 'en' || reportLanguage === 'ru'
    ? reportLanguage
    : (cfg.get('appLanguage') ?? 'ru')
  const ru = language === 'ru'
  // Prefer the real research question (from plan.md) over the run-dir slug so the
  // report title is meaningful ("RL в LLM…"), not "rl b llm".
  const planTopic = planQuestion(workspace, outputDir)
  const slugLike = !title || /^[a-z0-9]+(\s+[a-z0-9]+){0,4}$/i.test(title.trim()) && title.trim().split(/\s+/).every((w) => w.length <= 4)
  const effectiveTitle = (planTopic && (slugLike || planTopic.length > title.length)) ? planTopic : (title || planTopic || (ru ? 'Исследовательский отчёт' : 'Research Report'))
  const stats = corpusStats(workspace, outputDir)
  const matrix = evidenceMatrix(workspace, outputDir)
  const selected = listSelectedCorpus(workspace, 40, outputDir)
  const status = fullTextStatus(workspace, outputDir)
  const gates = formatGateReport(workspace, sessionId, outputDir)
  const evidenceContent = [
    ru ? '## Резюме по доказательной базе' : '## Evidence-First Summary',
    '',
    ru
      ? `Отчёт основан на ${stats.selected} отобранных источниках, ${stats.selectedRead} прочитанных полнотекстовых источниках и ${evidenceStats(workspace, outputDir).total} доказательных утверждениях.`
      : `This report is based on ${stats.selected} selected corpus item(s), ${stats.selectedRead} selected full-text read(s), and ${evidenceStats(workspace, outputDir).total} evidence claim(s).`,
    '',
    ru ? '## Покрытие' : '## Coverage',
    '',
    status,
    '',
    ru ? '## Матрица доказательств' : '## Evidence Matrix',
    '',
    matrix,
    '',
    ru ? '## Приложение: отобранный корпус' : '## Selected Corpus Appendix',
    '',
    selected,
    '',
    ru ? '## Проверки качества' : '## Quality Gates',
    '',
    gates,
    '',
    ru ? '## Ограничения' : '## Limitations',
    '',
    ru
      ? '- Разделы со слабой или отсутствующей доказательной базой нужно расширить перед использованием отчёта как финального научного вывода.'
      : '- Sections with weak or missing evidence should be expanded before using this as a final scientific conclusion.',
    ru
      ? '- Нельзя описывать сырой корпус как доказательную базу, если источники не были отобраны и прочитаны.'
      : '- Do not describe raw corpus size as the evidence base unless those items were selected and read.',
  ].join('\n')
  const evidencePath = resolveResearchOutputPath(undefined, workspace, path.join(canonicalResearchOutputDir(outputDir), 'evidence-report.md'))
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true })
  fs.writeFileSync(evidencePath, `# ${ru ? 'Доказательный отчёт' : 'Evidence Report'}\n\n${evidenceContent}\n`, 'utf-8')

  let synthesis = composeSynthesisReport(workspace, effectiveTitle, outputDir, ru)
  // Best-effort LLM quality pass: rate each section (read-only, no fact rewriting).
  try {
    const review = llmReviewReportSections(synthesis, ru)
    if (review) {
      synthesis += `\n\n## ${ru ? 'Контроль качества секций (LLM-проверка)' : 'Section Quality Check (LLM review)'}\n\n${review}\n`
    }
  } catch {}
  const result = generateReport(
    effectiveTitle,
    synthesis,
    outputPath || path.join(canonicalResearchOutputDir(outputDir), 'report.md'),
    undefined,
    workspace,
    { ignoreFinalReportStructureGate: true, allowEvidenceReportGenerator: true },
  )
  const relEvidence = path.relative(workspace, evidencePath)
  // Refresh the quality-gate snapshot against the report we just wrote. Without this
  // the snapshot keeps its pre-report value (final_report_structure missing/failed),
  // the live state tail keeps asking the model to "regenerate", and the agent loops
  // forever even though report.md is already final on disk.
  let gateNote = ''
  try {
    runQualityGatesTool(workspace, sessionId, undefined, undefined, undefined, outputDir, undefined, undefined, undefined)
    const refreshed = readQualityGateSnapshot(workspace, outputDir)
    if (refreshed) {
      gateNote = refreshed.allPassed
        ? `\nQuality gates re-checked against the new report: ${refreshed.passed}/${refreshed.total} passed.`
        : `\nQuality gates re-checked: ${refreshed.passed}/${refreshed.total}. report.md is written; remaining items are non-blocking for report finality.`
    }
  } catch {}
  return `${result}\nEvidence appendix saved to ${relEvidence}.${gateNote}`
}

// Titles often arrive from search snippets with arXiv-id prefixes, trailing
// ellipses, or site suffixes ("- Springer"). Clean them for display.
export function cleanReportTitle(raw?: string): string {
  return String(raw ?? '')
    .replace(/^\[\s*\d{4}\.\d{4,5}\s*\]\s*/i, '')
    .replace(/\s*[-–—]\s*(springer|arxiv|acm digital library|sciencedirect|ieee xplore|huggingface|hugging face)\b.*$/i, '')
    .replace(/\s*\.{3,}\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Failed-read reasons are raw error strings ("Error: fetch_url failed — HTTP 403",
// chained arXiv fallbacks). Map them to a short, human cause.
export function humanReadFailureReason(raw: string | undefined, ru: boolean): string | undefined {
  if (!raw) return undefined
  const r = String(raw)
  if (/HTTP\s*403|forbidden/i.test(r)) return ru ? 'доступ закрыт издателем (403)' : 'blocked by publisher (403)'
  if (/HTTP\s*404|not found/i.test(r)) return ru ? 'страница не найдена (404)' : 'not found (404)'
  if (/HTTP\s*429|rate.?limit/i.test(r)) return ru ? 'ограничение частоты запросов (429)' : 'rate-limited (429)'
  if (/HTTP\s*5\d\d/i.test(r)) return ru ? 'ошибка сервера источника' : 'source server error'
  if (/timeout|timed out/i.test(r)) return ru ? 'таймаут загрузки' : 'download timeout'
  return r.replace(/\s+/g, ' ').replace(/^error:\s*/i, '').trim().slice(0, 120)
}

// Quotes are extracted from fetched HTML/markdown and can carry tag soup, navigation
// residue, fetch dump-headers, or even internal screening metadata. Strip markup and
// reject junk so the report never shows garbage fragments.
export function stripQuoteMarkup(raw?: string): string {
  if (!raw) return ''
  let q = String(raw)
  q = q.replace(/<[^>]*>/g, ' ')
  q = q.replace(/\b(?:href|title|class|src|id|style|rel|target|data-[\w-]+)\s*=\s*"[^"]*"/gi, ' ')
  q = q.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  q = q.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ').replace(/&[a-z]+;/gi, ' ')
  q = q.replace(/[\s\u00a0]+/g, ' ').replace(/^["'“”‹›«»\s.|>·•–—-]+/, '').trim()
  return q
}

export function isJunkReportQuote(q: string): boolean {
  if (q.length < 24) return true
  if (/\btitle:\s[\s\S]*\burl:\s/i.test(q) && /(byline:|format:\s*markdown|length:\s*\d|site:\s)/i.test(q)) return true
  if (/selected score\s*\d|precision\s*\d+\s*;|\bmatched:\s/i.test(q)) return true
  if (/ltx_|cookies_not_supported|error=cookies|tocentry|ref_tag/i.test(q)) return true
  // Breadcrumb / table-of-contents paths extracted from arXiv HTML ("‣ 5 Experiments ‣ Title").
  if (/‣/.test(q)) return true
  // Trailing section-reference residue like "...Title"> 2 ." or "> §A.5 .".
  if (/(?:["'>]\s*)?(?:§\s*)?[\w.]+\s*\)?\s*\.?\s*$/.test(q) && /["'>]\s*(?:§|\d)/.test(q)) return true
  const letters = (q.match(/[\p{L}]/gu) || []).length
  if (letters / q.length < 0.55) return true
  return false
}

export function sanitizeReportQuote(quote?: string): string {
  const cleaned = stripQuoteMarkup(quote)
  if (!cleaned || isJunkReportQuote(cleaned)) return ''
  return cleaned.length > 260 ? cleaned.slice(0, 260).trimEnd() + '…' : cleaned
}

// Read-only LLM quality pass over the assembled report. It RATES each section and
// flags issues (clarity, coherence, language consistency, thin support) but never
// rewrites facts/numbers/citations — the report stays evidence-grounded and
// deterministic. Best-effort: if the local model is unavailable it returns '' and the
// report is published without the QA block.
function llmReviewReportSections(reportBody: string, ru: boolean): string {
  const apiUrl = 'http://127.0.0.1:7863'
  const sections = reportBody.split(/\n(?=## )/).map((s) => s.trim()).filter((s) => s.startsWith('## '))
  if (sections.length === 0) return ''
  const condensed = sections.map((s) => {
    const head = (s.match(/^##\s+(.+)/)?.[1] ?? 'Section').trim()
    const body = s.replace(/^##\s+.+\n?/, '').replace(/\s+/g, ' ').trim().slice(0, 600)
    return `### ${head}\n${body}`
  }).join('\n\n').slice(0, 10000)
  const prompt = ru
    ? `Ты — придирчивый научный редактор. Оцени КАЖДУЮ секцию отчёта по качеству: ясность, связность, единый язык (русский), нет ли «висящих» утверждений без опоры, нет ли явного мусора (HTML-теги, обрывки навигации).
ВАЖНО: ниже даны СОКРАЩЁННЫЕ выдержки секций (обрезаны для проверки) — НЕ считай саму обрезку/неполноту выдержки недостатком и НЕ пиши «обрезано/неполный».
НЕ переписывай факты, числа и ссылки. Только оцени и кратко укажи замечание.

Сокращённые выдержки секций:
${condensed}

Верни ТОЛЬКО markdown-таблицу, ничего больше:
| Секция | Оценка | Замечание |
|---|---|---|
Оценка — одно из: ОК / Замечания / Слабая. Замечание — максимум одна короткая фраза (или «—»).`
    : `You are a strict scientific editor. Rate EACH report section for quality: clarity, coherence, consistent language (English), no dangling unsupported claims, no obvious garbage (HTML tags, navigation fragments).
IMPORTANT: the section excerpts below are CONDENSED (truncated for review) — do NOT treat the truncation/incompleteness of the excerpt itself as a defect and do NOT say "truncated/incomplete".
Do NOT rewrite facts, numbers, or citations. Only rate and give a short note.

Condensed section excerpts:
${condensed}

Return ONLY a markdown table, nothing else:
| Section | Rating | Note |
|---|---|---|
Rating is one of: OK / Issues / Weak. Note is at most one short phrase (or "—").`
  const script = `
(async () => {
  const res = await fetch(process.argv[1] + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local',
      messages: [
        { role: 'system', content: 'You rate report sections and output exactly one markdown table. No prose, no code fences.' },
        { role: 'user', content: process.argv[2] },
      ],
      temperature: 0.2,
      max_tokens: 700,
      chat_template_kwargs: { enable_thinking: false },
    }),
  })
  if (!res.ok) { console.error('HTTP ' + res.status); process.exit(1) }
  const json = await res.json()
  process.stdout.write(String(json?.choices?.[0]?.message?.content || ''))
})().catch((err) => { console.error(String(err?.message || err)); process.exit(1) })
`
  try {
    const out = execFileSync(process.execPath, ['-e', script, apiUrl, prompt], {
      encoding: 'utf-8',
      timeout: 60000,
      maxBuffer: 1024 * 1024 * 2,
      env: { ...process.env, FORCE_COLOR: '0', ELECTRON_RUN_AS_NODE: '1' },
    }).trim()
    // Keep only the table; strip any stray prose/think the model might add.
    const cleaned = out.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```[a-z]*\n?|```/gi, '').trim()
    const tableStart = cleaned.indexOf('|')
    const table = tableStart >= 0 ? cleaned.slice(tableStart).trim() : ''
    if (!table.includes('|') || table.length < 40) return ''
    return table
  } catch {
    return ''
  }
}

/** Single synchronous chat call to the local llama-server. Returns '' on any failure. */
function callLocalChat(system: string, user: string, opts: { maxTokens?: number; timeoutMs?: number } = {}): string {
  // Keep unit tests hermetic and fast: never hit a (possibly running) local server.
  if (process.env.VITEST) return ''
  const apiUrl = 'http://127.0.0.1:7863'
  const script = `
(async () => {
  const res = await fetch(process.argv[1] + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local',
      messages: [
        { role: 'system', content: process.argv[3] },
        { role: 'user', content: process.argv[2] },
      ],
      temperature: 0.2,
      max_tokens: ${Number(opts.maxTokens) || 800},
      chat_template_kwargs: { enable_thinking: false },
    }),
  })
  if (!res.ok) { console.error('HTTP ' + res.status); process.exit(1) }
  const json = await res.json()
  process.stdout.write(String(json?.choices?.[0]?.message?.content || ''))
})().catch((err) => { console.error(String(err?.message || err)); process.exit(1) })
`
  try {
    const out = execFileSync(process.execPath, ['-e', script, apiUrl, user, system], {
      encoding: 'utf-8',
      timeout: opts.timeoutMs ?? 90000,
      maxBuffer: 1024 * 1024 * 4,
      env: { ...process.env, FORCE_COLOR: '0', ELECTRON_RUN_AS_NODE: '1' },
    }).trim()
    return out.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```[a-z]*\n?|```/gi, '').trim()
  } catch {
    return ''
  }
}

function parseJsonStringMap(text: string): Record<string, string> {
  const raw = String(text || '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return {}
  try {
    const obj = JSON.parse(raw.slice(start, end + 1))
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(obj)) if (typeof v === 'string' && v.trim()) out[k] = v.trim()
    return out
  } catch {
    return {}
  }
}

function readLocalExcerpt(localPath: string | undefined): string {
  if (!localPath) return ''
  try {
    if (!fs.existsSync(localPath)) return ''
    const raw = fs.readFileSync(localPath, 'utf-8')
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return text.slice(0, 1600)
  } catch {
    return ''
  }
}

/**
 * Generate a per-source summary (3–5 sentences) in the report language for the
 * presented sources. Grounded in the abstract, extracted evidence and a slice of
 * the read full text. Best-effort: cached on the corpus entry, bounded by a wall-clock
 * budget, and silently falls back (caller uses evidence/abstract) when the model is
 * unavailable. Mutates and persists the corpus entries it summarizes.
 */
function llmSummarizeSources(
  workspace: string,
  outputDir: string | undefined,
  sources: CorpusEntry[],
  claimsByCorpus: Map<string, string[]>,
  ru: boolean,
): void {
  const lang = ru ? 'ru' : 'en'
  const need = sources.filter((e) => !(e.summary && e.summaryLang === lang))
  if (!need.length) return
  const budgetMs = 4 * 60 * 1000
  const started = Date.now()
  const batchSize = 6
  const sys = ru
    ? 'Ты — научный аналитик. Ты пишешь СТРОГО на русском языке и возвращаешь только JSON.'
    : 'You are a research analyst. You write STRICTLY in English and return only JSON.'
  let changed = false
  for (let i = 0; i < need.length; i += batchSize) {
    if (Date.now() - started > budgetMs) break
    const batch = need.slice(i, i + batchSize)
    const payload = batch.map((e) => ({
      id: e.id,
      title: cleanReportTitle(e.title),
      year: e.year,
      abstract: stripQuoteMarkup(e.snippet || '').slice(0, 700),
      evidence: (claimsByCorpus.get(e.id) || []).slice(0, 3),
      excerpt: readLocalExcerpt(e.localPath),
    }))
    const user = ru
      ? `Для КАЖДОЙ статьи напиши развёрнутую выжимку (3–5 предложений) СТРОГО на русском языке: о чём работа, какой метод/подход предложен, ключевые результаты и числа, главный вывод. Английские термины можно оставлять как термины (DPO, GRPO, RLHF и т.п.), но связный текст обязан быть на русском. Не выдумывай факты сверх предоставленных данных; если данных мало — опиши кратко по названию и аннотации.
Верни ТОЛЬКО JSON-объект вида {"<id>": "<выжимка>", ...} без markdown и пояснений.

Данные статей (JSON):
${JSON.stringify(payload)}`
      : `For EACH paper write a detailed summary (3–5 sentences) STRICTLY in English: what it is about, the proposed method/approach, key results and numbers, the main takeaway. Do not invent facts beyond the provided data; if data is scarce, summarize briefly from the title and abstract.
Return ONLY a JSON object {"<id>": "<summary>", ...} with no markdown or explanations.

Paper data (JSON):
${JSON.stringify(payload)}`
    const out = callLocalChat(sys, user, { maxTokens: 1500, timeoutMs: 120000 })
    const map = parseJsonStringMap(out)
    for (const e of batch) {
      const s = map[e.id]
      if (s && s.length > 20) {
        e.summary = s.replace(/\s+/g, ' ').trim()
        e.summaryLang = lang
        e.updatedAt = Date.now()
        changed = true
      }
    }
  }
  if (changed && outputDir) {
    try {
      const full = loadCorpus(workspace, outputDir)
      const byId = new Map(full.map((e) => [e.id, e]))
      for (const e of sources) {
        if (e.summary && e.summaryLang === lang) {
          const target = byId.get(e.id)
          if (target) { target.summary = e.summary; target.summaryLang = lang; target.updatedAt = e.updatedAt }
        }
      }
      saveCorpus(workspace, full, outputDir)
    } catch {}
  }
}

/** Synthesize key takeaways + a closing conclusion from the supported evidence claims. */
function llmReportSynthesis(
  topic: string,
  claimLines: string[],
  ru: boolean,
): { tldr: string[]; conclusion: string } | null {
  if (!claimLines.length) return null
  const sys = ru
    ? 'Ты — научный аналитик. Пиши СТРОГО на русском языке и возвращай только JSON.'
    : 'You are a research analyst. Write STRICTLY in English and return only JSON.'
  const evidence = claimLines.slice(0, 60).map((c, i) => `${i + 1}. ${c}`).join('\n').slice(0, 8000)
  const user = ru
    ? `Тема исследования: «${topic}».
Ниже — подтверждённые доказательные утверждения по теме (из прочитанных источников).
Сделай синтез по всей информации СТРОГО на русском языке:
1) "tldr" — 4–6 кратких ключевых выводов по теме в целом (каждый ≤ 25 слов);
2) "conclusion" — связное заключение (2–4 абзаца): главные тенденции, что считается установленным, открытые проблемы и направления.
Опирайся только на приведённые утверждения, не выдумывай.
Верни ТОЛЬКО JSON: {"tldr": ["...", "..."], "conclusion": "..."}.

Утверждения:
${evidence}`
    : `Research topic: "${topic}".
Below are supported evidence claims (from read sources).
Synthesize across all of it STRICTLY in English:
1) "tldr" — 4–6 concise key takeaways about the topic overall (each ≤ 25 words);
2) "conclusion" — a coherent conclusion (2–4 paragraphs): main trends, what is established, open problems and directions.
Rely only on the provided claims; do not invent.
Return ONLY JSON: {"tldr": ["...", "..."], "conclusion": "..."}.

Claims:
${evidence}`
  const out = callLocalChat(sys, user, { maxTokens: 1600, timeoutMs: 120000 })
  const start = out.indexOf('{')
  const end = out.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(out.slice(start, end + 1))
    const tldr = Array.isArray(obj?.tldr) ? obj.tldr.map((x: any) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 8) : []
    const conclusion = typeof obj?.conclusion === 'string' ? obj.conclusion.trim() : ''
    if (!tldr.length && !conclusion) return null
    return { tldr, conclusion }
  } catch {
    return null
  }
}

export function composeSynthesisReport(workspace: string, title: string, outputDir: string | undefined, ru: boolean): string {
  const corpus = loadCorpus(workspace, outputDir)
  const selected = corpus.filter((e) => e.screeningStatus === 'selected')
  const read = selected.filter((e) => e.readStatus === 'read' || e.status === 'read')
  const unavailable = selected.filter((e) => e.readStatus === 'failed')
  const claims = loadEvidence(workspace, outputDir).filter((e) => e.status === 'supported')
  // How many sources the user wants PRESENTED in the report. Discovery/reads may be
  // larger; the report shows the top-N most relevant read sources. Explicit
  // reportSourceCount wins; otherwise fall back to the selected floor (minSelected).
  const spec = (() => { try { return outputDir ? ensureResearchRunSpec(workspace, outputDir) : null } catch { return null } })()
  const th = (spec?.thresholds || {}) as Record<string, number | boolean | string>
  const reportCount = Number(th.reportSourceCount) > 0
    ? Number(th.reportSourceCount)
    : (Number(th.minSelected) > 0 ? Number(th.minSelected) : 0)
  const rankedRead = [...read].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || ((b.year ?? 0) - (a.year ?? 0)))
  const reportSources = reportCount > 0 ? rankedRead.slice(0, reportCount) : rankedRead
  const reportSourceIds = new Set(reportSources.map((e) => e.id))
  const reviews = reportSources.filter((e) => e.publicationType === 'survey' || e.publicationType === 'review')
  const plan = parsePlan(workspace, outputDir)
  const byPlan = new Map<string, typeof claims>()
  for (const claim of claims) {
    const key = claim.planItemId || claim.topic || 'other'
    byPlan.set(key, [...(byPlan.get(key) || []), claim])
  }
  const sourceById = new Map(corpus.map((e) => [e.id, e]))
  const runDir = canonicalResearchOutputDir(outputDir).replace(/\\/g, '/').replace(/\/+$/, '')
  const link = (text: string, href?: string) => {
    const label = text.replace(/\|/g, '\\|')
    const target = String(href ?? '').trim()
    return target ? `[${label}](${target.replace(/\)/g, '%29')})` : label
  }
  const localHref = (localPath?: string) => {
    if (!localPath) return ''
    const normalized = localPath.replace(/\\/g, '/')
    return normalized.startsWith(`${runDir}/`) ? normalized.slice(runDir.length + 1) : normalized
  }
  const sourceTag = (id: string) => {
    const src = sourceById.get(id)
    return src ? link(id, src.url) : `\`${id}\``
  }
  const sourceLabel = (id: string) => {
    const src = sourceById.get(id)
    if (!src) return id
    return `${cleanTitle(src.title)}${src.year ? ` (${src.year})` : ''}`
  }
  const cite = (claim: { corpusIds?: string[] }) => (claim.corpusIds || []).slice(0, 3).map(sourceTag).join(', ') || (ru ? 'источник не привязан' : 'no linked source')
  const evidenceStrength = (claim: { quote?: string; notes?: string; evidenceType?: string; confidence?: string }) => {
    if (claim.notes?.toLowerCase().includes('abstract-only')) return ru ? 'только метаданные/аннотация' : 'metadata-only'
    if (claim.quote && claim.evidenceType === 'primary_result') return ru ? 'сильная' : 'strong'
    if (claim.quote) return ru ? 'средняя' : 'medium'
    return ru ? 'слабая' : 'weak'
  }
  const confidenceLabel = (value?: string) => {
    if (!ru) return value ?? 'unknown'
    if (value === 'high') return 'высокая'
    if (value === 'medium') return 'средняя'
    if (value === 'low') return 'низкая'
    if (value === 'speculative') return 'предварительная'
    return 'неизвестная'
  }
  const evidenceTypeLabel = (value?: string) => {
    if (!ru) return value ?? 'unknown'
    if (value === 'primary_result') return 'первичный результат'
    if (value === 'survey_statement') return 'утверждение из обзора'
    if (value === 'benchmark') return 'бенчмарк'
    if (value === 'safety_claim') return 'утверждение о безопасности'
    if (value === 'background') return 'контекст'
    return 'не классифицировано'
  }
  const priorityLabel = (value?: string) => {
    if (!ru) return value ?? 'low'
    if (value === 'high') return 'высокий'
    if (value === 'medium') return 'средний'
    return 'низкий'
  }
  const selectedLabel = ru ? 'отобранные' : 'selected'
  const readLabel = ru ? 'прочитанные' : 'read'
  const fullTextLabel = ru ? 'полный текст' : 'full text'
  const localArtifactHeader = ru ? 'Локальный артефакт' : 'Local artifact'
  const corpusIdHeader = ru ? 'ID корпуса' : 'Corpus ID'
  const sourceHeader = ru ? 'Источник' : 'Source'
  const typeHeader = ru ? 'Тип' : 'Type'
  const priorityHeader = ru ? 'Приоритет' : 'Priority'
  const planHeader = ru ? 'План' : 'Plan links'
  const cleanTitle = cleanReportTitle
  const cleanReadReason = (raw?: string) => humanReadFailureReason(raw, ru)
  const compactQuote = sanitizeReportQuote
  const sourceType = (e: { publicationType?: string }) => {
    if (!ru) return e.publicationType || 'unclassified'
    if (e.publicationType === 'survey') return 'обзор'
    if (e.publicationType === 'review') return 'обзор'
    if (e.publicationType === 'benchmark') return 'бенчмарк'
    if (e.publicationType === 'method') return 'метод'
    if (e.publicationType === 'tool') return 'инструмент'
    if (e.publicationType === 'safety') return 'безопасность'
    if (e.publicationType === 'background') return 'контекст'
    return 'не классифицирован'
  }
  // Per-source one-line summary in the report language. Prefer a recorded evidence
  // claim citing the source (already in the report language and grounded); fall back
  // to the cleaned abstract/snippet.
  const claimByCorpus = new Map<string, string>()
  const claimsByCorpusAll = new Map<string, string[]>()
  for (const c of claims) {
    for (const id of c.corpusIds || []) {
      if (!c.claim) continue
      if (!claimByCorpus.has(id)) claimByCorpus.set(id, c.claim)
      claimsByCorpusAll.set(id, [...(claimsByCorpusAll.get(id) || []), c.claim])
    }
  }
  // Best-effort: generate consistent, in-language, multi-sentence summaries for the
  // sources presented in the report. Mutates/caches onto the corpus entries.
  const lang = ru ? 'ru' : 'en'
  try { llmSummarizeSources(workspace, outputDir, reportSources, claimsByCorpusAll, ru) } catch {}
  const sourceSummary = (e: CorpusEntry): string => {
    if (e.summary && e.summaryLang === lang) return e.summary
    const claim = claimByCorpus.get(e.id)
    if (claim) {
      const t = claim.replace(/\s+/g, ' ').trim()
      return t.length > 300 ? t.slice(0, 300).trimEnd() + '…' : t
    }
    const snip = stripQuoteMarkup(e.snippet)
    if (snip && !isJunkReportQuote(snip)) return snip.length > 240 ? snip.slice(0, 240).trimEnd() + '…' : snip
    return ru ? '— (выжимка появится после извлечения доказательств)' : '— (summary pending evidence extraction)'
  }
  // Cross-source synthesis: key takeaways (top) + closing conclusion (end).
  const synthesis = (() => {
    try { return llmReportSynthesis(title, claims.map((c) => c.claim).filter(Boolean), ru) } catch { return null }
  })()
  const keyTakeawaysBlock = synthesis?.tldr?.length
    ? [ru ? '## Ключевые выводы' : '## Key Takeaways', '', ...synthesis.tldr.map((t) => `- ${t}`), '']
    : []
  const conclusionBlock = synthesis?.conclusion
    ? [ru ? '## Заключение' : '## Conclusion', '', synthesis.conclusion, '']
    : []
  // Data-driven limitations computed from THIS run (not boilerplate): shortfall vs the
  // requested target, unread/unavailable sources, and any quality gates that had to be
  // downgraded. Surfacing these honestly is more useful to the reader than a clean 17/17.
  const downgradedGates = Array.isArray(spec?.downgradedGates) ? spec!.downgradedGates : []
  const targetSelected = Number(th.minSelected) > 0 ? Number(th.minSelected) : 0
  const weakSelectedNow = selected.filter((e) => (e.topicalPrecisionScore ?? e.relevanceScore ?? 0) < 45).length
  const dataLimitations: string[] = []
  if (ru) {
    if (targetSelected && selected.length < targetSelected) dataLimitations.push(`- Отобрано ${selected.length} источников из целевых ${targetSelected}: релевантных публикаций по теме в доступных базах оказалось меньше запрошенного, поэтому выводы опираются на меньшую доказательную базу.`)
    if (selected.length && read.length < selected.length) dataLimitations.push(`- Полностью прочитано ${read.length} из ${selected.length} отобранных источников; остальные учтены по аннотациям/метаданным и трактуются слабее.`)
    if (unavailable.length) dataLimitations.push(`- У ${unavailable.length} источник(ов) не удалось получить полный текст — они учтены слабее (см. раздел о недоступных источниках).`)
    if (downgradedGates.length) dataLimitations.push(`- Проверки качества, понижённые до предупреждения из-за ограничений доступных источников: ${downgradedGates.join(', ')}.`)
    if (weakSelectedNow) dataLimitations.push(`- ${weakSelectedNow} отобранных источник(ов) имеют пониженную тематическую точность; связанные с ними выводы стоит перепроверить.`)
  } else {
    if (targetSelected && selected.length < targetSelected) dataLimitations.push(`- Selected ${selected.length} of the ${targetSelected} target sources: fewer on-topic publications were available than requested, so conclusions rest on a smaller evidence base.`)
    if (selected.length && read.length < selected.length) dataLimitations.push(`- Read full text for ${read.length} of ${selected.length} selected sources; the rest are used at the abstract/metadata level and weighted lower.`)
    if (unavailable.length) dataLimitations.push(`- Full text could not be retrieved for ${unavailable.length} source(s); they are weighted lower (see the unavailable-sources section).`)
    if (downgradedGates.length) dataLimitations.push(`- Quality gates downgraded to warnings due to limits of the available sources: ${downgradedGates.join(', ')}.`)
    if (weakSelectedNow) dataLimitations.push(`- ${weakSelectedNow} selected source(s) have reduced topical precision; treat conclusions that rely on them with extra caution.`)
  }
  const annotationLines = reportSources.length
    ? reportSources.map((e, i) => `${i + 1}. **${link(cleanTitle(e.title), e.url)}**${e.year ? ` (${e.year})` : ''} \`${e.id}\`\n   ${sourceSummary(e)}`)
    : [ru ? '- Нет прочитанных источников.' : '- No read sources.']
  const topSources = reportSources.map((e, i) => {
    const local = localHref(e.localPath)
    return [
      `| S${i + 1}`,
      `${link(cleanTitle(e.title), e.url)}${e.year ? ` (${e.year})` : ''}`,
      sourceType(e),
      priorityLabel(e.readPriority),
      e.subQuestions?.join(', ') || '-',
      local ? link(fullTextLabel, local) : '-',
      `\`${e.id}\` |`,
    ].join(' | ')
  })
  const reviewLines = reviews.length
    ? reviews.map((e) => {
      const covers = e.subQuestions?.length ? ` — ${ru ? 'покрывает' : 'covers'} ${e.subQuestions.join(', ')}` : ''
      return `- ${link(cleanTitle(e.title), e.url)}${e.year ? ` (${e.year})` : ''} (${sourceTag(e.id)})${covers}`
    })
    : [ru ? '- Обзорных источников среди прочитанных отобранных источников недостаточно; это ограничение.' : '- Review/survey coverage among read selected sources is insufficient; this is a limitation.']
  const unavailableLines = unavailable.length
    ? unavailable.map((e) => `- ${sourceTag(e.id)} ${link(cleanTitle(e.title), e.url)}: ${cleanReadReason(e.readReason) ?? (ru ? 'полный текст недоступен' : 'full text unavailable')}`)
    : [ru ? '- Нет отобранных источников с недоступным полным текстом.' : '- No selected sources have failed full-text reads.']
  const planSections = plan.length ? plan : [{ id: 'Q1', text: ru ? 'Основные результаты исследования' : 'Main research findings', done: true, level: 0, children: [] }]
  const directionRows = planSections.slice(0, 8).map((item) => {
    const rows = (byPlan.get(item.id) || []).slice(0, 4)
    const sourceCount = new Set(rows.flatMap((claim) => claim.corpusIds ?? [])).size
    const strongCount = rows.filter((claim) => evidenceStrength(claim) === (ru ? 'сильная' : 'strong')).length
    const weakCount = rows.length - strongCount
    const titleText = item.text.replace(/^Q\d+\.\s*/, '').replace(/\|/g, '\\|')
    const citeIds = [...new Set(rows.flatMap((c) => c.corpusIds ?? []))].slice(0, 5).map(sourceTag).join(', ') || '-'
    return [
      `| ${item.id}: ${titleText}`,
      ru ? `${rows.length} утвержд.; ${sourceCount} источн.` : `${rows.length} claims; ${sourceCount} source(s)`,
      ru ? `${strongCount} сильных; ${weakCount} ограниченных` : `${strongCount} strong; ${weakCount} limited`,
      `${citeIds} |`,
    ].join(' | ')
  })
  const sectionText = planSections.map((item) => {
    const rows = (byPlan.get(item.id) || []).slice(0, 5)
    const primary = rows.filter((c) => c.evidenceType === 'primary_result' || c.evidenceType === 'benchmark' || c.evidenceType === 'safety_claim')
    const surveys = rows.filter((c) => c.evidenceType === 'survey_statement')
    const metadataOnly = rows.filter((c) => c.notes?.toLowerCase().includes('abstract-only'))
    const bullets = rows.length
      ? rows.map((claim) => {
        const srcs = (claim.corpusIds || []).map((id) => {
          const src = sourceById.get(id)
          const local = localHref(src?.localPath)
          return `${sourceTag(id)}${src ? ` ${sourceLabel(id)}` : ''}${local ? ` (${link(fullTextLabel, local)})` : ''}`
        }).slice(0, 2).join('; ')
        const quote = compactQuote(claim.quote)
        return [
          `- **${claim.claim}**`,
          `  ${ru ? 'Источник' : 'Source'}: ${srcs || cite(claim)}.`,
          `  ${ru ? 'Сила доказательства' : 'Strength'}: ${evidenceStrength(claim)}; ${ru ? 'тип' : 'type'}: ${evidenceTypeLabel(claim.evidenceType)}; ${ru ? 'уверенность' : 'confidence'}=${confidenceLabel(claim.confidence)}.`,
          quote ? `  ${ru ? 'Фрагмент' : 'Quote'}: "${quote}"` : '',
        ].filter(Boolean).join('\n')
      })
      : [ru ? '- По этому разделу нет достаточно сильных доказательных утверждений; раздел требует дополнительного поиска и чтения.' : '- This section lacks strong claim-level evidence and needs more search/reading.']
    return [
      `## ${item.id}. ${item.text.replace(/^Q\d+\.\s*/, '')}`,
      '',
      ru
        ? `**Покрытие:** ${rows.length} доказательных утверждений; первичные/бенчмарк/безопасность=${primary.length}; обзорные=${surveys.length}; только метаданные=${metadataOnly.length}.`
        : `**Coverage:** ${rows.length} claims; primary/benchmark/safety=${primary.length}; survey=${surveys.length}; metadata-only=${metadataOnly.length}.`,
      '',
      ...bullets,
      '',
      ru
        ? 'Комментарий: эти выводы нужно читать как синтез отобранных и прочитанных источников, а не как исчерпывающую карту всей области.'
        : 'Comment: treat these points as a synthesis of selected/read sources, not as an exhaustive map of the whole field.',
    ].join('\n')
  }).join('\n\n')

  if (!ru) {
    return [
      '## Executive Summary',
      '',
      `This report presents the ${reportSources.length} most relevant sources, drawn from ${read.length} read full-text sources and ${selected.length} selected (out of a larger raw corpus). It includes ${reviews.length} review/survey sources and ${claims.length} supported evidence claims. It separates raw discovery from the evidence base: only selected and read material is used for conclusions.`,
      '',
      `The strongest parts of the report are the sections with multiple linked claims, read sources, and direct quotes. Sections with metadata-only evidence, failed full-text access, or few independent sources are treated as limitations rather than settled conclusions.`,
      '',
      ...keyTakeawaysBlock,
      '## How To Use This Report',
      '',
      '- Source IDs are clickable when an external URL is available, for example `[S1](...)` links to the paper page or DOI.',
      '- `full text` links open the local artifact saved under this research run.',
      '- Metadata-only evidence is marked explicitly and should be treated as weaker than full-text evidence.',
      '',
      '## Direction Matrix',
      '',
      '| Research question | Evidence coverage | Evidence strength | Evidence links |',
      '|---|---|---|---|',
      ...directionRows,
      '',
      '## Method And Scope',
      '',
      `The workflow separated raw discovery (${corpus.length} corpus item(s)) from the evidence base (${selected.length} selected, ${read.length} read). Sources were screened for topical precision, recency, authority, review/survey coverage, full-text availability, and claim-level evidence links. Conclusions below use only selected sources and supported evidence claims, not raw search hits.`,
      '',
      '## Evaluation Criteria And Benchmarks',
      '',
      'The synthesis evaluates sources by relevance to each research question, evidence type, recency, authority, independence, and whether claims are grounded in full-text passages or only in metadata/abstracts. Stronger conclusions require multiple read sources or direct primary evidence; weaker conclusions are explicitly marked.',
      '',
      '## Evidence Base',
      '',
      `| # | ${sourceHeader} | ${typeHeader} | ${priorityHeader} | ${planHeader} | ${localArtifactHeader} | ${corpusIdHeader} |`,
      '|---|---|---|---|---|---|---|',
      ...topSources,
      '',
      '## Source Annotations',
      '',
      `Short summary for each of the ${reportSources.length} sources presented in the report (the most relevant out of ${read.length} read). Summaries come from extracted evidence (in the report language) or the source abstract.`,
      '',
      ...annotationLines,
      '',
      '## Review And Survey Anchors',
      '',
      ...reviewLines,
      '',
      '## Unavailable High-Priority Sources',
      '',
      ...unavailableLines,
      '',
      sectionText,
      '',
      '## Cross-Source Interpretation',
      '',
      'Across the evidence, the important distinction is between well-supported findings, plausible but thin findings, and unresolved gaps. The synthesis prioritizes claims that connect to stable corpus IDs, direct quotes, and read local artifacts. Claims supported only by metadata, snippets, or unavailable high-priority sources are kept visible but not over-weighted.',
      '',
      '## Limitations',
      '',
      ...dataLimitations,
      '- This report should not treat unread, failed, or merely queued corpus items as evidence.',
      '- High-priority failed full-text reads require replacement sources or explicit caveats.',
      '- Citation counts and venue quality should be used as ranking signals, but recent 2025-2026 papers may be important despite low citations.',
      '',
      '## Practical Takeaways',
      '',
      '- Use the source table and per-question sections to see which conclusions are strongly supported and which need more reading.',
      '- Treat one-source findings as provisional until confirmed by another independent source or by a stronger full-text passage.',
      '- Keep raw discovery separate from the evidence base; do not cite items that were not selected/read or explicitly marked as metadata-only.',
      '',
      '## Future Directions And Trends',
      '',
      '- Follow-up work should target the weakest plan sections first: low source diversity, metadata-only support, or failed full-text access.',
      '- The next search pass should prioritize replacement sources for unavailable high-priority items and direct primary evidence for thin claims.',
      '- If this report is used for decision-making, rerun quality gates after adding or replacing evidence so limitations stay visible.',
      '',
      ...conclusionBlock,
    ].join('\n')
  }

  return [
    '## Краткое резюме',
    '',
    `В отчёте представлены ${reportSources.length} наиболее релевантных источников (отобраны из ${read.length} прочитанных полнотекстовых и ${selected.length} отобранных, при большем сыром корпусе). Включено ${reviews.length} обзорных источников и ${claims.length} поддержанных доказательных утверждений. Важно: сырой корпус не считается доказательной базой; выводы строятся только по отобранным и прочитанным источникам.`,
    '',
    'Самые сильные части отчёта — те, где есть несколько связанных доказательных утверждений, прочитанные источники и прямые цитаты. Разделы, где опора идёт только на метаданные, аннотации, единичные источники или недоступный полный текст, отмечаются как ограничения, а не как окончательные выводы.',
    '',
    ...keyTakeawaysBlock,
    '## Как пользоваться отчётом',
    '',
    '- Названия источников и ID корпуса кликабельны, если доступен внешний URL/DOI.',
    '- Ссылки `полный текст` открывают локально сохранённый артефакт внутри `.research/.../fulltext`.',
    '- Доказательства уровня “только метаданные/аннотация” явно помечаются и считаются слабее полнотекстовых доказательств.',
    '',
    '## Матрица направлений',
    '',
    '| Исследовательский вопрос | Покрытие доказательствами | Сила доказательств | Ссылки на доказательства |',
    '|---|---|---|---|',
    ...directionRows,
    '',
    '## Метод и подход к отбору источников',
    '',
    `Пайплайн отделяет сырое обнаружение источников (${corpus.length} элементов корпуса) от доказательной базы (${selected.length} ${selectedLabel}, ${read.length} ${readLabel}). Источники отбирались по тематической точности, свежести, авторитетности, наличию обзорных работ, доступности полного текста и связи с доказательными утверждениями. Выводы ниже строятся только на отобранных/прочитанных источниках и поддержанных утверждениях, а не на сырых поисковых совпадениях.`,
    '',
    '## Метрики и критерии оценки',
    '',
    'Источники сравниваются по релевантности к каждому вопросу плана, виду доказательства, свежести, авторитетности, независимости и тому, есть ли привязка к полнотекстовому фрагменту или только к аннотации/метаданным. Сильные выводы требуют нескольких прочитанных источников или прямого первичного доказательства; слабые выводы помечаются явно.',
    '',
    '## Доказательная база',
    '',
    `| # | ${sourceHeader} | ${typeHeader} | ${priorityHeader} | ${planHeader} | ${localArtifactHeader} | ${corpusIdHeader} |`,
    '|---|---|---|---|---|---|---|',
    ...topSources,
    '',
    '## Аннотации источников',
    '',
    ru
      ? `Краткая выжимка по каждому из ${reportSources.length} источников, представленных в отчёте (из ${read.length} прочитанных отобраны самые релевантные). Выжимка берётся из извлечённых доказательств (на языке отчёта) или из аннотации источника.`
      : '',
    '',
    ...annotationLines,
    '',
    '## Обзорные источники',
    '',
    ...reviewLines,
    '',
    '## Недоступные источники высокого приоритета',
    '',
    ...unavailableLines,
    '',
    sectionText,
    '',
    '## Сквозная интерпретация',
    '',
    'Сквозная интерпретация отделяет хорошо подтверждённые выводы от правдоподобных, но тонко подкреплённых утверждений и нерешённых пробелов. Приоритет получают утверждения, связанные со стабильными ID корпуса, прямыми цитатами и локально сохранёнными прочитанными артефактами. Утверждения, основанные только на метаданных, сниппетах или недоступных high-priority источниках, остаются видимыми, но не переоцениваются.',
    '',
    '## Ограничения и риски интерпретации',
    '',
    ...dataLimitations,
    '- Нельзя считать доказательной базой источники, которые остались в очереди, не прочитались или были найдены только в сыром корпусе.',
    '- Источники высокого приоритета с недоступным полным текстом должны быть заменены аналогами или явно отмечены как пробел.',
    '- Число цитирований и качество площадки важны для ранжирования, но свежие статьи 2025–2026 годов могут быть значимыми даже при низком числе цитирований.',
    '- Общие или слишком широкие источники не должны попадать в ядро обзора, если они не отвечают напрямую на вопросы плана.',
    '',
    '## Практические выводы',
    '',
    '- Используйте таблицу источников и секции по вопросам, чтобы быстро увидеть, какие выводы сильные, а какие требуют дополнительного чтения.',
    '- Выводы, основанные на одном источнике, лучше считать предварительными до подтверждения независимым источником или более сильной полнотекстовой цитатой.',
    '- Для каждого крупного вывода нужен ID корпуса, цитата/фрагмент и понимание, является ли источник первичным результатом, обзором или контекстом.',
    '',
    '## Тренды и дальнейшие направления',
    '',
    '- Следующий проход исследования должен начинаться с самых слабых секций плана: мало источников, только метаданные или недоступный полный текст.',
    '- Следующий поиск должен приоритизировать замены для недоступных high-priority источников и первичные источники для тонко подкреплённых утверждений.',
    '- Если отчёт используется для принятия решений, после добавления или замены evidence нужно снова прогнать проверки качества.',
    '',
    '## Приложение: доказательные утверждения',
    '',
    ...claims.slice(0, 30).map((claim) => `- ${claim.claim} Источники: ${cite(claim)}.`),
    '',
    ...conclusionBlock,
  ].join('\n')
}

function listResearchSkillsTool(workspace: string, query?: string): string {
  const skills = query ? recommendSkills(query, cfg.get('selectedPreset'), workspace) : listResearchSkills(workspace)
  if (skills.length === 0) return 'No research skills found.'
  return skills.map((s) => [
    `- ${s.id}: ${s.name}`,
    `  Domain: ${s.domain}`,
    `  Description: ${s.description}`,
    `  Tools: ${s.requiredTools.join(', ') || 'none'}`,
    `  Triggers: ${s.triggers.join(', ')}`,
  ].join('\n')).join('\n')
}

function listDomainConnectorsTool(profileId?: string): string {
  const profile = profileId
    ? (RESEARCH_PROFILES.find((p) => p.id === profileId || p.presetIds.includes(profileId as any)) ?? getResearchProfileByPresetId(profileId))
    : getResearchProfileByPresetId(cfg.get('selectedPreset'))
  return [
    `Profile: ${profile.label} (${profile.domain})`,
    `Preferred tools: ${profile.preferredTools.join(', ')}`,
    '',
    ...profile.sourceConnectors.map((c) => `- ${c.label} [${c.status}]: ${c.description}. Tools: ${c.preferredTools.join(', ')}`),
  ].join('\n')
}

function saveIdeaTool(workspace: string, args: Record<string, any>): string {
  const title = String(args.title ?? '').trim()
  const hypothesis = String(args.hypothesis ?? '').trim()
  const rationale = String(args.rationale ?? '').trim()
  if (!title || !hypothesis || !rationale) return 'Error: title, hypothesis and rationale are required.'
  return saveIdea(workspace, {
    title,
    hypothesis,
    rationale,
    sources: String(args.sources ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    novelty: Math.max(0, Math.min(100, Number(args.novelty) || 60)),
    feasibility: Math.max(0, Math.min(100, Number(args.feasibility) || 60)),
    impact: Math.max(0, Math.min(100, Number(args.impact) || 60)),
    nextSteps: String(args.next_steps ?? '').split(';').map((s) => s.trim()).filter(Boolean),
  }, args.output_dir)
}

function readFile(filePath: string, workspace: string, offset?: number, limit?: number): string {
  const p = resolvePath(filePath, workspace)
  assertInWorkspace(p, workspace)
  if (!fs.existsSync(p)) return `File not found: ${filePath}`
  const stat = fs.statSync(p)
  if (stat.isDirectory()) return `Error: ${filePath} is a directory, not a file. Use list_directory instead.`

  const lines = fs.readFileSync(p, 'utf-8').split('\n')
  const total = lines.length

  const start = Math.max(0, (offset ?? 1) - 1)
  const end = limit ? Math.min(start + limit, total) : total
  const slice = lines.slice(start, end)

  const padWidth = String(end).length
  const numbered = slice.map((line, i) => {
    const lineNum = String(start + i + 1).padStart(padWidth, ' ')
    return `${lineNum}|${line}`
  })

  let result = numbered.join('\n')
  if (result.length > 100000) result = result.slice(0, 100000) + '\n… [truncated]'

  const header = `[${filePath}] (${total} lines)`
  if (start > 0 || end < total) {
    return `${header} showing lines ${start + 1}-${end}:\n${result}`
  }
  return `${header}\n${result}`
}

function writeFile(filePath: string, content: string, workspace: string): string {
  const p = String(filePath || '').replace(/\\/g, '/').startsWith('.research/')
    ? resolveResearchOutputPath(filePath, workspace, filePath)
    : resolvePath(filePath, workspace)
  assertInWorkspace(p, workspace)
  const relPath = path.relative(workspace, p).replace(/\\/g, '/')
  if (/^\.research\/.*\/?report\.md$/i.test(relPath) || relPath === '.research/report.md') {
    return [
      'Error: direct write_file to research report.md is blocked.',
      'Use generate_evidence_report with the same output_dir instead. It writes report.md plus evidence-report.md and enforces/post-verifies quality gates.',
      'Do not bypass quality gates by writing report.md manually.',
    ].join('\n')
  }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
  const lines = content.split('\n').length
  return `Created ${filePath} (${lines} lines, ${content.length} bytes)`
}

function runNodeScript(source: string, args: string[], timeoutMs = 120000): string {
  return execFileSync(process.execPath, ['-e', source, ...args], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 10,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      ELECTRON_RUN_AS_NODE: '1',
    },
  })
}

/** Block the current thread for `ms` without busy-waiting. Safe here because the
 * search tools already run synchronously via execFileSync. */
function sleepSync(ms: number): void {
  if (!(ms > 0)) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.ceil(ms))
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) { /* fallback spin */ }
  }
}

// Per-host minimum spacing between outbound requests. Some scholarly APIs
// (notably arXiv's export endpoint and key-less Semantic Scholar) return
// 500/429 for rapid bursts no matter how many times we retry, because the whole
// burst lands inside the same rate-limit window. Spacing requests out turns a
// burst into a sequence the API actually accepts.
const lastRequestAtByHost: Record<string, number> = {}
function throttleHost(host: string, minIntervalMs: number): void {
  const now = Date.now()
  const earliest = (lastRequestAtByHost[host] ?? 0) + minIntervalMs
  const delay = Math.max(0, earliest - now)
  // Reserve this slot now (wall clock after the delay) so concurrent/sequential
  // callers each get their own spaced slot.
  lastRequestAtByHost[host] = now + delay
  sleepSync(delay)
}

// Circuit breaker: once a host rate-limits us (e.g. arXiv answering 400/429/500),
// it stays angry for a while. Hammering it just keeps the penalty alive and wastes
// time. After a trip we "open the breaker" for a cooldown window and short-circuit
// further calls so the agent immediately pivots to alternative sources instead.
// arXiv is a primary source, so prefer adaptive backoff over abandoning it: only
// open the breaker after a *sustained* streak (4 in a row), and keep the cooldown
// short. The adaptive throttle below does the real work of staying under the limit.
const hostBreaker = new HostBreaker(4, 15000)
// Base 3s spacing (arXiv's published guideline), widening up to 30s when it
// rate-limits and decaying back to 3s as requests succeed again.
const arxivThrottle = new AdaptiveThrottle(3000, 30000, 2)

/**
 * Snippet injected into spawned fetch scripts so every network request has a hard
 * abort deadline. Without this a slow/hung host blocks the synchronous worker thread
 * for the full process timeout (no events emitted), which both looks like "the search
 * tool never responds" and eventually trips the run watchdog. Use together with a
 * runNodeScript timeout that is a few seconds larger than the abort deadline so the
 * fetch aborts first and produces a clean, actionable error.
 */
function fetchWithTimeoutSnippet(ms: number): string {
  return `const __ctrl = new AbortController()
const __timer = setTimeout(() => __ctrl.abort(), ${ms})
const __abortSignal = __ctrl.signal
const __fetchErr = (err) => {
  const name = err && err.name
  if (name === 'AbortError' || name === 'TimeoutError') return 'request timed out after ${Math.round(ms / 1000)}s'
  return String((err && err.message) || err)
}`
}

/**
 * Injects __fetchRetry(url, init, retries, baseDelayMs) into a spawned script.
 * Used only for arXiv's export API, which — on rapid bursts — rate-limits with
 * 400/429/500 (confirmed: a burst returns HTTP 400 even for well-formed queries).
 * Our arXiv queries are always well-formed (all:...), so all of these are treated
 * as transient and retried with backoff.
 * Retries on transient failures (HTTP 5xx / 429 and network errors) with
 * exponential backoff, while propagating abort/timeout immediately. APIs like
 * arXiv's export endpoint return 500/503 when hit in rapid bursts, so a couple
 * of polite retries turn a hard failure into a successful response.
 */
function fetchRetrySnippet(): string {
  return `async function __fetchRetry(url, init, retries, baseDelayMs) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init)
      if ((res.status >= 500 || res.status === 429 || res.status === 400) && attempt < retries) {
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt)))
        continue
      }
      return res
    } catch (err) {
      lastErr = err
      const name = err && err.name
      if (name === 'AbortError' || name === 'TimeoutError') throw err
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt)))
        continue
      }
      throw err
    }
  }
  throw lastErr
}`
}

/**
 * Injects a self-contained __httpGet(url, init, opts) into a spawned script.
 * It applies a per-request abort timeout (so a stalled connection can't block
 * for the whole runNodeScript budget), retries transient 5xx/429/network/timeout
 * failures with exponential backoff, and reads the body within the timeout
 * window. Returns { ok, status, url, text }. Ideal for the JSON/HTML search APIs
 * which otherwise have no timeout and no retry. opts: { retries, baseDelayMs, timeoutMs }.
 */
function httpGetSnippet(): string {
  return `async function __httpGet(url, init, opts) {
  const o = opts || {}
  const retries = o.retries == null ? 3 : o.retries
  const baseDelayMs = o.baseDelayMs == null ? 1500 : o.baseDelayMs
  const timeoutMs = o.timeoutMs == null ? 20000 : o.timeoutMs
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(url, Object.assign({}, init || {}, { signal: ctrl.signal }))
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt)))
        continue
      }
      const text = await res.text()
      return { ok: res.ok, status: res.status, url: res.url || url, text }
    } catch (err) {
      lastErr = err
      const name = err && err.name
      const isTimeout = name === 'AbortError' || name === 'TimeoutError'
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt)))
        continue
      }
      if (isTimeout) throw new Error('request timed out after ' + Math.round(timeoutMs / 1000) + 's')
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr
}`
}

function normalizeArxivId(input: string): string {
  return String(input ?? '')
    .trim()
    .replace(/\.pdf$/i, '')
    .replace(/\/abs\//, '')
    .replace(/\/html\//, '')
    .replace(/\/pdf\//, '')
    .replace(/^https?:\/\/arxiv\.org\/abs\//i, '')
    .replace(/^https?:\/\/arxiv\.org\/html\//i, '')
    .replace(/^https?:\/\/arxiv\.org\/pdf\//i, '')
}

export function getBuiltinToolDefinitions(cfg?: Pick<AppConfig, 'webSearchProvider' | 'searxngBaseUrl'> | null): typeof TOOL_DEFINITIONS {
  const searchEnabled = shouldEnableWebSearchTool({
    webSearchProvider: cfg?.webSearchProvider ?? (cfg?.searxngBaseUrl ? 'custom-searxng' : 'disabled'),
    searxngBaseUrl: cfg?.searxngBaseUrl ?? null,
  })
  return TOOL_DEFINITIONS.filter((tool) => {
    if (tool.function.name === 'search_web' && !searchEnabled) return false
    if (tool.function.name === 'smart_search' && !searchEnabled) {
      // smart_search still works with academic-only sources, so we keep it
      return true
    }
    return true
  })
}

function escapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractXmlTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match ? escapeXml(match[1]) : ''
}

function extractXmlTags(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'))].map((match) => escapeXml(match[1]))
}

function clampSearchLimit(maxResults: number | undefined): number {
  return Math.max(1, Math.min(10, Number(maxResults) || 5))
}

function formatDateToYmd(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

function detectFreshnessHints(rawQuery: string): {
  freshness: boolean
  today: boolean
  week: boolean
  month: boolean
  year: boolean
} {
  const q = String(rawQuery ?? '').toLowerCase()
  const freshness = /(latest|recent|newest|fresh|today|this week|this month|this year|last week|last month|последн|свеж|новейш|сегодня|свежие|за сегодня|за неделю|за месяц|на этой неделе|в этом месяце|в этом году)/.test(q)
  return {
    freshness,
    today: /(today|сегодня|за сегодня)/.test(q),
    week: /(this week|last week|за неделю|на этой неделе)/.test(q),
    month: /(this month|last month|за месяц|в этом месяце)/.test(q),
    year: /(this year|в этом году|за год)/.test(q),
  }
}

function inferDateWindow(rawQuery: string): { fromDate: string | null; toDate: string | null; freshness: boolean } {
  const hints = detectFreshnessHints(rawQuery)
  const now = new Date()
  if (hints.today) {
    const ymd = formatDateToYmd(now)
    return { fromDate: ymd, toDate: ymd, freshness: true }
  }
  if (hints.week) {
    const from = new Date(now)
    from.setDate(now.getDate() - 7)
    return { fromDate: formatDateToYmd(from), toDate: formatDateToYmd(now), freshness: true }
  }
  if (hints.month) {
    const from = new Date(now.getFullYear(), now.getMonth(), 1)
    return { fromDate: formatDateToYmd(from), toDate: formatDateToYmd(now), freshness: true }
  }
  if (hints.year) {
    const from = new Date(now.getFullYear(), 0, 1)
    return { fromDate: formatDateToYmd(from), toDate: formatDateToYmd(now), freshness: true }
  }
  return { fromDate: null, toDate: null, freshness: hints.freshness }
}

function isFreshnessOnlyQuery(rawQuery: string): boolean {
  const stripped = String(rawQuery ?? '')
    .replace(/latest|recent|newest|fresh|today|this week|this month|this year|last week|last month|papers?|articles?|стат(ьи|ей|ья)|последн\w*|свеж\w*|новейш\w*|сегодня|за сегодня|за неделю|за месяц|на этой неделе|в этом месяце|в этом году/gi, '')
    .trim()
  return stripped.length === 0 || !/[a-zа-я0-9]{4,}/i.test(stripped)
}

function normalizeIsoDate(value: string | undefined): string | null {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return null
  if (/^\d{8}$/.test(trimmed)) return trimmed
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  return `${match[1]}${match[2]}${match[3]}`
}

function generateReport(
  title: string,
  content: string,
  outputPath: string | undefined,
  sessionId: string | undefined,
  workspace: string,
  opts?: { ignoreFinalReportStructureGate?: boolean; allowEvidenceReportGenerator?: boolean },
): string {
  const trimmedTitle = String(title ?? '').trim()
  if (!trimmedTitle) return 'Error: title is required.'
  const trimmedContent = String(content ?? '').trim()
  if (!trimmedContent) return 'Error: content is required.'

  const targetPath = resolveResearchOutputPath(outputPath, workspace, '.research/report.md')
  assertInWorkspace(targetPath, workspace)
  const relDir = path.relative(workspace, path.dirname(targetPath)) || '.research'
  const normalizedReportPath = path.relative(workspace, targetPath).replace(/\\/g, '/')
  if (/^\.research\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_.+\/report\.md$/i.test(normalizedReportPath) && !opts?.allowEvidenceReportGenerator) {
    return [
      'Error: generate_report is not allowed for managed research report.md.',
      `Use generate_evidence_report with output_dir: "${relDir}" instead. It builds the narrative report from corpus/evidence and verifies quality gates.`,
      'Do not try to create report.md manually or by wrapping an existing file.',
    ].join('\n')
  }
  const gateFailure = latestQualityGateFailure(
    workspace,
    relDir,
    opts?.ignoreFinalReportStructureGate ? { ignoreGates: ['final_report_structure'] } : undefined,
  )
  if (gateFailure) {
    return `Error: quality gates are failing. Final report generation is blocked until blockers are resolved.\n${gateFailure}\n\nContinue screening/reading corpus, extracting evidence, and rerun run_quality_gates.`
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })

  let references = ''
  if (sessionId) {
    try {
      const tracker = getSourceTracker(sessionId)
      const refText = tracker.formatForReport()
      if (refText) references = `\n\n---\n\n## References\n\n${refText}\n`
    } catch {}
  }

  const date = new Date().toISOString().slice(0, 10)
  const contentWithoutDuplicateTitle = trimmedContent.replace(new RegExp(`^#\\s+${escapeRegExp(trimmedTitle)}\\s*\\n+`, 'i'), '')
  const isRussianReport = /[а-яё]/i.test(`${trimmedTitle}\n${contentWithoutDuplicateTitle.slice(0, 1200)}`)
  const generatedLabel = isRussianReport ? 'Сгенерировано' : 'Generated'
  const report = `# ${trimmedTitle}\n\n*${generatedLabel}: ${date}*\n\n${contentWithoutDuplicateTitle}${references}\n`

  fs.writeFileSync(targetPath, report, 'utf-8')
  const relPath = path.relative(workspace, targetPath)
  return `Report saved to ${relPath} (${report.length} chars, ${references ? 'with' : 'without'} references section).`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function reflectOnFindings(findings: string, criteria?: string, sessionId?: string): string {
  const trimmed = String(findings ?? '').trim()
  if (!trimmed) return 'Error: findings text is required.'

  const allCriteria = ['completeness', 'accuracy', 'contradictions', 'gaps', 'bias', 'recency']
  const requested = criteria
    ? String(criteria).split(',').map((c) => c.trim().toLowerCase()).filter((c) => allCriteria.includes(c))
    : allCriteria
  if (requested.length === 0) requested.push(...allCriteria)

  // Gather source context for LLM critic
  let sourcesContext = ''
  if (sessionId) {
    try {
      const tracker = getSourceTracker(sessionId)
      if (tracker.count() > 0) {
        sourcesContext = '\n\n' + tracker.formatForSystemPrompt(3000)
      }
    } catch {}
  }

  // Try LLM-based critic via llama-server
  const llmCritic = tryLlmCritic(trimmed, requested, sourcesContext)
  if (llmCritic) return llmCritic

  // Fallback: static checklist
  const checklist: string[] = [
    '## Self-Reflection Checklist (static fallback)\n',
    'Evaluate the findings below against each criterion. For each, note whether the findings PASS, NEED IMPROVEMENT, or FAIL, and explain why.\n',
    `### Findings under review\n${trimmed.slice(0, 2000)}${trimmed.length > 2000 ? '\n...[truncated]' : ''}\n`,
  ]

  const criteriaDescriptions: Record<string, string> = {
    completeness: 'Are all aspects of the research question addressed? Are there sub-topics that were not explored?',
    accuracy: 'Are claims supported by the cited sources? Are there unsupported assertions presented as facts?',
    contradictions: 'Do any findings contradict each other? Are conflicting viewpoints acknowledged and resolved?',
    gaps: 'What important information is missing? What follow-up searches or analyses would strengthen the conclusions?',
    bias: 'Is the evidence one-sided? Are alternative perspectives represented? Is there selection bias in sources?',
    recency: 'Are the sources up-to-date for this topic? Are there more recent developments that should be included?',
  }

  for (const c of requested) {
    checklist.push(`### ${c.charAt(0).toUpperCase() + c.slice(1)}`)
    checklist.push(`${criteriaDescriptions[c]}\n`)
    checklist.push(`- [ ] Verdict: ___\n- [ ] Notes: ___\n`)
  }

  checklist.push('### Action Items')
  checklist.push('Based on the above evaluation, list specific next steps to improve the research quality before presenting final conclusions.\n')

  return checklist.join('\n')
}

/**
 * Call the running llama-server synchronously (via child Node process) with a
 * structured critic prompt. Returns null on any failure — caller falls back to
 * the static checklist.
 */
function tryLlmCritic(findings: string, criteria: string[], sourcesContext: string): string | null {
  const apiUrl = 'http://127.0.0.1:7863'
  const prompt = `You are a rigorous research critic. Review the findings below and produce concise structured markdown feedback.

# Criteria to evaluate
${criteria.map((c) => `- ${c}`).join('\n')}

# Findings under review
${findings.slice(0, 6000)}${findings.length > 6000 ? '\n... [truncated]' : ''}${sourcesContext}

# Required output format (return EXACTLY this structure, nothing else)

## Strengths
- 3–5 bullet points.

## Gaps
- Missing sub-topics, under-explored angles, absent stakeholders.

## Contradictions
- Conflicts between findings or between findings and cited sources (or "None detected.").

## Weak Sources
- Sources that look speculative, outdated, or uncited (or "None detected.").

## Action Items
- Concrete next search queries or verification steps (3–5 max).

Be direct, specific, and evidence-based. Do not repeat the findings verbatim.`

  const script = `
(async () => {
  const res = await fetch(process.argv[1] + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local',
      messages: [
        { role: 'system', content: 'You are a rigorous research critic. Follow the requested output format exactly.' },
        { role: 'user', content: process.argv[2] },
      ],
      temperature: 0.3,
      max_tokens: 900,
    }),
  })
  if (!res.ok) { console.error('HTTP ' + res.status); process.exit(1) }
  const json = await res.json()
  process.stdout.write(String(json?.choices?.[0]?.message?.content || ''))
})().catch((err) => { console.error(String(err?.message || err)); process.exit(1) })
`
  try {
    const out = execFileSync(process.execPath, ['-e', script, apiUrl, prompt], {
      encoding: 'utf-8',
      timeout: 90000,
      maxBuffer: 1024 * 1024 * 2,
      env: { ...process.env, FORCE_COLOR: '0', ELECTRON_RUN_AS_NODE: '1' },
    }).trim()
    if (out.length < 50) return null
    return `## Self-Reflection (LLM critic)\n\n${out}`
  } catch { return null }
}

function searchArxiv(
  query: string,
  maxResults?: number,
  fromDate?: string,
  toDate?: string,
  sortBy?: string,
  sortOrder?: string,
  start?: number,
): string {
  const trimmedQuery = String(query ?? '').trim()
  if (!trimmedQuery) return 'Error: query is required.'

  const limit = clampSearchLimit(maxResults)
  const startOffset = Number.isFinite(Number(start)) ? Math.max(0, Math.trunc(Number(start))) : 0

  const cacheParams = { q: trimmedQuery.toLowerCase(), limit, fromDate: fromDate ?? null, toDate: toDate ?? null, sortBy: sortBy ?? null, sortOrder: sortOrder ?? null, start: startOffset }
  const cached = searchCache.get('search_arxiv', cacheParams)
  if (cached) return `[cached]\n${cached}`

  // If arXiv recently rate-limited us, don't hit it again — pivot to alternatives.
  const cooldown = hostBreaker.coolingDownFor('arxiv')
  if (cooldown > 0) {
    return `Error: arXiv is cooling down after rate-limiting (~${Math.ceil(cooldown / 1000)}s left). Do NOT keep retrying arXiv now. Use search_openalex, search_semantic_scholar, or search_crossref instead — they index most arXiv papers — or call smart_search to query several sources at once.`
  }

  const inferredWindow = inferDateWindow(trimmedQuery)
  const freshnessHints = detectFreshnessHints(trimmedQuery)
  const normalizedFrom = normalizeIsoDate(fromDate) ?? inferredWindow.fromDate
  const normalizedTo = normalizeIsoDate(toDate) ?? inferredWindow.toDate
  if (fromDate && !normalizedFrom) return 'Error: from_date must be in YYYY-MM-DD or YYYYMMDD format.'
  if (toDate && !normalizedTo) return 'Error: to_date must be in YYYY-MM-DD or YYYYMMDD format.'

  const safeSortBy = ['relevance', 'submittedDate', 'lastUpdatedDate'].includes(String(sortBy ?? ''))
    ? String(sortBy)
    : inferredWindow.freshness ? 'submittedDate' : 'relevance'
  const safeSortOrder = ['ascending', 'descending'].includes(String(sortOrder ?? ''))
    ? String(sortOrder)
    : 'descending'
  const dateFilter = (normalizedFrom || normalizedTo)
    ? ` AND submittedDate:[${normalizedFrom ? normalizedFrom + '0000' : '*'} TO ${normalizedTo ? normalizedTo + '2359' : '*'}]`
    : ''
  const script = `
${fetchWithTimeoutSnippet(25000)}
${fetchRetrySnippet()}
const query = process.argv[1]
const limit = Number(process.argv[2] || '5')
const sortBy = process.argv[3] || 'relevance'
const sortOrder = process.argv[4] || 'descending'
const dateFilter = process.argv[5] || ''
const searchQuery = dateFilter ? '(all:' + query + ')' + dateFilter : 'all:' + query
const startOffset = Number(process.argv[6] || '0')
// Use https directly: http://export.arxiv.org now 301-redirects to https, and
// the extra hop is a needless failure point.
const url = 'https://export.arxiv.org/api/query?search_query=' + encodeURIComponent(searchQuery) + '&start=' + startOffset + '&max_results=' + limit + '&sortBy=' + encodeURIComponent(sortBy) + '&sortOrder=' + encodeURIComponent(sortOrder)
// Fail fast: do NOT retry. arXiv's export API rate-limits per IP, and retrying a
// 429/500 only deepens the penalty (and the website CDN stays up, which is why
// arxiv.org loads in a browser while this API 500s). One attempt, then pivot.
__fetchRetry(url, {
  headers: { 'User-Agent': 'one-click-research-agent/0.1 (mailto:research@example.com)' },
  signal: __abortSignal,
}, 0, 0).then(async (res) => {
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const text = await res.text()
  process.stdout.write(text)
}).catch((err) => {
  console.error(__fetchErr(err))
  process.exit(1)
}).finally(() => clearTimeout(__timer))
`

  // arXiv asks for no more than ~1 request every 3s and a single connection at a
  // time. Use adaptive spacing: stays at 3s normally, widens automatically if arXiv
  // starts rate-limiting, so a long run keeps using arXiv without tripping the limit.
  throttleHost('arxiv', arxivThrottle.current('arxiv'))

  let xml = ''
  try {
    xml = runNodeScript(script, [trimmedQuery, String(limit), safeSortBy, safeSortOrder, dateFilter, String(startOffset)], 40000)
  } catch (e: any) {
    const stderr = String(e?.stderr || e?.message || e).trim()
    const rateLimited = /HTTP 5\d\d|HTTP 429|HTTP 400|timed out/i.test(stderr)
    // Back off adaptively so the NEXT arXiv call waits longer instead of piling
    // onto the limit. Only open the breaker after a *sustained* streak.
    if (rateLimited) arxivThrottle.onRateLimited('arxiv')
    const tripped = rateLimited && hostBreaker.recordFailure('arxiv')
    const cause = /timed out/i.test(stderr)
      ? ' arXiv (export.arxiv.org) did not respond in time.'
      : /HTTP 5\d\d|HTTP 429|HTTP 400/i.test(stderr)
        ? ' arXiv throttles rapid bursts with 400/429/500 (the export API is a separate service, so it can be busy even when arxiv.org opens fine in a browser).'
        : ''
    const guidance = tripped
      ? ' arXiv is now on a short cooldown — pause it and use search_openalex / search_semantic_scholar / search_crossref (they index most arXiv papers) or smart_search.'
      : rateLimited
        ? ' This is usually transient — wait a few seconds and retry, or query search_openalex / search_semantic_scholar / search_crossref / smart_search meanwhile.'
        : ''
    return `Error: failed to search arXiv.${cause}${guidance} ${stderr}`.trim()
  }
  // Successful contact clears any prior penalty assumption and decays the spacing
  // back toward the base interval so arXiv speeds up again once it's happy.
  hostBreaker.recordSuccess('arxiv')
  arxivThrottle.onSuccess('arxiv')

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]).slice(0, limit)
  if (entries.length === 0) return `No arXiv papers found for "${trimmedQuery}".`

  const lines = entries.map((entry, idx) => {
    const idUrl = extractXmlTag(entry, 'id')
    const id = idUrl.split('/abs/').pop() || idUrl
    const normalizedId = normalizeArxivId(id)
    const title = extractXmlTag(entry, 'title')
    const summary = extractXmlTag(entry, 'summary')
    const published = extractXmlTag(entry, 'published')
    const authors = extractXmlTags(entry, 'name').join(', ')
    const categories = [...entry.matchAll(/<category[^>]*term="([^"]+)"/gi)].map((match) => match[1]).join(', ')
    const absUrl = `https://arxiv.org/abs/${normalizedId}`
    const htmlUrl = `https://arxiv.org/html/${normalizedId}`
    const pdfUrl = `https://arxiv.org/pdf/${normalizedId.replace(/v\\d+$/, '')}.pdf`
    return [
      `${idx + 1}. ${title}`,
      `   arXiv ID: ${normalizedId}`,
      `   Authors: ${authors || 'Unknown'}`,
      `   Published: ${published || 'Unknown'}`,
      `   Categories: ${categories || 'Unknown'}`,
      `   Abstract: ${absUrl}`,
      `   HTML: ${htmlUrl}`,
      `   PDF: ${pdfUrl}`,
      `   Summary: ${summary || 'No summary available.'}`,
    ].join('\n')
  })

  const filters: string[] = []
  if (normalizedFrom) filters.push(`from ${normalizedFrom.slice(0, 4)}-${normalizedFrom.slice(4, 6)}-${normalizedFrom.slice(6, 8)}`)
  if (normalizedTo) filters.push(`to ${normalizedTo.slice(0, 4)}-${normalizedTo.slice(4, 6)}-${normalizedTo.slice(6, 8)}`)
  filters.push(`sort ${safeSortBy} ${safeSortOrder}`)
  const out = `Found ${entries.length} arXiv paper(s) for "${trimmedQuery}" (${filters.join(', ')}):\n\n${lines.join('\n\n')}`
  searchCache.set('search_arxiv', cacheParams, out)
  return out
}

function searchWeb(
  query: string,
  maxResults: number | undefined,
  categories: string | undefined,
  language: string | undefined,
  timeRange: string | undefined,
): string {
  const trimmedQuery = String(query ?? '').trim()
  if (!trimmedQuery) return 'Error: query is required.'

  const webSearchCfg = loadWebSearchConfig()
  let searxngBaseUrl: string | null = null
  try {
    searxngBaseUrl = resolveWebSearchBaseUrl(webSearchCfg, true)
  } catch (e: any) {
    const message = String(e?.message || e).trim()
    return `Error: failed to prepare SearXNG backend. ${message}`
  }
  if (!searxngBaseUrl) {
    const status = getWebSearchStatus(webSearchCfg)
    return `Error: web search is unavailable. ${status.detail}`
  }

  const inferredWindow = inferDateWindow(trimmedQuery)
  const freshnessHints = detectFreshnessHints(trimmedQuery)
  const limit = Math.max(1, Math.min(10, Number(maxResults) || 5))
  const params = new URLSearchParams({
    q: trimmedQuery,
    format: 'json',
  })
  if (categories && String(categories).trim()) params.set('categories', String(categories).trim())
  if (language && String(language).trim()) params.set('language', String(language).trim())
  const effectiveTimeRange = String(timeRange ?? '').trim()
    || (freshnessHints.today ? 'day' : freshnessHints.week || freshnessHints.month ? 'month' : freshnessHints.year ? 'year' : '')
  if (effectiveTimeRange) params.set('time_range', effectiveTimeRange)

  // Retry transient SearXNG failures (cold container start, upstream-engine 5xx/429)
  // with backoff instead of failing the first time — matches the academic search tools.
  const script = `
${httpGetSnippet()}
const baseUrl = process.argv[1]
const queryString = process.argv[2]
;(async () => {
  const r = await __httpGet(baseUrl + '/search?' + queryString, {
    headers: { 'User-Agent': 'one-click-research-agent/0.1', Accept: 'application/json' },
  }, { retries: 2, baseDelayMs: 1200, timeoutMs: 20000 })
  if (!r.ok) { console.error('HTTP ' + r.status); process.exit(1) }
  process.stdout.write(r.text)
})().catch((err) => { console.error(String((err && err.message) || err)); process.exit(1) })
`

  let payload: any
  try {
    const out = runNodeScript(script, [searxngBaseUrl, params.toString()], 75000)
    payload = JSON.parse(out)
  } catch (e: any) {
    const stderr = String(e?.stderr || e?.message || e).trim()
    const hint = /timed out/i.test(stderr)
      ? ` SearXNG at ${searxngBaseUrl} did not respond in time. If you are using managed SearXNG, the container may still be starting — retry once; otherwise check the backend in Settings.`
      : ''
    return `Error: failed to search via SearXNG. ${stderr}${hint}`
  }

  // SearXNG returns the engines that failed/were rate-limited for this query.
  const unresponsive: string[] = Array.isArray(payload?.unresponsive_engines)
    ? payload.unresponsive_engines.map((u: any) => (Array.isArray(u) ? String(u[0]) : String(u))).filter(Boolean)
    : []
  const results = Array.isArray(payload?.results) ? payload.results.slice(0, limit) : []
  if (results.length === 0) {
    // Distinguish "genuinely nothing" from "engines were throttled/unreachable" so the
    // model retries or switches tools instead of concluding the topic has no sources.
    if (unresponsive.length) {
      return `No web results for "${trimmedQuery}" right now — ${unresponsive.length} SearXNG engine(s) were unresponsive or rate-limited (${unresponsive.slice(0, 6).join(', ')}). This is usually transient: wait a few seconds and retry, narrow the query, or use smart_search to also query academic sources.`
    }
    return `No web results found for "${trimmedQuery}".`
  }

  const lines = results.map((entry: any, idx: number) => {
    const title = String(entry?.title || 'Untitled').trim()
    const url = String(entry?.url || entry?.link || '').trim()
    const snippet = String(entry?.content || entry?.snippet || '').replace(/\s+/g, ' ').trim()
    const engines = Array.isArray(entry?.engines)
      ? entry.engines.join(', ')
      : String(entry?.engine || entry?.source || entry?.category || '').trim()
    const published = String(entry?.publishedDate || entry?.published || entry?.date || '').trim()
    return [
      `${idx + 1}. ${title}`,
      url ? `   URL: ${url}` : null,
      engines ? `   Engines: ${engines}` : null,
      published ? `   Published: ${published}` : null,
      snippet ? `   Snippet: ${snippet}` : null,
    ].filter(Boolean).join('\n')
  })

  const throttleNote = unresponsive.length
    ? `\n\n(Note: ${unresponsive.length} engine(s) were unresponsive/rate-limited this time: ${unresponsive.slice(0, 6).join(', ')}. Re-run for broader coverage if needed.)`
    : ''
  return `Found ${results.length} web result(s) for "${trimmedQuery}"${effectiveTimeRange ? ` (time_range=${effectiveTimeRange})` : ''}:\n\n${lines.join('\n\n')}${throttleNote}`
}

function searchHuggingFacePapers(query: string, maxResults?: number): string {
  const trimmedQuery = String(query ?? '').trim()
  if (!trimmedQuery) return 'Error: query is required.'

  const limit = clampSearchLimit(maxResults)
  const inferredWindow = inferDateWindow(trimmedQuery)
  const script = `
${httpGetSnippet()}
const query = process.argv[1]
const limit = Number(process.argv[2] || '5')
const latestMode = process.argv[3] === '1'
function decodeHtmlText(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}
function extractObjects(text, limit) {
  const marker = '{"paper":{"id":"'
  const out = []
  let index = 0
  while (out.length < limit && (index = text.indexOf(marker, index)) !== -1) {
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let i = index; i < text.length; i++) {
      const ch = text[i]
      if (escaped) { escaped = false; continue }
      if (ch === '\\\\' && inString) { escaped = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) { end = i + 1; break }
      }
    }
    if (end <= index) break
    try {
      const obj = JSON.parse(text.slice(index, end))
      if (obj && obj.paper && obj.paper.id) out.push(obj)
    } catch {}
    index = end
  }
  return out
}
const url = latestMode ? 'https://huggingface.co/papers' : 'https://huggingface.co/papers?q=' + encodeURIComponent(query)
;(async () => {
  const r = await __httpGet(url, { headers: { 'User-Agent': 'one-click-research-agent/0.1' } }, { timeoutMs: 20000 })
  if (!r.ok) { console.error('HTTP ' + r.status); process.exit(1) }
  const html = decodeHtmlText(r.text)
  process.stdout.write(JSON.stringify(extractObjects(html, limit)))
})().catch((err) => { console.error(String(err?.message || err)); process.exit(1) })
`

  let items: any[] = []
  try {
    const freshnessOnly = inferredWindow.freshness && isFreshnessOnlyQuery(trimmedQuery)
    const out = runNodeScript(script, [trimmedQuery, String(limit), freshnessOnly ? '1' : '0'], 30000)
    items = JSON.parse(out)
  } catch (e: any) {
    const stderr = String(e?.stderr || e?.message || e).trim()
    const hint = /HTTP 5\d\d|HTTP 429|timed out/i.test(stderr)
      ? ' Hugging Face Papers was slow or rate-limited even after retries. Try again shortly or use search_arxiv / search_openalex.'
      : ''
    return `Error: failed to search Hugging Face Papers. ${stderr}${hint}`
  }

  if (!Array.isArray(items) || items.length === 0) {
    return `No Hugging Face Papers results found for "${trimmedQuery}".`
  }

  const lines = items.slice(0, limit).map((entry: any, idx: number) => {
    const paper = entry?.paper ?? {}
    const title = String(entry?.title || paper?.title || 'Untitled').trim()
    const paperId = String(paper?.id || '').trim()
    const summary = String(entry?.summary || paper?.summary || '').replace(/\s+/g, ' ').trim()
    const org = String(entry?.organization?.fullname || entry?.organization?.name || paper?.organization?.fullname || '').trim()
    const projectPage = String(paper?.projectPage || '').trim()
    const githubRepo = String(paper?.githubRepo || '').trim()
    const published = String(entry?.publishedAt || paper?.publishedAt || '').trim()
    const upvotes = Number.isFinite(Number(paper?.upvotes)) ? String(paper.upvotes) : ''
    const comments = Number.isFinite(Number(entry?.numComments)) ? String(entry.numComments) : ''
    const authors = Array.isArray(paper?.authors)
      ? paper.authors.map((author: any) => String(author?.name || '').trim()).filter(Boolean).slice(0, 8).join(', ')
      : ''
    const paperUrl = paperId ? `https://huggingface.co/papers/${paperId}` : ''
    const arxivUrl = paperId ? `https://arxiv.org/abs/${paperId}` : ''
    return [
      `${idx + 1}. ${title}`,
      paperId ? `   Paper ID: ${paperId}` : null,
      paperUrl ? `   Hugging Face: ${paperUrl}` : null,
      arxivUrl ? `   arXiv: ${arxivUrl}` : null,
      projectPage ? `   Project: ${projectPage}` : null,
      githubRepo ? `   GitHub: ${githubRepo}` : null,
      org ? `   Organization: ${org}` : null,
      authors ? `   Authors: ${authors}` : null,
      published ? `   Published: ${published}` : null,
      upvotes ? `   Upvotes: ${upvotes}` : null,
      comments ? `   Comments: ${comments}` : null,
      summary ? `   Summary: ${summary}` : null,
    ].filter(Boolean).join('\n')
  })

  return `Found ${Math.min(items.length, limit)} Hugging Face Papers result(s) for "${trimmedQuery}":\n\n${lines.join('\n\n')}`
}

function searchOpenAlex(query: string, maxResults?: number, yearFrom?: number, yearTo?: number): string {
  const trimmedQuery = String(query ?? '').trim()
  if (!trimmedQuery) return 'Error: query is required.'

  const limit = clampSearchLimit(maxResults)
  const inferredWindow = inferDateWindow(trimmedQuery)
  const inferredMinYear = inferredWindow.fromDate ? Number(inferredWindow.fromDate.slice(0, 4)) : null
  const inferredMaxYear = inferredWindow.toDate ? Number(inferredWindow.toDate.slice(0, 4)) : null
  const minYear = Number.isFinite(Number(yearFrom)) ? Math.trunc(Number(yearFrom)) : inferredMinYear
  const maxYear = Number.isFinite(Number(yearTo)) ? Math.trunc(Number(yearTo)) : inferredMaxYear
  if (minYear !== null && (minYear < 1900 || minYear > 2100)) return 'Error: year_from must be between 1900 and 2100.'
  if (maxYear !== null && (maxYear < 1900 || maxYear > 2100)) return 'Error: year_to must be between 1900 and 2100.'
  if (minYear !== null && maxYear !== null && minYear > maxYear) return 'Error: year_from cannot be greater than year_to.'

  const params = new URLSearchParams()
  const freshnessOnly = inferredWindow.freshness && isFreshnessOnlyQuery(trimmedQuery)
  if (!freshnessOnly) params.set('search', trimmedQuery)
  const filters: string[] = []
  if (inferredWindow.fromDate) filters.push(`from_publication_date:${inferredWindow.fromDate.slice(0, 4)}-${inferredWindow.fromDate.slice(4, 6)}-${inferredWindow.fromDate.slice(6, 8)}`)
  else if (minYear !== null) filters.push(`from_publication_date:${minYear}-01-01`)
  if (inferredWindow.toDate) filters.push(`to_publication_date:${inferredWindow.toDate.slice(0, 4)}-${inferredWindow.toDate.slice(4, 6)}-${inferredWindow.toDate.slice(6, 8)}`)
  else if (maxYear !== null) filters.push(`to_publication_date:${maxYear}-12-31`)
  if (filters.length > 0) params.set('filter', filters.join(','))
  params.set('per_page', String(limit))
  if (inferredWindow.freshness) params.set('sort', 'publication_date:desc')

  const script = `
${httpGetSnippet()}
const url = 'https://api.openalex.org/works?' + process.argv[1]
;(async () => {
  const r = await __httpGet(url, { headers: { 'User-Agent': 'one-click-research-agent/0.1', Accept: 'application/json' } }, { timeoutMs: 20000 })
  if (!r.ok) { console.error('HTTP ' + r.status); process.exit(1) }
  process.stdout.write(r.text)
})().catch((err) => { console.error(String(err?.message || err)); process.exit(1) })
`

  let payload: any
  try {
    payload = JSON.parse(runNodeScript(script, [params.toString()], 30000))
  } catch (e: any) {
    const stderr = String(e?.stderr || e?.message || e).trim()
    const hint = /HTTP 5\d\d|HTTP 429|timed out/i.test(stderr)
      ? ' OpenAlex was slow or rate-limited even after retries. Wait a moment and retry, or use search_crossref / search_semantic_scholar.'
      : ''
    return `Error: failed to search OpenAlex. ${stderr}${hint}`
  }

  const items = Array.isArray(payload?.results) ? payload.results.slice(0, limit) : []
  if (items.length === 0) return `No OpenAlex papers found for "${trimmedQuery}".`

  const lines = items.map((entry: any, idx: number) => {
    const title = String(entry?.display_name || entry?.title || 'Untitled').trim()
    const url = String(entry?.id || '').trim()
    const doi = String(entry?.doi || '').trim()
    const landingPage = String(entry?.primary_location?.landing_page_url || '').trim()
    const openAccessPdf = String(entry?.primary_location?.pdf_url || '').trim()
    const year = entry?.publication_year ? String(entry.publication_year) : ''
    const venue = String(entry?.primary_location?.source?.display_name || '').trim()
    const publicationDate = String(entry?.publication_date || '').trim()
    const citationCount = Number.isFinite(Number(entry?.cited_by_count)) ? String(entry.cited_by_count) : ''
    const abstract = entry?.abstract_inverted_index
      ? Object.entries(entry.abstract_inverted_index as Record<string, number[]>)
          .flatMap(([word, positions]) => (positions as number[]).map((pos) => [pos, word] as const))
          .sort((a, b) => a[0] - b[0])
          .map(([, word]) => word)
          .join(' ')
      : ''
    const authors = Array.isArray(entry?.authorships)
      ? entry.authorships.map((authorship: any) => String(authorship?.author?.display_name || '').trim()).filter(Boolean).slice(0, 10).join(', ')
      : ''
    const fieldsOfStudy = Array.isArray(entry?.concepts)
      ? entry.concepts.map((concept: any) => String(concept?.display_name || '').trim()).filter(Boolean).slice(0, 6).join(', ')
      : ''
    return [
      `${idx + 1}. ${title}`,
      year ? `   Year: ${year}` : null,
      venue ? `   Venue: ${venue}` : null,
      publicationDate ? `   Published: ${publicationDate}` : null,
      authors ? `   Authors: ${authors}` : null,
      citationCount ? `   Citations: ${citationCount}` : null,
      fieldsOfStudy ? `   Fields: ${fieldsOfStudy}` : null,
      url ? `   OpenAlex: ${url}` : null,
      doi ? `   DOI: ${doi}` : null,
      landingPage ? `   Landing Page: ${landingPage}` : null,
      openAccessPdf ? `   Open PDF: ${openAccessPdf}` : null,
      abstract ? `   Abstract: ${abstract.replace(/\s+/g, ' ').trim()}` : null,
    ].filter(Boolean).join('\n')
  })

  const filterText = inferredWindow.fromDate || inferredWindow.toDate
    ? `, dates ${inferredWindow.fromDate ? `${inferredWindow.fromDate.slice(0, 4)}-${inferredWindow.fromDate.slice(4, 6)}-${inferredWindow.fromDate.slice(6, 8)}` : '*'}..${inferredWindow.toDate ? `${inferredWindow.toDate.slice(0, 4)}-${inferredWindow.toDate.slice(4, 6)}-${inferredWindow.toDate.slice(6, 8)}` : '*'}`
    : minYear !== null || maxYear !== null
      ? `, years ${minYear ?? '*'}-${maxYear ?? '*'}`
      : ''
  return `Found ${items.length} OpenAlex paper(s) for "${trimmedQuery}"${filterText}:\n\n${lines.join('\n\n')}`
}

function downloadArxivHtml(arxivId: string, outputPath: string | undefined, workspace: string): string {
  const trimmedId = String(arxivId ?? '').trim()
  if (!trimmedId) return 'Error: arxiv_id is required.'

  const normalizedId = normalizeArxivId(trimmedId)
  const safeId = normalizedId.replace(/\//g, '_')
  const targetPath = resolveResearchOutputPath(outputPath, workspace, path.join('.research', 'arxiv', `${safeId}.html`))
  assertInWorkspace(targetPath, workspace)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })

  const htmlUrl = `https://arxiv.org/html/${normalizedId}`
  const script = `
${httpGetSnippet()}
const url = process.argv[1]
const outPath = process.argv[2]
;(async () => {
  const r = await __httpGet(url, { headers: { 'User-Agent': 'one-click-research-agent/0.1' } }, { timeoutMs: 30000 })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  require('fs').writeFileSync(outPath, r.text, 'utf-8')
  process.stdout.write(String(r.text.length))
})().catch((err) => { console.error(String(err?.message || err)); process.exit(1) })
`

  let charCount = 0
  try {
    const out = runNodeScript(script, [htmlUrl, targetPath], 40000).trim()
    charCount = Number(out) || fs.readFileSync(targetPath, 'utf-8').length
  } catch (e: any) {
    const stderr = String(e?.stderr || e?.message || e).trim()
    if (stderr.includes('HTTP 404')) {
      return `Error: arXiv HTML is not available for ${normalizedId}. Use download_arxiv_pdf as a fallback.`
    }
    return `Error: failed to download arXiv HTML. ${stderr}`
  }

  return `Downloaded arXiv HTML ${normalizedId} to ${path.relative(workspace, targetPath) || targetPath} (${charCount} chars)`
}

function downloadArxivPdf(arxivId: string, outputPath: string | undefined, workspace: string): string {
  const trimmedId = String(arxivId ?? '').trim()
  if (!trimmedId) return 'Error: arxiv_id is required.'

  const normalizedId = normalizeArxivId(trimmedId)
  const safeId = normalizedId.replace(/\//g, '_')
  const targetPath = resolveResearchOutputPath(outputPath, workspace, path.join('.research', 'arxiv', `${safeId}.pdf`))
  assertInWorkspace(targetPath, workspace)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })

  const pdfUrl = `https://arxiv.org/pdf/${normalizedId.replace(/v\d+$/, '')}.pdf`

  const script = `
${fetchWithTimeoutSnippet(45000)}
const url = process.argv[1]
const outPath = process.argv[2]
fetch(url, {
  headers: { 'User-Agent': 'one-click-research-agent/0.1' },
  signal: __abortSignal,
}).then(async (res) => {
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const arr = new Uint8Array(await res.arrayBuffer())
  require('fs').writeFileSync(outPath, Buffer.from(arr))
  process.stdout.write(String(arr.byteLength))
}).catch((err) => {
  console.error(__fetchErr(err))
  process.exit(1)
}).finally(() => clearTimeout(__timer))
`

  let byteCount = 0
  try {
    const out = runNodeScript(script, [pdfUrl, targetPath], 55000).trim()
    byteCount = Number(out) || fs.statSync(targetPath).size
  } catch (e: any) {
    const stderr = String(e?.stderr || e?.message || e).trim()
    const hint = /timed out/i.test(stderr)
      ? ' The PDF download timed out (large file or slow mirror). Skip this source or try the HTML version (arxiv.org/html/<id>).'
      : ''
    return `Error: failed to download arXiv PDF. ${stderr}${hint}`
  }

  return `Downloaded arXiv PDF ${normalizedId} to ${path.relative(workspace, targetPath) || targetPath} (${byteCount} bytes)`
}

function editFile(filePath: string, oldStr: string, newStr: string, workspace: string): string {
  const p = resolvePath(filePath, workspace)
  assertInWorkspace(p, workspace)
  if (!fs.existsSync(p)) return `File not found: ${filePath}`

  const content = fs.readFileSync(p, 'utf-8')
  const count = content.split(oldStr).length - 1

  if (count === 0) {
    return `Error: old_string not found in ${filePath}. Make sure you copied the exact text including whitespace.`
  }
  if (count > 1) {
    return `Error: old_string found ${count} times in ${filePath}. It must be unique — include more surrounding context.`
  }

  const newContent = content.replace(oldStr, newStr)
  fs.writeFileSync(p, newContent)

  const oldLines = oldStr.split('\n').length
  const newLines = newStr.split('\n').length
  return `Edited ${filePath}: replaced ${oldLines} lines with ${newLines} lines`
}

function appendFile(filePath: string, content: string, workspace: string): string {
  const p = resolvePath(filePath, workspace)
  assertInWorkspace(p, workspace)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const existed = fs.existsSync(p)
  fs.appendFileSync(p, content)
  const totalContent = fs.readFileSync(p, 'utf-8')
  const totalLines = totalContent.split('\n').length
  const appendedLines = content.split('\n').length
  return existed
    ? `Appended to ${filePath}: +${appendedLines} lines (total: ${totalLines} lines, ${totalContent.length} bytes)`
    : `Created ${filePath} with ${appendedLines} lines (${content.length} bytes)`
}

function listDir(dirPath: string | undefined, workspace: string, maxDepth: number): string {
  const p = resolvePath(dirPath, workspace)
  assertInWorkspace(p, workspace)
  if (!fs.existsSync(p)) return `Not found: ${dirPath ?? '.'}`

  const lines: string[] = []
  const relRoot = path.relative(workspace, p) || '.'
  lines.push(`${relRoot}/`)

  function walk(dir: string, prefix: string, depth: number) {
    if (depth > maxDepth) {
      lines.push(`${prefix}└── …`)
      return
    }
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries = entries
      .filter((e) => !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const isLast = i === entries.length - 1
      const connector = isLast ? '└── ' : '├── '
      const childPrefix = isLast ? '    ' : '│   '

      if (entry.isDirectory()) {
        lines.push(`${prefix}${connector}${entry.name}/`)
        walk(path.join(dir, entry.name), prefix + childPrefix, depth + 1)
      } else {
        lines.push(`${prefix}${connector}${entry.name}`)
      }
    }
  }

  walk(p, '', 1)
  let result = lines.join('\n')
  if (result.length > 50000) result = result.slice(0, 50000) + '\n… [truncated]'
  return result
}

function findFiles(pattern: string, type: string, searchPath: string | undefined, workspace: string): string {
  const p = searchPath ? resolvePath(searchPath, workspace) : workspace
  assertInWorkspace(p, workspace)

  if (type === 'content') {
    try {
      const out = execSync(
        `rg --max-count=100 --line-number --no-heading --color=never -e ${JSON.stringify(pattern)} ${JSON.stringify(p)}`,
        { timeout: 30000, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 5 },
      )
      if (!out.trim()) return `No matches for '${pattern}'`
      const result = out.length > 50000 ? out.slice(0, 50000) + '\n… [truncated]' : out
      const matchCount = result.split('\n').filter(Boolean).length
      return `Found ${matchCount} matches for '${pattern}':\n${result}`
    } catch {
      return `No matches for '${pattern}'`
    }
  }

  // type === 'name': use find with glob
  try {
    const cmd = process.platform === 'win32'
      ? `dir /s /b "${p}\\${pattern}" 2>nul`
      : `find ${JSON.stringify(p)} -name ${JSON.stringify(pattern)} -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/__pycache__/*" 2>/dev/null | head -200`
    const out = execSync(cmd, { timeout: 15000, encoding: 'utf-8', maxBuffer: 1024 * 1024 })
    if (!out.trim()) return `No files matching '${pattern}'`
    const files = out.trim().split('\n').map((f) => path.relative(workspace, f))
    return `Found ${files.length} file(s) matching '${pattern}':\n${files.join('\n')}`
  } catch {
    return `No files matching '${pattern}'`
  }
}

const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\//, // rm -rf /
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev/,
  />\s*\/dev\/sd/,
  /\bchmod\s+777\s+\//,
  /\bchown\s+.*\s+\//,
  /\bcurl\b.*\|\s*(ba)?sh/,
  /\bwget\b.*\|\s*(ba)?sh/,
]

function execCommand(command: string, cwd: string | undefined, workspace: string): string {
  const workDir = cwd ? resolvePath(cwd, workspace) : workspace
  assertInWorkspace(workDir, workspace)

  // Intercept cat/head/tail — redirect to read_file for efficiency
  const catMatch = command.match(/^\s*cat\s+(.+?)\s*$/)
  if (catMatch) {
    const filePath = catMatch[1].replace(/^['"]|['"]$/g, '')
    return `[Hint: use read_file tool instead of cat for better context efficiency]\n` + readFile(filePath, workspace)
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return `Error: command blocked — matches dangerous pattern. Command: ${command}`
    }
  }

  try {
    const isWin = process.platform === 'win32'
    const out = execSync(command, {
      cwd: workDir,
      timeout: 120000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 10,
      env: { ...process.env, FORCE_COLOR: '0' },
      shell: isWin ? 'cmd.exe' : '/bin/sh',
    })
    let result = out
    if (result.length > 80000) result = result.slice(0, 80000) + '\n… [truncated]'
    return `Exit code: 0\n${result}`
  } catch (e: any) {
    const out = ((e.stdout ?? '') + '\n' + (e.stderr ?? '')).trim()
    const result = out.length > 80000 ? out.slice(0, 80000) + '\n… [truncated]' : out
    return `Exit code: ${e.status ?? -1}\n${result}`
  }
}

function createDir(dirPath: string, workspace: string): string {
  const p = resolvePath(dirPath, workspace)
  assertInWorkspace(p, workspace)
  fs.mkdirSync(p, { recursive: true })
  return `Created directory: ${dirPath}`
}

function deleteFile(filePath: string, workspace: string): string {
  const p = resolvePath(filePath, workspace)
  assertInWorkspace(p, workspace)
  if (!fs.existsSync(p)) return `File not found: ${filePath}`
  const stat = fs.statSync(p)
  if (stat.isDirectory()) return `Error: ${filePath} is a directory. Use execute_command with "rm -r" instead.`
  fs.unlinkSync(p)
  return `Deleted: ${filePath}`
}

// ---------------------------------------------------------------------------
// New research tools (Wave 1-6)
// ---------------------------------------------------------------------------

function parseDocumentTool(filePath: string, workspace: string, maxPages?: number): string {
  if (!filePath) return 'Error: path is required.'
  const p = resolvePath(filePath, workspace)
  assertInWorkspace(p, workspace)
  if (!fs.existsSync(p)) return `File not found: ${filePath}`
  const ext = path.extname(p).toLowerCase()
  if (!isDocumentExtension(ext)) return `parse_document supports .pdf/.docx/.doc only. For ${ext} use read_file.`
  try {
    const parsed = parseDocument(p, maxPages)
    const header = parsed.pages ? `Parsed ${filePath} — ${parsed.pages} pages, ${parsed.text.length} chars.\n\n` : `Parsed ${filePath} — ${parsed.text.length} chars.\n\n`
    const body = summarizeParsedForPrompt(parsed, 24000)
    return header + body
  } catch (e: any) {
    return `Error: parse_document failed. ${e?.message || e}`
  }
}

function verifySources(sessionId: string | undefined, maxSources?: number): string {
  if (!sessionId) return 'Error: no session context. verify_sources is only usable from within an agent session.'
  const tracker = getSourceTracker(sessionId)
  const all = tracker.getAll()
  if (all.length === 0) return 'No sources collected in this session yet — nothing to verify.'
  const limit = Math.max(1, Math.min(all.length, Number(maxSources) || all.length))
  const toCheck = all.slice(0, limit)
  const lines: string[] = [`Verified ${toCheck.length} source(s):`]
  const counts = { live: 0, archived: 0, dead: 0, hallucinated: 0, unknown: 0 }
  for (const src of toCheck) {
    const h = checkUrlHealth(src.url)
    tracker.updateHealth(src.url, h)
    counts[h.status] = (counts[h.status] || 0) + 1
    const extra = h.archivedUrl ? ` → archived: ${h.archivedUrl}` : (h.error ? ` (${h.error.slice(0, 80)})` : '')
    lines.push(`[${src.idx}] ${formatHealthBadge(h)}${h.httpStatus ? ` (HTTP ${h.httpStatus})` : ''} — ${src.url}${extra}`)
  }
  lines.push('')
  lines.push(`Summary: live=${counts.live}, archived=${counts.archived}, dead=${counts.dead}, hallucinated=${counts.hallucinated}, unknown=${counts.unknown}`)
  return lines.join('\n')
}

function planResearch(question: string, subQuestions: unknown, workspace: string, sessionId: string | undefined, outputDir?: string): string {
  const q = String(question ?? '').trim()
  if (!q) return 'Error: question is required.'
  const list = Array.isArray(subQuestions) ? subQuestions.map((s) => String(s || '').trim()).filter(Boolean) : []
  if (list.length === 0) return 'Error: sub_questions must be a non-empty array.'
  if (list.length > 10) list.length = 10
  try {
    writePlan(workspace, q, list, outputDir)
  } catch (e: any) {
    return `Error: failed to write plan. ${e?.message || e}`
  }
  const preview = list.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
  return `Plan saved to ${canonicalResearchOutputDir(outputDir)}/plan.md\n${preview}\n\nNext steps: investigate each sub-question (optionally via spawn_sub_researcher), then use update_plan_status to mark items done.`
}

function updatePlanStatus(itemId: string, done: boolean, workspace: string, outputDir?: string): string {
  if (!itemId) return 'Error: item_id is required.'
  const ok = updatePlanItem(workspace, String(itemId), Boolean(done), outputDir)
  if (!ok) return `Could not find plan item "${itemId}" in ${canonicalResearchOutputDir(outputDir)}/plan.md. Make sure plan_research was called first and the id exists (e.g. "Q2").`
  const items = parsePlan(workspace, outputDir)
  const progress = planProgress(items)
  return `Updated "${itemId}" → ${done ? 'done' : 'open'}. Progress: ${progress.done}/${progress.total} (${progress.pct}%).`
}

function searchCrossref(query: string, maxResults?: number, yearFrom?: number, yearTo?: number): string {
  const q = String(query ?? '').trim()
  if (!q) return 'Error: query is required.'
  const limit = clampSearchLimit(maxResults)
  const cacheParams = { q: q.toLowerCase(), limit, yearFrom: yearFrom ?? null, yearTo: yearTo ?? null }
  const cached = searchCache.get('search_crossref', cacheParams)
  if (cached) return `[cached]\n${cached}`

  const config = (() => { try { return cfg.load() } catch { return null } })()
  const mailto = config?.crossrefMailto ? String(config.crossrefMailto).trim() : ''
  const params = new URLSearchParams()
  params.set('query', q)
  params.set('rows', String(limit))
  const filters: string[] = []
  if (Number.isFinite(Number(yearFrom))) filters.push(`from-pub-date:${Math.trunc(Number(yearFrom))}-01-01`)
  if (Number.isFinite(Number(yearTo))) filters.push(`until-pub-date:${Math.trunc(Number(yearTo))}-12-31`)
  if (filters.length) params.set('filter', filters.join(','))
  if (mailto) params.set('mailto', mailto)

  const script = `
${httpGetSnippet()}
(async () => {
  const url = 'https://api.crossref.org/works?' + process.argv[1]
  const r = await __httpGet(url, { headers: { 'User-Agent': 'one-click-research-agent/0.1 (${mailto || 'mailto:researcher@example.com'})' } }, { timeoutMs: 20000 })
  if (!r.ok) { console.error('HTTP ' + r.status); process.exit(1) }
  process.stdout.write(r.text)
})().catch((err) => { console.error(String(err?.message || err)); process.exit(1) })
`
  let payload: any
  try { payload = JSON.parse(runNodeScript(script, [params.toString()], 30000)) } catch (e: any) {
    const stderr = String(e?.stderr || e?.message || e).trim()
    const hint = /HTTP 5\d\d|HTTP 429|timed out/i.test(stderr)
      ? ' Crossref was slow or rate-limited even after retries. Try again shortly or use search_openalex / search_semantic_scholar.'
      : ''
    return `Error: Crossref search failed. ${stderr}${hint}`
  }
  const items: any[] = Array.isArray(payload?.message?.items) ? payload.message.items : []
  if (items.length === 0) return `No Crossref works found for "${q}".`
  const lines = items.slice(0, limit).map((it: any, idx: number) => {
    const title = Array.isArray(it.title) ? it.title[0] : (it.title || 'Untitled')
    const doi = it.DOI ? `https://doi.org/${it.DOI}` : ''
    const urlRaw = it.URL || doi
    const journal = Array.isArray(it['container-title']) ? it['container-title'][0] : ''
    const publisher = it.publisher || ''
    const type = it.type || ''
    const issued = it.issued?.['date-parts']?.[0]?.join('-') || ''
    const authors = Array.isArray(it.author)
      ? it.author.map((a: any) => `${a.given || ''} ${a.family || ''}`.trim()).filter(Boolean).slice(0, 10).join(', ')
      : ''
    return [
      `${idx + 1}. ${title}`,
      doi ? `   DOI: ${doi}` : null,
      urlRaw ? `   URL: ${urlRaw}` : null,
      authors ? `   Authors: ${authors}` : null,
      journal ? `   Journal: ${journal}` : null,
      publisher ? `   Publisher: ${publisher}` : null,
      type ? `   Type: ${type}` : null,
      issued ? `   Published: ${issued}` : null,
    ].filter(Boolean).join('\n')
  })
  const out = `Found ${Math.min(items.length, limit)} Crossref work(s) for "${q}":\n\n${lines.join('\n\n')}`
  searchCache.set('search_crossref', cacheParams, out)
  return out
}

function searchSemanticScholar(query: string, maxResults?: number, yearFrom?: number, yearTo?: number): string {
  const q = String(query ?? '').trim()
  if (!q) return 'Error: query is required.'
  const limit = clampSearchLimit(maxResults)
  const cacheParams = { q: q.toLowerCase(), limit, yearFrom: yearFrom ?? null, yearTo: yearTo ?? null }
  const cached = searchCache.get('search_semantic_scholar', cacheParams)
  if (cached) return `[cached]\n${cached}`

  const config = (() => { try { return cfg.load() } catch { return null } })()
  const apiKey = config?.semanticScholarApiKey ? String(config.semanticScholarApiKey).trim() : ''
  const params = new URLSearchParams()
  params.set('query', q)
  params.set('limit', String(limit))
  params.set('fields', 'title,authors,year,venue,abstract,citationCount,url,externalIds,publicationDate')
  if (Number.isFinite(Number(yearFrom)) || Number.isFinite(Number(yearTo))) {
    const from = Number.isFinite(Number(yearFrom)) ? String(Math.trunc(Number(yearFrom))) : ''
    const to = Number.isFinite(Number(yearTo)) ? String(Math.trunc(Number(yearTo))) : ''
    params.set('year', `${from}-${to}`)
  }

  const headerLiteral = apiKey ? `, 'x-api-key': '${apiKey.replace(/'/g, "\\'")}'` : ''
  const script = `
${httpGetSnippet()}
(async () => {
  const url = 'https://api.semanticscholar.org/graph/v1/paper/search?' + process.argv[1]
  const r = await __httpGet(url, { headers: { 'User-Agent': 'one-click-research-agent/0.1'${headerLiteral} } }, { timeoutMs: 20000 })
  if (!r.ok) { console.error('HTTP ' + r.status); process.exit(1) }
  process.stdout.write(r.text)
})().catch((err) => { console.error(String(err?.message || err)); process.exit(1) })
`
  // Key-less Semantic Scholar shares a strict pool (~1 req/s) and 429s on bursts.
  throttleHost('semantic-scholar', 1200)

  let payload: any
  try { payload = JSON.parse(runNodeScript(script, [params.toString()], 30000)) } catch (e: any) {
    const stderr = String(e?.stderr || e?.message || e).trim()
    if (stderr.includes('HTTP 403') || stderr.includes('HTTP 429')) {
      return `Semantic Scholar is rate-limited or unavailable (${stderr.match(/HTTP \d+/)?.[0] || 'network error'}). Try search_crossref or search_openalex instead.`
    }
    const hint = /HTTP 5\d\d|timed out/i.test(stderr)
      ? ' Semantic Scholar was slow or returned a server error even after retries. Try search_crossref or search_openalex.'
      : ''
    return `Error: Semantic Scholar search failed. ${stderr}${hint}`
  }
  const items: any[] = Array.isArray(payload?.data) ? payload.data : []
  if (items.length === 0) return `No Semantic Scholar papers found for "${q}".`
  const lines = items.slice(0, limit).map((it: any, idx: number) => {
    const title = it.title || 'Untitled'
    const year = it.year ? String(it.year) : ''
    const venue = it.venue || ''
    const url = it.url || (it.externalIds?.DOI ? `https://doi.org/${it.externalIds.DOI}` : '')
    const authors = Array.isArray(it.authors)
      ? it.authors.map((a: any) => a?.name).filter(Boolean).slice(0, 10).join(', ')
      : ''
    const abstract = String(it.abstract || '').replace(/\s+/g, ' ').slice(0, 400)
    const cites = Number.isFinite(Number(it.citationCount)) ? String(it.citationCount) : ''
    return [
      `${idx + 1}. ${title}`,
      year ? `   Year: ${year}` : null,
      url ? `   URL: ${url}` : null,
      authors ? `   Authors: ${authors}` : null,
      venue ? `   Venue: ${venue}` : null,
      cites ? `   Citations: ${cites}` : null,
      abstract ? `   Abstract: ${abstract}` : null,
    ].filter(Boolean).join('\n')
  })
  const out = `Found ${Math.min(items.length, limit)} Semantic Scholar paper(s) for "${q}":\n\n${lines.join('\n\n')}`
  searchCache.set('search_semantic_scholar', cacheParams, out)
  return out
}

function searchPubMed(query: string, maxResults?: number, yearFrom?: number, yearTo?: number): string {
  const q = String(query ?? '').trim()
  if (!q) return 'Error: query is required.'
  const limit = clampSearchLimit(maxResults)
  const cacheParams = { q: q.toLowerCase(), limit, yearFrom: yearFrom ?? null, yearTo: yearTo ?? null }
  const cached = searchCache.get('search_pubmed', cacheParams)
  if (cached) return `[cached]\n${cached}`

  let effectiveQuery = q
  const yearFilter: string[] = []
  if (Number.isFinite(Number(yearFrom))) yearFilter.push(`PUB_YEAR:[${Math.trunc(Number(yearFrom))} TO *]`)
  if (Number.isFinite(Number(yearTo))) yearFilter.push(`PUB_YEAR:[* TO ${Math.trunc(Number(yearTo))}]`)
  if (yearFilter.length) effectiveQuery = `(${q}) AND (${yearFilter.join(' AND ')})`

  const params = new URLSearchParams()
  params.set('query', effectiveQuery)
  params.set('format', 'json')
  params.set('pageSize', String(limit))
  params.set('resultType', 'core')

  const script = `
${httpGetSnippet()}
(async () => {
  const url = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?' + process.argv[1]
  const r = await __httpGet(url, { headers: { 'User-Agent': 'one-click-research-agent/0.1', Accept: 'application/json' } }, { timeoutMs: 20000 })
  if (!r.ok) { console.error('HTTP ' + r.status); process.exit(1) }
  process.stdout.write(r.text)
})().catch((err) => { console.error(String(err?.message || err)); process.exit(1) })
`
  let payload: any
  try { payload = JSON.parse(runNodeScript(script, [params.toString()], 30000)) } catch (e: any) {
    const stderr = String(e?.stderr || e?.message || e).trim()
    const hint = /HTTP 5\d\d|HTTP 429|timed out/i.test(stderr)
      ? ' Europe PMC was slow or rate-limited even after retries. Try again shortly or use search_crossref / search_openalex.'
      : ''
    return `Error: Europe PMC (PubMed) search failed. ${stderr}${hint}`
  }
  const items: any[] = Array.isArray(payload?.resultList?.result) ? payload.resultList.result : []
  if (items.length === 0) return `No PubMed / Europe PMC papers found for "${q}".`
  const lines = items.slice(0, limit).map((it: any, idx: number) => {
    const title = String(it.title || 'Untitled').trim().replace(/\.$/, '')
    const journal = it.journalInfo?.journal?.title || it.journalTitle || ''
    const pubDate = String(it.firstPublicationDate || it.pubYear || '').trim()
    const pmid = it.pmid || ''
    const doi = it.doi ? `https://doi.org/${it.doi}` : ''
    const url = doi || (pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '')
    const authors = String(it.authorString || '').trim()
    const abstract = String(it.abstractText || '').replace(/\s+/g, ' ').slice(0, 400)
    return [
      `${idx + 1}. ${title}`,
      pubDate ? `   Published: ${pubDate}` : null,
      authors ? `   Authors: ${authors}` : null,
      journal ? `   Journal: ${journal}` : null,
      url ? `   URL: ${url}` : null,
      doi ? `   DOI: ${doi}` : null,
      abstract ? `   Abstract: ${abstract}` : null,
    ].filter(Boolean).join('\n')
  })
  const out = `Found ${Math.min(items.length, limit)} PubMed / Europe PMC paper(s) for "${q}":\n\n${lines.join('\n\n')}`
  searchCache.set('search_pubmed', cacheParams, out)
  return out
}

function smartSearch(query: string, maxPerSource: number | undefined, workspace: string): string {
  const q = String(query ?? '').trim()
  if (!q) return 'Error: query is required.'
  const perSource = Math.max(1, Math.min(6, Number(maxPerSource) || 4))
  const decision = classifyQuery(q)
  const webSearchAvailable = (() => {
    try {
      const conf = loadWebSearchConfig()
      return !!resolveWebSearchBaseUrl(conf, false)
    } catch { return false }
  })()

  const parts: string[] = [`# smart_search "${q}"`]
  parts.push(`Classifier: ${decision.classes.join(', ')}; sources: ${decision.sources.join(', ')}`)
  parts.push('')
  const seenUrls = new Set<string>()
  const mergedResults: string[] = []

  for (const tool of decision.sources) {
    let out: string | null = null
    try {
      if (tool === 'search_web') {
        if (!webSearchAvailable) { mergedResults.push(`## search_web\nskipped (SearXNG not configured)`); continue }
        out = searchWeb(q, perSource, undefined, undefined, undefined)
      } else if (tool === 'search_arxiv') {
        out = searchArxiv(q, perSource)
      } else if (tool === 'search_openalex') {
        out = searchOpenAlex(q, perSource)
      } else if (tool === 'search_huggingface_papers') {
        out = searchHuggingFacePapers(q, perSource)
      } else if (tool === 'search_crossref') {
        out = searchCrossref(q, perSource)
      } else if (tool === 'search_semantic_scholar') {
        out = searchSemanticScholar(q, perSource)
      } else if (tool === 'search_pubmed') {
        out = searchPubMed(q, perSource)
      }
    } catch (e: any) { out = `Error: ${e?.message || e}` }
    if (!out) continue
    const sources = extractSourcesFromToolResult(tool, out)
    const unique = sources.filter((s) => {
      if (!s.url) return false
      if (seenUrls.has(s.url)) return false
      seenUrls.add(s.url)
      return true
    })
    mergedResults.push(`## ${tool} (${unique.length} new / ${sources.length} total)\n${out}`)
  }

  return parts.concat(mergedResults).join('\n\n')
}

function fetchUrlTool(url: string, format: string | undefined, workspace: string): string {
  const u = String(url ?? '').trim()
  if (!u) return 'Error: url is required.'
  if (!/^https?:\/\//i.test(u)) return 'Error: only http(s) URLs are supported.'

  const fmt = (format === 'html' || format === 'text' || format === 'markdown') ? format : 'markdown'
  const kind = classifyUrlImpl(u)

  // Delegate arxiv to existing tools for consistent local caching
  if (kind === 'arxiv-abs') {
    const id = extractArxivId(u)
    if (id) {
      const download = downloadArxivHtml(id, undefined, workspace)
      return `fetch_url detected arXiv abstract; downloaded HTML locally.\n${download}`
    }
  }
  if (kind === 'arxiv-pdf') {
    const id = extractArxivId(u)
    if (id) {
      const download = downloadArxivPdf(id, undefined, workspace)
      return `fetch_url detected arXiv PDF; downloaded PDF locally.\n${download}\nNext step: call parse_document on the downloaded file.`
    }
  }

  const cacheKey = { url: u, format: fmt }
  const cached = searchCache.get('fetch_url', cacheKey)
  if (cached) return `[cached]\n${cached}`

  const result = fetchUrlImpl(u, fmt)
  if ('error' in result && result.error) {
    if (result.isBinary && result.contentTypeHint === 'pdf') {
      return `fetch_url: remote returned a PDF (Content-Type: ${result.contentType}). Use download_arxiv_pdf or save the file with execute_command and parse_document.`
    }
    return `Error: fetch_url failed — ${result.error}`
  }
  const page = result as any
  const excerpt = (page.content || '').length > 32000 ? page.content.slice(0, 32000) + '\n… [truncated]' : page.content
  const header = [
    `Title: ${page.title}`,
    `URL: ${page.finalUrl}`,
    page.byline ? `Byline: ${page.byline}` : null,
    page.siteName ? `Site: ${page.siteName}` : null,
    page.publishedTime ? `Published: ${page.publishedTime}` : null,
    `Format: ${fmt}`,
    `Length: ${page.length} chars`,
  ].filter(Boolean).join('\n')
  const out = `${header}\n\n---\n\n${excerpt}`
  searchCache.set('fetch_url', cacheKey, out)
  return out
}

async function screenshotPageTool(url: string, outputPath: string | undefined, fullPage: boolean | undefined, workspace: string): Promise<string> {
  const u = String(url ?? '').trim()
  if (!u) return 'Error: url is required.'
  if (!/^https?:\/\//i.test(u)) return 'Error: only http(s) URLs are supported.'
  const slug = u.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 80) + '.png'
  const out = outputPath ? resolvePath(outputPath, workspace) : resolvePath(path.join('.research', 'screenshots', slug), workspace)
  assertInWorkspace(out, workspace)
  try {
    const { bytes, title } = await screenshotPage(u, out, !!fullPage)
    return `Screenshot saved to ${path.relative(workspace, out) || out} (${bytes} bytes). Page title: ${title}`
  } catch (e: any) {
    return `Error: screenshot_page failed — ${e?.message || e}`
  }
}

async function searchKnowledgeTool(query: string, k: number | undefined, rebuild: boolean | undefined, workspace: string): Promise<string> {
  const q = String(query ?? '').trim()
  if (!q) return 'Error: query is required.'
  const kk = Math.max(1, Math.min(20, Number(k) || 8))
  if (rebuild) {
    try { await rebuildIndex(workspace) } catch (e: any) { return `Error: rebuildIndex failed — ${e?.message || e}` }
  }
  const stats = indexStats(workspace)
  if (stats.chunks === 0) {
    try { await rebuildIndex(workspace) } catch {}
  }
  const results = await searchHybrid(workspace, q, kk)
  if (results.length === 0) return `No results in local knowledge index for "${q}". (index: ${stats.chunks} chunks, ${stats.docs} docs, vectors: ${stats.hasVectors ? 'yes' : 'no'})`
  const lines: string[] = [`Found ${results.length} local passages for "${q}" (index: ${indexStats(workspace).chunks} chunks, vectors: ${indexStats(workspace).hasVectors ? 'yes' : 'no'})`, '']
  results.forEach((r, i) => {
    const scoreParts: string[] = []
    if (r.bm25Rank) scoreParts.push(`bm25#${r.bm25Rank}`)
    if (r.vectorRank) scoreParts.push(`vec#${r.vectorRank}`)
    lines.push(`${i + 1}. [${r.chunk.doc}] (${scoreParts.join(', ') || 'hybrid'})`)
    const preview = r.chunk.text.length > 600 ? r.chunk.text.slice(0, 600) + '…' : r.chunk.text
    lines.push(`   ${preview.replace(/\n/g, ' ')}`)
    lines.push('')
  })
  return lines.join('\n')
}

async function spawnSubResearcherTool(task: string, maxIters: number | undefined, parentSessionId: string | undefined, apiUrl: string | undefined, temperature: number | undefined, _workspace: string): Promise<string> {
  if (!parentSessionId) return 'Error: parent session id missing (spawn_sub_researcher is only usable inside an agent session).'
  const t = String(task ?? '').trim()
  if (!t) return 'Error: task is required.'
  if (!apiUrl) return 'Error: LLM api URL unavailable for sub-researcher.'
  if (!canSpawnMore()) return 'Error: maximum of 3 sub-researchers already running. Wait for one to finish.'
  const res = await runSubResearcher(
    { task: t, maxIters, parentSessionId, apiUrl, temperature },
    (name: string, args: any) => executeTool(name, args, _workspace),
  )
  return `[sub_researcher result]\nTask: ${t}\nIterations: ${res.iterations}\nTool calls: ${res.toolCallsMade.join(', ') || 'none'}\nNew sources collected: ${res.sourcesAdded}\n\n${res.report}`
}

async function exportReportTool(markdownPath: string | undefined, format: string, outputPath: string | undefined, sessionId: string | undefined, workspace: string): Promise<string> {
  if (!format || !['pdf', 'docx', 'bibtex'].includes(format)) return 'Error: format must be one of pdf, docx, bibtex.'
  if (format === 'bibtex') {
    if (!sessionId) return 'Error: session id missing, cannot export BibTeX.'
    const tracker = getSourceTracker(sessionId)
    const out = outputPath ? resolvePath(outputPath, workspace) : resolvePath(path.join('.research', 'references.bib'), workspace)
    assertInWorkspace(out, workspace)
    try {
      const n = exportBibTex(tracker, out)
      return `Wrote ${n} BibTeX entr${n === 1 ? 'y' : 'ies'} to ${path.relative(workspace, out)}.`
    } catch (e: any) { return `Error: export_report bibtex failed — ${e?.message || e}` }
  }

  const mdPath = resolvePath(markdownPath || path.join('.research', 'report.md'), workspace)
  assertInWorkspace(mdPath, workspace)
  if (!fs.existsSync(mdPath)) return `Error: markdown file not found: ${markdownPath || '.research/report.md'}`
  const markdownContent = fs.readFileSync(mdPath, 'utf-8')
  const titleMatch = markdownContent.match(/^#\s+(.+)$/m)
  const title = titleMatch ? titleMatch[1].trim() : path.basename(mdPath, '.md')

  const defaultOut = format === 'pdf'
    ? mdPath.replace(/\.md$/, '.pdf')
    : mdPath.replace(/\.md$/, '.docx')
  const out = outputPath ? resolvePath(outputPath, workspace) : defaultOut
  assertInWorkspace(out, workspace)
  try {
    if (format === 'pdf') await exportPdf(markdownContent, title, out)
    else await exportDocx(markdownContent, title, out)
    const bytes = fs.statSync(out).size
    return `Exported ${format.toUpperCase()} to ${path.relative(workspace, out)} (${bytes} bytes).`
  } catch (e: any) {
    return `Error: export_report ${format} failed — ${e?.message || e}`
  }
}

export function executeCustomTool(
  tool: CustomTool, args: Record<string, any>, workspace: string,
): string {
  if (!workspace) return 'Error: workspace not set.'
  try {
    let cmd = tool.command
    for (const [key, val] of Object.entries(args)) {
      cmd = cmd.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(val))
    }

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(cmd)) {
        return `Error: command blocked — matches dangerous pattern. Command: ${cmd}`
      }
    }

    const out = execSync(cmd, {
      cwd: workspace,
      timeout: 120000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 10,
      env: { ...process.env, FORCE_COLOR: '0', ...Object.fromEntries(
        Object.entries(args).map(([k, v]) => [`TOOL_${k.toUpperCase()}`, String(v)]),
      )},
    })
    let result = out
    if (result.length > 80000) result = result.slice(0, 80000) + '\n… [truncated]'
    return `Exit code: 0\n${result}`
  } catch (e: any) {
    const out = ((e.stdout ?? '') + '\n' + (e.stderr ?? '')).trim()
    const result = out.length > 80000 ? out.slice(0, 80000) + '\n… [truncated]' : out
    return `Exit code: ${e.status ?? -1}\n${result}`
  }
}
