// タイピングの進行そのもの。React にも three.js にも依存しない（vitest で試せる）。
//
//   update(dt)  時間を進める（影が近づく・新しい影が出る・ボスが子分を呼ぶ）
//   key(ch)     1 文字打つ
// どちらも「起きた出来事（GameEvent[]）」を返す。音と演出は出来事を見て画面側が出す。
//
// 位置: プレイヤーは原点で +z を向いている。影は z = SPAWN_Z に出て、z が REACH_Z まで来たら襲われる。
//
// 狙いの決まり方:
//   - 誰も狙っていないとき、打ったキーで始まる影のうち、いちばん近いものを狙う
//   - 狙った影は、打ち終えるまで変わらない（Backspace で狙いを外せる → release()）
//
// 仲間の力（Perks）: 物語で助けた仲間が力を貸してくれる（油の上限・霧の見える距離・油が戻る打数・鈴）。
// どの仲間がいるかはセーブで決まる（save.ts の perksOf）。鈴は ringBell() で鳴らす。

import { type Behavior, CHAPTERS, type Chapter, ENDLESS, FAST_WORDS, type Wave, type Word } from './chapters'
import { RomajiMatcher } from './romaji'
import { Rng } from './rng'

export const SPAWN_Z = 30
export const REACH_Z = 1.8
export const BOSS_Z = 22
/** ボスの言葉を 1 つ返すと、どれだけ押し戻せるか（m） */
export const BOSS_KNOCKBACK = 7
export const MAX_OIL = 5
/** このコンボごとに油が 1 戻る */
export const HEAL_COMBO = 30
/** 鈴を鳴らすと影が押し戻される距離（m）。ボスはこの半分 */
export const BELL_PUSH = 11

/** 仲間がくれる力 */
export interface Perks {
  maxOil: number
  healCombo: number
  /** 霧の章で、言葉が読める距離を何 m 伸ばすか */
  revealBonus: number
  /** 鈴を持っているか（戦いごとに 1 回鳴らせる） */
  bell: boolean
}

export const NO_PERKS: Perks = { maxOil: MAX_OIL, healCombo: HEAL_COMBO, revealBonus: 0, bell: false }
/** 狐火の速さ（ふつうの影の何倍か） */
export const FAST_MUL = 1.7
/** 飛びかかる影（lunge）が足を止めて力を溜める距離（m）と時間（秒）、飛びかかる速さ（m/秒） */
export const LUNGE_Z = 11
export const LUNGE_WINDUP = 1.4
export const LUNGE_SPEED = 16
/** いきなり出てくる影（ambush）が現れる距離（m） */
export const AMBUSH_Z = 12
/** 消える影（blink）が何秒ごとに、何 m 先へ現れるか */
export const BLINK_EVERY = 2.6
export const BLINK_JUMP = 5

/** 難しさ。影が目の前に来るまでの時間に掛ける */
export const DIFFICULTIES = {
  easy: { name: 'やさしい', time: 1.4 },
  normal: { name: 'ふつう', time: 1 },
  hard: { name: 'むずかしい', time: 0.75 },
} as const
export type Difficulty = keyof typeof DIFFICULTIES

export type EnemyKind = 'shade' | 'fox' | 'boss'

export interface Enemy {
  id: number
  kind: EnemyKind
  word: Word
  matcher: RomajiMatcher
  x: number
  z: number
  /** m/秒 */
  speed: number
  /** 左右の揺れの基準位置と位相 */
  baseX: number
  phase: number
  /** 動き方（chapters.ts の Behavior）。狐火とボスは 'walk' */
  behavior: Behavior
  /** lunge の段階: move 近づく → windup 溜める → dash 飛びかかる */
  state: 'move' | 'windup' | 'dash'
  /** 動きに使う時計（秒） */
  timer: number
  /** あと何個の言葉で倒れるか（tank は 2、ほかは 1） */
  hp: number
  /** ボスだけ: なくした言葉の一覧と、今いくつ目か */
  phrases?: Word[]
  phraseIndex?: number
}

