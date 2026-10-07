/**
 * HEAD-checks an asset URL before handing it to a loader. Loaders only see bytes, so a
 * 404 or an HTML fallback page (Vite's SPA fallback answers missing files with
 * index.html + HTTP 200) would otherwise surface as a misleading parse error.
 */
export async function preflightAsset(url: string, kind: string): Promise<void> {
  const res = await fetch(url, { method: 'HEAD' })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim())
  const type = res.headers.get('content-type') ?? ''
  if (type.includes('text/html')) {
    throw new Error(`server returned an HTML page instead of a ${kind} file (file not found?)`)
  }
}
