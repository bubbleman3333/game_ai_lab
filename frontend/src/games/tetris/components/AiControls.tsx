// AI の選択と速さの設定。

import type { AgentDto } from '../api/types'

/** AI の速さ。PPS（1 秒に置くミノの数）で指定する。人の PPS に合わせると、組み方の勝負になる */
const PPS_CHOICES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]

export const AI_SPEEDS = [
  ...PPS_CHOICES.map((pps) => ({
    label: `${pps} PPS`,
    // 1 手の時間の中で操作を見やすく散らす（速すぎ・遅すぎにならない範囲で）
    actionDelayMs: Math.round(Math.min(80, Math.max(15, 1000 / pps / 8))),
    pieceDelayMs: Math.round(1000 / pps),
  })),
  { label: '最速', actionDelayMs: 0, pieceDelayMs: 0 },
]
/** 最初に選ばれている速さ（2 PPS） */
export const DEFAULT_AI_SPEED = PPS_CHOICES.indexOf(2)

interface Props {
  agents: AgentDto[]
  agent: string
  onAgent: (id: string) => void
  speed: number
  onSpeed: (i: number) => void
}

export function AiControls({ agents, agent, onAgent, speed, onSpeed }: Props) {
  return (
    <div className="controls-row">
      <label>
        AI
        <select value={agent} onChange={(e) => onAgent(e.target.value)}>
          <option value="">既定（いちばん新しい best・学習に合わせて自動で更新）</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        速さ
        <select value={speed} onChange={(e) => onSpeed(Number(e.target.value))}>
          {AI_SPEEDS.map((s, i) => (
            <option key={s.label} value={i}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

/** いま手を選んでいる AI の表示（学習が進むとエピソード数が増える） */
export function AiVersion({ agent }: { agent: { id: string; episode: number | null } | null }) {
  if (!agent) return null
  return (
    <p className="muted small">
      使用中の AI: {agent.id}
      {agent.episode != null && `（${agent.episode.toLocaleString()} エピソード学習した時点）`}
    </p>
  )
}