export type GameEvent =
  | { kind: 'key'; id: number; combo: number }
  | { kind: 'miss' }
  | { kind: 'lock'; id: number }
  | { kind: 'release'; id: number }
  | { kind: 'kill'; id: number; x: number; z: number; enemy: EnemyKind; score: number }
  | { kind: 'hit'; id: number; damage: number }
  | { kind: 'heal' }
  | { kind: 'spawn'; id: number; enemy: EnemyKind }
  | { kind: 'wave'; index: number; total: number }
  | { kind: 'boss'; name: string }
  | { kind: 'boss-hurt'; id: number; left: number; score: number }
  | { kind: 'bell' }
  | { kind: 'windup'; id: number }
  | { kind: 'dash'; id: number }
  | { kind: 'blink'; id: number; x: number; fromZ: number; toZ: number }
  | { kind: 'ambush'; id: number }
  | { kind: 'armor'; id: number }
  | { kind: 'split'; id: number }
  | { kind: 'clear' }
  | { kind: 'dead' }

export interface Stats {
  correct: number
  misses: number
  kills: number
  maxCombo: number
  damage: number
}

/** 結果のランク。打つ速さ（1 分あたりのキー数）と正確さで決める */
export function rankOf(kpm: number, accuracy: number): 'S' | 'A' | 'B' | 'C' {
  const p = kpm * accuracy * accuracy
  if (p >= 240) return 'S'
  if (p >= 170) return 'A'
  if (p >= 110) return 'B'
  return 'C'
}

/** コンボに応じた得点の倍率（10 コンボごとに +0.25、最大 ×4） */
export function multiplierOf(combo: number): number {
  return Math.min(4, 1 + Math.floor(combo / 10) * 0.25)
}

export class TypingGame {
  readonly chapter: Chapter
  readonly difficulty: Difficulty
  readonly endless: boolean
  enemies: Enemy[] = []
  target: Enemy | null = null
  readonly perks: Perks
  oil: number
  /** 残りの鈴の回数 */
  bells: number
  score = 0
  combo = 0
  time = 0
  stats: Stats = { correct: 0, misses: 0, kills: 0, maxCombo: 0, damage: 0 }
  /** 0 から数えた今の波。ボス戦中は waves.length */
  waveIndex = 0
  result: 'clear' | 'dead' | null = null
  /** ボス戦に入ったか */
  bossStarted = false

  private rng: Rng
  private nextId = 1
  private spawned = 0
  private spawnTimer = 0
  /** 波と波のあいだの休み（秒） */
  private pause = 1.2
  private waveAnnounced = false
  private summonTimer = 0
  private bossSpawned = false

  constructor(chapter: Chapter, difficulty: Difficulty = 'normal', seed = Date.now(), perks: Perks = NO_PERKS) {
    this.perks = perks
    this.oil = perks.maxOil
    this.bells = perks.bell ? 1 : 0
    this.chapter = chapter
    this.difficulty = difficulty
    this.endless = chapter.id === ENDLESS.id
    this.rng = new Rng(seed)
  }

  get over(): boolean {
    return this.result !== null
  }

  get boss(): Enemy | null {
    return this.enemies.find((e) => e.kind === 'boss') ?? null
  }

  get totalWaves(): number {
    return this.endless ? Infinity : this.chapter.waves.length
  }

  get multiplier(): number {
    return multiplierOf(this.combo)
  }

  get accuracy(): number {
    const all = this.stats.correct + this.stats.misses
    return all ? this.stats.correct / all : 1
  }

  /** 1 分あたりの正しいキー数 */
  get kpm(): number {
    return this.time > 0 ? (this.stats.correct / this.time) * 60 : 0
  }

