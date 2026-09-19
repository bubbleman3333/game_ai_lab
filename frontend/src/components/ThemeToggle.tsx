import { setTheme, useTheme } from '../lib/theme'

export function ThemeToggle() {
  const theme = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <button
      className="icon-button"
      onClick={() => setTheme(next)}
      aria-label={next === 'light' ? '明るい画面にする' : '暗い画面にする'}
      title={next === 'light' ? '明るい画面にする' : '暗い画面にする'}
    >
      {theme === 'dark' ? '☀️' : '🌙'}
    </button>
  )
}
