import { createApp } from './app.js'
import { logger } from './logger.js'

const PORT = parseInt(process.env.CHORUS_PANEL_PORT || '8088', 10)
const HOST = process.env.CHORUS_PANEL_HOST || '127.0.0.1'

export function startServer(): void {
  const app = createApp()
  app.listen(PORT, HOST, () => {
    logger.info(`ChorusPanel listening on http://${HOST}:${PORT}`)
  })
}

process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'Unhandled rejection')
})

startServer()
