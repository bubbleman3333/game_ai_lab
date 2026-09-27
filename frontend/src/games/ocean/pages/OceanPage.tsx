// 海を泳ぐゲームの画面 `/ocean`。タイトル（説明・最高記録）と、泳ぐ画面。
//
// 3D の重い部分（three.js）は scene/ にまとまっていて、このページはその外側
// （説明・HUD・結果）だけを持つ。最高記録はブラウザに保存する（localStorage）。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { OceanCanvas, type Snapshot } from '../components/OceanCanvas'
import { OceanHud } from '../components/OceanHud'
import { OceanTouch } from '../components/OceanTouch'
import { OceanInput } from '../game/input'
import { THEMES } from '../scene/themes'
import { type Cause, DEEP_PEARL_SCORE, DODGE_SCORE, type GameEvent, MAX_AIR, MAX_HP, MAX_STAMINA, OceanGame, PEARL_SCORE, PUNCH_SCORE } from '../sim/game'
import { ZONES } from '../sim/zones'
import '../ocean.css'

const BEST_KEY = 'game-ai-lab:ocean:best'

interface Best { distance: number; score: number }

function loadBest(): Best | null {
  try {
    const raw = localStorage.getItem(BEST_KEY)
    return raw ? (JSON.parse(raw) as Best) : null
  } catch {
    return null
  }
}

const EMPTY: Snapshot = {
  distance: 0, score: 0, hp: MAX_HP, maxHp: MAX_HP, air: MAX_AIR / MAX_AIR, stamina: MAX_STAMINA / MAX_STAMINA,
  underwater: false, cameraUnderwater: false, depth: 0, depthM: 0, zoneId: 'shallow', zoneName: ZONES[0].name,
  nextZoneIn: ZONES[1]?.from ?? null, threat: null, dead: false, cause: null, pearls: 0, dodges: 0, punches: 0, time: 0,
}

const CAUSE_TEXT: Record<Cause, string> = {
  shark: 'サメに食べられた',
  jelly: 'クラゲに刺されすぎた',
  drown: '息が続かなかった',
}

type Flash = { text: string; kind: 'good' | 'bad' | 'info'; id: number }
type Hurt = { kind: 'bite' | 'sting'; id: number }

