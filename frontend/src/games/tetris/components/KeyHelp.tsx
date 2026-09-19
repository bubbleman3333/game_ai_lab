// 画面下の操作説明。設定画面で変えたキーがそのまま出る。

import { Link } from 'react-router-dom'
import { ACTION_LABELS, keyLabel, loadKeys } from '../game/settings'
import type { KeyBindings } from '../game/keyboard'

export function KeyHelp({ extra }: { extra?: string }) {
  const keys = loadKeys()
  const parts = (Object.keys(ACTION_LABELS) as (keyof KeyBindings)[])
    .map((a) => `${keys[a].map(keyLabel).join('・') || '未設定'} ${ACTION_LABELS[a]}`)
  if (extra) parts.push(extra)
  return (
    <p className="key-help">
      {parts.join(' / ')} <Link to="/tetris/settings">キー設定を変える</Link>
    </p>
  )
}
