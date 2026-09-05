import { jsxRenderer } from 'hono/jsx-renderer'
import { Link, ViteClient } from 'vite-ssr-components/hono'

export const renderer = jsxRenderer(({ children }, context) => {
  const path = new URL(context.req.url).pathname
  const privatePage = path === '/app' || path.startsWith('/checkout/')
  const title = path.startsWith('/verify')
    ? 'Verify evidence | Outdock'
    : path === '/app'
      ? 'Workspace | Outdock'
      : 'Outdock — Verifiable event-chain evidence'
  const description = 'Create tamper-evident event records, anchor them on Base, and grant time-bounded verification access without storing original files by default.'
  const canonical = new URL(path === '/' || path.startsWith('/verify') ? path : '/', context.req.url).toString()
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#f7f3ea" />
        <title>{title}</title>
        <meta name="description" content={description} />
        {privatePage && <meta name="robots" content="noindex,nofollow" />}
        {!privatePage && <link rel="canonical" href={canonical} />}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Outdock" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={description} />
        <link rel="manifest" href="/manifest.webmanifest" />
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