  /** 言葉が読めるか（霧の章では、近づくまで読めない。読めない影は狙えない） */
  isVisible(e: Enemy): boolean {
    return e.kind === 'boss' || this.chapter.reveal <= 0 || e.z <= this.chapter.reveal + this.perks.revealBonus
  }

  /** 今の波の設定（終わらない夜は波ごとに作る） */
  private wave(i: number): Wave | null {
    if (this.endless) {
      return { count: 6 + i * 2, interval: Math.max(1.0, 2.2 - i * 0.12), maxAlive: Math.min(6, 3 + Math.floor(i / 2)) }
    }
    return this.chapter.waves[i] ?? null
  }

  /** 影が目の前に来るまでの秒数 */
  private travelTime(romajiLength: number): number {
    const c = this.chapter
    let t = c.baseTime + c.perChar * romajiLength
    if (this.endless) t *= Math.max(0.5, 1 - this.waveIndex * 0.05)
    return t * DIFFICULTIES[this.difficulty].time
  }

  /** 言葉の候補。終わらない夜は、波が進むほど後ろの章の言葉が混ざる */
  private pool(): Word[] {
    if (!this.endless) return this.chapter.words
    const upto = Math.min(CHAPTERS.length, 1 + Math.floor(this.waveIndex / 2))
    return CHAPTERS.slice(0, upto).flatMap((c) => c.words)
  }

  /** 画面に出ている影と、頭文字も言葉もかぶらないものを選ぶ（狙いが迷わないように） */
  private pickWord(pool: Word[]): Word {
    const alive = this.enemies.map((e) => e.word.kana)
    const heads = new Set(this.enemies.map((e) => (e.matcher.typed + e.matcher.rest)[0]))
    let best = pool[0]
    for (let i = 0; i < 12; i++) {
      const cand = this.rng.pick(pool)
      if (alive.includes(cand.kana)) continue
      best = cand
      if (!heads.has(new RomajiMatcher(cand.kana).rest[0])) return cand
    }
    return best
  }

  /** 章の重みに従って、影の動き方を選ぶ */
  private pickBehavior(): Behavior {
    const entries = Object.entries(this.chapter.behaviors) as [Behavior, number][]
    const total = entries.reduce((a, [, w]) => a + w, 0)
    let r = this.rng.next() * total
    for (const [b, w] of entries) {
      r -= w
      if (r <= 0) return b
    }
    return 'walk'
  }

  /** 短い言葉（すばやく打たないといけない影に使う）。ローマ字で max 文字まで */
  private shortPool(max: number): Word[] {
    const list = this.pool().filter((w) => new RomajiMatcher(w.kana).length <= max)
    return list.length >= 3 ? list : FAST_WORDS
  }

  private spawn(kind: EnemyKind, events: GameEvent[], opts: { z?: number; x?: number; behavior?: Behavior } = {}): Enemy {
    const behavior: Behavior = kind === 'fox' ? 'walk' : opts.behavior ?? this.pickBehavior()
    const z = opts.z ?? (behavior === 'ambush' ? AMBUSH_Z : SPAWN_Z)
    const pool = kind === 'fox' ? FAST_WORDS
      : behavior === 'ambush' || behavior === 'mini' ? this.shortPool(6)
        : behavior === 'lunge' ? this.shortPool(10)
          : this.pool()
    const word = this.pickWord(pool)
    const matcher = new RomajiMatcher(word.kana)
    const time = this.travelTime(matcher.length)
    let speed = (z - REACH_Z) / time
    switch (behavior) {
      case 'lunge':
        // 溜める時間のぶん、近づくのは少し速い。止まって溜めたあと一気に飛びかかる
        speed = (z - LUNGE_Z) / Math.max(1.5, time - LUNGE_WINDUP - 0.6)
        break
      case 'ambush': speed = (z - REACH_Z) / Math.max(2.2, time * 0.85); break
      case 'mini': speed = (z - REACH_Z) / Math.max(2.2, time * 0.75); break
      case 'creep': speed /= 1.1; break // 平均の速さがふつうの影と同じになるように
      case 'blink': speed *= 0.55; break // 消えて近づくぶん、歩くのは遅い
      case 'tank': speed *= 0.72; break // 言葉が 2 つあるぶん遅い
    }
    if (kind === 'fox') speed *= FAST_MUL
    const baseX = opts.x ?? this.rng.range(-3.2, 3.2)
    const e: Enemy = {
      id: this.nextId++, kind, word, matcher, x: baseX, z, speed, baseX, phase: this.rng.range(0, Math.PI * 2),
      behavior, state: 'move', timer: 0, hp: behavior === 'tank' ? 2 : 1,
    }
    this.enemies.push(e)
    events.push({ kind: 'spawn', id: e.id, enemy: kind })
    if (behavior === 'ambush') events.push({ kind: 'ambush', id: e.id })
    return e
  }

