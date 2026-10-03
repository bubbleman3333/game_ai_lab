// タイピングの進行そのもの。React にも three.js にも依存しない（vitest で試せる）。
//
//   update(dt)  時間を進める（影が近づく・新しい影が出る・影やボスが攻撃してくる）
//   key(ch)     1 文字打つ
// どちらも「起きた出来事（GameEvent[]）」を返す。音と演出は出来事を見て画面側が出す。
//
// 位置: プレイヤーは原点で +z を向いている。影は z = SPAWN_Z に出て、z が REACH_Z まで来たら襲われる。
//
// 狙いの決まり方:
//   - 誰も狙っていないとき、打ったキーで始まる影のうち、いちばん近いものを狙う
//   - 狙った影は、打ち終えるまで変わらない（Backspace で狙いを外せる → release()）
//
// 攻めてくる影（chapters.ts の Behavior）:
//   火の玉を投げる（shooter → orb）・闇を吐く（ink → darkness）・咆哮（howl → 打ちかけが崩れ、お手本が消える）・
//   吸い付いて油を吸う（leech）・仲間を呼ぶ（caller）・言葉が化ける（mimic）・溜めて飛びかかる（lunge）など。
// ボスは attackEvery 秒ごとに力を溜め（boss-charge）、attacks を順に放つ（boss-attack）。
// 金色の影（golden）は母の手記を持っている。攻撃せず、近づくと逃げる。
//
// 仲間の力（Perks）: 物語で助けた仲間が力を貸してくれる（油の上限・霧の見える距離・油が戻る打数・鈴）。
// どの仲間がいるかはセーブで決まる（save.ts の perksOf）。鈴は ringBell() で鳴らす。

import {
  type Behavior, type BossAttack, CHAPTERS, type Chapter, ENDLESS, FAST_WORDS, GOLDEN_WORDS, ORB_WORDS, type Wave, type Word,
} from './chapters'
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
/** 火の玉を投げる影（shooter）: 止まる距離・投げる間隔（秒）・投げる数。火の玉が届くまでの秒数 */
export const SHOOT_Z = 17
export const SHOOT_EVERY = 3.2
export const SHOOT_MAX = 3
export const ORB_TIME = 2.8
/** 闇を吐く影（ink）: 吐く距離と、見えなくなる秒数 */
export const INK_Z = 15
export const INK_TIME = 4.5
/** 咆哮する影（howl）: 吠える距離と、ローマ字のお手本が消える秒数 */
export const HOWL_Z = 13
export const GUIDE_HIDE = 3.5
/** 仲間を呼ぶ影（caller）・言葉が化ける影（mimic）が動く距離 */
export const CALL_Z = 19
export const MIMIC_Z = 15
/** 吸い付く影（leech）が油を吸う間隔（秒） */
export const LEECH_DRAIN = 3
/** 金色の影が逃げる距離 */
export const GOLDEN_FLEE_Z = 7
/** ボスが攻撃の前に力を溜める秒数 */
export const BOSS_CHARGE = 1.3

/** 難しさ。影が目の前に来るまでの時間に掛ける */
export const DIFFICULTIES = {
  easy: { name: 'やさしい', time: 1.4 },
  normal: { name: 'ふつう', time: 1 },
  hard: { name: 'むずかしい', time: 0.75 },
} as const
export type Difficulty = keyof typeof DIFFICULTIES

/** shade ふつうの影 / fox 狐火 / boss ボス / orb 飛んでくる火の玉 */
export type EnemyKind = 'shade' | 'fox' | 'boss' | 'orb'

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
  /** 動き方（chapters.ts の Behavior）。狐火・ボス・火の玉は 'walk' */
  behavior: Behavior
  /**
   * 段階: move 近づく / windup 溜める（lunge）/ dash 飛びかかる（lunge）/
   * aim 立ち止まって火の玉を投げる（shooter）/ latched 目の前に吸い付いている（leech）
   */
  state: 'move' | 'windup' | 'dash' | 'aim' | 'latched'
  /** 動きに使う時計（秒） */
  timer: number
  /** あと何個の言葉で倒れるか（tank は 2、ほかは 1） */
  hp: number
  /** 一度きりの技（闇・咆哮・呼び寄せ・化け）を使ったか */
  acted: boolean
  /** 投げた火の玉の数（shooter） */
  throws: number
  /** 金色の影が持っている手記の番号 */
  page?: number
  /** ボスだけ: なくした言葉の一覧と、今いくつ目か */
  phrases?: Word[]
  phraseIndex?: number
}

