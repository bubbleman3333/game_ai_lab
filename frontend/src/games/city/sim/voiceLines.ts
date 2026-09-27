// 声を付けるセリフの一覧。scripts/city-voices.ts がここから全部を読み出して VOICEVOX で音声にし、
// public/city/voice/ に置く。ゲームは同じ key（名前とセリフから作る）で音声ファイルを探して再生する。
//
// セリフを足したり直したりしたら、VOICEVOX を起動してから次を実行する（音声が無いセリフは字幕だけ出る）:
//   cd frontend; node scripts/city-voices.ts
//
// ※ import に .ts を付けているのは、node で直接実行するため（Vite でもそのまま動く）

import { CHAPTERS, type Line } from './story.ts'

/** 職務質問のセリフ */
export const QUESTION = {
  start: [
    { who: '警察官', text: 'すみません、ちょっといいですか。免許証を見せてもらえます？' },
    { who: '警察官', text: 'このあたりで事故が続いてましてね。少しお話を聞かせてください' },
  ],
  fled: [{ who: '警察官', text: '待ちなさい！　止まりなさい！' }],
  found: [
    { who: '警察官', text: '……トランクの中のこれは何ですか？　署まで来てもらいます' },
    { who: 'レン', text: '（まずい。逃げるしかない）' },
  ],
  released: [{ who: '警察官', text: 'ご協力ありがとうございました。安全運転でお願いしますね' }],
} satisfies Record<string, Line[]>

/** 追跡中のパトカーからの呼びかけ（拡声器）。パトカーの位置から聞こえる */
export const POLICE_BARKS: Line[] = [
  { who: '警察官', text: '前の車、止まりなさい！' },
  { who: '警察官', text: 'そこの車、左に寄せて止まりなさい！' },
  { who: '警察官', text: '止まれ！　逃げても無駄だ！' },
  { who: '警察官', text: '危ない！　歩行者に注意しなさい！' },
  { who: '警察官', text: '応援を頼む！　対象は西へ逃走中！' },
  { who: '警察官', text: '車を降りて、両手を上げなさい！' },
]

/** 野次馬のつぶやき。建物から出てきた人のところから聞こえる */
export const CROWD_BARKS: Line[] = [
  { who: '野次馬A', text: 'え、なに？　事故？' },
  { who: '野次馬A', text: 'やばくない？　警察めっちゃ来てるよ' },
  { who: '野次馬B', text: 'ちょっと、撮っとこ' },
  { who: '野次馬B', text: 'うそ、あの車まだ逃げてる' },
  { who: '野次馬C', text: '危ないから下がって！' },
  { who: '野次馬C', text: 'ヘリまで飛んでるじゃん' },
  { who: '野次馬D', text: 'すごい音したね' },
  { who: '野次馬D', text: 'ニュースになるんじゃない？' },
]

/** はねられた・ぶつかられた人の悲鳴（女性の声・男性の声） */
export const PAIN = {
  female: [
    { who: '通行人女1', text: 'きゃああっ！' },
    { who: '通行人女1', text: 'いやああっ！' },
    { who: '通行人女2', text: 'きゃあっ！' },
    { who: '通行人女2', text: 'いたいっ！' },
  ],
  male: [
    { who: '通行人男1', text: 'うわあああっ！' },
    { who: '通行人男1', text: 'ぐあっ！' },
    { who: '通行人男2', text: 'ぎゃあっ！' },
    { who: '通行人男2', text: 'うおっ！？' },
  ],
} satisfies Record<string, Line[]>

/** 逃げ惑う人の叫び */
export const PANIC = {
  female: [
    { who: '通行人女1', text: 'きゃー！' },
    { who: '通行人女1', text: '逃げて！' },
    { who: '通行人女2', text: '危ない！' },
    { who: '通行人女2', text: '車が来る！' },
  ],
  male: [
    { who: '通行人男1', text: 'うわっ、なんだ！？' },
    { who: '通行人男1', text: '逃げろ！' },
    { who: '通行人男2', text: '危ねえ！' },
    { who: '通行人男2', text: 'どけ、どけ！' },
  ],
} satisfies Record<string, Line[]>

/** 声を付けるセリフを全部（重複は除く） */
export function allVoiceLines(): Line[] {
  const all: Line[] = []
  for (const ch of CHAPTERS) {
    all.push(...ch.intro, ...ch.outro)
    for (const s of ch.steps) all.push(...s.before, ...s.after)
  }
  for (const lines of Object.values(QUESTION)) all.push(...lines)
  all.push(...POLICE_BARKS, ...CROWD_BARKS, ...PAIN.female, ...PAIN.male, ...PANIC.female, ...PANIC.male)
  const seen = new Set<string>()
  return all.filter((l) => {
    const k = voiceKey(l)
    if (seen.has(k) || l.who === '無線') return false
    seen.add(k)
    return true
  })
}

/** 声に出すときは（）の中のト書き（（無線）など）を取る */
export function spokenText(text: string): string {
  const t = text.replace(/（[^）]*）/g, '').replace(/[　 ]+/g, ' ').trim()
  // 全体が（）の独り言は、中身をしゃべる
  return t || text.replace(/[（）]/g, '').trim()
}

/** 無線（トランシーバー）越しの声か。ざらついた無線の音にして再生する */
export const isRadio = (l: Line) => l.text.startsWith('（無線）')

/** 名前とセリフから作る、音声ファイルの名前（FNV-1a ハッシュ） */
export function voiceKey(l: Line): string {
  let h = 0x811c9dc5
  const s = `${l.who}|${l.text}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