  /** 影を 1 体ぶん動かす（動き方ごと） */
  private move(e: Enemy, dt: number, events: GameEvent[]): void {
    e.timer += dt
    if (e.kind === 'boss') {
      e.z -= e.speed * dt
      return
    }
    let v = e.speed
    let swayAmp = this.chapter.sway
    let swayRate = e.kind === 'fox' ? 3.2 : 1.1
    switch (e.behavior) {
      case 'creep': {
        // 遠くではゆっくり、近づくほど速く
        const k = 1 - Math.max(0, Math.min(1, (e.z - REACH_Z) / (SPAWN_Z - REACH_Z)))
        v = e.speed * (0.5 + 1.2 * k)
        break
      }
      case 'hop':
        // 跳ねて進み、止まる（平均の速さは同じ）
        v = e.speed * Math.PI * Math.max(0, Math.sin(e.timer * 2.6))
        swayAmp *= 0.3
        break
      case 'zigzag':
        swayAmp = 2.6
        swayRate = 1.6
        break
      case 'blink':
        if (e.timer >= BLINK_EVERY && e.z > LUNGE_Z - 2) {
          e.timer = 0
          const fromZ = e.z
          e.z = Math.max(6, e.z - BLINK_JUMP)
          e.baseX = Math.max(-3.4, Math.min(3.4, e.baseX + this.rng.range(-2.5, 2.5)))
          events.push({ kind: 'blink', id: e.id, x: e.baseX, fromZ, toZ: e.z })
        }
        break
      case 'lunge':
        if (e.state === 'move') {
          if (e.z <= LUNGE_Z) {
            e.state = 'windup'
            e.timer = 0
            events.push({ kind: 'windup', id: e.id })
          }
        } else if (e.state === 'windup') {
          v = 0
          swayAmp *= 0.15
          if (e.timer >= LUNGE_WINDUP) {
            e.state = 'dash'
            events.push({ kind: 'dash', id: e.id })
          }
        } else {
          v = LUNGE_SPEED
          swayAmp = 0
        }
        break
    }
    e.z -= v * dt
    e.phase += dt * swayRate
    e.x = e.baseX + Math.sin(e.phase) * swayAmp
  }

  private spawnBoss(events: GameEvent[]): void {
    const def = this.chapter.boss!
    const word = def.phrases[0]
    const e: Enemy = {
      id: this.nextId++, kind: 'boss', word, matcher: new RomajiMatcher(word.kana),
      x: 0, z: BOSS_Z, speed: 0, baseX: 0, phase: 0, phrases: def.phrases, phraseIndex: 0,
      behavior: 'walk', state: 'move', timer: 0, hp: def.phrases.length,
    }
    e.speed = this.bossSpeed(e)
    this.enemies.push(e)
    this.bossSpawned = true
    this.summonTimer = def.summonEvery
    events.push({ kind: 'boss', name: def.name })
  }

