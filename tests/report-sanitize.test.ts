import { describe, it, expect } from 'vitest'
import {
  cleanReportTitle,
  humanReadFailureReason,
  stripQuoteMarkup,
  isJunkReportQuote,
  sanitizeReportQuote,
} from '../electron/tools'

describe('cleanReportTitle', () => {
  it('strips arXiv-id prefixes, trailing ellipses and site suffixes', () => {
    expect(cleanReportTitle('[2511.03939] RLHF: A comprehensive Survey for Cultural ...'))
      .toBe('RLHF: A comprehensive Survey for Cultural')
    expect(cleanReportTitle('RLHF: A Comprehensive Survey for Cultural, Multimodal and ... - Springer'))
      .toBe('RLHF: A Comprehensive Survey for Cultural, Multimodal and')
    expect(cleanReportTitle('Reinforcement Learning Meets Large Language Models: A Survey of ...'))
      .toBe('Reinforcement Learning Meets Large Language Models: A Survey of')
  })

  it('leaves clean titles untouched', () => {
    expect(cleanReportTitle('DeepSeek-R1 incentivizes reasoning in LLMs through reinforcement learning'))
      .toBe('DeepSeek-R1 incentivizes reasoning in LLMs through reinforcement learning')
  })
})

describe('humanReadFailureReason', () => {
  it('maps HTTP errors to short human causes', () => {
    expect(humanReadFailureReason('Error: fetch_url failed — HTTP 403', true)).toBe('доступ закрыт издателем (403)')
    expect(humanReadFailureReason('... Error: failed to download arXiv PDF. HTTP 404', true)).toBe('страница не найдена (404)')
    expect(humanReadFailureReason('Error: fetch_url failed — HTTP 403', false)).toBe('blocked by publisher (403)')
  })
  it('returns undefined for empty input', () => {
    expect(humanReadFailureReason(undefined, true)).toBeUndefined()
  })
})

describe('quote sanitization', () => {
  it('strips HTML tag soup', () => {
    const raw = 'Introduction ‣ <span class="ltx_text ltx_ref_tag">2</span></a>, our review is organized around the full RL lifecycle for LLMs in detail.'
    const cleaned = stripQuoteMarkup(raw)
    expect(cleaned).not.toContain('<span')
    expect(cleaned).not.toContain('class=')
  })

  it('rejects internal screening metadata leaked as a quote', () => {
    const junk = 'Selected score 71; precision 100; type=survey; citations=unknown; matched: llm, reasoning, deepseek-r1'
    expect(sanitizeReportQuote(junk)).toBe('')
    expect(isJunkReportQuote(junk)).toBe(true)
  })

  it('rejects fetch dump-headers', () => {
    const junk = 'Title: Detecting hallucinations URL: https://www.nature.com/articles/x Byline: Gal, Yarin Site: Nature Format: markdown Length: 1234'
    expect(sanitizeReportQuote(junk)).toBe('')
  })

  it('rejects latex/html tooling residue and cookie errors', () => {
    expect(sanitizeReportQuote('error=cookies_not_supported&code=2ec28cad longer text here padding padding')).toBe('')
    // Realistic arXiv HTML fragment: tags + attributes stripped; the short leftover is junk.
    const arxivFragment = 'Multi-Modal Grounding.</span></a></li> <li class="ltx_tocentry ltx_tocentry_paragraph"><a class="ltx_ref" href="x" title="In 7 Challenges">'
    const out = sanitizeReportQuote(arxivFragment)
    expect(out).not.toContain('ltx_')
    expect(out).not.toContain('class=')
    expect(out).not.toContain('</')
  })

  it('rejects breadcrumb/TOC paths and trailing section refs', () => {
    expect(sanitizeReportQuote('‣ 5.1 Experimental Setup ‣ 4 Experiments ‣ Step-DPO for Long-chain Reasoning')).toBe('')
    expect(sanitizeReportQuote('Mitigating Reward Hacking in RLHF via Bayesian Reward Modeling" > §A.5 .')).toBe('')
    expect(sanitizeReportQuote('Interference-Aware K-Step Reachable Communication in MARL" > 7th item .')).toBe('')
  })

  it('keeps a genuine sentence quote and truncates long ones', () => {
    const good = 'Their dependence on human-annotated reasoning traces slows scalability and introduces cognitive biases.'
    expect(sanitizeReportQuote(good)).toBe(good)
    const long = 'a real readable sentence about reinforcement learning '.repeat(10)
    const out = sanitizeReportQuote(long)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(261)
  })
})
