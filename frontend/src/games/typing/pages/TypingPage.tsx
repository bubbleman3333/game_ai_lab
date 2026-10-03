// 灯守（タイピング）の画面 `/typing`。
//
// 画面の流れ:
//   タイトル（「はじめる」を打つ）→ セーブスロット選び → 拠点（物語を進める・章を遊び直す・難しさ）
//     → 物語（はじめの話）→ 戦い → 結果 → 物語（その後の話）→ 次の章のはじめの話 → …
//
// セーブは sim/save.ts。物語は 1 行ごと、戦いは結果が出たときに保存する。
// タイトル・セーブ・拠点・結果の後ろには、ずっと夜の森（ForestBackdrop）を動かしている。

import { useCallback, useEffect, useRef, useState } from 'react'
import { SoundControl } from '../../../components/SoundControl'
import { ForestBackdrop } from '../components/ForestBackdrop'
import { ForestCanvas, type Snapshot, snapshotOf } from '../components/ForestCanvas'
import { TitleScreen } from '../components/TitleScreen'
import { StoryView } from '../components/StoryView'
import { type Flash, TypingHud } from '../components/TypingHud'
import { themeFor } from '../scene/themes'
import { ALLIES, type AllyId, CHAPTERS, type Chapter, ENDLESS, type StoryLine } from '../sim/chapters'
import { JOURNAL } from '../sim/journal'
import { DIFFICULTIES, type Difficulty, type GameEvent, type Perks, rankOf, TypingGame } from '../sim/game'
import {
  advanceLine, alliesOf, type Best, currentChapter, perksOf, deleteSlot, exportSave, finishPart, loadSlots, newSave, parseSave,
  playableChapters, recordResult, type SaveData, SLOT_COUNT, storyFinished, writeSlot,
} from '../sim/save'
import { Link } from 'react-router-dom'
import { runtime } from '../runtime'
import '../typing.css'

type View =
  | { k: 'title' }
  | { k: 'slots' }
  | { k: 'hub' }
  | { k: 'story' }
  | { k: 'play'; chapter: Chapter; story: boolean; run: number }
  | { k: 'result'; chapter: Chapter; story: boolean; cleared: boolean; best: Best; record: boolean; snap: Snapshot; maxCombo: number; kills: number; damage: number; pages: number[] }

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60)
  return h > 0 ? `${h} 時間 ${m} 分` : `${m} 分`
}

function whereText(s: SaveData): string {
  const ch = currentChapter(s)
  if (!ch) return '物語を終えた（終わらない夜が遊べる）'
  const part = s.part === 'intro' ? `はじめの話 ${s.line + 1}/${ch.intro.length}` : s.part === 'play' ? '戦いの前' : `その後の話 ${s.line + 1}/${ch.outro.length}`
  return `${ch.number}「${ch.title}」 ${part}`
}

