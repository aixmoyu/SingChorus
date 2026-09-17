import { defineStore } from 'pinia'
import { ref } from 'vue'
import http from '@/lib/http'
import type { ValidateResult } from '@/lib/types'

/**
 * Store for config validation actions.
 * Validation is a stateless operation (the server returns a result, we don't
 * cache it), so this store only owns the `lastResult` for convenience in views
 * that want to display it after the call.
 */
export const useValidationStore = defineStore('validation', () => {
  const lastResult = ref<ValidateResult | null>(null)

  async function validateConfig(
    config: Record<string, unknown>,
    label?: string,
    image?: string,
  ): Promise<ValidateResult> {
    const res = await http.post('/core/validate', { config, label, image })
    lastResult.value = res.data
    return res.data
  }

  async function validateEntry(name: string, side: 'server' | 'client'): Promise<ValidateResult> {
    const res = await http.post(`/core/validate/entry/${encodeURIComponent(name)}?side=${side}`)
    lastResult.value = res.data
    return res.data
  }

  async function validateMerged(): Promise<ValidateResult> {
    const res = await http.post('/core/validate/merged')
    lastResult.value = res.data
    return res.data
  }

  async function validateSubscription(): Promise<ValidateResult> {
    const res = await http.post('/core/validate/subscription')
    lastResult.value = res.data
    return res.data
  }

  return { lastResult, validateConfig, validateEntry, validateMerged, validateSubscription }
})
