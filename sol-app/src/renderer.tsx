import { jsxRenderer } from 'hono/jsx-renderer'
import { Link, ViteClient } from 'vite-ssr-components/hono'

export const renderer = jsxRenderer(({ children }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#f7f3ea" />
        <title>Outside Docker — Event-chain integrity</title>
        <meta name="description" content="Outside Docker preserves the integrity of human documents and machine logs without storing the original content." />
        <link href="/od.svg" rel="icon" type="image/svg+xml" />
        <link href="/od.svg" rel="apple-touch-icon" />
        <ViteClient />
        <Link href="/src/style.css" rel="stylesheet" />
        <script src="/app.js" defer></script>
      </head>
      <body>{children}</body>
    </html>
  )
})
