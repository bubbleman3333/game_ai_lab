// 利用状況の送信（backend/apps/monitoring）。
//   - 15 秒ごとに「この画面を開いています」の合図（どのページか・スマホかどうか・ニックネーム）
//   - 画面で起きたエラー
// IP アドレスなどは送らない。ID はタブごとのランダムな文字列（閉じると消える）。

import { apiPost } from '../api/client'
import { isTouchDevice } from './useViewport'

const HEARTBEAT_MS = 15_000
const NAME_KEY = 'tetris-rl:name' // usePlayerName と同じ場所

function sessionId(): string {
  try {
    let id = sessionStorage.getItem('game-ai-lab:session')
    if (!id) {
      id = crypto.randomUUID()
      sessionStorage.setItem('game-ai-lab:session', id)
    }
    return id
  } catch {
    return 'no-storage-' + Math.random().toString(36).slice(2, 12)
  }
}

function nickname(): string {
  try {
    return (localStorage.getItem(NAME_KEY) ?? '').slice(0, 20)
  } catch {
    return ''
  }
}

const SID = sessionId()

function beat(leaving = false): void {
  if (location.pathname.startsWith('/monitor')) return // 監視ページ自身は数えない
  apiPost('/api/monitoring/heartbeat/', {
    session_id: SID,
    path: location.pathname,
    device: isTouchDevice() ? 'mobile' : 'desktop',
    nickname: nickname(),
    leaving,
  }).catch(() => undefined)
}

let lastError = 0
function reportError(message: string, stack = ''): void {
  const now = Date.now()
  if (now - lastError < 5000) return // 同じエラーが連続して大量に送られないように
  lastError = now
  apiPost('/api/monitoring/client-error/', {
    session_id: SID, path: location.pathname, message: message.slice(0, 300), stack: stack.slice(0, 2000),
  }).catch(() => undefined)
}

let started = false

/** アプリの起動時に 1 回呼ぶ */
export function startTelemetry(): void {
  if (started || typeof window === 'undefined') return
  started = true
  beat()
  window.setInterval(() => document.visibilityState === 'visible' && beat(), HEARTBEAT_MS)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && beat())
  window.addEventListener('pagehide', () => beat(true))
  window.addEventListener('error', (e) => reportError(e.message || 'error', e.error?.stack))
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    reportError(r instanceof Error ? r.message : String(r), r instanceof Error ? r.stack : '')
  })
}

/** ページを移ったとき（ルーティングの変化）にすぐ合図を送る */
export const notifyNavigation = () => beat()
