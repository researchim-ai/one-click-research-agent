import { useAgent } from './hooks/useAgent'
import { useEditor } from './hooks/useEditor'
import { useResizable } from './hooks/useResizable'
import { Sidebar } from './components/Sidebar'
import { EditorTabs } from './components/EditorTabs'
import { CodeEditor } from './components/CodeEditor'
import { MarkdownViewer } from './components/MarkdownViewer'
import { Chat, type CodeReference } from './components/Chat'
import { Terminal } from './components/Terminal'
import { SetupWizard } from './components/SetupWizard'
import { StatusBar } from './components/StatusBar'
import { SessionTabs } from './components/SessionTabs'
import { SettingsPanel } from './components/SettingsPanel'
import { SourcesPanel } from './components/SourcesPanel'
import { ResearchArtifacts } from './components/ResearchArtifacts'
import { ResearchDashboard } from './components/ResearchDashboard'
import { NewResearchDialog, type NewResearchRequest } from './components/NewResearchDialog'
import { TitleBar } from './components/TitleBar'
import { DiffViewer } from './components/DiffViewer'
import { useState, useEffect, useCallback, useRef } from 'react'
import { normalizeExternalHttpUrl } from './utils/external-links'
import { RESEARCH_PROFILES } from '../research-profiles'
import type { ResearchPresetId } from '../research-presets'
import { makeResearchRunDirFromTopic } from '../research-slug'

