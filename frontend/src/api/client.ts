// fetch の薄いラッパー。エラーは backend/config/exceptions.py の形 {error: {code, message, detail}}。

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly detail: unknown

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.detail = detail
  }
}

const BASE = import.meta.env.VITE_API_BASE ?? ''

/** API の完全な URL（fetch を直接使うとき用） */
export const apiUrl = (path: string) => BASE + path

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'network', 'サーバーに接続できません（backend は起動していますか？）')
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    const e = data?.error
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `HTTP ${res.status}`, e?.detail)
  }
  return data as T
}

export const apiGet = <T>(path: string) => request<T>('GET', path)
export const apiPost = <T>(path: string, body: unknown = {}) => request<T>('POST', path, body)

/** WebSocket の URL（開発時は vite の proxy 経由で Django へ） */
export function wsUrl(path: string): string {
  const base = import.meta.env.VITE_WS_BASE
  if (base) return base + path
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${path}`
}
