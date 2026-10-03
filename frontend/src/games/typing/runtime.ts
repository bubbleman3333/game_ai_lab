// 灯守がどこで動いているか。
//   standalone = false  Game AI Lab の中の 1 ページ（/typing）。上に Game AI Lab のメニューがある
//   standalone = true   単独のサイト（himori-typing.rakunowa.workers.dev）。standalone.tsx が true にする
// 単独のときは「← ゲーム一覧」を出さず、音の切り替えを自前で出す（Game AI Lab のメニューが無いため）。

export const runtime = { standalone: false }