  /** ボスは言葉が長いぶんゆっくり来る（いまの言葉を打ち切れる時間で目の前に着く） */
  private bossSpeed(e: Enemy): number {
    return (e.z - REACH_Z) / (this.travelTime(e.matcher.length) * 1.25)
  }

  update(dt: number): GameEvent[] {
    const events: GameEvent[] = []
    if (this.over) return events
    this.time += dt

    // --- 波の進行 ---
    const wave = this.wave(this.waveIndex)
    if (this.pause > 0) {
      this.pause -= dt
    } else if (wave) {
      if (!this.waveAnnounced) {
        this.waveAnnounced = true
        events.push({ kind: 'wave', index: this.waveIndex, total: this.totalWaves })
      }
      const alive = this.enemies.length
      if (this.spawned < wave.count && alive < wave.maxAlive) {
        this.spawnTimer -= dt
        if (this.spawnTimer <= 0 || alive === 0) {
          const fast = this.rng.next() < this.chapter.fastChance
          this.spawn(fast ? 'fox' : 'shade', events)
          this.spawned++
          this.spawnTimer = wave.interval
        }
      } else if (this.spawned >= wave.count && alive === 0) {
        this.waveIndex++
        this.spawned = 0
        this.spawnTimer = 0
        this.waveAnnounced = false
        this.pause = 2.2
      }
    } else if (this.chapter.boss) {
      // 波を全部越えたらボス
      if (!this.bossStarted) {
        this.bossStarted = true
        this.spawnBoss(events)
      } else if (this.chapter.boss.summonEvery > 0 && this.boss) {
        this.summonTimer -= dt
        if (this.summonTimer <= 0 && this.enemies.length < 3) {
          this.summonTimer = this.chapter.boss.summonEvery
          this.spawn(this.rng.next() < 0.4 ? 'fox' : 'shade', events)
        }
      }
      if (this.bossSpawned && this.enemies.length === 0) this.finish('clear', events)
    } else {
      this.finish('clear', events)
    }

    // --- 影が近づく ---
    for (const e of [...this.enemies]) {
      this.move(e, dt, events)
      if (e.z <= REACH_Z) this.hit(e, events)
      if (this.over) break
    }
    return events
  }

  private hit(e: Enemy, events: GameEvent[]): void {
    const damage = e.kind === 'boss' ? 2 : 1
    this.oil = Math.max(0, this.oil - damage)
    this.stats.damage += damage
    this.combo = 0
    events.push({ kind: 'hit', id: e.id, damage })
    if (e.kind === 'boss') {
      // ボスは消えずに押し戻され、今の言葉を最初から
      e.z = BOSS_Z
      e.matcher.reset()
      e.speed = this.bossSpeed(e)
      if (this.target === e) this.target = null
    } else {
      this.remove(e)
    }
    if (this.oil <= 0) this.finish('dead', events)
  }

  private remove(e: Enemy): void {
    this.enemies = this.enemies.filter((x) => x !== e)
    if (this.target === e) this.target = null
  }

  private finish(result: 'clear' | 'dead', events: GameEvent[]): void {
    if (this.over) return
    this.result = result
    this.target = null
    events.push({ kind: result })
  }

