// 使える AI の一覧を読み込むフック。

import { useEffect, useState } from 'react'
import { fetchAgents } from '../api/ai'
import type { AgentDto } from '../api/types'

export function useAgents() {
  const [agents, setAgents] = useState<AgentDto[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    fetchAgents().then(setAgents).catch((e: Error) => setError(e.message))
  }, [])
  return { agents, error }
}
