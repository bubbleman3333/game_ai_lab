// 物語。4 つの街をまたぐ 4 章。章ごとに舞台の街（maps.ts）が決まっていて、
// 章の中のミッション（MissionDef）を順に片付けると次の章の街へ進める。
//
// 会話は、運転しながら読める「無線」の字幕として流す（止まらない）。
// 進み具合（何章の何番目か）は画面側（pages/CityPage.tsx）がブラウザに保存する。
//
// 話を足す・直すときはこのファイルだけ変えればよい。

import type { MissionDef } from './missions'

export interface Line {
  who: string
  text: string
}

export interface StoryStep {
  /** 始まる輪の場所（交差点 (i, j) から dir の向き）。街の大きさの範囲に収めること */
  at: [number, number, number]
  before: Line[]
  mission: MissionDef
  after: Line[]
}

export interface Chapter {
  map: string
  title: string
  intro: Line[]
  steps: StoryStep[]
  outro: Line[]
}

/** 登場人物（字幕の名前の色に使う） */
export const CAST: Record<string, string> = {
  レン: '#e8e8e8',
  ミオ: '#6fd3ff',
  カミヤ: '#ff8a5c',
  ハヤト: '#9dff7a',
  サエキ: '#ffd24a',
  無線: '#b0b6c0',
  警察官: '#8fb3ff',
}