  /** 1 文字打つ。英小文字・数字・記号（- , . ! ?）以外は無視する */
  key(raw: string): GameEvent[] {
    const events: GameEvent[] = []
    if (this.over || raw.length !== 1) return events
    const ch = raw.toLowerCase()
    if (!/[a-z0-9\-,.!?']/.test(ch)) return events

    let t = this.target
    if (!t) {
      const cands = this.enemies.filter((e) => this.isVisible(e) && e.matcher.accepts(ch)).sort((a, b) => a.z - b.z)
      t = cands[0] ?? null
      if (t) {
        this.target = t
        events.push({ kind: 'lock', id: t.id })
      }
    }
    if (!t || !t.matcher.key(ch)) {
      this.combo = 0
      this.stats.misses++
      events.push({ kind: 'miss' })
      return events
    }

    this.combo++
    this.stats.correct++
    this.stats.maxCombo = Math.max(this.stats.maxCombo, this.combo)
    this.score += Math.round(10 * this.multiplier)
    events.push({ kind: 'key', id: t.id, combo: this.combo })
    if (this.combo % this.perks.healCombo === 0 && this.oil < this.perks.maxOil) {
      this.oil++
      events.push({ kind: 'heal' })
    }

    if (t.matcher.done) this.complete(t, events)
    return events
  }

  /** 狙っている言葉を打ち終えた */
  private complete(t: Enemy, events: GameEvent[]): void {
    const mul = this.multiplier
    if (t.kind === 'boss') {
      const phrases = t.phrases!
      const next = t.phraseIndex! + 1
      const gain = Math.round(300 * mul)
      this.score += gain
      if (next < phrases.length) {
        t.phraseIndex = next
        t.word = phrases[next]
        t.matcher = new RomajiMatcher(t.word.kana)
        t.z = Math.min(BOSS_Z, t.z + BOSS_KNOCKBACK)
        t.speed = this.bossSpeed(t)
        this.target = null
        events.push({ kind: 'boss-hurt', id: t.id, left: phrases.length - next, score: gain })
        return
      }
      this.stats.kills++
      events.push({ kind: 'kill', id: t.id, x: t.x, z: t.z, enemy: 'boss', score: gain })
      // ボスがほどけると、呼ばれていた子分も一緒に光に戻る（得点は無し）
      for (const e of this.enemies) {
        if (e !== t) events.push({ kind: 'kill', id: e.id, x: e.x, z: e.z, enemy: e.kind, score: 0 })
      }
      this.enemies = []
      this.target = null
      return
    }
    // 硬い影: 1 つ目の言葉で殻が割れ、少し押し戻されて 2 つ目の言葉が出る
    if (t.behavior === 'tank' && t.hp > 1) {
      t.hp--
      t.word = this.pickWord(this.shortPool(8))
      t.matcher = new RomajiMatcher(t.word.kana)
      t.z = Math.min(SPAWN_Z, t.z + 3)
      this.target = null
      this.score += Math.round(60 * mul)
      events.push({ kind: 'armor', id: t.id })
      return
    }
    // 遠くで倒すほど少し多くもらえる
    const gain = Math.round((40 * t.word.kana.length + t.z * 4) * mul)
    this.score += gain
    this.stats.kills++
    events.push({ kind: 'kill', id: t.id, x: t.x, z: t.z, enemy: t.kind, score: gain })
    this.remove(t)
    // 分かれる影: 小さな影 2 体になって、左右から来る
    if (t.behavior === 'split') {
      events.push({ kind: 'split', id: t.id })
      for (const dx of [-1.3, 1.3]) {
        this.spawn('shade', events, { z: Math.max(t.z, 7), x: Math.max(-3.6, Math.min(3.6, t.x + dx)), behavior: 'mini' })
      }
    }
  }

  /** 狙いを外す（Backspace）。打ちかけた分は最初から */
  /** 鈴を鳴らす（Space）。影をまとめて押し戻し、狙いを外す。鳴らせなければ何も起きない */
  ringBell(): GameEvent[] {
    if (this.over || this.bells <= 0) return []
    this.bells--
    for (const e of this.enemies) {
      e.z = Math.min(e.kind === 'boss' ? BOSS_Z : SPAWN_Z, e.z + (e.kind === 'boss' ? BELL_PUSH / 2 : BELL_PUSH))
    }
    return [{ kind: 'bell' }]
  }

  release(): GameEvent[] {
    const t = this.target
    if (!t || this.over) return []
    t.matcher.reset()
    this.target = null
    return [{ kind: 'release', id: t.id }]
  }
}
