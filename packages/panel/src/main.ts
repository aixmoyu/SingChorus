import { createApp } from 'vue'
import { createPinia } from 'pinia'
// Self-hosted fonts (Inter + Fira Code) — bundled by Vite, no CDN, works offline.
// vfonts defines them as `v-sans` and `v-mono` font-family names.
import 'vfonts/Inter.css'
import 'vfonts/FiraCode.css'
import './styles/design-system.css'
import App from './App.vue'
import router from './router'
import { setRouter } from './lib/http'

setRouter(router)

const app = createApp(App)

// Global error boundary: catches errors thrown from any component lifecycle
// or event handler that wasn't caught locally. Without this, Vue just logs
// the error and leaves the user staring at a half-rendered view.
app.config.errorHandler = (err, _instance, info) => {
  console.error('[Vue runtime error]', info, err)
}

app.use(createPinia())
app.use(router)
app.mount('#app')