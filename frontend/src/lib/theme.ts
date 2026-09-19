// 画面の明るさ（dark / light）。選んだものはブラウザに保存し、最初は端末の設定に合わせる。
// 色はすべて styles.css の CSS 変数なので、<html data-theme="..."> を切り替えるだけで全体が変わる。

import { useSyncExternalStore } from 'react'

export type Theme = 'dark' | 'light'
const KEY = 'game-ai-lab:theme'
const listeners = new Set<() => void>()

function initial(): Theme {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'dark' || saved === 'light') return saved
  } catch {
    /* 読めなければ端末の設定 */
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

let current: Theme = typeof window === 'undefined' ? 'dark' : initial()
if (typeof document !== 'undefined') document.documentElement.dataset.theme = current

export function setTheme(t: Theme): void {
  current = t
  document.documentElement.dataset.theme = t
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* 保存できなくても切り替えはする */
  }
  listeners.forEach((l) => l())
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
  )
}
