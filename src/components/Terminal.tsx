import { useEffect, useRef, useCallback } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface Props {
  workspace: string
  visible: boolean
}

export function Terminal({ workspace, visible }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termIdRef = useRef<string | null>(null)
  const cleanupRef = useRef<(() => void)[]>([])

  const initTerminal = useCallback(async () => {
    if (!containerRef.current || !workspace || !window.api) return
    if (xtermRef.current) return

    const xterm = new XTerm({
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: {
        background: '#09090b',
        foreground: '#d4d4d8',
        cursor: '#60a5fa',
        selectionBackground: '#3b82f640',
        black: '#18181b',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e4e4e7',
        brightBlack: '#52525b',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde047',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#fafafa',
      },
      allowProposedApi: true,
    })

    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.open(containerRef.current)

    xtermRef.current = xterm
    fitRef.current = fit

    setTimeout(() => fit.fit(), 50)

    try {
      const id = await window.api.terminalCreate(workspace)
      termIdRef.current = id

      xterm.onData((data) => {
        window.api.terminalInput(id, data)
      })

      const unData = window.api.onTerminalData((termId, data) => {
        if (termId === id) xterm.write(data)
      })

      const unExit = window.api.onTerminalExit((termId, code) => {
        if (termId === id) {
          xterm.writeln(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m`)
          termIdRef.current = null
        }
      })

      cleanupRef.current.push(unData, unExit)
    } catch (e) {
      xterm.writeln(`\x1b[31mFailed to create terminal: ${e}\x1b[0m`)
    }
  }, [workspace])

  useEffect(() => {
    if (visible) initTerminal()
  }, [visible, initTerminal])

  useEffect(() => {
    if (!visible || !fitRef.current) return
    const timer = setTimeout(() => {
      fitRef.current?.fit()
      if (termIdRef.current && xtermRef.current) {
        window.api.terminalResize(termIdRef.current, xtermRef.current.cols, xtermRef.current.rows)
      }
    }, 100)
    return () => clearTimeout(timer)
  }, [visible])

  useEffect(() => {
    if (!visible) return
    const observer = new ResizeObserver(() => {
      if (fitRef.current && xtermRef.current) {
        fitRef.current.fit()
        if (termIdRef.current) {
          window.api.terminalResize(termIdRef.current, xtermRef.current.cols, xtermRef.current.rows)
        }
      }
    })
    if (containerRef.current) observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [visible])

  useEffect(() => {
    return () => {
      cleanupRef.current.forEach((fn) => fn())
      if (termIdRef.current) window.api.terminalKill(termIdRef.current)
      xtermRef.current?.dispose()
      xtermRef.current = null
      fitRef.current = null
      termIdRef.current = null
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className="w-full h-full overflow-hidden"
      style={{ display: visible ? 'block' : 'none' }}
    />
  )
}