export function TypingPage() {
  const [slots, setSlots] = useState<(SaveData | null)[]>(() => loadSlots())
  const [slot, setSlot] = useState<number | null>(null)
  const [save, setSave] = useState<SaveData | null>(null)
  const [view, setView] = useState<View>({ k: 'title' })
  const [saveFailed, setSaveFailed] = useState(false)

  /** セーブを変えて保存する（画面の値も一緒に変える） */
  const persist = useCallback((next: SaveData) => {
    setSave(next)
    if (slot !== null) {
      setSaveFailed(!writeSlot(slot, next))
      setSlots((list) => list.map((x, i) => (i === slot ? next : x)))
    }
  }, [slot])

  const openSlot = (i: number, data: SaveData) => {
    setSlot(i)
    setSave(data)
    setView({ k: 'hub' })
  }

  // ---------------------------------------------------------------- 物語を進める
  /** 物語の今の位置から続ける（話なら物語の画面、戦いの前なら戦い） */
  const continueStory = useCallback((s: SaveData) => {
    const ch = currentChapter(s)
    if (!ch) return setView({ k: 'hub' })
    if (s.part === 'play') setView({ k: 'play', chapter: ch, story: true, run: Date.now() })
    else setView({ k: 'story' })
  }, [])

  // 物語の画面なのに読む話が無い（戦いの前・物語の終わり）ときは、正しい画面へ移す
  useEffect(() => {
    if (view.k === 'story' && save && (save.part === 'play' || !currentChapter(save))) continueStory(save)
  }, [view.k, save, continueStory])

  // ---------------------------------------------------------------- 画面
  if (view.k === 'title') {
    return (
      <MenuShell themeId="title" bare>
        <TitleScreen onStart={() => setView({ k: 'slots' })} />
      </MenuShell>
    )
  }

  if (view.k === 'slots' || !save || slot === null) {
    return (
      <MenuShell themeId="title">
      <SlotScreen
        slots={slots}
        onOpen={openSlot}
        onNew={(i) => {
          const s = newSave()
          writeSlot(i, s)
          setSlots(loadSlots())
          setSlot(i)
          setSave(s)
          setView({ k: 'story' })
        }}
        onDelete={(i) => { deleteSlot(i); setSlots(loadSlots()) }}
        onImport={(i, s) => { writeSlot(i, s); setSlots(loadSlots()) }}
      />
      </MenuShell>
    )
  }

  if (view.k === 'story') {
    const ch = currentChapter(save)
    if (!ch || save.part === 'play') return null // 上の useEffect が画面を移す
    const lines = save.part === 'intro' ? ch.intro : ch.outro
    // 背景: 今の行までで最後に指定された bg（無ければ章の森）
    let bg = ch.id
    for (let i = Math.min(save.line, lines.length - 1); i >= 0; i--) {
      const b = lines[i].bg
      if (b) {
        bg = b
        break
      }
    }
    return (
      <MenuShell themeId={bg} bare>
      <StoryView
        chapter={ch}
        part={save.part}
        lines={lines}
        line={save.line}
        accent={themeFor(ch.id).accent}
        onLine={() => persist(advanceLine(save))}
        onDone={() => {
          const next = finishPart(save)
          persist(next)
          // その後の話を読み終えたら、そのまま次の章のはじめの話へ（物語が終わっていれば拠点へ）
          if (storyFinished(next)) setView({ k: 'hub' })
          else continueStory(next)
        }}
      />
      </MenuShell>
    )
  }

  if (view.k === 'play') {
    return (
      <PlayScreen
        key={view.run}
        chapter={view.chapter}
        difficulty={save.difficulty}
        perks={perksOf(save)}
        allies={alliesOf(save)}
        ownedPages={save.fragments}
        onQuit={() => setView({ k: 'hub' })}
        onFinish={(game) => {
          const snap = snapshotOf(game)
          const cleared = game.result === 'clear'
          const best: Best = { score: game.score, rank: rankOf(game.kpm, game.accuracy), kpm: game.kpm, accuracy: game.accuracy }
          const key = `${view.chapter.id}:${save.difficulty}`
          const prev = save.best[key]
          const counts = cleared || view.chapter.id === ENDLESS.id
          const record = counts && (!prev || best.score > prev.score)
          persist(recordResult(save, view.chapter.id, save.difficulty, cleared, best, game.time, game.fragmentsFound))
          setView({
            k: 'result', chapter: view.chapter, story: view.story, cleared, best, record, snap,
            maxCombo: game.stats.maxCombo, kills: game.stats.kills, damage: game.stats.damage,
            pages: game.fragmentsFound,
          })
        }}
      />
    )
  }

  if (view.k === 'result') {
    return (
      <MenuShell themeId={view.chapter.id}>
        <ResultScreen
          view={view}
          onRetry={() => setView({ k: 'play', chapter: view.chapter, story: view.story, run: Date.now() })}
          onStory={() => continueStory(save)}
          onHub={() => setView({ k: 'hub' })}
        />
      </MenuShell>
    )
  }

  return (
    <MenuShell themeId={currentChapter(save)?.id ?? 'dawn'}>
      <HubScreen
        save={save}
        slot={slot}
        saveFailed={saveFailed}
        onStory={() => continueStory(save)}
        onPlay={(c) => setView({ k: 'play', chapter: c, story: false, run: Date.now() })}
        onDifficulty={(d) => persist({ ...save, difficulty: d })}
        onBack={() => { setSlots(loadSlots()); setView({ k: 'slots' }) }}
      />
    </MenuShell>
  )
}

