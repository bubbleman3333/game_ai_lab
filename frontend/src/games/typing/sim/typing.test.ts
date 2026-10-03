import { describe, expect, it } from 'vitest'
import { CHAPTERS, ENDLESS, FAST_WORDS } from './chapters'
import { MAX_OIL, REACH_Z, TypingGame } from './game'
import { RomajiMatcher, romanize, toChunks } from './romaji'
import { advanceLine, exportSave, finishPart, newSave, parseSave, playableChapters, recordResult, storyFinished } from './save'

/** 文字列を 1 文字ずつ打って、全部正解だったか */
function typeAll(m: RomajiMatcher, s: string): boolean {
  for (const ch of s) if (!m.key(ch)) return false
  return m.done
}

describe('ローマ字の判定', () => {
  it('いろいろな打ち方を受け付ける', () => {
    const ok: [string, string][] = [
      ['しか', 'shika'], ['しか', 'sika'], ['しか', 'cika'],
      ['つき', 'tsuki'], ['つき', 'tuki'], ['ふくろう', 'fukurou'], ['ふくろう', 'hukurou'],
      ['ちょうちん', 'chouchinn'], ['ちょうちん', 'tyoutinn'], ['ちょうちん', 'cyoutixn'],
      ['きんぎょすくい', 'kingyosukui'], ['きんぎょすくい', 'kinngyosukui'],
      ['はっぱ', 'happa'], ['はっぱ', 'haxtupa'], ['ねっこ', 'nekko'], ['ねっこ', 'necco'],
      ['いっしょ', 'issho'], ['いっしょ', 'issyo'], ['いっしょ', 'ixtusixyo'],
      ['じゃ', 'ja'], ['じゃ', 'zya'], ['じゃ', 'jixya'],
      ['あなたのなまえは、ほたるのもり', 'anatanonamaeha,hotarunomori'],
      ['ほたる', 'HOTARU'.toLowerCase()],
    ]
    for (const [kana, keys] of ok) {
      expect(typeAll(new RomajiMatcher(kana), keys), `${kana} を ${keys}`).toBe(true)
    }
  })

  it('「ん」は次が母音・な行・や行なら n 1 回では打てない', () => {
    // 「きんえん」: kin のあと e が来ると「きにぇ」になってしまうので nn が要る
    const m = new RomajiMatcher('きんえん')
    expect(m.key('k') && m.key('i') && m.key('n')).toBe(true)
    expect(m.accepts('e')).toBe(false)
    expect(typeAll(m, 'nenn')).toBe(true)
    // 最後の「ん」も nn
    const m2 = new RomajiMatcher('みかん')
    expect(typeAll(m2, 'mikan')).toBe(false)
    expect(typeAll(new RomajiMatcher('みかん'), 'mikann')).toBe(true)
    // 「んな」は nnna
    expect(typeAll(new RomajiMatcher('こんな'), 'konnna')).toBe(true)
  })

  it('まちがったキーでは進まない', () => {
    const m = new RomajiMatcher('もり')
    expect(m.key('m')).toBe(true)
    expect(m.key('x')).toBe(false)
    expect(m.typed).toBe('m')
    expect(m.rest).toBe('ori')
  })

  it('お手本は打ち始めた書き方に合わせて変わる', () => {
    const m = new RomajiMatcher('しずく')
    expect(m.rest).toBe('shizuku')
    m.key('s')
    m.key('i')
    expect(m.typed + m.rest).toBe('sizuku')
  })

  it('全部の章の言葉がローマ字にできる', () => {
    const all = [...CHAPTERS.flatMap((c) => [...c.words, ...(c.boss?.phrases ?? [])]), ...FAST_WORDS, ...ENDLESS.words]
    for (const word of all) {
      expect(() => toChunks(word.kana), word.text).not.toThrow()
      // お手本どおりに打てば打ち切れる
      expect(typeAll(new RomajiMatcher(word.kana), romanize(word.kana)), word.text).toBe(true)
    }
  })
})

/** 狙っている影（いなければいちばん近い影）の言葉を打ち切る */
function typeNearest(g: TypingGame): void {
  const e = g.target ?? [...g.enemies].sort((a, b) => a.z - b.z)[0]
  if (!e) return
  const word = e.matcher.rest
  for (const ch of word) g.key(ch)
}