export type GameEvent =
  | { kind: 'key'; id: number; combo: number }
  | { kind: 'miss' }
  | { kind: 'lock'; id: number }
  | { kind: 'release'; id: number }
  | { kind: 'kill'; id: number; x: number; z: number; enemy: EnemyKind; score: number; golden?: boolean }
  | { kind: 'hit'; id: number; damage: number }
  | { kind: 'heal' }
  | { kind: 'spawn'; id: number; enemy: EnemyKind }
  | { kind: 'wave'; index: number; total: number }
  | { kind: 'midwave'; index: number }
  | { kind: 'boss'; name: string }
  | { kind: 'boss-hurt'; id: number; left: number; score: number }
  | { kind: 'boss-charge'; id: number; attack: BossAttack }
  | { kind: 'boss-attack'; id: number; attack: BossAttack }
  | { kind: 'bell' }
  | { kind: 'windup'; id: number }
  | { kind: 'dash'; id: number }
  | { kind: 'blink'; id: number; x: number; fromZ: number; toZ: number }
  | { kind: 'ambush'; id: number }
  | { kind: 'armor'; id: number }
  | { kind: 'split'; id: number }
  | { kind: 'shoot'; id: number; orb: number }
  | { kind: 'ink'; id: number }
  | { kind: 'howl'; id: number }
  | { kind: 'latch'; id: number }
  | { kind: 'drain'; id: number }
  | { kind: 'call'; id: number }
  | { kind: 'mimic'; id: number }
  | { kind: 'golden'; id: number }
  | { kind: 'escape'; id: number }
  | { kind: 'fragment'; page: number }
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
  /** 闇が残っている秒数（このあいだ、遠くの言葉は見えず狙えない） */
  darkness = 0
  /** ローマ字のお手本が消えている秒数（咆哮） */
  guideHidden = 0
  /** この戦いで見つけた母の手記の番号 */
  fragmentsFound: number[] = []
  /** ボスが溜めている攻撃（溜めていなければ null）と、放つまでの秒数 */
  bossCharging: BossAttack | null = null
  bossChargeLeft = 0

  private rng: Rng
  private nextId = 1
  private spawned = 0
  private spawnTimer = 0
  /** 波と波のあいだの休み（秒） */
  private pause = 1.2
  private waveAnnounced = false
  private midAnnounced = false
  private bossSpawned = false
  private bossAttackTimer = 0
  private bossAttackIndex = 0
  /** すでに持っている手記（金色の影を出さない） */
  private ownedPages: Set<number>

  constructor(chapter: Chapter, difficulty: Difficulty = 'normal', seed = Date.now(), perks: Perks = NO_PERKS,
              ownedPages: readonly number[] = []) {
    this.perks = perks
    this.oil = perks.maxOil
    this.bells = perks.bell ? 1 : 0
    this.chapter = chapter
    this.difficulty = difficulty
    this.endless = chapter.id === ENDLESS.id
    this.rng = new Rng(seed)
    this.ownedPages = new Set(ownedPages)
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

  private get timeMul(): number {
    return DIFFICULTIES[this.difficulty].time
  }

  /**
   * 言葉が読めて、狙えるか。
   * 闇のあいだは、狙っている影と目の前（7m 以内）の影しか見えない。霧の章では遠すぎる影は狙えない。
   */
  isVisible(e: Enemy): boolean {
    if (e.kind === 'boss') return true
    if (this.darkness > 0 && e !== this.target && e.z > 7) return false
    return this.chapter.reveal <= 0 || e.z <= this.chapter.reveal + this.perks.revealBonus
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
    return t * this.timeMul
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
    for (let i = 0; i < 16; i++) {
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

  private spawn(kind: EnemyKind, events: GameEvent[], opts: { z?: number; x?: number; behavior?: Behavior; page?: number } = {}): Enemy {
    const behavior: Behavior = kind === 'fox' || kind === 'orb' ? 'walk' : opts.behavior ?? this.pickBehavior()
    const z = opts.z ?? (behavior === 'ambush' ? AMBUSH_Z : SPAWN_Z)
    const pool = kind === 'fox' ? FAST_WORDS
      : kind === 'orb' ? ORB_WORDS
        : behavior === 'golden' ? GOLDEN_WORDS
          : behavior === 'ambush' || behavior === 'mini' ? this.shortPool(6)
            : behavior === 'lunge' || behavior === 'leech' ? this.shortPool(10)
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
      case 'shooter': speed = (z - SHOOT_Z) / Math.max(1.5, time * 0.35); break // 投げる位置までは早足
      case 'golden': speed = (z - GOLDEN_FLEE_Z) / (time * 0.9); break
    }
    if (kind === 'fox') speed *= FAST_MUL
    if (kind === 'orb') speed = (z - REACH_Z) / (ORB_TIME * this.timeMul)
    const baseX = opts.x ?? this.rng.range(-3.2, 3.2)
    const e: Enemy = {
      id: this.nextId++, kind, word, matcher, x: baseX, z, speed, baseX, phase: this.rng.range(0, Math.PI * 2),
      behavior, state: 'move', timer: 0, hp: behavior === 'tank' ? 2 : 1, acted: false, throws: 0, page: opts.page,
    }
    this.enemies.push(e)
    events.push({ kind: 'spawn', id: e.id, enemy: kind })
    if (behavior === 'ambush') events.push({ kind: 'ambush', id: e.id })
    if (behavior === 'golden') events.push({ kind: 'golden', id: e.id })
    return e
  }

  /** 影を 1 体ぶん動かす（動き方ごと）。攻撃もここで出す */
  private move(e: Enemy, dt: number, events: GameEvent[]): void {
    e.timer += dt
    if (e.kind === 'boss' || e.kind === 'orb') {
      e.z -= e.speed * dt
      return
    }
    if (e.state === 'latched') {
      // 吸い付いた影: 目の前に張りついて、油を吸い続ける
      e.x += (0 - e.x) * Math.min(1, dt * 3)
      if (e.timer >= LEECH_DRAIN) {
        e.timer = 0
        events.push({ kind: 'drain', id: e.id })
        this.loseOil(1, e.id, events)
      }
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
      case 'golden':
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
      case 'shooter':
        if (e.state === 'move' && e.throws < SHOOT_MAX && e.z <= SHOOT_Z) {
          e.state = 'aim'
          e.timer = SHOOT_EVERY - 0.8 // 止まってすぐ 1 発目
        }
        if (e.state === 'aim') {
          v = 0
          swayAmp *= 0.4
          if (e.timer >= SHOOT_EVERY) {
            e.timer = 0
            e.throws++
            const orb = this.spawn('orb', events, { z: e.z - 0.5, x: e.x })
            events.push({ kind: 'shoot', id: e.id, orb: orb.id })
            if (e.throws >= SHOOT_MAX) {
              // 投げ終えたら、また近づいてくる（残り時間で目の前に着く速さ）
              e.state = 'move'
              e.speed = (e.z - REACH_Z) / Math.max(3, this.travelTime(e.matcher.length) * 0.6)
            }
          }
        }
        break
      case 'ink':
        if (!e.acted && e.z <= INK_Z) {
          e.acted = true
          this.darkness = INK_TIME
          events.push({ kind: 'ink', id: e.id })
        }
        break
      case 'howl':
        if (!e.acted && e.z <= HOWL_Z) {
          e.acted = true
          this.howl(events, e.id)
        }
        break
      case 'caller':
        if (!e.acted && e.z <= CALL_Z) {
          e.acted = true
          events.push({ kind: 'call', id: e.id })
          for (const dx of [-1.6, 1.6]) {
            this.spawn('shade', events, { z: e.z + 1, x: Math.max(-3.6, Math.min(3.6, e.x + dx)), behavior: 'mini' })
          }
        }
        break
      case 'mimic':
        if (!e.acted && e.z <= MIMIC_Z) {
          e.acted = true
          e.word = this.pickWord(this.pool())
          e.matcher = new RomajiMatcher(e.word.kana)
          if (this.target === e) this.target = null
          events.push({ kind: 'mimic', id: e.id })
        }
        break
    }
    e.z -= v * dt
    e.phase += dt * swayRate
    e.x = e.baseX + Math.sin(e.phase) * swayAmp
  }

  /** 咆哮: 打ちかけの言葉が崩れ、しばらくローマ字のお手本が消える */
  private howl(events: GameEvent[], id: number): void {
    this.target?.matcher.reset()
    this.target = null
    this.guideHidden = GUIDE_HIDE
    events.push({ kind: 'howl', id })
  }

  private spawnBoss(events: GameEvent[]): void {
    const def = this.chapter.boss!
    const word = def.phrases[0]
    const e: Enemy = {
      id: this.nextId++, kind: 'boss', word, matcher: new RomajiMatcher(word.kana),
      x: 0, z: BOSS_Z, speed: 0, baseX: 0, phase: 0, phrases: def.phrases, phraseIndex: 0,
      behavior: 'walk', state: 'move', timer: 0, hp: def.phrases.length, acted: false, throws: 0,
    }
    e.speed = this.bossSpeed(e)
    this.enemies.push(e)
    this.bossSpawned = true
    this.bossAttackTimer = def.attackEvery * this.timeMul * 0.7
    events.push({ kind: 'boss', name: def.name })
  }

  /** ボスは言葉が長いぶんゆっくり来る（いまの言葉を打ち切れる時間で目の前に着く） */
  private bossSpeed(e: Enemy): number {
    return (e.z - REACH_Z) / (this.travelTime(e.matcher.length) * 1.25)
  }

  /** ボスの攻撃（力を溜めて → 放つ） */
  private bossTurn(boss: Enemy, dt: number, events: GameEvent[]): void {
    const def = this.chapter.boss!
    if (this.bossCharging) {
      this.bossChargeLeft -= dt
      if (this.bossChargeLeft > 0) return
      const attack = this.bossCharging
      this.bossCharging = null
      events.push({ kind: 'boss-attack', id: boss.id, attack })
      switch (attack) {
        case 'orbs':
          // 火の玉を 3 つ。少しずつずらして、続けざまに届くように
          for (let i = 0; i < 3; i++) {
            this.spawn('orb', events, { z: Math.min(SPAWN_Z, boss.z + i * 3.2), x: (i - 1) * 2.4 })
          }
          break
        case 'howl': this.howl(events, boss.id); break
        case 'ink': this.darkness = INK_TIME; break
        case 'quake':
          // 地鳴り: 影がみな少し近づく
          for (const e of this.enemies) if (e !== boss && e.state !== 'latched') e.z = Math.max(REACH_Z + 1.5, e.z - 3.5)
          break
        case 'summon':
          if (this.enemies.length < 5) for (let i = 0; i < 2; i++) this.spawn('shade', events, {})
          break
      }
      this.bossAttackTimer = def.attackEvery * this.timeMul
      return
    }
    this.bossAttackTimer -= dt
    if (this.bossAttackTimer <= 0 && def.attacks.length) {
      const attack = def.attacks[this.bossAttackIndex++ % def.attacks.length]
      this.bossCharging = attack
      this.bossChargeLeft = BOSS_CHARGE
      events.push({ kind: 'boss-charge', id: boss.id, attack })
    }
  }

  update(dt: number): GameEvent[] {
    const events: GameEvent[] = []
    if (this.over) return events
    this.time += dt
    this.darkness = Math.max(0, this.darkness - dt)
    this.guideHidden = Math.max(0, this.guideHidden - dt)

    // --- 波の進行 ---
    const wave = this.wave(this.waveIndex)
    if (this.pause > 0) {
      this.pause -= dt
    } else if (wave) {
      if (!this.waveAnnounced) {
        this.waveAnnounced = true
        this.midAnnounced = false
        events.push({ kind: 'wave', index: this.waveIndex, total: this.totalWaves })
      }
      const alive = this.enemies.filter((e) => e.kind !== 'orb').length
      if (this.spawned < wave.count && alive < wave.maxAlive) {
        this.spawnTimer -= dt
        if (this.spawnTimer <= 0 || alive === 0) {
          const spot = this.chapter.fragments.find((f) => f.wave === this.waveIndex && f.at === this.spawned)
          if (spot && !this.ownedPages.has(spot.page) && !this.fragmentsFound.includes(spot.page)) {
            this.spawn('shade', events, { behavior: 'golden', page: spot.page })
          } else {
            const fast = this.rng.next() < this.chapter.fastChance
            this.spawn(fast ? 'fox' : 'shade', events)
          }
          this.spawned++
          this.spawnTimer = wave.interval
          if (!this.midAnnounced && this.spawned >= Math.ceil(wave.count / 2)) {
            this.midAnnounced = true
            events.push({ kind: 'midwave', index: this.waveIndex })
          }
        }
      } else if (this.spawned >= wave.count && this.enemies.length === 0) {
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
      } else if (this.boss) {
        this.bossTurn(this.boss, dt, events)
      }
      if (this.bossSpawned && this.enemies.length === 0) this.finish('clear', events)
    } else {
      this.finish('clear', events)
    }

    // --- 影が近づく ---
    for (const e of [...this.enemies]) {
      if (!this.enemies.includes(e)) continue
      this.move(e, dt, events)
      if (this.over) break
      if (e.state === 'latched') continue
      if (e.behavior === 'golden' && e.z <= GOLDEN_FLEE_Z) {
        // 金色の影は襲わずに逃げていく（手記は手に入らない）
        this.remove(e)
        events.push({ kind: 'escape', id: e.id })
        continue
      }
      if (e.z <= REACH_Z) this.hit(e, events)
      if (this.over) break
    }
    return events
  }

  /** 油を減らす（0 になったら終わり） */
  private loseOil(damage: number, id: number, events: GameEvent[]): void {
    this.oil = Math.max(0, this.oil - damage)
    this.stats.damage += damage
    this.combo = 0
    events.push({ kind: 'hit', id, damage })
    if (this.oil <= 0) this.finish('dead', events)
  }

  private hit(e: Enemy, events: GameEvent[]): void {
    if (e.behavior === 'leech' && e.kind === 'shade') {
      // 吸い付く影は消えずに張りつき、油を吸い続ける
      e.state = 'latched'
      e.z = REACH_Z + 0.4
      e.timer = 0
      events.push({ kind: 'latch', id: e.id })
      this.loseOil(1, e.id, events)
      return
    }
    this.loseOil(e.kind === 'boss' ? 2 : 1, e.id, events)
    if (e.kind === 'boss') {
      // ボスは消えずに押し戻され、今の言葉を最初から
      e.z = BOSS_Z
      e.matcher.reset()
      e.speed = this.bossSpeed(e)
      if (this.target === e) this.target = null
    } else {
      this.remove(e)
    }
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
      // ボスがほどけると、呼ばれていた子分も火の玉も一緒に光に戻る（得点は無し）
      for (const e of this.enemies) {
        if (e !== t) events.push({ kind: 'kill', id: e.id, x: e.x, z: e.z, enemy: e.kind, score: 0 })
      }
      this.enemies = []
      this.target = null
      this.bossCharging = null
      this.darkness = 0
      this.guideHidden = 0
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
    // 遠くで倒すほど少し多くもらえる。火の玉は少しだけ、金色の影は多め
    const gain = t.kind === 'orb' ? Math.round(20 * mul)
      : Math.round((40 * t.word.kana.length + t.z * 4 + (t.behavior === 'golden' ? 500 : 0)) * mul)
    this.score += gain
    if (t.kind !== 'orb') this.stats.kills++
    events.push({ kind: 'kill', id: t.id, x: t.x, z: t.z, enemy: t.kind, score: gain, golden: t.behavior === 'golden' })
    this.remove(t)
    if (t.behavior === 'golden' && t.page !== undefined) {
      this.fragmentsFound.push(t.page)
      events.push({ kind: 'fragment', page: t.page })
    }
    // 分かれる影: 小さな影 2 体になって、左右から来る
    if (t.behavior === 'split') {
      events.push({ kind: 'split', id: t.id })
      for (const dx of [-1.3, 1.3]) {
        this.spawn('shade', events, { z: Math.max(t.z, 7), x: Math.max(-3.6, Math.min(3.6, t.x + dx)), behavior: 'mini' })
      }
    }
  }

  /** 鈴を鳴らす（Space）。影も火の玉もまとめて押し戻し、吸い付いた影を引きはがし、闇を払う */
  ringBell(): GameEvent[] {
    if (this.over || this.bells <= 0) return []
    this.bells--
    for (const e of this.enemies) {
      if (e.state === 'latched') e.state = 'move'
      e.z = Math.min(e.kind === 'boss' ? BOSS_Z : SPAWN_Z, e.z + (e.kind === 'boss' ? BELL_PUSH / 2 : BELL_PUSH))
    }
    this.darkness = 0
    return [{ kind: 'bell' }]
  }

  /** 狙いを外す（Backspace）。打ちかけた分は最初から */
  release(): GameEvent[] {
    const t = this.target
    if (!t || this.over) return []
    t.matcher.reset()
    this.target = null
    return [{ kind: 'release', id: t.id }]
  }
}
