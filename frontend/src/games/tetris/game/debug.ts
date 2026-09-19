// 開発時だけ window.__tetris にゲームの中身を置く（コンソールでの調査用）。
// 例: __tetris.controller.game.board.toStrings().join('\n')

export function exposeForDebug(objects: Record<string, unknown>): void {
  if (import.meta.env.DEV) (window as unknown as { __tetris: unknown }).__tetris = objects
}
