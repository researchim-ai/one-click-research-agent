/**
 * Agent worker: runs runAgent in a separate thread so the main process stays responsive.
 * Main posts { type: 'run', payload } and receives { type: 'emit'|'approval'|'session-update'|'done' }.
 * When payload.sessionPath is set, session is loaded from disk (avoids huge postMessage with 262K context).
 */

import { parentPort } from 'worker_threads'
import fs from 'fs'
import { runAgent, type AgentBridge, type Session } from './agent'
import type { AgentEvent } from './types'
import type { AppConfig } from './config'

if (!parentPort) throw new Error('agent-worker must run as worker thread')

let workerCancelRequested = false
let workerCtxSize = 32768
const pendingApprovals = new Map<string, (approved: boolean) => void>()
const pendingQueryCtx = new Map<string, () => void>()

function createWorkerBridge(payload: {
  message: string
  workspace: string
  config: AppConfig
  session: Session
  apiUrl: string
  ctxSize: number
}): AgentBridge {
  let session = { ...payload.session }
  workerCtxSize = payload.ctxSize

  return {
    emit(event: AgentEvent) {
      parentPort!.postMessage({ type: 'emit', event })
    },
    async requestApproval(toolName: string, args: Record<string, any>): Promise<boolean> {
      const approvalId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      return new Promise((resolve) => {
        pendingApprovals.set(approvalId, resolve)
        parentPort!.postMessage({ type: 'approval', approvalId, name: toolName, args })
      })
    },
    getConfig(): AppConfig {
      return payload.config
    },
    getSession(): Session {
      return session
    },
    saveSession(s: Session): void {
      session = s
      parentPort!.postMessage({ type: 'session-update', session: s })
    },
    getApiUrl(): string {
      return payload.apiUrl
    },
    getCtxSize(): number {
      return workerCtxSize
    },
    setCtxSize(n: number): void {
      workerCtxSize = n
    },
    async queryActualCtxSize(): Promise<void> {
      const id = `query-ctx-${Date.now()}`
      return new Promise((resolve) => {
        pendingQueryCtx.set(id, () => { resolve() })
        parentPort!.postMessage({ type: 'query-ctx', id })
      })
    },
    isCancelRequested(): boolean {
      return workerCancelRequested
    },
    notifyWorkspaceChanged() {
      parentPort!.postMessage({ type: 'workspace-changed' })
    },
  }
}

parentPort.on('message', async (msg: any) => {
  if (msg.type === 'approval-result') {
    const resolve = pendingApprovals.get(msg.approvalId)
    if (resolve) {
      pendingApprovals.delete(msg.approvalId)
      resolve(msg.approved === true)
    }
    return
  }
  if (msg.type === 'cancel') {
    workerCancelRequested = true
    return
  }
  if (msg.type === 'query-ctx-result') {
    const done = pendingQueryCtx.get(msg.id)
    if (done) {
      pendingQueryCtx.delete(msg.id)
      if (typeof msg.ctxSize === 'number') workerCtxSize = msg.ctxSize
      done()
    }
    return
  }
  if (msg.type === 'run') {
    workerCancelRequested = false
    const { message, workspace, config, session: payloadSession, apiUrl, ctxSize, sessionPath } = msg.payload
    let session: Session
    if (sessionPath) {
      const raw = await fs.promises.readFile(sessionPath, 'utf-8')
      session = JSON.parse(raw) as Session
    } else {
      session = payloadSession
    }
    const bridge = createWorkerBridge({ message, workspace, config, session, apiUrl, ctxSize })
    try {
      const result = await runAgent(message, workspace, bridge)
      parentPort!.postMessage({ type: 'done', result, session: bridge.getSession() })
    } catch (err: any) {
      parentPort!.postMessage({ type: 'done', result: `Error: ${err?.message ?? err}`, session: bridge.getSession(), error: true })
    }
  }
})
