import { defineStore } from 'pinia'
import { ref } from 'vue'
import http from '@/lib/http'

export const useAuthStore = defineStore('auth', () => {
  const isAuthenticated = ref(false)
  const firstRun = ref(false)
  const initialized = ref(false)
  const checked = ref(false)

  async function checkStatus() {
    try {
      const res = await http.get('/auth/status')
      isAuthenticated.value = res.data.authenticated
      firstRun.value = res.data.first_run
      initialized.value = Boolean(res.data.initialized)
      checked.value = true
    } catch {
      isAuthenticated.value = false
      checked.value = true
    }
  }

  async function setup(password: string) {
    const res = await http.post('/auth/setup', { password })
    isAuthenticated.value = true
    firstRun.value = false
    return res.data
  }

  async function login(password: string) {
    const res = await http.post('/auth/login', { password })
    isAuthenticated.value = true
    return res.data
  }

  async function logout() {
    await http.post('/auth/logout')
    isAuthenticated.value = false
  }

  async function changePassword(oldPassword: string, newPassword: string) {
    const res = await http.post('/auth/change-password', { old_password: oldPassword, new_password: newPassword })
    return res.data
  }

  return { isAuthenticated, firstRun, initialized, checked, checkStatus, setup, login, logout, changePassword }
})