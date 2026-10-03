// ローマ字入力の判定。React にも three.js にも依存しない（vitest で試せる）。
//
// 考え方:
//   1. ひらがなを「ひとかたまり（チャンク）」に分ける。チャンクごとに「受け付ける打ち方」の一覧を持つ
//      例: 「し」→ shi / si / ci、「きゃ」→ kya / kixya / kilya
//   2. 「っ」と「ん」は次のチャンクとくっつけて 1 チャンクにする（打ち方が次の文字で決まるため）
//      例: 「っか」→ kka / xtuka …、「んか」→ nka / nnka / xnka（「んな」は nnna だけ）
//   3. 打たれたキーを今のチャンクの打ち方の先頭と比べ、合うものが 1 つでもあれば正解
//
// 画面に出すお手本（まだ打っていない部分）は、今打っている打ち方に合わせて変わる
// （si と打ち始めたら、お手本も shi ではなく si になる）。

/** 1 文字（または小さい文字つきの 2 文字）の打ち方。先頭がお手本に使われる */
const TABLE: Record<string, string[]> = {
  あ: ['a'], い: ['i', 'yi'], う: ['u', 'wu', 'whu'], え: ['e'], お: ['o'],
  か: ['ka', 'ca'], き: ['ki'], く: ['ku', 'cu', 'qu'], け: ['ke'], こ: ['ko', 'co'],
  さ: ['sa'], し: ['shi', 'si', 'ci'], す: ['su'], せ: ['se', 'ce'], そ: ['so'],
  た: ['ta'], ち: ['chi', 'ti'], つ: ['tsu', 'tu'], て: ['te'], と: ['to'],
  な: ['na'], に: ['ni'], ぬ: ['nu'], ね: ['ne'], の: ['no'],
  は: ['ha'], ひ: ['hi'], ふ: ['fu', 'hu'], へ: ['he'], ほ: ['ho'],
  ま: ['ma'], み: ['mi'], む: ['mu'], め: ['me'], も: ['mo'],
  や: ['ya'], ゆ: ['yu'], よ: ['yo'],
  ら: ['ra'], り: ['ri'], る: ['ru'], れ: ['re'], ろ: ['ro'],
  わ: ['wa'], を: ['wo'], ん: ['nn', 'xn'],
  が: ['ga'], ぎ: ['gi'], ぐ: ['gu'], げ: ['ge'], ご: ['go'],
  ざ: ['za'], じ: ['ji', 'zi'], ず: ['zu'], ぜ: ['ze'], ぞ: ['zo'],
  だ: ['da'], ぢ: ['di'], づ: ['du'], で: ['de'], ど: ['do'],
  ば: ['ba'], び: ['bi'], ぶ: ['bu'], べ: ['be'], ぼ: ['bo'],
  ぱ: ['pa'], ぴ: ['pi'], ぷ: ['pu'], ぺ: ['pe'], ぽ: ['po'],
  ゔ: ['vu'],
  ぁ: ['xa', 'la'], ぃ: ['xi', 'li'], ぅ: ['xu', 'lu'], ぇ: ['xe', 'le'], ぉ: ['xo', 'lo'],
  ゃ: ['xya', 'lya'], ゅ: ['xyu', 'lyu'], ょ: ['xyo', 'lyo'], ゎ: ['xwa', 'lwa'],
  っ: ['xtu', 'ltu', 'xtsu', 'ltsu'],
  ー: ['-'], '、': [','], '。': ['.'], '！': ['!'], '？': ['?'],
}

/** 小さい文字つきの 2 文字（拗音など）。分けて打つ書き方（kixya など）は後で自動で足す */
const YOUON: Record<string, string[]> = {
  きゃ: ['kya'], きゅ: ['kyu'], きょ: ['kyo'], きぇ: ['kye'],
  ぎゃ: ['gya'], ぎゅ: ['gyu'], ぎょ: ['gyo'],
  しゃ: ['sha', 'sya'], しゅ: ['shu', 'syu'], しょ: ['sho', 'syo'], しぇ: ['she', 'sye'],
  じゃ: ['ja', 'jya', 'zya'], じゅ: ['ju', 'jyu', 'zyu'], じょ: ['jo', 'jyo', 'zyo'], じぇ: ['je', 'jye', 'zye'],
  ちゃ: ['cha', 'tya', 'cya'], ちゅ: ['chu', 'tyu', 'cyu'], ちょ: ['cho', 'tyo', 'cyo'], ちぇ: ['che', 'tye', 'cye'],
  にゃ: ['nya'], にゅ: ['nyu'], にょ: ['nyo'],
  ひゃ: ['hya'], ひゅ: ['hyu'], ひょ: ['hyo'],
  びゃ: ['bya'], びゅ: ['byu'], びょ: ['byo'],
  ぴゃ: ['pya'], ぴゅ: ['pyu'], ぴょ: ['pyo'],
  みゃ: ['mya'], みゅ: ['myu'], みょ: ['myo'],
  りゃ: ['rya'], りゅ: ['ryu'], りょ: ['ryo'],
  ぢゃ: ['dya'], ぢゅ: ['dyu'], ぢょ: ['dyo'],
  てぃ: ['thi'], でぃ: ['dhi'], でゅ: ['dhu'], とぅ: ['twu'], どぅ: ['dwu'],
  ふぁ: ['fa'], ふぃ: ['fi'], ふぇ: ['fe'], ふぉ: ['fo'],
  うぃ: ['wi'], うぇ: ['we'], うぉ: ['who'],
  ゔぁ: ['va'], ゔぃ: ['vi'], ゔぇ: ['ve'], ゔぉ: ['vo'],
  つぁ: ['tsa'], つぇ: ['tse'], つぉ: ['tso'],
}

