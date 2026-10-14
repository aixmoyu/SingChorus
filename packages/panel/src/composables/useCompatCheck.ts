import { onMounted, onUnmounted, watch } from 'vue'
import { useInfoStore } from '@/stores/info'
import { useAuthStore } from '@/stores/auth'

/** Periodic compat re-check cadence (low frequency; instant refresh on focus). */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000

/**
 * Keeps the compat report in the info store fresh: fetch once after login,
 * then every 5 minutes and whenever the page becomes visible again. The
 * interval keeps running but every tick is skipped while the page is hidden
 * (same visibility rule as the other long polling in this app).
 */
export function useCompatCheck() {
  const info = useInfoStore()
  const auth = useAuthStore()
  let timer: number | null = null

  async function tick() {
    if (document.hidden) return
    if (!auth.isAuthenticated) return
    // Best-effort: a 401 (expired session) must not surface as an error.
    await info.fetchSystemInfo().catch(() => { /* silent */ })
  }

  function startTimer() {
    if (timer === null) timer = window.setInterval(tick, REFRESH_INTERVAL_MS)
  }
  function stopTimer() {
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }

  function onVisibilityChange() {
    if (!document.hidden) void tick()
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibilityChange)
    watch(
      () => auth.isAuthenticated,
      (authenticated) => {
        if (authenticated) {
          void tick()
          startTimer()
        } else {
          stopTimer()
        }
      },
      { immediate: true },
    )
  })

  onUnmounted(() => {
    stopTimer()
    document.removeEventListener('visibilitychange', onVisibilityChange)
  })
}
