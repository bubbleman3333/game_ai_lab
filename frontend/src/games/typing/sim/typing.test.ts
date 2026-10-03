import { describe, expect, it } from 'vitest'
import { CHAPTERS, ENDLESS, FAST_WORDS } from './chapters'
import { BELL_PUSH, MAX_OIL, NO_PERKS, REACH_Z, TypingGame } from './game'
import { RomajiMatcher, romanize, toChunks } from './romaji'
import { advanceLine, alliesOf, exportSave, finishPart, newSave, parseSave, perksOf, playableChapters, recordResult, storyFinished } from './save'

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

  it('お手本は打つ数がいちばん少ない書き方で、打ち始めた書き方に合わせて変わる', () => {
    expect(new RomajiMatcher('なつのよる').rest).toBe('natunoyoru')
    expect(new RomajiMatcher('ちいさなこえ').rest).toBe('tiisanakoe')
    expect(new RomajiMatcher('しゃしん').rest).toBe('shasinn') // 同じ長さなら sha（表の先頭）
    expect(new RomajiMatcher('きんぎょ').rest).toBe('kingyo') // 子音の前の「ん」は n 1 つ
    expect(new RomajiMatcher('はっぱ').rest).toBe('happa')
    const m = new RomajiMatcher('しずく')
    expect(m.rest).toBe('sizuku')
    m.key('s')
    m.key('h')
    expect(m.typed + m.rest).toBe('shizuku')
  })

  it('全部の章の言葉がローマ字にできる', () => {
    const all = [...CHAPTERS.flatMap((c) => [...c.words, ...c.longWords, ...(c.boss?.phrases ?? [])]), ...FAST_WORDS, ...ENDLESS.words]
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

describe('物語と仲間', () => {
  it('波ごとの声とボスの本音が、波・言葉と同じ数だけある', () => {
    for (const c of CHAPTERS) {
      expect(c.waveLines.length, c.title).toBe(c.waves.length)
      if (c.boss) expect(c.boss.reactions.length, c.title).toBe(c.boss.phrases.length)
    }
  })

  it('章をクリアするたびに仲間が増え、力が強くなる', () => {
    let s = newSave()
    expect(perksOf(s)).toEqual(NO_PERKS)
    const ids: string[] = []
    for (const c of CHAPTERS) {
      ids.push(c.id)
      s = { ...s, cleared: [...ids] }
    }
    expect(alliesOf(s)).toEqual(['kuro', 'ruri', 'bell', 'mio'])
    expect(perksOf(s)).toEqual({ maxOil: MAX_OIL + 1, healCombo: 20, revealBonus: 6, bell: true })
  })

  it('鈴は 1 回だけ鳴らせて、影を押し戻す', () => {
    const g = new TypingGame(CHAPTERS[0], 'normal', 7, { ...NO_PERKS, bell: true })
    for (let i = 0; i < 400 && !g.enemies.some((e) => e.z < 15); i++) g.update(0.05)
    const e = g.enemies[0]
    const z = e.z
    expect(g.ringBell()).toEqual([{ kind: 'bell' }])
    expect(e.z).toBeCloseTo(Math.min(30, z + BELL_PUSH))
    expect(g.ringBell()).toEqual([])
  })

  it('ミオの歌があると 20 打で油が戻る', () => {
    const g = new TypingGame(CHAPTERS[0], 'normal', 8, { ...NO_PERKS, healCombo: 20 })
    g.oil = 3
    let healed = false
    for (let i = 0; i < 4000 && !healed && !g.over; i++) {
      g.update(0.05)
      const e = g.target ?? [...g.enemies].sort((a, b) => a.z - b.z)[0]
      if (e && e.z < 14) for (const ch of e.matcher.rest) if (g.key(ch).some((ev) => ev.kind === 'heal')) healed = true
    }
    expect(healed).toBe(true)
    expect(g.stats.maxCombo).toBeGreaterThanOrEqual(20)
    expect(g.stats.maxCombo).toBeLessThan(30)
  })
})

describe('影の動き方', () => {
  /** その動き方の影だけが出る章を作る */
  const only = (behavior: string) => ({ ...CHAPTERS[0], behaviors: { [behavior]: 1 }, formations: [], fragments: [] })
  const firstEnemy = (g: TypingGame) => {
    for (let i = 0; i < 400 && g.enemies.length === 0; i++) g.update(0.05)
    return g.enemies[0]
  }
  const finish = (g: TypingGame, e: { matcher: { rest: string } }) => { for (const ch of e.matcher.rest) g.key(ch) }

  it('飛びかかる影は、途中で止まって溜めてから、いきなり飛びかかる', () => {
    const g = new TypingGame(only('lunge'), 'normal', 11)
    const e = firstEnemy(g)
    const kinds: string[] = []
    let stoppedAt = 0
    for (let i = 0; i < 600 && g.enemies.includes(e); i++) {
      for (const ev of g.update(0.05)) {
        kinds.push(ev.kind)
        if (ev.kind === 'windup') stoppedAt = e.z
      }
    }
    expect(kinds).toContain('windup')
    expect(kinds).toContain('dash')
    expect(stoppedAt).toBeLessThanOrEqual(11)
    expect(kinds).toContain('hit')
  })

  it('いきなり出てくる影は、目の前の近くに現れる', () => {
    const g = new TypingGame(only('ambush'), 'normal', 12)
    const e = firstEnemy(g)
    expect(e.z).toBeGreaterThan(11.5)
    expect(e.z).toBeLessThanOrEqual(12)
  })

  it('硬い影は言葉を 2 つ打たないと倒れない', () => {
    const g = new TypingGame(only('tank'), 'normal', 13)
    const e = firstEnemy(g)
    finish(g, e)
    expect(g.enemies).toContain(e)
    expect(e.hp).toBe(1)
    finish(g, e)
    expect(g.enemies).not.toContain(e)
  })

  it('分かれる影は、倒すと小さな影 2 体になる', () => {
    const g = new TypingGame(only('split'), 'normal', 14)
    const e = firstEnemy(g)
    finish(g, e)
    expect(g.enemies.filter((x) => x.behavior === 'mini')).toHaveLength(2)
  })

  it('消える影は、ときどき近くへ現れる', () => {
    const g = new TypingGame(only('blink'), 'normal', 15)
    const e = firstEnemy(g)
    let blinked = false
    for (let i = 0; i < 200 && !blinked; i++) for (const ev of g.update(0.05)) if (ev.kind === 'blink') blinked = true
    expect(blinked).toBe(true)
    expect(e.z).toBeLessThan(30)
  })
})

describe('攻めてくる影とボスの攻撃', () => {
  const only = (behavior: string, extra: object = {}) => ({ ...CHAPTERS[0], behaviors: { [behavior]: 1 }, fragments: [], formations: [], ...extra })
  const run = (g: TypingGame, seconds: number, stop?: (kinds: string[]) => boolean) => {
    const kinds: string[] = []
    for (let i = 0; i < seconds * 20 && !g.over; i++) {
      for (const ev of g.update(0.05)) kinds.push(ev.kind)
      if (stop?.(kinds)) break
    }
    return kinds
  }

  it('火の玉を投げる影は、止まって火の玉を投げてくる。火の玉も打ち落とせる', () => {
    const g = new TypingGame(only('shooter'), 'normal', 21)
    const kinds = run(g, 20, (k) => k.includes('shoot'))
    expect(kinds).toContain('shoot')
    const orb = g.enemies.find((e) => e.kind === 'orb')!
    expect(orb).toBeTruthy()
    for (const ch of orb.matcher.rest) g.key(ch)
    expect(g.enemies).not.toContain(orb)
  })

  it('闇を吐く影のあとは、遠くの影が狙えない', () => {
    const g = new TypingGame(only('ink'), 'normal', 22)
    run(g, 30, (k) => k.includes('ink'))
    expect(g.darkness).toBeGreaterThan(0)
    const far = { ...g.enemies[0], z: 20 }
    expect(g.isVisible(far)).toBe(false)
  })

  it('咆哮で打ちかけの言葉が崩れ、お手本が消える', () => {
    const g = new TypingGame(only('howl'), 'normal', 23)
    for (let i = 0; i < 400 && g.enemies.length === 0; i++) g.update(0.05)
    const e = g.enemies[0]
    g.key(e.matcher.rest[0])
    expect(e.matcher.typed.length).toBe(1)
    run(g, 30, (k) => k.includes('howl'))
    expect(e.matcher.typed).toBe('')
    expect(g.guideHidden).toBeGreaterThan(0)
  })

  it('吸い付く影は、目の前に張りついて油を吸い続ける', () => {
    const g = new TypingGame(only('leech', { waves: [{ count: 1, interval: 2, maxAlive: 1 }] }), 'normal', 24)
    const kinds = run(g, 40, (k) => k.filter((x) => x === 'drain').length >= 2)
    expect(kinds).toContain('latch')
    expect(kinds.filter((x) => x === 'drain').length).toBe(2)
    expect(g.oil).toBe(MAX_OIL - 3)
  })

  it('金色の影を倒すと母の手記が手に入り、逃がすと手に入らない', () => {
    const chapter = { ...CHAPTERS[0], behaviors: { walk: 1 }, fragments: [{ wave: 0, at: 0, page: 4 }] }
    const g = new TypingGame(chapter, 'normal', 25)
    const kinds = run(g, 10, (k) => k.includes('golden'))
    expect(kinds).toContain('golden')
    const gold = g.enemies.find((e) => e.behavior === 'golden')!
    for (const ch of gold.matcher.rest) g.key(ch)
    expect(g.fragmentsFound).toEqual([4])
    // すでに持っている手記は、もう出ない
    const g2 = new TypingGame(chapter, 'normal', 25, NO_PERKS, [4])
    expect(run(g2, 10)).not.toContain('golden')
    // 逃がした場合
    const g3 = new TypingGame(chapter, 'normal', 26)
    expect(run(g3, 40, (k) => k.includes('escape'))).toContain('escape')
    expect(g3.fragmentsFound).toEqual([])
  })

  it('ボスは力を溜めてから攻撃してくる', () => {
    for (const chapter of CHAPTERS) {
      const g = new TypingGame({ ...chapter, waves: [], fragments: [] }, 'normal', 27)
      const kinds = run(g, 30, (k) => k.includes('boss-attack'))
      expect(kinds.indexOf('boss-charge'), chapter.title).toBeGreaterThan(-1)
      expect(kinds.indexOf('boss-attack'), chapter.title).toBeGreaterThan(kinds.indexOf('boss-charge'))
    }
  })

  it('波の半ばで合図が出る（物語の台詞用）', () => {
    const g = new TypingGame(CHAPTERS[0], 'normal', 28)
    // 何も打たないので、油が尽きないようにしておく
    const kinds = run(g, 30, (k) => { g.oil = 99; return k.includes('midwave') })
    expect(kinds).toContain('midwave')
  })

  it('波の半ばの声も、波と同じ数だけある', () => {
    for (const c of CHAPTERS) expect(c.midLines.length, c.title).toBe(c.waves.length)
  })
})

describe('攻撃のバリエーション', () => {
  const only = (behavior: string, extra: object = {}) => ({
    ...CHAPTERS[0], behaviors: { [behavior]: 1 }, fragments: [], formations: [], waves: [{ count: 1, interval: 2, maxAlive: 1 }], ...extra,
  })
  const run = (g: TypingGame, seconds: number, stop?: (kinds: string[]) => boolean) => {
    const kinds: string[] = []
    for (let i = 0; i < seconds * 20 && !g.over; i++) {
      for (const ev of g.update(0.05)) kinds.push(ev.kind)
      if (stop?.(kinds)) break
    }
    return kinds
  }

  it('時限の影は止まって数を数え、0 になると爆発して油が 2 減る', () => {
    const g = new TypingGame(only('bomb'), 'normal', 31)
    const kinds = run(g, 30, (k) => k.includes('explode'))
    expect(kinds).toContain('arm')
    expect(kinds).toContain('explode')
    expect(g.oil).toBe(MAX_OIL - 2)
  })

  it('守りの影がいると、後ろの影は狙えない。倒すと結界が解ける', () => {
    const g = new TypingGame(only('walk', { waves: [{ count: 2, interval: 0.1, maxAlive: 2 }] }), 'normal', 32)
    run(g, 3, () => g.enemies.length >= 2)
    const [a, b] = g.enemies
    a.behavior = 'guardian'
    a.z = 10
    a.x = 0
    b.z = 20
    b.x = 0.5
    expect(g.isShielded(b)).toBe(true)
    expect(g.isTargetable(b)).toBe(false)
    const kinds: string[] = []
    for (const ch of a.matcher.rest) for (const ev of g.key(ch)) kinds.push(ev.kind)
    expect(kinds).toContain('shield-break')
    expect(g.isShielded(b)).toBe(false)
  })

  it('幻影は 3 体出て、偽物を打つと本物が詰め寄る。本物を倒すと偽物も消える', () => {
    const g = new TypingGame(only('phantom'), 'normal', 33)
    run(g, 3, () => g.enemies.length >= 3)
    expect(g.enemies).toHaveLength(3)
    const real = g.enemies.find((e) => !e.decoy)!
    const fake = g.enemies.find((e) => e.decoy)!
    const z = real.z
    const kinds: string[] = []
    for (const ch of fake.matcher.rest) for (const ev of g.key(ch)) kinds.push(ev.kind)
    expect(kinds).toContain('decoy')
    expect(real.z).toBeLessThan(z)
    for (const ch of real.matcher.rest) g.key(ch)
    expect(g.enemies).toHaveLength(0)
  })

  it('足もとの手は近くに現れ、しばらくするとつかみかかる', () => {
    const g = new TypingGame(only('hand'), 'normal', 34)
    const kinds = run(g, 10, (k) => k.includes('grab'))
    expect(kinds).toContain('hand')
    expect(kinds).toContain('grab')
    expect(g.oil).toBe(MAX_OIL - 1)
  })

  it('急降下は空で溜めてから降りてくる。回り込みは画面の横から来る', () => {
    const g = new TypingGame(only('diver'), 'normal', 35)
    run(g, 3, () => g.enemies.length > 0)
    const d = g.enemies[0]
    expect(d.lift).toBeGreaterThan(5)
    const kinds = run(g, 10, (k) => k.includes('dive'))
    expect(kinds).toContain('dive')
    const g2 = new TypingGame(only('flanker'), 'normal', 36)
    run(g2, 3, () => g2.enemies.length > 0)
    expect(Math.abs(g2.enemies[0].x)).toBeGreaterThan(6)
  })

  it('陣形はまとめて仕掛けてくる', () => {
    for (const name of ['surround', 'column', 'pincer', 'rain', 'rush', 'hands'] as const) {
      const g = new TypingGame(only('walk', { formations: [name], formationChance: 1, waves: [{ count: 8, interval: 2, maxAlive: 3 }] }), 'normal', 37)
      const kinds = run(g, 5, (k) => k.includes('formation'))
      expect(kinds, name).toContain('formation')
      expect(g.enemies.length, name).toBeGreaterThanOrEqual(2)
    }
  })

  it('ボスは言葉を半分返すと怒り、攻撃が速くなる。どの章のボスも全部の技を使える', () => {
    for (const chapter of CHAPTERS) {
      const g = new TypingGame({ ...chapter, waves: [], fragments: [] }, 'easy', 38)
      run(g, 3, () => g.boss !== null)
      const boss = g.boss!
      const half = Math.ceil(boss.phrases!.length / 2)
      for (let i = 0; i < half; i++) for (const ch of boss.matcher.rest) g.key(ch)
      const kinds = run(g, 2, (k) => k.includes('boss-phase2'))
      expect(kinds, chapter.title).toContain('boss-phase2')
      expect(g.bossEnraged).toBe(true)
      // 技を一通り放っても、エラーにならない
      const used = new Set<string>()
      for (let i = 0; i < 4000 && !g.over && used.size < chapter.boss!.attacks.length; i++) {
        for (const ev of g.update(0.05)) if (ev.kind === 'boss-attack') used.add(ev.attack)
        g.oil = 1000 // 技を全部見るまで倒れないように（同じフレームに火の雨がまとめて当たることがある）
        if (g.boss) g.boss.z = 20
      }
      expect(used.size, chapter.title).toBe(chapter.boss!.attacks.length)
    }
  })
})

describe('影の技', () => {
  const chapter = {
    ...CHAPTERS[0], behaviors: { walk: 1 }, fragments: [], formations: [], strikeChance: 1, strikeMoves: ['claw' as const], strikeRepeat: 1,
    waves: [{ count: 1, interval: 2, maxAlive: 1 }],
  }

  it('足を止めて技を溜め、当てると油が減って跳び退く', () => {
    const g = new TypingGame(chapter, 'normal', 41)
    const kinds: string[] = []
    let zAtStrike = 0
    for (let i = 0; i < 600 && !kinds.includes('strike'); i++) {
      for (const ev of g.update(0.05)) {
        kinds.push(ev.kind)
        if (ev.kind === 'strike') zAtStrike = g.enemies[0]?.z ?? 0
      }
    }
    expect(kinds).toContain('strike-warn')
    expect(kinds.indexOf('strike')).toBeGreaterThan(kinds.indexOf('strike-warn'))
    expect(g.oil).toBe(MAX_OIL - 1)
    expect(zAtStrike).toBeGreaterThan(8)
  })

  it('溜めているあいだに打ち切ると、見切りで止められる', () => {
    const g = new TypingGame(chapter, 'normal', 42)
    const kinds: string[] = []
    for (let i = 0; i < 600 && !kinds.includes('strike-warn'); i++) for (const ev of g.update(0.05)) kinds.push(ev.kind)
    const e = g.enemies[0]
    for (const ch of e.matcher.rest) for (const ev of g.key(ch)) kinds.push(ev.kind)
    expect(kinds).toContain('parry')
    expect(g.oil).toBe(MAX_OIL)
  })
})

describe('技の種類', () => {
  it('一斉射撃は、火の玉を一度に 3 つ飛ばしてくる', () => {
    const chapter = {
      ...CHAPTERS[0], behaviors: { walk: 1 }, fragments: [], formations: [], strikeChance: 1, strikeMoves: ['volley' as const], strikeRepeat: 1,
      waves: [{ count: 1, interval: 2, maxAlive: 1 }],
    }
    const g = new TypingGame(chapter, 'normal', 51)
    const kinds: string[] = []
    for (let i = 0; i < 600 && !kinds.includes('strike'); i++) for (const ev of g.update(0.05)) kinds.push(ev.kind)
    expect(g.enemies.filter((e) => e.kind === 'orb')).toHaveLength(3)
  })

  it('2 回仕掛けてくる章では、跳び退いたあとにもう一度仕掛けてくる', () => {
    const chapter = {
      ...CHAPTERS[1], behaviors: { walk: 1 }, fragments: [], formations: [], strikeChance: 1, strikeMoves: ['claw' as const], strikeRepeat: 2,
      reveal: 0, waves: [{ count: 1, interval: 2, maxAlive: 1 }],
    }
    const g = new TypingGame(chapter, 'easy', 52)
    let strikes = 0
    for (let i = 0; i < 1200 && strikes < 2 && !g.over; i++) for (const ev of g.update(0.05)) if (ev.kind === 'strike') strikes++
    expect(strikes).toBe(2)
  })

  it('章ごとに、使う技が違う', () => {
    expect(CHAPTERS[0].strikeMoves).not.toEqual(CHAPTERS[1].strikeMoves)
    for (const c of CHAPTERS) expect(c.strikeMoves.length, c.title).toBeGreaterThan(0)
  })
})
