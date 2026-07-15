import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import {
  PROMPT_DEFS,
  renderPrompt,
  getRawPrompt,
  defaultPromptText,
  listPrompts,
  validateAllPrompts,
} from '../electron/prompts'

// Anchor the registry to the repo's shipped defaults regardless of CWD.
beforeAll(() => {
  process.env.OCA_PROMPTS_DIR = path.resolve(__dirname, '..', 'prompts')
})

describe('prompt registry integrity', () => {
  it('has a default file for every declared prompt and no placeholder typos', () => {
    expect(validateAllPrompts()).toEqual([])
  })

  it('ships a file for each id and reports them all as defaults out of the box', () => {
    const list = listPrompts()
    expect(list.length).toBe(PROMPT_DEFS.length)
    for (const p of list) {
      expect(p.text.length).toBeGreaterThan(0)
      expect(p.defaultText.length).toBeGreaterThan(0)
      expect(p.source).toBe('default')
      expect(p.overridden).toBe(false)
    }
  })
})

describe('renderPrompt', () => {
  it('substitutes every declared placeholder — nothing is left unresolved', () => {
    for (const def of PROMPT_DEFS) {
      const vars = Object.fromEntries(def.placeholders.map((k) => [k, `<<${k}>>`]))
      const out = renderPrompt(def.id, vars)
      expect(out, `${def.id} still has unresolved tokens`).not.toMatch(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/)
      for (const k of def.placeholders) expect(out).toContain(`<<${k}>>`)
    }
  })

  it('injects the current date into the intake prompt', () => {
    const out = renderPrompt('intake.system', { currentDate: '2026-07-13' })
    expect(out).toContain("Today's date is 2026-07-13")
    expect(out).toContain('YYYY-MM-DD..YYYY-MM-DD')
    // Every {{currentDate}} occurrence must be resolved.
    expect(out).not.toContain('{{currentDate}}')
  })

  it('renders the sub-researcher prompt with its runtime values', () => {
    const out = renderPrompt('sub_researcher.system', { task: 'compare optimizers', maxIters: 5, tools: 'search_web, search_arxiv' })
    expect(out).toContain('Task: compare optimizers')
    expect(out).toContain('at most 5 tool calls')
    expect(out).toContain('search_web, search_arxiv')
  })

  it('throws on an unknown prompt id', () => {
    expect(() => renderPrompt('does.not.exist')).toThrow(/Unknown prompt id/)
  })
})

describe('prompt resolution', () => {
  it('getRawPrompt returns the shipped default with a real path', () => {
    const raw = getRawPrompt('system.default')
    expect(raw.source).toBe('default')
    expect(raw.path).toMatch(/system\.default\.md$/)
    expect(raw.text).toBe(defaultPromptText('system.default'))
  })
})
