import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db.ts',
  out: './migrations',
  dialect: 'sqlite',
})
