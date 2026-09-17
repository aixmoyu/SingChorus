import { defineStore } from 'pinia'
import { ref } from 'vue'
import http from '@/lib/http'
import type { Subscription } from '@/lib/types'

/**
 * Store for cloud subscription CRUD operations.
 */
export const useSubscriptionStore = defineStore('subscription', () => {
  const subscriptions = ref<Subscription[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchSubscriptions(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await http.get('/core/cloud/subscriptions')
      subscriptions.value = res.data.subscriptions || []
    } catch (e) {
      const msg =
        (e as { response?: { data?: { message?: string } }; message?: string }).response?.data
          ?.message ||
        (e as { message?: string }).message ||
        'Failed to fetch subscriptions'
      console.error('fetchSubscriptions error:', msg)
      error.value = msg
    } finally {
      loading.value = false
    }
  }

  async function fetchSubscription(id: string): Promise<Subscription> {
    const res = await http.get(`/core/cloud/subscriptions/${encodeURIComponent(id)}`)
    return res.data.subscription
  }

  async function createSubscription(
    data: Partial<Subscription> & {
      name?: string
      path?: string
      overallTemplateId?: string | null
      overallParams?: Record<string, unknown>
    },
  ): Promise<Subscription> {
    const res = await http.post('/core/cloud/subscriptions', data)
    return res.data.subscription
  }

  async function updateSubscription(
    id: string,
    data: Partial<Subscription> & { regenerateToken?: boolean },
  ): Promise<Subscription> {
    const res = await http.put(`/core/cloud/subscriptions/${encodeURIComponent(id)}`, data)
    return res.data.subscription
  }

  async function deleteSubscription(id: string): Promise<void> {
    await http.delete(`/core/cloud/subscriptions/${encodeURIComponent(id)}`)
  }

  return {
    subscriptions,
    loading,
    error,
    fetchSubscriptions,
    fetchSubscription,
    createSubscription,
    updateSubscription,
    deleteSubscription,
  }
})
