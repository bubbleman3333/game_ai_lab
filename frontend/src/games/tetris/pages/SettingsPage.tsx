// テトリスの操作設定。キーを押して割り当て、DAS/ARR をその場で試せる。設定はブラウザに保存される。

import { useEffect, useMemo, useState } from 'react'
import { useGameLoop } from '../../../lib/useGameLoop'
import { PlayerView } from '../components/PlayerView'
import { Game, GameController } from '../engine'
import { DEFAULT_HANDLING, DEFAULT_KEYS, KeyboardInput, type Handling, type KeyBindings } from '../game/keyboard'
import { ACTION_LABELS, keyLabel, loadHandling, loadKeys, saveHandling, saveKeys } from '../game/settings'
import { useTetrisSounds } from '../sounds'

type ActionName = keyof KeyBindings

export function SettingsPage() {
  const [keys, setKeys] = useState<KeyBindings>(loadKeys)
  const [handling, setHandling] = useState<Handling>(loadHandling)
  const [listening, setListening] = useState<ActionName | null>(null)
  const [round, setRound] = useState(0)

  const updateKeys = (k: KeyBindings) => {
    setKeys(k)
    saveKeys(k)
  }
  const updateHandling = (h: Handling) => {
    setHandling(h)
    saveHandling(h)
  }

  // 「キーを追加」を押したあと、次に押されたキーを割り当てる（ほかの操作と重なっていたらそちらから外す）
  useEffect(() => {
    if (!listening) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.code === 'Escape') {
        setListening(null)
        return
      }
      const next = { ...keys } as KeyBindings
      for (const a of Object.keys(next) as ActionName[]) next[a] = next[a].filter((c) => c !== e.code)
      next[listening] = [...next[listening], e.code]
      updateKeys(next)
      setListening(null)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening, keys])

  // 試し打ち用の盤面（設定を変えるたびに作り直す）
  const controller = useMemo(
    () => new GameController(new Game(Math.floor(Math.random() * 2 ** 31)), { gravityMs: 0 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [round],
  )
  const keyboard = useMemo(() => new KeyboardInput(controller, keys, handling), [controller, keys, handling])
  useEffect(() => {
    keyboard.enabled = !listening
  }, [keyboard, listening])
  useEffect(() => keyboard.attach(), [keyboard])
  useTetrisSounds(controller)
  useGameLoop([keyboard], [controller], () => controller.version)
  useEffect(() => {
    if (controller.game.over) setRound((r) => r + 1)
  })

  const removeKey = (a: ActionName, code: string) => updateKeys({ ...keys, [a]: keys[a].filter((c) => c !== code) })

  return (
    <div className="page">
      <h1>テトリスの操作設定</h1>
      <p className="muted">設定はこのブラウザに保存され、すべてのテトリス画面で使われます。右の盤面でそのまま試せます（重力なし）。</p>
      <div className="settings-layout">
        <div>
          <h2>キー</h2>
          <table className="key-table">
            <tbody>
              {(Object.keys(ACTION_LABELS) as ActionName[]).map((a) => (
                <tr key={a}>
                  <th>{ACTION_LABELS[a]}</th>
                  <td>
                    {keys[a].map((c) => (
                      <span key={c} className="key-chip">
                        {keyLabel(c)}
                        <button className="chip-x" onClick={() => removeKey(a, c)} aria-label={`${keyLabel(c)} を外す`}>×</button>
                      </span>
                    ))}
                    {keys[a].length === 0 && <span className="error small">未設定</span>}
                  </td>
                  <td>
                    <button onClick={() => setListening(a)} className={listening === a ? 'listening' : ''}>
                      {listening === a ? 'キーを押してください（Esc で中止）' : 'キーを追加'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>押しっぱなしの動き</h2>
          <HandlingSlider label="DAS（連続移動が始まるまで）" unit="ms" min={0} max={300} value={handling.dasMs}
            onChange={(v) => updateHandling({ ...handling, dasMs: v })} />
          <HandlingSlider label="ARR（連続移動の間隔。0 で壁まで一瞬）" unit="ms" min={0} max={100} value={handling.arrMs}
            onChange={(v) => updateHandling({ ...handling, arrMs: v })} />
          <HandlingSlider label="ソフトドロップの間隔（0 で床まで一瞬）" unit="ms" min={0} max={100} value={handling.softDropMs}
            onChange={(v) => updateHandling({ ...handling, softDropMs: v })} />

          <div className="controls-row" style={{ marginTop: 16 }}>
            <button onClick={() => { updateKeys(DEFAULT_KEYS); updateHandling(DEFAULT_HANDLING) }}>初期設定に戻す</button>
          </div>
        </div>
        <div className="arena">
          <PlayerView controller={controller} cell={22} title="試し打ち" />
        </div>
      </div>
    </div>
  )
}

function HandlingSlider({ label, unit, min, max, value, onChange }: {
  label: string; unit: string; min: number; max: number; value: number; onChange: (v: number) => void
}) {
  return (
    <label className="slider-row">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="mono">{value} {unit}</span>
    </label>
  )
}
