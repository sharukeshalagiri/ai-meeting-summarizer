import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // FRONTEND_PORT lets parallel worktrees run side by side. It is read
  // from the shell or frontend/.env*; the '' prefix loads unprefixed keys.
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  const port = Number(env.FRONTEND_PORT) || 5173

  return {
    plugins: [react()],
    server: { port, strictPort: true },
    preview: { port },
  }
})