export function OceanPage() {
  const [game, setGame] = useState<OceanGame | null>(null)
  const [snap, setSnap] = useState<Snapshot>(EMPTY)
  const [flash, setFlash] = useState<Flash | null>(null)
  const [hurt, setHurt] = useState<Hurt | null>(null)
  const [best, setBest] = useState<Best | null>(() => loadBest())
  const [saved, setSaved] = useState(false)
  const input = useMemo(() => new OceanInput(), [])

  useEffect(() => input.attach(), [input])

  const start = useCallback(() => {
    setSnap(EMPTY)
    setFlash(null)
    setHurt(null)
    setSaved(false)
    input.clear()
    setGame(new OceanGame())
  }, [input])

  const quit = useCallback(() => {
    setGame(null)
    input.clear()
  }, [input])

  const readInput = useCallback(() => input.read(), [input])

  const onEvents = useCallback((events: GameEvent[]) => {
    for (const ev of events) {
      const id = Date.now() + Math.random()
      switch (ev.kind) {
        case 'bite': setHurt({ kind: 'bite', id }); setFlash({ text: '噛まれた！', kind: 'bad', id }); break
        case 'sting': setHurt({ kind: 'sting', id }); setFlash({ text: 'クラゲに刺された', kind: 'bad', id }); break
        case 'dodge': setFlash({ text: `かわした！ +${DODGE_SCORE}`, kind: 'good', id }); break
        case 'punch': setFlash({ text: `サメを追い払った！ +${PUNCH_SCORE}`, kind: 'good', id }); break
        case 'pearl': setFlash({ text: `${(ev.value ?? PEARL_SCORE) > PEARL_SCORE ? '深海の真珠' : '真珠'} +${ev.value ?? PEARL_SCORE}`, kind: 'good', id }); break
        case 'shark-warn': setFlash({ text: 'サメの気配…', kind: 'info', id }); break
        case 'drowning': setFlash({ text: '息が切れた！ 海面へ', kind: 'bad', id }); break
        case 'zone': {
          const zone = ZONES.find((z) => z.from === ev.value)
          if (zone) setFlash({ text: `${zone.name}に入った`, kind: 'info', id })
          break
        }
      }
    }
  }, [])

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 1400)
    return () => clearTimeout(t)
  }, [flash])

  // 力尽きたら記録を残す
  useEffect(() => {
    if (!game || !snap.dead || saved) return
    setSaved(true)
    const d = Math.floor(snap.distance)
    if (!best || snap.score > best.score) {
      const b = { distance: d, score: snap.score }
      setBest(b)
      try { localStorage.setItem(BEST_KEY, JSON.stringify(b)) } catch { /* 保存できなくてもよい */ }
    }
  }, [game, snap.dead, snap.distance, snap.score, saved, best])

  if (game) {
    const accent = THEMES[snap.zoneId].accent
    const isBest = best !== null && snap.score >= best.score && snap.dead
    return (
      <div className="ocean-play" style={{ ['--ocean-accent' as string]: accent }}>
        <OceanCanvas game={game} readInput={readInput} onSnapshot={setSnap} onEvents={onEvents} />
        <OceanHud snap={snap} flash={flash} hurt={hurt} />
        <OceanTouch input={input} />
        <button type="button" className="ocean-quit" onClick={quit}>やめる</button>
        {snap.dead && (
          <div className="ocean-result card">
            <h2>{snap.cause ? CAUSE_TEXT[snap.cause] : '力尽きた'}</h2>
            <p className="mono ocean-result-dist">{Math.floor(snap.distance)} m</p>
            <dl className="ocean-result-list">
              <div><dt>得点</dt><dd className="mono">{snap.score}{isBest && ' ★'}</dd></div>
              <div><dt>たどり着いた海</dt><dd>{snap.zoneName}</dd></div>
              <div><dt>真珠</dt><dd>{snap.pearls} 個</dd></div>
              <div><dt>サメをかわした</dt><dd>{snap.dodges} 回</dd></div>
              <div><dt>サメを追い払った</dt><dd>{snap.punches} 回</dd></div>
              <div><dt>泳いだ時間</dt><dd className="mono">{Math.floor(snap.time / 60)}:{String(Math.floor(snap.time % 60)).padStart(2, '0')}</dd></div>
            </dl>
            <div className="ocean-result-actions">
              <button type="button" onClick={start}>もう一度</button>
              <button type="button" className="ghost" onClick={quit}>戻る</button>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="page ocean-menu">
      <h1>オーシャン・スイム <small>― 海を泳ぐ ―</small></h1>
      <p className="muted">
        3D の海をどこまでも泳ぐ。浅瀬から沖合、そして夜の海へ。漂うクラゲに触れると刺され、
        たまにサメが現れて襲ってくる。息は 30 秒ほど。沖合では水深 30m まで潜れて、
        深いところの真珠は点が高い（{DEEP_PEARL_SCORE} 点）。光の届かない深さでは、あたりが暗くなる。
      </p>

      <section className="card">
        <h2>操作</h2>
        <ul className="ocean-keys">
          <li><kbd>←</kbd><kbd>→</kbd> または <kbd>A</kbd><kbd>D</kbd> … 左右に動く</li>
          <li><kbd>↓</kbd> または <kbd>S</kbd> … 潜る（押しているあいだ。離すと浮く）。浅瀬では海底の手前で止まる</li>
          <li><kbd>↑</kbd> / <kbd>W</kbd> / <kbd>Shift</kbd> … ダッシュ（スタミナを使う）</li>
          <li><kbd>Space</kbd> … 蹴る。サメが目の前まで来た瞬間に蹴ると追い払える</li>
        </ul>
        <p className="muted small">スマホでは画面下のボタンで操作できます。</p>
      </section>

      <section className="card">
        <h2>海</h2>
        <div className="ocean-zones">
          {ZONES.map((z) => (
            <div key={z.id} className="ocean-zone-card" style={{ ['--ocean-accent' as string]: THEMES[z.id].accent }}>
              <span className="ocean-zone-name">{z.name}</span>
              <span className="muted small">{z.from} m から</span>
              <span className="muted small">
                {z.id === 'shallow' && 'サンゴと魚の群れ。クラゲはまばらで、サメも様子見'}
                {z.id === 'offshore' && '底が見えない深い青。クラゲが増え、サメは 2〜3 回突っ込んでくる'}
                {z.id === 'night' && '真っ暗な海に光るクラゲ。サメは休まない'}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>サメが来たら</h2>
        <p className="muted">
          背びれが見えたら「サメの気配」。しばらく周りをうろついてから、こちらに向かって突っ込んでくる。
          突っ込みが始まったら<strong>横へ動き続ける</strong>とかわせる（サメは狙いを大きくは直せない）。
          怖くなければ、<strong>鼻先まで来た瞬間に蹴る</strong>と追い払えて高得点。
        </p>
      </section>

      {best && (
        <p className="muted">
          最高記録: <span className="mono">{best.score} 点</span>（{best.distance} m）
        </p>
      )}
      <button type="button" className="primary ocean-start" onClick={start}>泳ぐ</button>
    </div>
  )
}