const VOWELS_N_Y = new Set(['a', 'i', 'u', 'e', 'o', 'n', 'y'])
/** 「っ」を子音を重ねて打てる文字（母音・n・記号は重ねられない） */
const DOUBLABLE = /^[bcdfghjklmpqrstvwxz]/

export interface Chunk {
  /** このチャンクのひらがな */
  kana: string
  /** 受け付ける打ち方。先頭がお手本 */
  cands: string[]
}

/** カタカナ → ひらがな（「ー」はそのまま） */
export function toHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
}

function uniq(list: string[]): string[] {
  return [...new Set(list)]
}

/** ひらがなをチャンクに分ける。表に無い文字があれば例外（単語の書き間違いをテストで見つけるため） */
export function toChunks(kana: string): Chunk[] {
  const s = toHiragana(kana)
  const raw: Chunk[] = []
  for (let i = 0; i < s.length;) {
    const two = s.slice(i, i + 2)
    if (YOUON[two]) {
      // 分けて打つ書き方（き + ゃ = kixya / kilya）も受け付ける
      const split = TABLE[two[0]].flatMap((a) => TABLE[two[1]].map((b) => a + b))
      raw.push({ kana: two, cands: uniq([...YOUON[two], ...split]) })
      i += 2
      continue
    }
    const one = s[i]
    if (!TABLE[one]) throw new Error(`ローマ字にできない文字: 「${one}」（${kana}）`)
    raw.push({ kana: one, cands: [...TABLE[one]] })
    i += 1
  }

  // 後ろから見て、「っ」「ん」を次のチャンクとくっつける
  const out: Chunk[] = []
  for (let i = raw.length - 1; i >= 0; i--) {
    const c = raw[i]
    const next = out[0]
    if (c.kana === 'っ' && next) {
      const doubled = next.cands.filter((n) => DOUBLABLE.test(n)).map((n) => n[0] + n)
      const spelled = TABLE['っ'].flatMap((x) => next.cands.map((n) => x + n))
      if (doubled.length) {
        out[0] = { kana: c.kana + next.kana, cands: uniq([...doubled, ...spelled]) }
        continue
      }
    } else if (c.kana === 'ん' && next) {
      // 次が母音・な行・や行で始まらないときだけ n 1 回で「ん」になる
      const single = next.cands.filter((n) => !VOWELS_N_Y.has(n[0]) && /^[a-z]/.test(n)).map((n) => 'n' + n)
      const spelled = TABLE['ん'].flatMap((x) => next.cands.map((n) => x + n))
      out[0] = { kana: c.kana + next.kana, cands: uniq([...single, ...spelled]) }
      continue
    }
    out.unshift(c)
  }
  return out
}

/** 1 つの言葉を打ち進める。key() で 1 文字ずつ渡す */
export class RomajiMatcher {
  readonly chunks: Chunk[]
  private index = 0
  private buf = ''
  /** これまでに正しく打ったキー */
  typed = ''

  constructor(kana: string) {
    this.chunks = toChunks(kana)
  }

  get done(): boolean {
    return this.index >= this.chunks.length
  }

  /** 1 文字でも打ったか */
  get started(): boolean {
    return this.typed.length > 0
  }

  /** そのキーが正解か（状態は変えない） */
  accepts(key: string): boolean {
    if (this.done) return false
    const next = this.buf + key
    return this.chunks[this.index].cands.some((c) => c.startsWith(next))
  }

  /** キーを渡す。正解なら true（進む）、まちがいなら false（何も変わらない） */
  key(key: string): boolean {
    if (!this.accepts(key)) return false
    this.buf += key
    this.typed += key
    if (this.chunks[this.index].cands.includes(this.buf)) {
      this.index++
      this.buf = ''
    }
    return true
  }

  /** お手本の残り（今の打ち方に合わせる） */
  get rest(): string {
    if (this.done) return ''
    const cur = this.chunks[this.index].cands.find((c) => c.startsWith(this.buf)) ?? ''
    let s = cur.slice(this.buf.length)
    for (let i = this.index + 1; i < this.chunks.length; i++) s += this.chunks[i].cands[0]
    return s
  }

  /** お手本どおりに打ったときの全体の長さ（打つのにかかる時間の目安） */
  get length(): number {
    return this.typed.length + this.rest.length
  }

  /** 最初からやり直す */
  reset(): void {
    this.index = 0
    this.buf = ''
    this.typed = ''
  }
}

/** お手本どおりのローマ字（テスト・長さの計算用） */
export function romanize(kana: string): string {
  return toChunks(kana).map((c) => c.cands[0]).join('')
}
