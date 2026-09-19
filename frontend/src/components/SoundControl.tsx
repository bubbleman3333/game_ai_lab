// 画面右上の音量・ミュート。設定はブラウザに保存される（lib/sound.ts）。

import { useSyncExternalStore } from 'react'
import { sound } from '../lib/sound'

export function SoundControl() {
  const settings = useSyncExternalStore(
    (cb) => sound.subscribe(cb),
    () => sound.settings,
  )
  const muted = settings.muted || settings.volume === 0
  return (
    <div className="sound-control">
      <button
        className="icon-button"
        onClick={() => sound.update({ muted: !settings.muted })}
        aria-label={muted ? '音を出す' : 'ミュート'}
        title={muted ? '音を出す' : 'ミュート'}
      >
        {muted ? '🔇' : '🔊'}
      </button>
      <input
        type="range" min={0} max={1} step={0.05} value={settings.volume}
        onChange={(e) => sound.update({ volume: Number(e.target.value), muted: false })}
        aria-label="音量"
      />
    </div>
  )
}
