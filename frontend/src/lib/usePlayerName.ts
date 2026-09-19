// ニックネームをブラウザに覚えておく（localStorage が使えなくても動く）。

import { useState } from 'react'

const KEY = 'tetris-rl:name'

function load(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

export function usePlayerName(): [string, (v: string) => void] {
  const [name, setName] = useState(load)
  const set = (v: string) => {
    setName(v)
    try {
      localStorage.setItem(KEY, v)
    } catch {
      /* 保存できなくても続ける */
    }
  }
  return [name, set]
}