export const CHAPTERS: Chapter[] = [
  {
    map: 'bayside',
    title: '第 1 章　逃がし屋',
    intro: [
      { who: 'ミオ', text: '久しぶり、レン。3 年ぶりのベイサイドはどう？' },
      { who: 'レン', text: '潮の匂いは変わってないな。仕事はあるか' },
      { who: 'ミオ', text: 'カミヤさんがあなたの腕を試したいって。地図に黄色い輪を出しておいた' },
    ],
    steps: [
      {
        at: [5, 5, 0],
        before: [
          { who: 'カミヤ', text: '噂の逃がし屋か。まずはこの荷物を港まで運んでもらおう' },
          { who: 'カミヤ', text: '中身は聞くな。遅れるな。それだけだ' },
        ],
        mission: { kind: 'delivery', title: '最初の荷物', distance: [420, 640], reward: 1000 },
        after: [{ who: 'カミヤ', text: '悪くない。次はもっと速さが要る仕事だ' }],
      },
      {
        at: [7, 4, 1],
        before: [
          { who: 'ハヤト', text: 'よう、お前が新入りか。俺はハヤト。カミヤさんの一番の運転手だ' },
          { who: 'ハヤト', text: '本番の前に、逃走ルートを一緒に下見する。遅れずについて来い' },
        ],
        mission: { kind: 'checkpoints', title: '逃走ルートの下見', count: 6, time: 80, reward: 1200 },
        after: [
          { who: 'ハヤト', text: 'やるじゃねえか。……本番は今夜だ' },
          { who: 'ミオ', text: 'ハヤトには気をつけて。あの人、最近カミヤさんと揉めてるって話' },
        ],
      },
      {
        at: [4, 7, 0],
        before: [
          { who: 'カミヤ', text: '金庫の中身はハヤトが運び出す。お前の仕事は警察を引きつけることだ' },
          { who: 'サエキ', text: '（無線）こちらサエキ。港湾地区で不審車両。全車、追跡に入れ' },
        ],
        mission: { kind: 'escape', title: 'おとり', stars: 2, reward: 1800 },
        after: [
          { who: 'ミオ', text: 'レン、まずい。ハヤトが金を持ったまま消えた' },
          { who: 'カミヤ', text: '裏切りだ。……ハヤトの車を止めろ。どんな手を使ってもいい' },
        ],
      },
      {
        at: [8, 8, 2],
        before: [{ who: 'ミオ', text: '見つけた。黒いセダンが湾岸線を走ってる。地図に印をつけるね' }],
        mission: { kind: 'takedown', title: '裏切り者を追え', target: 'sedan', time: 150, reward: 2500 },
        after: [
          { who: 'ミオ', text: '……車の中は空っぽ。ハヤトはいない。金もない' },
          { who: 'サエキ', text: '（無線）逃がし屋のレン。金庫破りの主犯としてお前を手配した' },
          { who: 'レン', text: 'はめられた……カミヤか' },
        ],
      },
    ],
    outro: [
      { who: 'ミオ', text: 'ベイサイドはもう無理。メトロポリスに知り合いがいる。そっちへ逃げて' },
      { who: 'レン', text: 'ハヤトも、たぶんそこにいる' },
    ],
  },
  {
    map: 'metro',
    title: '第 2 章　摩天楼の影',
    intro: [
      { who: 'ミオ', text: 'ようこそメトロポリスへ。ここは広いよ。道に迷わないでね' },
      { who: 'ミオ', text: 'カミヤの組織はここに本拠地がある。ハヤトの足取りを追いましょう' },
    ],
    steps: [
      {
        at: [8, 8, 0],
        before: [{ who: 'ミオ', text: 'まずは隠れ家へ。私の知り合いのガレージがある' }],
        mission: { kind: 'reach', title: '隠れ家へ', distance: [500, 800], reward: 600 },
        after: [{ who: 'ミオ', text: 'ここなら少しは安全。……カミヤの運び屋が今夜、帳簿を運ぶらしい' }],
      },
      {
        at: [10, 6, 1],
        before: [
          { who: 'ミオ', text: '帳簿があれば、あなたがはめられた証拠になる' },
          { who: 'ミオ', text: '運び屋の車は白い SUV。壊して止めて' },
        ],
        mission: { kind: 'takedown', title: '帳簿を奪え', target: 'suv', time: 160, reward: 3000 },
        after: [
          { who: 'レン', text: '帳簿は手に入れた。……ハヤトの名前がある。金の受け取り先だ' },
          { who: 'サエキ', text: '（無線）逃がし屋がメトロに入った。見つけ次第確保しろ' },
        ],
      },
      {
        at: [5, 12, 0],
        before: [
          { who: 'ミオ', text: '警察の包囲が狭まってる。繁華街で騒ぎを起こして、目をそらして' },
          { who: 'レン', text: '手荒だな' },
          { who: 'ミオ', text: '手荒じゃない方法があるなら教えて' },
        ],
        mission: { kind: 'rampage', title: '陽動', count: 10, time: 70, reward: 2500 },
        after: [{ who: 'ミオ', text: '今のうちに街を出る準備をして。サエキが本気になった' }],
      },
      {
        at: [12, 12, 3],
        before: [{ who: 'サエキ', text: '（無線）全車に告ぐ。逃がし屋を発見。今度こそ逃がすな' }],
        mission: { kind: 'escape', title: '包囲網を破れ', stars: 4, reward: 4000 },
        after: [
          { who: 'ミオ', text: 'よく逃げ切った……ハヤトはサンセット・ヒルズに隠れてる' },
        ],
      },
    ],
    outro: [
      { who: 'レン', text: 'ハヤトに会って、全部聞き出す' },
      { who: 'ミオ', text: '夕方の郊外は見通しがいい。気をつけてね' },
    ],
  },
  {
    map: 'sunset',
    title: '第 3 章　夕暮れの隠れ家',
    intro: [
      { who: 'ミオ', text: 'サンセット・ヒルズ。のどかな町だけど、ハヤトの仲間が見張ってる' },
    ],
    steps: [
      {
        at: [6, 6, 0],
        before: [{ who: 'ミオ', text: '見張りに気づかれる前に、ハヤトの隠れ家の近くまで行って。時間がない' }],
        mission: { kind: 'delivery', title: '夕暮れの接近', distance: [500, 750], time: 70, reward: 2000 },
        after: [
          { who: 'ハヤト', text: '（無線）……レンか。来ると思ってた' },
          { who: 'ハヤト', text: '話がしたいなら、俺に追いついてみろ。昔みたいにな' },
        ],
      },
      {
        at: [9, 9, 1],
        before: [{ who: 'ハヤト', text: '輪を順にくぐれ。遅れたら話はなしだ' }],
        mission: { kind: 'checkpoints', title: 'ハヤトとの走り', count: 8, time: 95, reward: 2500 },
        after: [
          { who: 'ハヤト', text: '腕は落ちてないな。……金はカミヤの命令で動かした。お前をはめたのもカミヤだ' },
          { who: 'ハヤト', text: '俺も用が済めば消される。だから逃げた' },
          { who: 'カミヤ', text: '（無線）ハヤト、そこまでだ。二人まとめて片付ける' },
        ],
      },
      {
        at: [4, 11, 0],
        before: [{ who: 'ミオ', text: 'カミヤの手下の車が 1 台、ハヤトを追ってる。先に止めて！' }],
        mission: { kind: 'takedown', title: 'ハヤトを守れ', target: 'van', time: 150, reward: 3500 },
        after: [
          { who: 'ハヤト', text: '借りができたな。カミヤは北の港、ノースハーバーから船で逃げる気だ' },
          { who: 'サエキ', text: '（無線）逃がし屋を郊外で確認。応援を回せ' },
        ],
      },
      {
        at: [11, 3, 2],
        before: [{ who: 'ミオ', text: 'サエキたちが来る。北へ抜ける道を開けて' }],
        mission: { kind: 'escape', title: '郊外の追跡', stars: 4, reward: 4000 },
        after: [{ who: 'レン', text: '北へ行く。全部終わらせる' }],
      },
    ],
    outro: [
      { who: 'ミオ', text: 'ノースハーバーは雪。道が凍ってるから、ブレーキは早めにね' },
    ],
  },
  {
    map: 'northport',
    title: '最終章　最後の港',
    intro: [
      { who: 'ミオ', text: 'カミヤの船は夜明けに出る。それまでに片をつけて' },
      { who: 'ハヤト', text: '（無線）俺も港の近くにいる。手を貸すぜ、相棒' },
    ],
    steps: [
      {
        at: [6, 6, 1],
        before: [{ who: 'ハヤト', text: '凍った道の抜け道を教える。輪を順にくぐれ' }],
        mission: { kind: 'checkpoints', title: '雪の抜け道', count: 7, time: 100, reward: 3000 },
        after: [{ who: 'ミオ', text: 'カミヤの護衛車が港へ向かってる。帳簿と一緒に、証拠を全部消すつもり' }],
      },
      {
        at: [9, 5, 2],
        before: [{ who: 'ハヤト', text: '護衛の車を止めろ。俺が反対側から回る' }],
        mission: { kind: 'takedown', title: '護衛を崩せ', target: 'suv', time: 150, reward: 4000 },
        after: [
          { who: 'カミヤ', text: '（無線）しぶといな、逃がし屋。だが船は予定どおり出る' },
          { who: 'サエキ', text: '（無線）……レン。帳簿の写しをミオから受け取った。カミヤの件は本当らしい' },
          { who: 'サエキ', text: '（無線）だが私の立場では、お前を見逃すことはできない' },
        ],
      },
      {
        at: [4, 9, 0],
        before: [{ who: 'ミオ', text: 'カミヤが乗り込む前に、本人の車を止めて！　黒いセダンよ' }],
        mission: { kind: 'takedown', title: 'カミヤ', target: 'sedan', time: 160, reward: 6000 },
        after: [
          { who: 'カミヤ', text: '……ここまでか' },
          { who: 'サエキ', text: '（無線）カミヤを確保した。……全車、次は逃がし屋だ' },
        ],
      },
      {
        at: [10, 10, 3],
        before: [
          { who: 'ハヤト', text: '港の外れにボートを用意した。サエキを振り切って来い！' },
          { who: 'サエキ', text: '（無線）最後の仕事だ。本気で追え' },
        ],
        mission: { kind: 'escape', title: '夜明けの逃走', stars: 5, reward: 8000 },
        after: [
          { who: 'サエキ', text: '（無線）……見失った。全車、撤収' },
          { who: 'ミオ', text: 'おつかれさま、レン。これであなたは自由よ' },
          { who: 'レン', text: 'しばらくは、ただのドライブがしたいな' },
        ],
      },
    ],
    outro: [
      { who: '無線', text: '― 完 ―　4 つの街は自由に走れます。寄り道のミッションも残っています' },
    ],
  },
]

/** 物語の進み具合（保存する形） */
export interface StoryProgress {
  chapter: number
  step: number
}

export const storyDone = (p: StoryProgress) => p.chapter >= CHAPTERS.length

/** その街がもう行けるか（物語でたどり着いた街だけ） */
export function mapUnlocked(p: StoryProgress, mapId: string): boolean {
  const idx = CHAPTERS.findIndex((c) => c.map === mapId)
  return idx < 0 || idx <= p.chapter
}
