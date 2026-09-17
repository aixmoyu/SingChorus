import { ref, computed, onMounted, onUnmounted } from 'vue'

/**
 * Shared mobile breakpoint. Keep in sync with CSS `@media (max-width: 767px)`
 * usages: the query below is inclusive-exclusive consistent with those rules
 * (≤767px = mobile).
 */
export const MOBILE_QUERY = '(max-width: 767px)'

/** Reactive `isMobile` flag backed by a matchMedia listener. */
export function useBreakpoint() {
  const isMobile = ref(false)
  let mq: MediaQueryList | null = null

  function onChange(event: MediaQueryListEvent) {
    isMobile.value = event.matches
  }

  onMounted(() => {
    mq = window.matchMedia(MOBILE_QUERY)
    isMobile.value = mq.matches
    mq.addEventListener('change', onChange)
  })

  onUnmounted(() => {
    mq?.removeEventListener('change', onChange)
  })

  return { isMobile }
}

/** Reactive label placement for n-form: top on mobile, left on desktop. */
export function useFormLabelPlacement() {
  const { isMobile } = useBreakpoint()
  const labelPlacement = computed(() => (isMobile.value ? 'top' : 'left') as 'top' | 'left')
  return { labelPlacement, isMobile }
}