export function App() {
  const {
    messages, busy, status, downloadProgress, buildStatus,
    workspace, setWorkspace, contextUsage, tokensPerSecond, autoOpenFile,
    agentActivity, busyElapsedSec, gpuResources,
    sendMessage, startResearchRun, resetChat, pollStatus, respondApproval, cancel,
    sessions, activeSessionId,
    newSession, switchToSession, removeSession,
  } = useAgent()

  const {
    openFiles, activeFile, activeFilePath,
    openFile, closeFile, closeAll, closeOthers, refreshFile, updateFileContent, setActiveFilePath,
  } = useEditor()

  const [setupDone, setSetupDone] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [codeRefs, setCodeRefs] = useState<CodeReference[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined)
  const [newResearchOpen, setNewResearchOpen] = useState(false)
  const [diffView, setDiffView] = useState<{ filePath: string; original: string; modified: string } | null>(null)
  const [externalLinksEnabled, setExternalLinksEnabled] = useState(true)
  const [appLanguage, setAppLanguage] = useState<'ru' | 'en'>('ru')
  const [pendingExternalUrl, setPendingExternalUrl] = useState<string | null>(null)
  const [citationHighlight, setCitationHighlight] = useState<{ n: number; token: number } | null>(null)
  const handleCitationClick = useCallback((n: number) => {
    setCitationHighlight({ n, token: Date.now() })
  }, [])
  const [breadcrumbExpandTo, setBreadcrumbExpandTo] = useState<string | null>(null)
  const [fileMenuOpen, setFileMenuOpen] = useState(false)
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([])
  const fileMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setBreadcrumbExpandTo(null)
  }, [activeFilePath])

  useEffect(() => {
    if (!fileMenuOpen || !window.api?.getRecentWorkspaces) return
    window.api.getRecentWorkspaces().then(setRecentWorkspaces).catch(() => setRecentWorkspaces([]))
  }, [fileMenuOpen])

  useEffect(() => {
    if (!window.api?.getConfig) return
    window.api.getConfig()
      .then((cfg) => {
        setExternalLinksEnabled(cfg.externalLinksEnabled ?? true)
        setAppLanguage(cfg.appLanguage ?? 'ru')
      })
      .catch(() => setExternalLinksEnabled(true))
  }, [settingsOpen])

  useEffect(() => {
    if (!fileMenuOpen) return
    const onOutside = (e: MouseEvent) => {
      if (fileMenuRef.current && !fileMenuRef.current.contains(e.target as Node)) setFileMenuOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [fileMenuOpen])

  const handleOpenDiff = useCallback(async (filePath: string) => {
    if (!workspace || !window.api?.getGitFileAtHead || !window.api?.readFileContent) return
    const sep = workspace.includes('\\') ? '\\' : '/'
    const rel = filePath.startsWith(workspace)
      ? filePath.slice(workspace.length).replace(/^[/\\]+/, '').replace(/[/\\]+/g, '/')
      : filePath
    try {
      const [original, fileData] = await Promise.all([
        window.api.getGitFileAtHead(workspace, rel),
        window.api.readFileContent(filePath),
      ])
      setDiffView({
        filePath,
        original: original ?? '',
        modified: fileData?.content ?? '',
      })
    } catch {
      setDiffView(null)
    }
  }, [workspace])

  useEffect(() => {
    if (autoOpenFile?.path) openFile(autoOpenFile.path)
  }, [autoOpenFile?.token])

  const makeResearchRunDir = useCallback((topic: string): string => {
    return makeResearchRunDirFromTopic(topic)
  }, [])

  const buildResearchPrompt = useCallback((request: NewResearchRequest): string => {
    const profile = RESEARCH_PROFILES.find((p) => p.id === request.profileId) ?? RESEARCH_PROFILES[0]
    const runDir = makeResearchRunDir(request.topic)
    const dateRange = request.dateRange === 'custom'
      ? request.customDateRange || 'custom range not specified'
      : request.dateRange
    const reportLanguageLabel = request.reportLanguage === 'ru' ? 'Russian / русский' : 'English'
    // Resolve the date range into explicit year bounds so the period is actually
    // ENFORCED by search (year_from/year_to) and screening (strict cutoff). Without
    // explicit years, strict_date_range has nothing to compare against and is a no-op.
    const nowYear = new Date().getFullYear()
    const yearBounds: { from?: number; to?: number } = (() => {
      switch (request.dateRange) {
        case 'any': return {}
        case 'last-year': return { from: nowYear - 1, to: nowYear }
        case 'last-2-years': return { from: nowYear - 2, to: nowYear }
        case 'since-2024': return { from: 2024, to: nowYear }
        case 'custom': {
          const ys = (request.customDateRange.match(/\b(?:19|20)\d{2}\b/g) || []).map(Number)
          return ys.length ? { from: Math.min(...ys), to: Math.max(...ys) } : {}
        }
        default: return {}
      }
    })()
    const fromDate = request.dateRange === 'custom'
      ? (request.customDateRange.split('..')[0]?.trim() || (yearBounds.from ? `${yearBounds.from}-01-01` : ''))
      : (yearBounds.from ? `${yearBounds.from}-01-01` : '')
    const toDate = request.dateRange === 'custom'
      ? (request.customDateRange.split('..')[1]?.trim() || (yearBounds.to ? `${yearBounds.to}-12-31` : ''))
      : (yearBounds.to ? `${yearBounds.to}-12-31` : '')
    const hasBounds = yearBounds.from != null || yearBounds.to != null
    const yearArgs = hasBounds
      ? `\`year_from: ${yearBounds.from ?? '*'}\`, \`year_to: ${yearBounds.to ?? nowYear}\`, `
      : ''
    // Non-academic ("general") topics use a separate, web-first contract: the tuned
    // academic pipeline stays the default, but for the general profile we tell the
    // agent to rely on web search and we relax academic-only quality gates.
    // researchKind is classified at intake (model + heuristic safety net) and is
    // independent of the profile domain. A consumer/market topic mapped to the
    // finance profile must NOT trigger the academic science pipeline. Fall back to
    // the old profile-domain heuristic only if the field is somehow unset.
    const researchKind = request.researchKind === 'general' || request.researchKind === 'academic'
      ? request.researchKind
      : (profile.domain === 'general' ? 'general' : 'academic')
    const isGeneral = researchKind === 'general'
    return [
      '# Start managed research run',
      '',
      `Topic: ${request.topic}`,
      `Research profile: ${profile.label} (${profile.domain})`,
      `Mode: ${request.mode}`,
      `Date range: ${dateRange}${hasBounds ? ` (years ${yearBounds.from ?? '*'}–${yearBounds.to ?? nowYear})` : ' (no date restriction)'}`,
      `Max sources: ${request.maxSources}`,
      `Need full text: ${request.needFullText ? 'yes' : 'no'}`,
      `Minimum selected sources: ${request.minSelectedSources}`,
      `Minimum full-text reads: ${request.minFullTextReads}`,
      `Evidence per plan section: ${request.evidencePerSection}`,
      `Strict date range: ${request.strictDateRange ? 'yes' : 'no'}`,
      `Require quality pass before report: ${request.requireQualityPass ? 'yes' : 'no'}`,
      `Report language: ${reportLanguageLabel}`,
      `Research artifact directory: ${runDir}`,
      `Requested outputs: ${request.outputs.join(', ') || 'brief'}`,
      `User-review checkpoints: ${request.checkpoints.join(', ') || 'none'}`,
      request.extraDirections ? `Extra directions: ${request.extraDirections}` : '',
      '',
      'Run this as a managed, editable research workflow, not as a one-shot answer.',
      `All user-facing research outputs, checkpoints, briefings, report sections, limitations, and generated Markdown artifacts must be written in ${reportLanguageLabel}.`,
      request.reportLanguage === 'ru'
        ? 'Keep terminology consistent in Russian. English technical terms are allowed only as terms of art, preferably with Russian explanation on first use. Do not produce mixed-language prose.'
        : 'Keep terminology consistent in English. Do not switch to Russian unless the user explicitly asks.',
      '',
      'The system "Managed research contract" and the live "Research state" block at the end of the',
      'conversation are authoritative for the workflow and report rules. This kickoff only sets run',
      'parameters and checkpoints. Follow the contract; do not re-derive or contradict it.',
      '',
      'Run parameters:',
      `- Store all artifacts in \`${runDir}\` (not the shared \`.research/\` root). Treat the directory as an opaque id: copy it exactly into \`output_dir\` for every tool that supports it. Never translate or re-slugify it.`,
      hasBounds
        ? `- Date period is ${yearBounds.from ?? '*'}–${yearBounds.to ?? nowYear}. ENFORCE it: pass ${yearArgs}(or \`from_date: ${fromDate}\`, \`to_date: ${toDate}\`) to search_arxiv/search tools, and the same \`year_from\`/\`year_to\` to screen_corpus. ${request.strictDateRange ? 'strict_date_range is true — sources outside this period must be rejected, not just down-ranked.' : 'strict_date_range is false — prefer in-period sources but older seminal works are allowed.'}`
        : '- No date restriction: do not filter by year, but still prefer recent work for fast-moving topics.',
      `- The final report.md must PRESENT exactly the top ${request.minSelectedSources} most relevant read sources (each with a short summary in ${reportLanguageLabel}, plus an overall synthesis). Discovery and full-text reading are intentionally LARGER than ${request.minSelectedSources} so the best ${request.minSelectedSources} can be chosen — do not stop discovery/reading at ${request.minSelectedSources}.`,
      `- screen_corpus: \`min_selected: ${request.minSelectedSources}\` (FLOOR — at least this many on-topic selected so the report can present ${request.minSelectedSources}), \`max_selected: ${Math.min(request.maxSources, Math.max(request.minSelectedSources + 5, Math.round(request.minSelectedSources * 1.4)))}\` (select a bit more than the report needs), ${yearArgs}\`strict_date_range: ${request.strictDateRange ? 'true' : 'false'}\`, \`research_kind: '${researchKind}'\`. To get the freshest work, pass \`sub_questions\` and prefer recent items; when discovering via search_arxiv use \`sort_by: 'submittedDate'\` for "latest/новые" requests.`,
      `- run_quality_gates: \`min_selected: ${request.minSelectedSources}\`, \`min_full_text_reads: ${request.minFullTextReads}\`, \`evidence_per_section: ${request.evidencePerSection}\`, \`research_kind: '${researchKind}'\`.`,
      isGeneral
        ? '- GENERAL (non-academic) research: prioritize web sources. Use `smart_search`/`search_web` to discover pages and `fetch_url` to read them; arXiv/OpenAlex/PubMed are optional and only when actually relevant. Survey/review coverage and recency are NOT required for this kind — do not waste turns hunting for academic surveys or recent-year papers; rank by topical relevance and source authority/credibility instead. Still ground every claim in a read source with a quote/passage.'
        : '',
      `- maxSources (${request.maxSources}) is the raw search/corpus cap, NOT the number of sources presented in the report (${request.minSelectedSources}). Report found/selected/read/evidence counts separately.`,
      request.requireQualityPass
        ? '- A quality pass is required before the report: data/evidence gates must pass before `generate_evidence_report`.'
        : '- A non-passing report is allowed: still produce it only via `generate_evidence_report`, including blockers and limitations.',
      '',
      'User-review checkpoints (stop and ask me before continuing):',
      request.checkpoints.includes('plan') ? '- plan: call `plan_research` to save `plan.md`, then stop. The runtime will show the approval checkpoint; do not continue to search before approval and do not duplicate the checkpoint prose.' : '',
      request.checkpoints.includes('corpus') ? '- corpus: stop after corpus building; ask which sources/directions to keep, remove, or prioritize.' : '',
      request.checkpoints.includes('evidence') ? '- evidence: stop after evidence extraction; ask what claims/gaps to revise.' : '',
      request.checkpoints.includes('report') ? '- report: show gaps and quality warnings before the final report; ask for approval or edits.' : '',
      request.checkpoints.length === 0 ? '- none: work autonomously through the contract phases.' : '- Between checkpoints, work autonomously using the profile tools.',
      '',
      'Start now with `plan_research`.',
    ].filter(Boolean).join('\n')
  }, [makeResearchRunDir])

  const presetForResearch = useCallback((request: NewResearchRequest): ResearchPresetId => {
    if (request.mode === 'reproduction') return 'paper-reproduction'
    if (request.profileId === 'universal' && (request.mode === 'deep' || request.mode === 'systematic' || request.mode === 'idea-scout')) return 'deep-research'
    const profile = RESEARCH_PROFILES.find((p) => p.id === request.profileId) ?? RESEARCH_PROFILES[0]
    return profile.presetIds[0]
  }, [])

  const handleStartResearch = useCallback(async (request: NewResearchRequest) => {
    const preset = presetForResearch(request)
    await window.api?.saveConfig?.({ selectedPreset: preset }).catch(() => {})
    setNewResearchOpen(false)
    const title = `Research: ${request.topic}`
    await startResearchRun(buildResearchPrompt(request), title)
  }, [buildResearchPrompt, presetForResearch, startResearchRun])

  const addCodeRef = useCallback((ref: CodeReference) => {
    setCodeRefs((prev) => {
      const key = `${ref.filePath}:${ref.startLine}:${ref.endLine}`
      if (prev.some((r) => `${r.filePath}:${r.startLine}:${r.endLine}` === key)) return prev
      return [...prev, ref]
    })
  }, [])

  const removeCodeRef = useCallback((index: number) => {
    setCodeRefs((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const sidebar = useResizable({
    direction: 'left',
    initialSize: 240,
    minSize: 160,
    maxSize: 480,
    collapsedSize: 0,
    collapseThreshold: 100,
  })

  const chat = useResizable({
    direction: 'right',
    initialSize: 420,
    minSize: 280,
    maxSize: 800,
    collapsedSize: 40,
    collapseThreshold: 180,
  })

  const onBottomDragStart = useCallback(() => {
    setTerminalOpen(true)
  }, [])

  const openTerminalRef = useRef(() => {
    bottomPanel.setCollapsed(false)
    setTerminalOpen(true)
  })
  openTerminalRef.current = () => {
    bottomPanel.setCollapsed(false)
    setTerminalOpen(true)
  }
  const onOpenTerminalAt = useCallback((_dir: string) => {
    openTerminalRef.current()
  }, [])

  const bottomPanel = useResizable({
    direction: 'down',
    initialSize: 250,
    minSize: 120,
    maxSize: 600,
    collapsedSize: 0,
    collapseThreshold: 80,
    onDragStart: onBottomDragStart,
  })

  const serverOnline = status?.serverRunning === true && status?.serverHealth?.status === 'ok'
  const showSetup = !setupDone && !serverOnline

  const handleSetupComplete = () => {
    setSetupDone(true)
    pollStatus()
  }

  const requestOpenExternalLink = useCallback((rawUrl: string) => {
    const safeUrl = normalizeExternalHttpUrl(rawUrl)
    if (!safeUrl || !externalLinksEnabled) return
    setPendingExternalUrl(safeUrl)
  }, [externalLinksEnabled])

  const confirmOpenExternalLink = useCallback(async () => {
    if (!pendingExternalUrl || !window.api?.openExternalUrl) return
    try {
      await window.api.openExternalUrl(pendingExternalUrl)
    } catch (e: any) {
      alert((appLanguage === 'ru' ? 'Не удалось открыть ссылку: ' : 'Failed to open link: ') + (e?.message ?? e))
    } finally {
      setPendingExternalUrl(null)
    }
  }, [pendingExternalUrl])

  const toggleTerminal = () => {
    if (!terminalOpen || bottomPanel.collapsed) {
      bottomPanel.setCollapsed(false)
      setTerminalOpen(true)
    } else {
      bottomPanel.setCollapsed(true)
      setTerminalOpen(false)
    }
  }

  const closeTerminal = () => {
    bottomPanel.setCollapsed(true)
    setTerminalOpen(false)
  }

  const showTerminal = terminalOpen && !bottomPanel.collapsed

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault()
        toggleTerminal()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const refreshFileRef = useRef(refreshFile)
  refreshFileRef.current = refreshFile
  const openFilesRef = useRef(openFiles)
  openFilesRef.current = openFiles
  useEffect(() => {
    if (!window.api?.onWorkspaceFilesChanged) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = window.api.onWorkspaceFilesChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        openFilesRef.current.forEach((f) => refreshFileRef.current(f.path))
      }, 600)
    })
    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (!window.api?.onMenuAction) return
    const unsub = window.api.onMenuAction((action, payload) => {
      switch (action) {
        case 'open-recent':
          if (typeof payload === 'string' && payload.trim()) {
            setWorkspace(payload.trim())
          }
          break
        case 'new-chat':
          newSession()
          break
        case 'new-research':
          setNewResearchOpen(true)
          break
        case 'reset-context':
          resetChat()
          break
        case 'settings-model':
          setSettingsTab('model')
          setSettingsOpen(true)
          break
        case 'settings-tools':
          setSettingsTab('tools')
          setSettingsOpen(true)
          break
        case 'settings-prompts':
          setSettingsTab('prompts')
          setSettingsOpen(true)
          break
        case 'defaults-reset':
          setSettingsOpen(false)
          break
        case 'toggle-terminal':
          toggleTerminal()
          break
        case 'toggle-sidebar':
          sidebar.setCollapsed(!sidebar.collapsed)
          break
      }
    })
    return unsub
  })

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-50">
      {/* Title bar with window controls */}
      {showSetup ? (
        <TitleBar>
          <span className="text-[11px] font-semibold text-zinc-500 tracking-wide">
            ⚡ One-Click Research Agent
          </span>
        </TitleBar>
      ) : (
        <TitleBar>
          <span className="text-[11px] font-semibold text-zinc-500 tracking-wide">
            ⚡ One-Click Research Agent
          </span>
          <div className="relative flex items-center gap-1" ref={fileMenuRef} style={{ WebkitAppRegion: 'no-drag' } as any}>
            <button
              type="button"
              onClick={() => setFileMenuOpen((v) => !v)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/80 cursor-pointer transition-colors"
              title={appLanguage === 'ru' ? 'Файл' : 'File'}
            >
              {appLanguage === 'ru' ? 'Файл' : 'File'}
            </button>
            {fileMenuOpen && (
              <div className="absolute left-0 top-full mt-0.5 z-50 min-w-[200px] py-1 bg-zinc-900 border border-zinc-700 rounded-md shadow-lg">
                <button
                  type="button"
                  className="w-full text-left px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-700/80 cursor-pointer"
                  onClick={async () => {
                    setFileMenuOpen(false)
                    const dir = await window.api?.pickDirectory()
                    if (dir?.trim()) setWorkspace(dir.trim())
                  }}
                >
                  {appLanguage === 'ru' ? 'Открыть папку…' : 'Open folder…'}
                </button>
                <div className="border-t border-zinc-700/80 my-1" />
                <div className="px-2 py-0.5 text-[10px] text-zinc-500 uppercase tracking-wider">{appLanguage === 'ru' ? 'Недавние' : 'Recent'}</div>
                {recentWorkspaces.length === 0 ? (
                  <div className="px-3 py-1.5 text-[11px] text-zinc-500">{appLanguage === 'ru' ? 'Нет недавних проектов' : 'No recent projects'}</div>
                ) : (
                  recentWorkspaces.map((dir) => (
                    <button
                      key={dir}
                      type="button"
                      className="w-full text-left px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-700/80 cursor-pointer truncate"
                      title={dir}
                      onClick={() => {
                        setFileMenuOpen(false)
                        setWorkspace(dir)
                      }}
                    >
                      {dir.split(/[/\\]/).filter(Boolean).pop() || dir}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <button
            onClick={() => setNewResearchOpen(true)}
            disabled={!workspace || busy}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
            style={{ WebkitAppRegion: 'no-drag' } as any}
            title={appLanguage === 'ru' ? 'Начать управляемое исследование' : 'Start managed research'}
          >
            {appLanguage === 'ru' ? 'New Research' : 'New Research'}
          </button>
          <button
            onClick={() => { setSettingsTab('model'); setSettingsOpen(true) }}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/80 cursor-pointer transition-colors"
            style={{ WebkitAppRegion: 'no-drag' } as any}
            title={appLanguage === 'ru' ? 'Настройки (модель, контекст, инструменты)' : 'Settings (model, context, tools)'}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {appLanguage === 'ru' ? 'Настройки' : 'Settings'}
          </button>
        </TitleBar>
      )}

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} initialTab={settingsTab} />
      <NewResearchDialog
        open={newResearchOpen}
        busy={busy}
        appLanguage={appLanguage}
        onClose={() => setNewResearchOpen(false)}
        onStart={handleStartResearch}
      />
      {pendingExternalUrl && (
        <div className="fixed inset-0 z-[220] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={() => setPendingExternalUrl(null)} />
          <div className="relative w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl">
            <div className="px-5 py-4 border-b border-zinc-800">
              <div className="text-base font-semibold text-zinc-100">{appLanguage === 'ru' ? 'Открыть внешнюю ссылку?' : 'Open external link?'}</div>
              <div className="text-sm text-zinc-500 mt-1">
                {appLanguage === 'ru' ? 'Ссылка будет открыта в браузере вне приложения.' : 'The link will be opened in your browser outside the app.'}
              </div>
            </div>
            <div className="px-5 py-4">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-300 break-all">
                {pendingExternalUrl}
              </div>
            </div>
            <div className="px-5 py-4 border-t border-zinc-800 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setPendingExternalUrl(null)}
                className="px-4 py-2 text-sm rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors"
              >
                {appLanguage === 'ru' ? 'Отмена' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={confirmOpenExternalLink}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 cursor-pointer transition-colors"
              >
                {appLanguage === 'ru' ? 'Открыть' : 'Open'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* File tree sidebar */}
        {sidebar.collapsed ? (
          <button
            onClick={() => sidebar.setCollapsed(false)}
            className="w-10 bg-[#0d1117] border-r border-zinc-800/60 flex flex-col items-center pt-3 gap-2 shrink-0 cursor-pointer hover:bg-zinc-900/50 transition-colors"
            title={appLanguage === 'ru' ? 'Развернуть панель' : 'Expand panel'}
          >
            <span className="text-sm">⚡</span>
            <span className="text-[10px] text-zinc-600 [writing-mode:vertical-lr] rotate-180">{appLanguage === 'ru' ? 'Файлы' : 'Files'}</span>
          </button>
        ) : (
          <div style={{ width: sidebar.size }} className="shrink-0 flex flex-col overflow-hidden">
            <Sidebar
              workspace={workspace}
              onWorkspaceChange={setWorkspace}
              onFileClick={openFile}
              serverOnline={serverOnline}
              onReset={resetChat}
              onOpenTerminalAt={onOpenTerminalAt}
              onOpenDiff={handleOpenDiff}
              expandToPath={breadcrumbExpandTo ?? activeFilePath ?? null}
              activeFilePath={activeFilePath}
              appLanguage={appLanguage}
            />
          </div>
        )}

        <div className="resize-handle" onMouseDown={sidebar.onMouseDown} />

        {showSetup ? (
          <main className="flex-1 flex flex-col overflow-hidden">
            <SetupWizard
              status={status}
              downloadProgress={downloadProgress}
              buildStatus={buildStatus}
              onComplete={handleSetupComplete}
              appLanguage={appLanguage}
              onLanguageChange={setAppLanguage}
            />
          </main>
        ) : (
          <>
            {/* Center: editor + bottom terminal */}
            <div className="flex-1 flex flex-col overflow-hidden min-w-0">
              {/* Editor */}
              <div className="flex-1 flex flex-col overflow-hidden bg-[#0d1117]">
                {diffView ? (
                  <DiffViewer
                    filePath={diffView.filePath}
                    original={diffView.original}
                    modified={diffView.modified}
                    onClose={() => setDiffView(null)}
                    appLanguage={appLanguage}
                  />
                ) : (
                  <>
                    <EditorTabs
                      files={openFiles}
                      activeFilePath={activeFilePath}
                      workspace={workspace}
                      onSelect={setActiveFilePath}
                      onClose={closeFile}
                      onCloseAll={closeAll}
                      onCloseOthers={closeOthers}
                      appLanguage={appLanguage}
                    />
                    {activeFile?.language === 'markdown' ? (
                      <MarkdownViewer
                        file={activeFile}
                        workspace={workspace}
                        onAttachCode={addCodeRef}
                        onOpenFile={openFile}
                        onContentChange={(content) => updateFileContent(activeFile.path, content)}
                        onAfterSave={() => refreshFile(activeFile.path)}
                        onBreadcrumbClick={(dirPath) => setBreadcrumbExpandTo(dirPath)}
                        externalLinksEnabled={externalLinksEnabled}
                        onOpenExternalLink={requestOpenExternalLink}
                        appLanguage={appLanguage}
                      />
                    ) : activeFile ? (
                      <CodeEditor
                        file={activeFile}
                        workspace={workspace}
                        onAttachCode={addCodeRef}
                        onOpenFile={openFile}
                        onContentChange={(content) => updateFileContent(activeFile.path, content)}
                        onAfterSave={() => refreshFile(activeFile.path)}
                        onBreadcrumbClick={(dirPath) => setBreadcrumbExpandTo(dirPath)}
                        appLanguage={appLanguage}
                      />
                    ) : (
                      <ResearchDashboard
                        workspace={workspace}
                        appLanguage={appLanguage}
                        onNewResearch={() => setNewResearchOpen(true)}
                        onOpenSettings={() => {
                          setSettingsTab('agent')
                          setSettingsOpen(true)
                        }}
                      />
                    )}
                  </>
                )}
              </div>

              {/* Resize handle — always between editor and terminal area */}
              <div className="resize-handle-h" onMouseDown={bottomPanel.onMouseDown} />

              {/* Bottom panel: terminal */}
              {showTerminal && (
                <div
                  style={{ height: bottomPanel.size }}
                  className="shrink-0 flex flex-col overflow-hidden"
                >
                  <div className="flex items-center justify-between px-3 py-1 bg-[#0d1117] border-b border-zinc-800/40 shrink-0">
                    <span className="text-[11px] text-zinc-400 font-semibold">{appLanguage === 'ru' ? 'Терминал' : 'Terminal'}</span>
                    <button
                      onClick={closeTerminal}
                      className="w-5 h-5 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 cursor-pointer text-[10px]"
                      title={appLanguage === 'ru' ? 'Закрыть терминал' : 'Close terminal'}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <Terminal workspace={workspace} visible={showTerminal} />
                  </div>
                </div>
              )}
            </div>

            <div className="resize-handle" onMouseDown={chat.onMouseDown} />

            {/* Chat panel */}
            {chat.collapsed ? (
              <button
                onClick={() => chat.setCollapsed(false)}
                className="w-10 bg-[#0d1117] border-l border-zinc-800/60 flex flex-col items-center pt-3 gap-2 shrink-0 cursor-pointer hover:bg-zinc-900/50 transition-colors"
                title={appLanguage === 'ru' ? 'Развернуть чат' : 'Expand chat'}
              >
                <span className="text-sm">💬</span>
                <span className="text-[10px] text-zinc-600 [writing-mode:vertical-lr] rotate-180">{appLanguage === 'ru' ? 'Агент' : 'Agent'}</span>
              </button>
            ) : (
              <div
                style={{ width: chat.size }}
                className="border-l border-zinc-800/60 flex flex-col shrink-0 overflow-hidden panel-contain"
              >
                <SessionTabs
                  sessions={sessions}
                  activeSessionId={activeSessionId}
                  busy={busy}
                  onNew={newSession}
                  onNewResearch={() => setNewResearchOpen(true)}
                  onSwitch={switchToSession}
                  onDelete={removeSession}
                  appLanguage={appLanguage}
                  onCollapse={() => chat.setCollapsed(true)}
                />
                <Chat
                  messages={messages}
                  busy={busy}
                  workspace={workspace}
                  onSend={sendMessage}
                  onCancel={cancel}
                  onApproval={(id, approved) => respondApproval(id, approved)}
                  codeRefs={codeRefs}
                  onRemoveCodeRef={removeCodeRef}
                  contextUsage={contextUsage}
                  agentActivity={agentActivity}
                  busyElapsedSec={busyElapsedSec}
                  tokensPerSecond={tokensPerSecond}
                  gpuResources={gpuResources}
                  externalLinksEnabled={externalLinksEnabled}
                  onOpenExternalLink={requestOpenExternalLink}
                  appLanguage={appLanguage}
                  onCitationClick={handleCitationClick}
                />
                <ResearchArtifacts
                  workspace={workspace}
                  appLanguage={appLanguage}
                  onOpenFile={openFile}
                />
                <SourcesPanel
                  sessionId={activeSessionId}
                  workspace={workspace}
                  appLanguage={appLanguage}
                  externalLinksEnabled={externalLinksEnabled}
                  onOpenExternalLink={requestOpenExternalLink}
                  highlightCitationToken={citationHighlight}
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center shrink-0">
        <div className="flex-1">
          <StatusBar status={status} tokensPerSecond={tokensPerSecond} />
        </div>
        {!showSetup && (
          <button
            onClick={toggleTerminal}
            className={`px-3 h-6 text-[10px] border-t border-zinc-800/60 flex items-center gap-1.5 cursor-pointer transition-colors shrink-0 ${
              showTerminal
                ? 'bg-zinc-800/60 text-zinc-300'
                : 'bg-zinc-950 text-zinc-500 hover:text-zinc-300'
            }`}
            title={appLanguage === 'ru' ? 'Ctrl+` — Терминал' : 'Ctrl+` — Terminal'}
          >
            <span className="text-[9px]">▸</span>
            {appLanguage === 'ru' ? 'Терминал' : 'Terminal'}
          </button>
        )}
      </div>
    </div>
  )
}
