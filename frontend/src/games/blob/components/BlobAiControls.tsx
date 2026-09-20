// AI の選択と速さの設定（ブロブチェイン）。速さは PPS = 1 秒に置く組の数。

import type { BlobAgentDto } from '../api/types'
import { BLOB_AI_SPEEDS } from '../game/aiPlayer'

interface Props {
  agents: BlobAgentDto[]
  agent: string
  onAgent: (id: string) => void
  speed: number
  onSpeed: (i: number) => void
}

export function BlobAiControls({ agents, agent, onAgent, speed, onSpeed }: Props) {
  return (
    <div className="controls-row">
      <label>
        AI
        <select value={agent} onChange={(e) => onAgent(e.target.value)}>
          <option value="">既定（いちばん新しい best・学習に合わせて自動で更新）</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.label}</option>
          ))}
        </select>
      </label>
      <label>
        速さ
        <select value={speed} onChange={(e) => onSpeed(Number(e.target.value))}>
          {BLOB_AI_SPEEDS.map((s, i) => (
            <option key={s.label} value={i}>{s.label}</option>
          ))}
        </select>
      </label>
    </div>
  )
}

/** いま手を選んでいる AI の表示（学習が進むとエピソード数が増える） */
export function BlobAiVersion({ agent }: { agent: { id: string; episode: number | null } | null }) {
  if (!agent) return null
  return (
    <p className="muted small">
      使用中の AI: {agent.id}
      {agent.episode != null && `（${agent.episode.toLocaleString()} エピソード学習した時点）`}
    </p>
  )
}
