import { useState, useCallback } from 'react'

export interface OpenFile {
  path: string
  name: string
  content: string
  language: string
  lines: number
  size: number
}

const EXT_TO_LANG: Record<string, string> = {
  // JavaScript / TypeScript
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', mts: 'typescript', cts: 'typescript',

  // Web
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', xhtml: 'xml', xsl: 'xml',
  css: 'css', scss: 'scss', less: 'less', sass: 'scss', styl: 'stylus',
  vue: 'xml', svelte: 'xml', astro: 'xml',

  // Data / Config
  json: 'json', jsonc: 'json', json5: 'json',
  yml: 'yaml', yaml: 'yaml', toml: 'ini',
  ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini',
  env: 'bash', dotenv: 'bash',

  // Python
  py: 'python', pyw: 'python', pyi: 'python', pyx: 'python',

  // Systems
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp', hh: 'cpp',
  rs: 'rust',
  go: 'go',
  zig: 'zig',

  // JVM
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'groovy',
  gradle: 'groovy', clj: 'clojure', cljs: 'clojure',

  // .NET
  cs: 'csharp', fs: 'fsharp', vb: 'vbnet', xaml: 'xml', csproj: 'xml',

  // Mobile
  swift: 'swift', m: 'objectivec', mm: 'objectivec',
  dart: 'dart',

  // Scripting
  rb: 'ruby', php: 'php', pl: 'perl', pm: 'perl',
  lua: 'lua', r: 'r', R: 'r', jl: 'julia',
  ex: 'elixir', exs: 'elixir', erl: 'erlang', hrl: 'erlang',
  hs: 'haskell', ml: 'ocaml', mli: 'ocaml',
  nim: 'nim', cr: 'crystal',

  // Shell
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  bat: 'dos', cmd: 'dos',

  // Query / DB
  sql: 'sql', graphql: 'graphql', gql: 'graphql', prisma: 'prisma',

  // Markup / Docs
  md: 'markdown', mdx: 'markdown', rst: 'plaintext',
  tex: 'latex', latex: 'latex', bib: 'bibtex',

  // DevOps / Infra
  dockerfile: 'dockerfile', makefile: 'makefile',
  tf: 'hcl', hcl: 'hcl', nix: 'nix',
  cmake: 'cmake',

  // Misc
  proto: 'protobuf', thrift: 'thrift',
  wasm: 'wasm', wat: 'wasm',
  diff: 'diff', patch: 'diff',
  gitignore: 'plaintext', editorconfig: 'ini',
  txt: 'plaintext', log: 'plaintext', csv: 'plaintext',
  lock: 'json',
}

function detectLanguage(filename: string): string {
  const lower = filename.toLowerCase()
  // Special filenames
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile'
  if (lower === 'makefile' || lower === 'gnumakefile') return 'makefile'
  if (lower === 'cmakelists.txt') return 'cmake'
  if (lower === 'vagrantfile') return 'ruby'
  if (lower === 'gemfile' || lower === 'rakefile') return 'ruby'
  if (lower === 'justfile') return 'makefile'
  if (lower === '.gitignore' || lower === '.dockerignore') return 'plaintext'
  if (lower === '.env' || lower.startsWith('.env.')) return 'bash'
  if (lower === 'nginx.conf') return 'nginx'
  const ext = lower.split('.').pop() ?? ''
  return EXT_TO_LANG[ext] ?? 'plaintext'
}

export function useEditor() {
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)

  const openFile = useCallback(async (filePath: string) => {
    // Already open? Just activate
    const existing = openFiles.find((f) => f.path === filePath)
    if (existing) {
      setActiveFilePath(filePath)
      return
    }

    try {
      const { content, size, lines } = await window.api.readFileContent(filePath)
      const name = filePath.split(/[\\/]/).pop() ?? filePath
      const language = detectLanguage(name)
      const file: OpenFile = { path: filePath, name, content, language, lines, size }
      setOpenFiles((prev) => [...prev, file])
      setActiveFilePath(filePath)
    } catch (e: any) {
      console.error('Failed to open file:', e)
    }
  }, [openFiles])

  const closeFile = useCallback((filePath: string) => {
    setOpenFiles((prev) => {
      const updated = prev.filter((f) => f.path !== filePath)
      if (activeFilePath === filePath) {
        const idx = prev.findIndex((f) => f.path === filePath)
        const next = updated[Math.min(idx, updated.length - 1)]
        setActiveFilePath(next?.path ?? null)
      }
      return updated
    })
  }, [activeFilePath])

  const refreshFile = useCallback(async (filePath: string) => {
    try {
      const { content, size, lines } = await window.api.readFileContent(filePath)
      setOpenFiles((prev) =>
        prev.map((f) => f.path === filePath ? { ...f, content, size, lines } : f)
      )
    } catch {}
  }, [])

  const updateFileContent = useCallback((filePath: string, content: string) => {
    setOpenFiles((prev) =>
      prev.map((f) => f.path === filePath ? { ...f, content, lines: content.split('\n').length } : f)
    )
  }, [])

  const closeAll = useCallback(() => {
    setOpenFiles([])
    setActiveFilePath(null)
  }, [])

  const closeOthers = useCallback((keepPath: string) => {
    setOpenFiles((prev) => prev.filter((f) => f.path === keepPath))
    setActiveFilePath(keepPath)
  }, [])

  const activeFile = openFiles.find((f) => f.path === activeFilePath) ?? null

  return {
    openFiles,
    activeFile,
    activeFilePath,
    openFile,
    closeFile,
    closeAll,
    closeOthers,
    refreshFile,
    updateFileContent,
    setActiveFilePath,
  }
}
