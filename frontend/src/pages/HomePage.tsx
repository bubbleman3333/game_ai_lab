import { Link } from 'react-router-dom'

const GAMES = [
  {
    title: 'テトリス',
    text: 'SRS・T-Spin 対応。AI は「置いた後の盤面の価値」をニューラルネットで学習（DQN 系）',
    links: [
      { to: '/tetris/play', label: 'ひとりで遊ぶ' },
      { to: '/tetris/vs-ai', label: 'AI と対戦' },
      { to: '/tetris/online', label: 'オンライン対戦' },
      { to: '/tetris/stats', label: 'AI の強さ' },
      { to: '/tetris/settings', label: 'キー設定' },
    ],
  },
  {
    title: 'ブロブチェイン',
    text: '同じ色を 4 つつなげて消す落ち物パズル。AI は「置いた後の盤面の価値」をニューラルネットで学習（テトリスと同じ DQN 系）',
    links: [
      { to: '/blob', label: 'ひとりで遊ぶ' },
      { to: '/blob/vs-ai', label: 'AI と対戦' },
      { to: '/blob/online', label: 'オンライン対戦' },
      { to: '/blob/stats', label: 'AI の強さ' },
    ],
  },
  {
    title: 'オセロ',
    text: 'AI は形ごとの点数（n-tuple）を自己対戦で学習し、アルファベータ法で先を読む',
    links: [
      { to: '/othello', label: 'AI と対局' },
      { to: '/othello/stats', label: 'AI の強さ' },
    ],
  },
  {
    title: 'エアホッケー',
    text: 'AI は PPO（強化学習）で、過去の自分や学習なしの AI と打ち合って打ち方を覚える',
    links: [
      { to: '/airhockey', label: 'AI と対戦' },
      { to: '/airhockey/stats', label: 'AI の強さ' },
    ],
  },
  {
    title: 'レース',
    text: '3D の周回レース。3 つのコースを大ジャンプで駆ける。AI は PPO（強化学習）で走り方を覚える',
    links: [
      { to: '/racer', label: '走る' },
      { to: '/racer/stats', label: 'AI の強さ' },
    ],
  },
  {
    title: '将棋',
    text: 'AI は強豪 AI 同士の対局（floodgate）から ResNet で学び、モンテカルロ木探索で読む（dlshogi 方式）',
    links: [
      { to: '/shogi', label: 'AI と対局' },
      { to: '/shogi/stats', label: 'AI の強さ' },
    ],
  },
  {
    title: 'ポーカー',
    text: '1 対 1 のノーリミット・テキサスホールデム。相手の手札が見えないので、AI は「手を確率で混ぜる」CFR（反事実的後悔最小化）で学習する',
    links: [
      { to: '/poker', label: 'AI と対戦' },
      { to: '/poker/stats', label: 'AI の強さ' },
    ],
  },
]

export function HomePage() {
  return (
    <div className="page narrow">
      <h1>Game AI Lab</h1>
      <p className="muted">ゲームと、強化学習で育てる AI。</p>
      <div className="menu">
        {GAMES.map((g) => (
          <section key={g.title} className="menu-item">
            <span className="menu-title">{g.title}</span>
            <span className="muted">{g.text}</span>
            <div className="menu-links">
              {g.links.map((l) => <Link key={l.to} to={l.to}>{l.label}</Link>)}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