// ==================================================================== メニューの外枠
/** 夜の森を背景に、メニューを重ねて出す。bare のときは中身をそのまま全面に出す（タイトル用） */
function MenuShell({ themeId, bare, children }: { themeId: string; bare?: boolean; children: React.ReactNode }) {
  return (
    <div className="typing-shell" style={{ ['--typing-accent' as string]: themeFor(themeId).accent }}>
      <ForestBackdrop key={themeId} themeId={themeId} />
      <div className="typing-shell-veil" />
      {runtime.standalone
        ? <div className="typing-sound"><SoundControl /></div>
        : <Link to="/" className="typing-home">← ゲーム一覧</Link>}
      <div className={bare ? 'typing-shell-bare' : 'typing-shell-body'}>{children}</div>
    </div>
  )
}

// ==================================================================== セーブスロット
function SlotScreen({ slots, onOpen, onNew, onDelete, onImport }: {
  slots: (SaveData | null)[]
  onOpen: (i: number, s: SaveData) => void
  onNew: (i: number) => void
  onDelete: (i: number) => void
  onImport: (i: number, s: SaveData) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [importTo, setImportTo] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const download = (i: number, s: SaveData) => {
    const blob = new Blob([exportSave(s)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `himori-save-${i + 1}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || importTo === null) return
    try {
      const s = parseSave(await file.text())
      if (slots[importTo] && !window.confirm(`スロット ${importTo + 1} のセーブを、読み込んだデータで上書きしますか？`)) return
      onImport(importTo, s)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="page typing-menu">
      <h1>灯守 <small>― 夜の森を灯せ ―</small></h1>
      <p className="muted">
        夜明けまでに、影にさらわれた妹ミオを連れ戻せ。灯守（ひもり）の見習いが、ランタンひとつで夜の森を進むタイピングゲーム。
        近づいてくる「影」の言葉を打てば、影は光に還る。影に捕らわれた仲間を助け出しながら、森の奥へ。
      </p>

      <h2>セーブデータ</h2>
      <div className="typing-slots">
        {slots.map((s, i) => (
          <section key={i} className="typing-slot card">
            <div className="typing-slot-head">
              <span className="typing-slot-num">スロット {i + 1}</span>
              {s && <span className="muted small">{new Date(s.updatedAt).toLocaleString()}</span>}
            </div>
            {s ? (
              <>
                <p className="typing-slot-where">{whereText(s)}</p>
                <p className="muted small">
                  クリアした章 {s.cleared.filter((id) => CHAPTERS.some((c) => c.id === id)).length} / {CHAPTERS.length}
                  　遊んだ時間 {formatTime(s.playTime)}　難しさ {DIFFICULTIES[s.difficulty].name}
                </p>
                <div className="typing-slot-actions">
                  <button type="button" className="primary" onClick={() => onOpen(i, s)}>つづきから</button>
                  <button type="button" className="ghost" onClick={() => download(i, s)}>ファイルに書き出す</button>
                  <button type="button" className="ghost" onClick={() => { setImportTo(i); fileRef.current?.click() }}>読み込む</button>
                  <button type="button" className="ghost danger" onClick={() => {
                    if (window.confirm(`スロット ${i + 1} のセーブを消しますか？（元に戻せません）`)) onDelete(i)
                  }}>消す</button>
                </div>
              </>
            ) : (
              <>
                <p className="muted">空きスロット</p>
                <div className="typing-slot-actions">
                  <button type="button" className="primary" onClick={() => onNew(i)}>はじめから</button>
                  <button type="button" className="ghost" onClick={() => { setImportTo(i); fileRef.current?.click() }}>ファイルから読み込む</button>
                </div>
              </>
            )}
          </section>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={onFile} />
      <p className="muted small">
        セーブはこのブラウザに自動で保存されます（{SLOT_COUNT} つまで）。別のブラウザや PC で続けたいときは
        「ファイルに書き出す」で保存し、向こうで「読み込む」を押してください。
      </p>
    </div>
  )
}

const ALLY_ICON: Record<AllyId, string> = { kuro: '🦉', ruri: '✦', bell: '🔔', mio: '♪' }

/**
 * 森の地図: 村から丘までの道のりに、今いる場所と、夜明けまでの残りを出す（何をしているのかが一目でわかるように）
 */
function ForestMap({ save }: { save: SaveData }) {
  const stops = [{ id: 'village', name: '村' }, ...CHAPTERS.map((c) => ({ id: c.id, name: c.title }))]
  const here = Math.min(save.chapter + 1, stops.length - 1)
  const done = storyFinished(save)
  const left = Math.max(0, 4 - save.chapter)
  return (
    <section className="card typing-map">
      <h2>夜の森の地図</h2>
      <p className="typing-map-goal">
        {done ? '夜は明けた。ミオと母さんを連れて、村へ帰った。'
          : save.chapter >= 3 ? '目的: 森のいちばん奥で夜の主を鎮め、ミオと母さんを連れて帰る'
            : '目的: 夜明けまでに、森にさらわれた妹ミオを連れ戻す'}
      </p>
      <ol className="typing-map-path">
        {stops.map((s, i) => (
          <li key={s.id} className={done || i < here ? 'passed' : i === here ? 'here' : ''}>
            <span className="typing-map-dot" aria-hidden />
            <span className="typing-map-name">{i <= here || done ? s.name : '？？？'}</span>
            {i === here && !done && <span className="typing-map-you">いまここ</span>}
          </li>
        ))}
      </ol>
      {!done && <p className="muted small">夜明けまで、あと{left > 0 ? ` ${left} 刻` : 'わずか'}。</p>}
    </section>
  )
}

/** 母の手記: 見つけたページを読める。まだのページは、どの章の金色の影が持っているかだけ出す */
function JournalSection({ save }: { save: SaveData }) {
  const [open, setOpen] = useState<number | null>(null)
  const page = open !== null ? JOURNAL[open] : null
  return (
    <section className="card">
      <h2>母の手記 <small className="muted">{save.fragments.length} / {JOURNAL.length}</small></h2>
      <p className="muted small">戦いの中に現れる金色の影が、母さんの手記を持っている。近づくと逃げるので、急いで唱えよう。</p>
      <div className="typing-journal">
        {JOURNAL.map((p, i) => {
          const have = save.fragments.includes(i)
          const where = CHAPTERS.find((c) => c.fragments.some((f) => f.page === i))
          return (
            <button key={i} type="button" className={have ? 'typing-journal-page have' : 'typing-journal-page'}
                    disabled={!have} onClick={() => setOpen(i)}>
              {have ? p.title : `${where?.number ?? ''}の金色の影`}
            </button>
          )
        })}
      </div>
      {page && (
        <div className="typing-journal-read" onClick={() => setOpen(null)}>
          <article className="card" onClick={(e) => e.stopPropagation()}>
            <h3>{page.title}</h3>
            {page.body.map((t, i) => <p key={i}>{t}</p>)}
            <button type="button" className="ghost" onClick={() => setOpen(null)}>閉じる</button>
          </article>
        </div>
      )}
    </section>
  )
}

// ==================================================================== 拠点
function HubScreen({ save, slot, saveFailed, onStory, onPlay, onDifficulty, onBack }: {
  save: SaveData
  slot: number
  saveFailed: boolean
  onStory: () => void
  onPlay: (c: Chapter) => void
  onDifficulty: (d: Difficulty) => void
  onBack: () => void
}) {
  const cur = currentChapter(save)
  const playable = playableChapters(save)
  return (
    <div className="page typing-menu">
      <h1>灯守 <small>― 夜の森を灯せ ―</small></h1>
      <p className="muted small">スロット {slot + 1}　遊んだ時間 {formatTime(save.playTime)}</p>
      {saveFailed && <p className="error">このブラウザでは保存できませんでした（プライベートブラウズなど）。</p>}

      <section className="card typing-next" style={{ ['--typing-accent' as string]: themeFor(cur?.id ?? 'dawn').accent }}>
        {cur ? (
          <>
            <div className="typing-next-hour">{cur.hour}</div>
            <div className="typing-next-title">{cur.number}「{cur.title}」</div>
            <p className="typing-next-goal">目的: {cur.goal}</p>
            <p className="muted small">{cur.blurb}</p>
            <button type="button" className="primary typing-big" onClick={onStory}>
              {save.part === 'play' ? '戦いへ' : '物語を進める'}
            </button>
          </>
        ) : (
          <>
            <div className="typing-next-title">物語は終わった</div>
            <p className="muted">夜は明けた。……けれど、森のどこかには、まだ終わらない夜が残っている。</p>
            <button type="button" className="primary typing-big" onClick={() => onPlay(ENDLESS)}>終わらない夜へ</button>
          </>
        )}
      </section>

      <ForestMap save={save} />

      <section className="card">
        <h2>仲間とお守り</h2>
        <div className="typing-allies">
          {(Object.keys(ALLIES) as AllyId[]).map((id) => {
            const a = ALLIES[id]
            const have = alliesOf(save).includes(id)
            const where = CHAPTERS.find((c) => c.rescue === id)
            return (
              <div key={id} className={have ? 'typing-ally have' : 'typing-ally'}>
                <span className="typing-ally-icon" aria-hidden>{have ? ALLY_ICON[id] : '？'}</span>
                <span className="typing-ally-name">{have ? a.name : '？？？'}</span>
                <span className="muted small">{have ? a.power : `${where?.number ?? ''}で、影に捕らわれている……`}</span>
              </div>
            )
          })}
        </div>
      </section>

      <JournalSection save={save} />

      <section className="card">
        <h2>難しさ</h2>
        <div className="typing-diff">
          {(Object.keys(DIFFICULTIES) as Difficulty[]).map((d) => (
            <label key={d}>
              <input type="radio" name="diff" checked={save.difficulty === d} onChange={() => onDifficulty(d)} />
              {DIFFICULTIES[d].name}
            </label>
          ))}
        </div>
        <p className="muted small">影が目の前に来るまでの時間が変わる。自己ベストは難しさごとに記録される。</p>
      </section>

      <section className="card">
        <h2>章を選んで遊ぶ</h2>
        <div className="typing-chapters">
          {[...CHAPTERS, ...(storyFinished(save) ? [ENDLESS] : [])].map((c) => {
            const open = playable.includes(c)
            const best = save.best[`${c.id}:${save.difficulty}`]
            return (
              <button
                key={c.id}
                type="button"
                className="typing-chapter-card"
                disabled={!open}
                style={{ ['--typing-accent' as string]: themeFor(c.id).accent }}
                onClick={() => onPlay(c)}
              >
                <span className="typing-chapter-num">{c.number}</span>
                <span className="typing-chapter-title">{open ? c.title : '？？？'}</span>
                <span className="muted small">{open ? c.blurb : 'まだ物語が届いていない'}</span>
                {best && (
                  <span className="typing-chapter-best">
                    <b className={`rank rank-${best.rank}`}>{best.rank}</b>
                    <span className="mono">{best.score.toLocaleString()}</span>
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <p className="muted small">遊び直しても物語の位置は変わらない。今の章を遊び直してクリアすると、物語も進む。</p>
      </section>

      <section className="card">
        <h2>遊び方</h2>
        <ul className="typing-howto">
          <li>影の頭の上の言葉をローマ字で打つ。<b>半角英数</b>で（日本語入力はオフに）。shi / si、tsu / tu、nn など、どの打ち方でも通る</li>
          <li>最初の 1 文字で、その文字から始まるいちばん近い影を狙う。打ち終えるまで狙いは変わらない（<kbd>Backspace</kbd> で外せる）</li>
          <li>近づかれるとランタンの油が減る。油が 0 になると灯りが消えて終わり。<b>30 打ミス無しで油が 1 戻る</b></li>
          <li>コンボが続くほど得点の倍率が上がり（最大 ×4）、ランタンも明るくなる</li>
          <li>章の最後にはボス。ボスの「なくした言葉」を順に打って返すと、捕らわれた者を助け出せる。<kbd>Esc</kbd> で一時停止</li>
          <li>助けた仲間は力を貸してくれる。忘れ神の鈴を手に入れたら、<kbd>Space</kbd> で 1 戦に 1 回、影を押し戻せる</li>
        </ul>
      </section>

      <button type="button" className="ghost" onClick={onBack}>セーブデータの選択へ戻る</button>
    </div>
  )
}

// ==================================================================== 戦い
/** 油が残りわずかになったとき、そばにいる仲間がかける声（いない仲間の声は出さない） */
const CHEERS: { ally: AllyId | null; line: StoryLine }[] = [
  { ally: 'mio', line: { who: 'ミオ', text: 'だいじょうぶ、歌ってるよ！ ゆっくりでいいから！' } },
  { ally: 'ruri', line: { who: 'ルリ', text: 'がんばって！ 灯り、まだ消えてないよ！' } },
  { ally: 'kuro', line: { who: 'クロ', text: '落ち着け！ 近いものから、正しく唱えよ！' } },
  { ally: null, line: { text: '油が残りわずかだ。……落ち着いて、一つずつ。' } },
]

function PlayScreen({ chapter, difficulty, perks, allies, ownedPages, onQuit, onFinish }: {
  chapter: Chapter
  difficulty: Difficulty
  perks: Perks
  allies: AllyId[]
  ownedPages: number[]
  onQuit: () => void
  onFinish: (game: TypingGame) => void
}) {
  // 戦いは最初の 1 回だけ作る（perks は描き直すたびに新しい値になるので、useMemo の依存にすると作り直されてしまう）
  const [game] = useState(() => new TypingGame(chapter, difficulty, Date.now(), perks, ownedPages))
  /** 戦いの最中に出る台詞（波ごとの声・ボスの本音・仲間の声） */
  const [talk, setTalk] = useState<(StoryLine & { id: number }) | null>(null)
  const cheered = useRef(false)
  /** 操作の案内（第一章だけ）: 最初の影が出たら出し、最初に倒したら消す */
  const [tutorial, setTutorial] = useState<'wait' | 'show' | 'done'>(chapter.id === 'entrance' ? 'wait' : 'done')
  const [snap, setSnap] = useState<Snapshot>(() => snapshotOf(game))
  const [flash, setFlash] = useState<Flash | null>(null)
  const [hurt, setHurt] = useState<number | null>(null)
  const [paused, setPaused] = useState(false)
  const [ime, setIme] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const finished = useRef(false)

  const onEvents = useCallback((events: GameEvent[]) => {
    for (const ev of events) {
      const id = Date.now() + Math.random()
      switch (ev.kind) {
        case 'wave': {
          setFlash(game.endless
            ? { text: `第 ${ev.index + 1} の波`, kind: 'big', id }
            : { text: ev.index === 0 ? '影が近づいてくる……' : `第 ${ev.index + 1} の波`, kind: 'big', id })
          const line = chapter.waveLines[ev.index]
          if (line) setTalk({ ...line, id })
          break
        }
        case 'boss':
          setFlash({ text: `${ev.name} が現れた`, kind: 'big', id })
          if (chapter.boss) setTalk({ ...chapter.boss.appear, id })
          break
        case 'boss-hurt': {
          setFlash({ text: `言葉を返した！ +${ev.score}`, kind: 'good', id })
          const b = chapter.boss
          if (b) setTalk({ who: b.name, text: b.reactions[b.phrases.length - ev.left - 1], id })
          break
        }
        case 'spawn': setTutorial((t) => (t === 'wait' ? 'show' : t)); break
        case 'kill': {
          setTutorial('done')
          const b = chapter.boss
          if (ev.enemy === 'boss' && b) setTalk({ who: b.name, text: b.reactions[b.reactions.length - 1], id })
          break
        }
        case 'bell': setFlash({ text: '鈴の音が、森に響きわたった', kind: 'big', id }); break
        case 'windup': setFlash({ text: '来るぞ！ 飛びかかってくる！', kind: 'bad', id }); break
        case 'ambush': setFlash({ text: '茂みから飛び出してきた！', kind: 'bad', id }); break
        case 'armor': setFlash({ text: '殻が割れた！ もうひとつ！', kind: 'good', id }); break
        case 'split': setFlash({ text: '影が分かれた！', kind: 'info', id }); break
        case 'midwave': {
          const line = chapter.midLines[ev.index]
          if (line) setTalk({ ...line, id })
          break
        }
        case 'shoot': setFlash({ text: '火の玉が飛んでくる！ 打ち落とせ！', kind: 'bad', id }); break
        case 'ink': setFlash({ text: '闇を吐かれた！ 遠くが見えない！', kind: 'bad', id }); break
        case 'howl': setFlash({ text: '咆哮！ 書き付けが読めない！ かなを見て打て！', kind: 'bad', id }); break
        case 'latch': setFlash({ text: '吸い付かれた！ 早く引きはがせ！', kind: 'bad', id }); break
        case 'drain': setHurt(id); setFlash({ text: '油を吸われている！', kind: 'bad', id }); break
        case 'call': setFlash({ text: '影が仲間を呼んだ！', kind: 'bad', id }); break
        case 'mimic': setFlash({ text: '言葉が化けた！', kind: 'info', id }); break
        case 'golden': setTalk({ text: '金色の影だ……！ 何かを抱えている。逃がすな！', id }); break
        case 'fragment': setFlash({ text: `母の手記「${JOURNAL[ev.page]?.title ?? ''}」を見つけた！`, kind: 'big', id }); break
        case 'escape': setFlash({ text: '金色の影に逃げられた……', kind: 'info', id }); break
        case 'boss-charge': {
          const names = { orbs: '火の玉', howl: '咆哮', ink: '闇', quake: '地鳴り', summon: '呼び寄せ' } as const
          setFlash({ text: `${chapter.boss?.name ?? 'ボス'}が力を溜めている……（${names[ev.attack]}）`, kind: 'bad', id })
          break
        }
        case 'heal': setFlash({ text: allies.includes('mio') ? 'ミオの歌が灯りを強めた（油 +1）' : 'ホタルが油を運んできた（油 +1）', kind: 'good', id }); break
        case 'hit': {
          setHurt(id)
          setFlash({ text: ev.damage > 1 ? '影に呑まれかけた！ 油 -2' : '影に触れられた 油 -1', kind: 'bad', id })
          if (game.oil <= 2 && game.oil > 0 && !cheered.current) {
            cheered.current = true
            const c = CHEERS.find((x) => x.ally === null || allies.includes(x.ally))!
            setTalk({ ...c.line, id })
          }
          break
        }
        case 'clear': setFlash({ text: '影はすべて光に戻った', kind: 'big', id }); break
        case 'dead': setFlash({ text: 'ランタンの灯が消えた……', kind: 'bad', id }); break
        case 'key': setIme(false); break
      }
    }
  }, [game, chapter, allies])

  useEffect(() => {
    if (!talk) return
    const t = setTimeout(() => setTalk(null), 4800)
    return () => clearTimeout(t)
  }, [talk])

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), flash.kind === 'big' ? 2200 : 1300)
    return () => clearTimeout(t)
  }, [flash])

  // 終わったら少し余韻を見せてから結果へ
  useEffect(() => {
    if (!snap.result || finished.current) return
    finished.current = true
    const t = setTimeout(() => onFinish(game), snap.result === 'clear' ? 2600 : 2000)
    return () => clearTimeout(t)
  }, [snap.result, game, onFinish])

  // スマホ: 画面に触れたら見えない入力欄にフォーカスしてキーボードを出す
  const focusInput = () => inputRef.current?.focus()
  useEffect(() => { inputRef.current?.focus() }, [])

  const accent = themeFor(chapter.id).accent
  return (
    <div className="typing-play" style={{ ['--typing-accent' as string]: accent }} onPointerDown={focusInput}>
      <ForestCanvas
        game={game}
        paused={paused}
        onSnapshot={setSnap}
        onEvents={onEvents}
        onPause={() => setPaused((p) => !p)}
        onIme={() => setIme(true)}
        inputRef={inputRef}
      />
      <TypingHud snap={snap} chapterLabel={`${chapter.number} ${chapter.title}`} goal={chapter.goal} healCombo={perks.healCombo}
        flash={flash} hurt={hurt} endless={game.endless} />
      {tutorial === 'show' && !paused && (
        <div className="typing-tutorial">
          影の上に浮かぶ言葉を、<b>ローマ字</b>で打とう<br />
          <span className="muted small">例: 森（もり）→ </span><span className="mono">mori</span>
          <span className="muted small">　打ち間違えても大丈夫。正しいキーだけ進む</span>
        </div>
      )}
      {talk && (
        <div key={talk.id} className="typing-talk">
          {talk.who && <span className="typing-talk-who">{talk.who}</span>}
          <span className="typing-talk-text">{talk.text}</span>
        </div>
      )}
      <input
        ref={inputRef}
        className="typing-hidden-input"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        inputMode="email"
        aria-label="ここに打つ"
      />
      {ime && !paused && (
        <div className="typing-ime">日本語入力がオンになっています。<b>半角英数</b>に切り替えてください（「英数」キーや <kbd>半角/全角</kbd>）</div>
      )}
      <button type="button" className="typing-pause-btn" onClick={(e) => { e.stopPropagation(); setPaused(true) }}>一時停止</button>
      {paused && (
        <div className="typing-pause card" onPointerDown={(e) => e.stopPropagation()}>
          <h2>一時停止</h2>
          <p className="muted small">やめると、この戦いの記録は残らない（物語の位置はそのまま）。</p>
          {runtime.standalone && <div className="typing-pause-sound"><SoundControl /></div>}
          <div className="typing-result-actions">
            <button type="button" className="primary" onClick={() => setPaused(false)}>続ける（Esc）</button>
            <button type="button" className="ghost" onClick={onQuit}>やめて戻る</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ==================================================================== 結果
function ResultScreen({ view, onRetry, onStory, onHub }: {
  view: Extract<View, { k: 'result' }>
  onRetry: () => void
  onStory: () => void
  onHub: () => void
}) {
  const { chapter, cleared, best, record, snap } = view
  const endless = chapter.id === ENDLESS.id
  const toStory = view.story && cleared
  const [copied, setCopied] = useState(false)
  const shareText = endless
    ? `「灯守 ― 夜の森を灯せ ―」終わらない夜で第 ${snap.wave + 1} の波まで灯した！ ${best.score.toLocaleString()} 点・${Math.round(best.kpm)} 打/分 #灯守タイピング`
    : cleared
      ? `「灯守 ― 夜の森を灯せ ―」${chapter.number}「${chapter.title}」をランク ${best.rank} でクリア！ ${best.score.toLocaleString()} 点・${Math.round(best.kpm)} 打/分・正確さ ${(best.accuracy * 100).toFixed(1)}% #灯守タイピング`
      : `「灯守 ― 夜の森を灯せ ―」${chapter.number}「${chapter.title}」で灯が消えた……。${best.score.toLocaleString()} 点 #灯守タイピング`
  const shareUrl = `${window.location.origin}/typing`
  const tweet = `https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${shareText}
${shareUrl}`)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      if (toStory) onStory()
      else onRetry()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toStory, onStory, onRetry])

  return (
    <div className="page typing-menu typing-result-page" style={{ ['--typing-accent' as string]: themeFor(chapter.id).accent }}>
      <div className="card typing-result">
        <div className="muted">{chapter.number}「{chapter.title}」</div>
        <h1>{endless ? `第 ${snap.wave + 1} の波で力尽きた` : cleared ? '影はすべて光に戻った' : 'ランタンの灯が消えた'}</h1>
        {(cleared || endless) && <div className={`typing-rank rank-${best.rank}`}>{best.rank}</div>}
        <div className="typing-result-score mono">{best.score.toLocaleString()}{record && <span className="typing-record">自己ベスト！</span>}</div>
        <dl className="typing-result-list">
          <div><dt>打つ速さ</dt><dd className="mono">{Math.round(best.kpm)} 打/分</dd></div>
          <div><dt>正確さ</dt><dd className="mono">{(best.accuracy * 100).toFixed(1)}%</dd></div>
          <div><dt>最大コンボ</dt><dd className="mono">{view.maxCombo}</dd></div>
          <div><dt>光に戻した影</dt><dd className="mono">{view.kills}</dd></div>
          <div><dt>減った油</dt><dd className="mono">{view.damage}</dd></div>
          <div><dt>時間</dt><dd className="mono">{Math.floor(snap.time / 60)}:{String(Math.floor(snap.time % 60)).padStart(2, '0')}</dd></div>
        </dl>
        {view.pages.length > 0 && (
          <p className="typing-result-pages">母の手記を見つけた: {view.pages.map((p) => `「${JOURNAL[p]?.title}」`).join('')}（拠点で読める）</p>
        )}
        {!cleared && !endless && <p className="muted small">油は 30 打ミス無しで 1 戻る。急がず正確に打つのが近道。難しさを下げることもできる。</p>}
        <div className="typing-share">
          <a className="typing-share-x" href={tweet} target="_blank" rel="noopener noreferrer">𝕏 で結果をシェア</a>
          <button type="button" className="ghost" onClick={copy}>{copied ? 'コピーしました' : '結果の文をコピー'}</button>
        </div>
        <div className="typing-result-actions">
          {toStory && <button type="button" className="primary typing-big" onClick={onStory}>物語のつづきへ（Enter）</button>}
          <button type="button" className={toStory ? 'ghost' : 'primary'} onClick={onRetry}>もう一度{toStory ? '' : '（Enter）'}</button>
          <button type="button" className="ghost" onClick={onHub}>拠点へ</button>
        </div>
      </div>
    </div>
  )
}
