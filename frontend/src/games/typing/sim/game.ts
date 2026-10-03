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
//   時限の影（bomb）・結界で守る影（guardian）・横から回り込む影（flanker）・急降下（diver）・幻影（phantom）・
//   札が裏返る影（mirror）・足もとから生える手（hand）。
// 陣形（Formation）: 包囲・行列・挟み撃ち・火の雨・一斉突撃・地の手。影が出るときに formationChance の割合でまとめて仕掛ける。
// ボスは attackEvery 秒ごとに力を溜め（boss-charge）、attacks を順に放つ（boss-attack）。
// 言葉を半分返すと怒り（boss-phase2）、攻撃の間隔が短くなって、技を 2 つ続けて放つ。
// 金色の影（golden）は母の手記を持っている。攻撃せず、近づくと逃げる。
//
// 仲間の力（Perks）: 物語で助けた仲間が力を貸してくれる（油の上限・霧の見える距離・油が戻る打数・鈴）。
// どの仲間がいるかはセーブで決まる（save.ts の perksOf）。鈴は ringBell() で鳴らす。

import {
  type Behavior, type BossAttack, CHAPTERS, type Chapter, ENDLESS, FAST_WORDS, type Formation, GOLDEN_WORDS, ORB_WORDS,
  type StrikeMoveName, type Wave, type Word,
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
/** 怒ったボスの攻撃の間隔（ふだんの何倍か） */
export const ENRAGE_MUL = 0.6
/** 時限の影（bomb）: 止まる距離と、爆発までの秒数・爆発で減る油 */
export const BOMB_Z = 9
export const BOMB_FUSE = 5
export const BOMB_DAMAGE = 2
/** 守りの影（guardian）が守る、左右の幅（m） */
export const GUARD_RANGE_X = 2.8
/** 回り込む影（flanker）が出てくる横の位置（m） */
export const FLANK_X = 7.5
/** 急降下（diver）: 出てくる距離・高さ・空で溜める秒数・降りてくる速さ */
export const DIVE_Z = 17
export const DIVE_HEIGHT = 6
export const DIVE_HOVER = 1.4
export const DIVE_SPEED = 9
/** 足もとの手（hand）が、つかみかかるまでの秒数 */
export const HAND_TIME = 3.6
/** 幻影の偽物を打つと、本物がどれだけ詰め寄るか（m） */
export const PHANTOM_LUNGE = 4
/** 火の雨が降り始める高さ（m） */
export const RAIN_HEIGHT = 7
/**
 * 技（strike）: ふつうの影が近づく途中で足を止め、技を溜めてから仕掛ける。
 * 溜めているあいだ（STRIKE_WINDUP 秒）に言葉を打ち切れば止められる（見切り）。当たると油 -1、影は跳び退く。
 */
export const STRIKE_Z = 13
export const STRIKE_MIN_Z = 5
export const STRIKE_WINDUP = 1.3
export const STRIKE_RECOIL = 4
/**
 * 技の種類: 引っかき・噛みつき・毒吐き・舌・跳びかかり（上から）・叩きつけ（伸び上がって下へ）・
 * 一斉射撃（火の玉を一度に 3 つ扇状に飛ばす。当たるのではなく、打ち落とす火の玉が 3 つ増える）
 */
export type StrikeMove = StrikeMoveName
export const STRIKE_NAMES: Record<StrikeMove, string> = {
  claw: '引っかき', bite: '噛みつき', spit: '毒吐き', tongue: '舌', leap: '跳びかかり', slam: '叩きつけ', volley: '一斉射撃',
}
/** 技を仕掛けてくる動き方（ほかの動き方は、それぞれの攻撃を持っている） */
const STRIKERS = new Set<Behavior>(['walk', 'creep', 'hop', 'zigzag', 'tank', 'split', 'mirror', 'guardian', 'caller', 'mimic', 'flanker', 'phantom', 'howl', 'ink'])

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
   * 段階: move 近づく / windup 溜める（lunge）/ dash 飛びかかる（lunge・diver）/
   * aim 立ち止まって火の玉を投げる（shooter）/ latched 目の前に吸い付いている（leech）/
   * armed 爆発までの数を数えている（bomb）/ hover 空で溜めている（diver）/ strike 技を溜めている
   */
  state: 'move' | 'windup' | 'dash' | 'aim' | 'latched' | 'armed' | 'hover' | 'strike'
  /** 技の種類（技を仕掛けない影は undefined）・あと何回仕掛けるか・次に技を始める距離 */
  move?: StrikeMove
  strikesLeft?: number
  strikeAt?: number
  /** 地面からの高さ（m。急降下・火の雨で使う。ふつうは 0） */
  lift: number
  /** 出てきたときの距離と高さ（高さを距離に合わせて下げていくため） */
  startZ: number
  startLift: number
  /** この言葉を打っているあいだに間違えたか（間違えずに打ち切ると「完璧」） */
  missed?: boolean
  /** 幻影: 偽物か。group は本物の id（本物も自分の id） */
  decoy?: boolean
  group?: number
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
  | { kind: 'kill'; id: number; x: number; z: number; enemy: EnemyKind; score: number; golden?: boolean; perfect?: boolean }
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
  | { kind: 'arm'; id: number }
  | { kind: 'explode'; id: number }
  | { kind: 'shield-break'; id: number }
  | { kind: 'flank'; id: number; side: 'left' | 'right' }
  | { kind: 'dive-warn'; id: number }
  | { kind: 'dive'; id: number }
  | { kind: 'decoy'; id: number }
  | { kind: 'hand'; id: number }
  | { kind: 'grab'; id: number }
  | { kind: 'formation'; name: Formation }
  | { kind: 'boss-phase2'; id: number }
  | { kind: 'strike-warn'; id: number; move: StrikeMove }
  | { kind: 'strike'; id: number; move: StrikeMove }
  | { kind: 'parry'; id: number; move: StrikeMove }
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
  /** ボスが怒っているか（言葉を半分返したあと） */
  bossEnraged = false
  /** 怒ったボスが続けざまに放った 2 つ目の技か */
  private chainedAttack = false
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

  /** 守りの影の結界に入っているか（守りの影より奥で、左右が近い）。結界の中の影は狙えない */
  isShielded(e: Enemy): boolean {
    if (e.kind === 'boss' || e.behavior === 'guardian') return false
    return this.enemies.some((g) => g.behavior === 'guardian' && g !== e && g.z < e.z && Math.abs(g.x - e.x) < GUARD_RANGE_X)
  }

  /** 時限の影が爆発するまで・足もとの手がつかみかかるまでの残り秒数（どちらでもなければ null） */
  fuseLeft(e: Enemy): number | null {
    if (e.state === 'armed') return Math.max(0, BOMB_FUSE * this.timeMul - e.timer)
    if (e.behavior === 'hand') return Math.max(0, HAND_TIME * this.timeMul - e.timer)
    return null
  }

  /** 打ち始めの狙いにできるか（読めて、結界の外） */
  isTargetable(e: Enemy): boolean {
    return this.isVisible(e) && !this.isShielded(e)
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

  private spawn(kind: EnemyKind, events: GameEvent[],
                opts: { z?: number; x?: number; behavior?: Behavior; page?: number; lift?: number; decoy?: boolean; group?: number } = {}): Enemy {
    const behavior: Behavior = kind === 'fox' || kind === 'orb' ? 'walk' : opts.behavior ?? this.pickBehavior()
    const side = this.rng.next() < 0.5 ? -1 : 1
    const z = opts.z ?? (behavior === 'ambush' ? AMBUSH_Z
      : behavior === 'diver' ? DIVE_Z
        : behavior === 'flanker' ? this.rng.range(13, 18)
          : behavior === 'hand' ? this.rng.range(4.5, 6.5)
            : SPAWN_Z)
    const pool = kind === 'fox' ? FAST_WORDS
      : kind === 'orb' ? ORB_WORDS
        : behavior === 'golden' ? GOLDEN_WORDS
          : behavior === 'elder' ? (this.endless ? CHAPTERS.slice(0, Math.min(CHAPTERS.length, 1 + Math.floor(this.waveIndex / 2))).flatMap((c) => c.longWords) : this.chapter.longWords)
          : behavior === 'hand' ? this.shortPool(5)
            : behavior === 'ambush' || behavior === 'mini' ? this.shortPool(6)
              : behavior === 'bomb' || behavior === 'diver' || behavior === 'flanker' ? this.shortPool(8)
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
      case 'bomb': speed = (z - BOMB_Z) / Math.max(1.5, time * 0.55); break // 止まる場所までは早足
      case 'guardian': speed *= 0.75; break
      case 'flanker': speed = (z - REACH_Z) / Math.max(2.5, time * 0.8); break
      case 'phantom': speed *= 0.9; break
      case 'hand': speed = 0; break
    }
    if (kind === 'fox') speed *= FAST_MUL
    if (kind === 'orb') speed = (z - REACH_Z) / (ORB_TIME * this.timeMul)
    const baseX = opts.x ?? (behavior === 'flanker' ? side * FLANK_X : this.rng.range(-3.2, 3.2))
    const lift = opts.lift ?? (behavior === 'diver' ? DIVE_HEIGHT : 0)
    const e: Enemy = {
      id: this.nextId++, kind, word, matcher, x: baseX, z, speed, baseX, phase: this.rng.range(0, Math.PI * 2),
      behavior, state: behavior === 'diver' ? 'hover' : 'move', timer: 0, hp: behavior === 'tank' ? 2 : 1,
      acted: false, throws: 0, page: opts.page, lift, startZ: z, startLift: lift, decoy: opts.decoy, group: opts.group,
    }
    if (kind === 'shade' && !opts.decoy && STRIKERS.has(behavior) && this.rng.next() < this.chapter.strikeChance) {
      e.move = this.rng.pick(this.chapter.strikeMoves)
      e.strikesLeft = this.chapter.strikeRepeat
      e.strikeAt = this.rng.range(STRIKE_MIN_Z + 3, STRIKE_Z)
    }
    this.enemies.push(e)
    events.push({ kind: 'spawn', id: e.id, enemy: kind })
    if (behavior === 'ambush') events.push({ kind: 'ambush', id: e.id })
    if (behavior === 'golden') events.push({ kind: 'golden', id: e.id })
    if (behavior === 'flanker') events.push({ kind: 'flank', id: e.id, side: baseX < 0 ? 'right' : 'left' }) // 右が −x
    if (behavior === 'diver') events.push({ kind: 'dive-warn', id: e.id })
    if (behavior === 'hand') events.push({ kind: 'hand', id: e.id })
    // 幻影: 本物のまわりに偽物を 2 体
    if (behavior === 'phantom' && !opts.decoy) {
      e.group = e.id
      for (const dx of [-2.2, 2.2]) {
        this.spawn('shade', events, { z: z + this.rng.range(-1, 1), x: Math.max(-3.8, Math.min(3.8, baseX + dx)), behavior: 'phantom', decoy: true, group: e.id })
      }
      // 本物がどれか分からないよう、並び順を混ぜる（いちばん近い影が本物とは限らない）
      const mine = this.enemies.filter((x) => x.group === e.id)
      for (const m of mine) m.phase = this.rng.range(0, Math.PI * 2)
    }
    return e
  }

  /** 陣形: まとめて仕掛ける。出した影の数を返す */
  private formation(name: Formation, events: GameEvent[]): number {
    events.push({ kind: 'formation', name })
    const lane = this.rng.range(-2, 2)
    switch (name) {
      case 'surround':
        for (const x of [-4, -2, 0, 2, 4]) this.spawn('shade', events, { z: 18 + this.rng.range(0, 2.5), x, behavior: 'walk' })
        return 5
      case 'column':
        for (let i = 0; i < 4; i++) this.spawn('shade', events, { z: 20 + i * 3, x: lane, behavior: 'mini' })
        return 4
      case 'pincer':
        this.spawn('shade', events, { x: -FLANK_X, behavior: 'flanker' })
        this.spawn('shade', events, { x: FLANK_X, behavior: 'flanker' })
        return 2
      case 'rain':
        for (let i = 0; i < 5; i++) this.spawn('orb', events, { z: 12 + i * 2.2, x: this.rng.range(-3.5, 3.5), lift: RAIN_HEIGHT })
        return 3
      case 'rush':
        for (const x of [-3, 0, 3]) this.spawn('shade', events, { z: 19, x, behavior: 'lunge' })
        return 3
      case 'hands':
        for (const x of [-2.5, 0, 2.5]) this.spawn('shade', events, { x, behavior: 'hand' })
        return 3
    }
  }

  /** 影を 1 体ぶん動かす（動き方ごと）。攻撃もここで出す */
  private move(e: Enemy, dt: number, events: GameEvent[]): void {
    e.timer += dt
    if (e.kind === 'boss' || e.kind === 'orb') {
      e.z -= e.speed * dt
      // 火の雨: 近づくほど低く降りてくる
      if (e.startLift > 0) e.lift = e.startLift * Math.max(0, (e.z - REACH_Z) / Math.max(1, e.startZ - REACH_Z))
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
    // 技: 決めた距離まで来たら足を止めて溜め、当てたら跳び退く（同時に技を溜める影は 1 体まで）
    if (e.move && (e.strikesLeft ?? 0) > 0 && e.state === 'move' && e.strikeAt !== undefined && e.z <= e.strikeAt
        && !this.enemies.some((x) => x.state === 'strike')) {
      e.state = 'strike'
      e.timer = 0
      e.startLift = e.lift
      events.push({ kind: 'strike-warn', id: e.id, move: e.move })
    }
    if (e.state === 'strike' && e.move) {
      const k = Math.min(1, e.timer / (STRIKE_WINDUP * this.timeMul))
      // 跳びかかり: 高く跳び上がりながら少し前へ / 叩きつけ: その場で伸び上がる
      if (e.move === 'leap') {
        e.lift = Math.sin(k * Math.PI) * 3
        e.z -= dt * 2.5
      } else if (e.move === 'slam') {
        e.lift = k < 0.8 ? k * 2.5 : (1 - k) * 12
      } else {
        e.z += dt * 0.8 // のけぞって力を溜める
      }
      if (k >= 1) {
        e.strikesLeft = (e.strikesLeft ?? 1) - 1
        e.state = 'move'
        e.lift = 0
        events.push({ kind: 'strike', id: e.id, move: e.move })
        if (e.move === 'volley') {
          // 一斉射撃: 火の玉を 3 つ、扇状に（打ち落とす）
          for (const dx of [-2, 0, 2]) this.spawn('orb', events, { z: e.z - 0.5, x: Math.max(-3.8, Math.min(3.8, e.x + dx)) })
        } else {
          e.z = Math.min(SPAWN_Z, e.z + STRIKE_RECOIL)
          this.loseOil(1, e.id, events)
        }
        // もう一度仕掛けるなら、また少し近づいてから
        if ((e.strikesLeft ?? 0) > 0) e.strikeAt = Math.max(STRIKE_MIN_Z, e.z - this.rng.range(2, 4))
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
      case 'bomb':
        if (e.state === 'move' && e.z <= BOMB_Z) {
          e.state = 'armed'
          e.timer = 0
          events.push({ kind: 'arm', id: e.id })
        }
        if (e.state === 'armed') {
          v = 0
          swayAmp *= 0.2
          if (e.timer >= BOMB_FUSE * this.timeMul) {
            events.push({ kind: 'explode', id: e.id })
            this.remove(e)
            this.loseOil(BOMB_DAMAGE, e.id, events)
            return
          }
        }
        break
      case 'guardian':
        swayAmp *= 0.3
        break
      case 'flanker':
        // 横から、道のまんなかへ寄りながら迫る
        e.baseX += (Math.sign(e.baseX) * 1.2 - e.baseX) * Math.min(1, dt * 0.9)
        swayAmp = 0
        break
      case 'diver':
        if (e.state === 'hover') {
          v = 0
          swayAmp = 0.5
          if (e.timer >= DIVE_HOVER * this.timeMul) {
            e.state = 'dash'
            events.push({ kind: 'dive', id: e.id })
          }
        } else {
          v = DIVE_SPEED / Math.max(0.75, this.timeMul)
          swayAmp = 0
          e.lift = e.startLift * Math.max(0, (e.z - REACH_Z) / Math.max(1, e.startZ - REACH_Z))
        }
        break
      case 'hand':
        v = 0
        swayAmp = 0
        if (e.timer >= HAND_TIME * this.timeMul) {
          events.push({ kind: 'grab', id: e.id })
          this.remove(e)
          this.loseOil(1, e.id, events)
          return
        }
        break
      case 'mirror':
        swayAmp *= 1.5
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
      behavior: 'walk', state: 'move', timer: 0, hp: def.phrases.length, acted: false, throws: 0, lift: 0, startZ: BOSS_Z, startLift: 0,
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
        case 'rain':
          for (let i = 0; i < 5; i++) this.spawn('orb', events, { z: 12 + i * 2.2, x: this.rng.range(-3.5, 3.5), lift: RAIN_HEIGHT })
          break
        case 'eclipse': this.darkness = INK_TIME * 1.5; break
        case 'hands':
          for (const x of [-2.5, 0, 2.5]) this.spawn('shade', events, { x, behavior: 'hand' })
          break
        case 'phantoms': this.spawn('shade', events, { z: 18, behavior: 'phantom' }); break
        case 'bombs':
          for (const x of [-2.2, 2.2]) this.spawn('shade', events, { z: 15, x, behavior: 'bomb' })
          break
        case 'flank':
          this.spawn('shade', events, { x: -FLANK_X, behavior: 'flanker' })
          this.spawn('shade', events, { x: FLANK_X, behavior: 'flanker' })
          break
        case 'rush':
          for (const x of [-3, 0, 3]) this.spawn('shade', events, { z: 16, x, behavior: 'lunge' })
          break
      }
      // 怒ったボスは間隔が短く、溜めた直後にもうひとつ放つ
      this.bossAttackTimer = def.attackEvery * this.timeMul * (this.bossEnraged ? ENRAGE_MUL : 1)
      if (this.bossEnraged && !this.chainedAttack) {
        this.chainedAttack = true
        this.bossAttackTimer = 0.9
      } else {
        this.chainedAttack = false
      }
      return
    }
    // 言葉を半分返すと怒る
    const half = Math.ceil((boss.phrases?.length ?? 2) / 2)
    if (!this.bossEnraged && (boss.phraseIndex ?? 0) >= half) {
      this.bossEnraged = true
      this.bossAttackTimer = Math.min(this.bossAttackTimer, 1.5)
      events.push({ kind: 'boss-phase2', id: boss.id })
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
          const left = wave.count - this.spawned
          if (spot && !this.ownedPages.has(spot.page) && !this.fragmentsFound.includes(spot.page)) {
            this.spawn('shade', events, { behavior: 'golden', page: spot.page })
            this.spawned++
          } else if (this.chapter.formations.length && left >= 3 && alive <= 1 && this.rng.next() < this.chapter.formationChance) {
            this.spawned += this.formation(this.rng.pick(this.chapter.formations), events)
          } else {
            const fast = this.rng.next() < this.chapter.fastChance
            this.spawn(fast ? 'fox' : 'shade', events)
            this.spawned++
          }
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
      if (!this.enemies.includes(e) || e.state === 'latched') continue
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
      const cands = this.enemies.filter((e) => this.isTargetable(e) && e.matcher.accepts(ch)).sort((a, b) => a.z - b.z)
      t = cands[0] ?? null
      if (t) {
        this.target = t
        events.push({ kind: 'lock', id: t.id })
      }
    }
    if (!t || !t.matcher.key(ch)) {
      if (t) t.missed = true
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
      this.bossEnraged = false
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
    // 幻影の偽物: 消えて、本物が詰め寄ってくる
    if (t.decoy) {
      events.push({ kind: 'decoy', id: t.id })
      this.remove(t)
      const real = this.enemies.find((e) => e.id === t.group)
      if (real) real.z = Math.max(REACH_Z + 1.5, real.z - PHANTOM_LUNGE)
      return
    }
    // 技を溜めているあいだに倒した（見切り）
    if (t.state === 'strike' && t.move) {
      events.push({ kind: 'parry', id: t.id, move: t.move })
      this.score += Math.round(150 * mul)
    }
    // 遠くで倒すほど少し多くもらえる。火の玉は少しだけ、金色の影は多め
    const gain = t.kind === 'orb' ? Math.round(20 * mul)
      : Math.round((40 * t.word.kana.length + t.z * 4 + (t.behavior === 'golden' ? 500 : 0)) * mul)
    this.score += gain
    if (t.kind !== 'orb') this.stats.kills++
    events.push({ kind: 'kill', id: t.id, x: t.x, z: t.z, enemy: t.kind, score: gain, golden: t.behavior === 'golden', perfect: !t.missed && t.kind !== 'orb' })
    this.remove(t)
    // 幻影の本物を倒すと、偽物もまとめて消える
    if (t.behavior === 'phantom') {
      for (const e of this.enemies.filter((x) => x.group === t.id)) {
        events.push({ kind: 'kill', id: e.id, x: e.x, z: e.z, enemy: e.kind, score: 0 })
        this.remove(e)
      }
    }
    if (t.behavior === 'guardian') events.push({ kind: 'shield-break', id: t.id })
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
