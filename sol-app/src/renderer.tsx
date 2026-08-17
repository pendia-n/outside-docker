import { jsxRenderer } from 'hono/jsx-renderer'
import { Link, ViteClient } from 'vite-ssr-components/hono'

export const renderer = jsxRenderer(({ children }) => {
  return (
    <html>
      <head>
        <title>Outside Docker — Event-chain integrity</title>
        <meta name="description" content="Outside Docker preserves the integrity of human documents and machine logs without storing the original content." />
        <link href="/od.svg" rel="icon" type="image/svg+xml" />
        <link href="/od.svg" rel="apple-touch-icon" />
        <ViteClient />
        <Link href="/src/style.css" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  )
})