describe('進行', () => {
  it('影の言葉を打てば倒せて、得点が入る', () => {
    const g = new TypingGame(CHAPTERS[0], 'normal', 1)
    for (let i = 0; i < 200 && g.enemies.length === 0; i++) g.update(0.05)
    expect(g.enemies.length).toBe(1)
    typeNearest(g)
    expect(g.enemies.length).toBe(0)
    expect(g.stats.kills).toBe(1)
    expect(g.score).toBeGreaterThan(0)
    expect(g.stats.misses).toBe(0)
  })

  it('放っておくと影に襲われて油が減り、いつか灯りが消える', () => {
    const g = new TypingGame(CHAPTERS[0], 'normal', 2)
    let hits = 0
    for (let i = 0; i < 20000 && !g.over; i++) {
      for (const ev of g.update(0.05)) if (ev.kind === 'hit') hits++
    }
    expect(g.result).toBe('dead')
    expect(hits).toBe(MAX_OIL)
    expect(g.oil).toBe(0)
  })

  it('打ち続ければ波を越えてボスが出て、ボスの言葉を全部返すとクリア', () => {
    for (const chapter of CHAPTERS) {
      const g = new TypingGame(chapter, 'normal', 3)
      let sawBoss = false
      for (let i = 0; i < 40000 && !g.over; i++) {
        for (const ev of g.update(0.05)) if (ev.kind === 'boss') sawBoss = true
        // 近づかれる前に打つ（人が打っている想定）
        if (g.enemies.some((e) => e.z < 12)) typeNearest(g)
      }
      expect(g.result, chapter.title).toBe('clear')
      expect(sawBoss, chapter.title).toBe(chapter.boss !== null)
      expect(g.oil, chapter.title).toBe(MAX_OIL)
    }
  })

  it('まちがえるとコンボが切れ、狙いは打ち終えるまで変わらない', () => {
    const g = new TypingGame(CHAPTERS[0], 'normal', 4)
    for (let i = 0; i < 400 && g.enemies.length < 2; i++) g.update(0.05)
    expect(g.enemies.length).toBe(2)
    const [a] = [...g.enemies].sort((x, y) => x.z - y.z)
    g.key(a.matcher.rest[0])
    expect(g.target).toBe(a)
    expect(g.combo).toBe(1)
    g.key('q') // どの言葉にも合わない
    expect(g.combo).toBe(0)
    expect(g.stats.misses).toBe(1)
    expect(g.target).toBe(a)
    g.release()
    expect(g.target).toBe(null)
    expect(a.matcher.typed).toBe('')
  })

  it('ボスは目の前まで来ても消えず、押し戻される', () => {
    const g = new TypingGame(CHAPTERS[0], 'normal', 5)
    for (let i = 0; i < 40000 && !g.boss && !g.over; i++) {
      g.update(0.05)
      if (g.enemies.some((e) => e.z < 12)) typeNearest(g)
    }
    const boss = g.boss!
    expect(boss).not.toBe(null)
    for (let i = 0; i < 4000 && boss.z > REACH_Z + 1; i++) g.update(0.05)
    const oil = g.oil
    for (let i = 0; i < 100 && g.oil === oil; i++) g.update(0.05)
    expect(g.oil).toBe(oil - 2)
    expect(g.boss).toBe(boss)
    expect(boss.z).toBeGreaterThan(10)
  })

  it('終わらない夜は終わらず、波を越えるごとに速くなる', () => {
    const g = new TypingGame(ENDLESS, 'normal', 6)
    let waves = 0
    for (let i = 0; i < 60000 && waves < 6; i++) {
      for (const ev of g.update(0.05)) if (ev.kind === 'wave') waves++
      if (g.enemies.some((e) => e.z < 14)) typeNearest(g)
    }
    expect(waves).toBe(6)
    expect(g.over).toBe(false)
  })
})

describe('セーブ', () => {
  it('物語は 1 行ずつ進み、戦いをクリアすると終わりの話、次の章へ進む', () => {
    let s = newSave()
    expect(s.part).toBe('intro')
    for (let i = 0; i < CHAPTERS[0].intro.length; i++) s = advanceLine(s)
    expect(s.part).toBe('play')
    // 負けても物語は進まない
    s = recordResult(s, 'entrance', 'normal', false, { score: 10, rank: 'C', kpm: 50, accuracy: 0.9 }, 30)
    expect(s.part).toBe('play')
    expect(s.cleared).toEqual([])
    s = recordResult(s, 'entrance', 'normal', true, { score: 999, rank: 'A', kpm: 200, accuracy: 0.97 }, 90)
    expect(s.part).toBe('outro')
    expect(s.cleared).toEqual(['entrance'])
    expect(s.best['entrance:normal'].score).toBe(999)
    expect(s.playTime).toBe(120)
    s = finishPart(s)
    expect(s.chapter).toBe(1)
    expect(s.part).toBe('intro')
    expect(playableChapters(s).map((c) => c.id)).toEqual(['entrance', 'marsh'])
  })

  it('遊び直しで低い点を取っても自己ベストは下がらず、物語の位置も変わらない', () => {
    let s = { ...newSave(), chapter: 2, cleared: ['entrance', 'marsh'], best: { 'entrance:normal': { score: 500, rank: 'B' as const, kpm: 100, accuracy: 0.9 } } }
    s = recordResult(s, 'entrance', 'normal', true, { score: 300, rank: 'C', kpm: 80, accuracy: 0.8 }, 10)
    expect(s.best['entrance:normal'].score).toBe(500)
    expect(s.chapter).toBe(2)
    expect(s.part).toBe('intro')
  })

  it('物語を最後まで進めると終わらない夜が遊べる', () => {
    let s = newSave()
    for (const c of CHAPTERS) {
      s = finishPart(s)
      s = recordResult(s, c.id, 'normal', true, { score: 1, rank: 'C', kpm: 1, accuracy: 1 }, 1)
      s = finishPart(s)
    }
    expect(storyFinished(s)).toBe(true)
    expect(playableChapters(s).at(-1)!.id).toBe(ENDLESS.id)
  })

  it('書き出したものを読み込むと同じになり、壊れたものは理由つきで断る', () => {
    const s = { ...newSave('hard'), chapter: 3, part: 'outro' as const, line: 2, cleared: ['entrance'] }
    expect(parseSave(exportSave(s))).toEqual(s)
    expect(() => parseSave('こんにちは')).toThrow('JSON')
    expect(() => parseSave('{"foo":1}')).toThrow('必要な項目')
  })
})
