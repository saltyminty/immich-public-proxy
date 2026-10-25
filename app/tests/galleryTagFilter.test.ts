import { describe, it, expect, beforeEach } from 'vitest'
import { KeyType, loadConfig, type SharedLink } from '@ipp/core'
import type { Response } from 'express-serve-static-core'
import { gallery } from '../src/gallery/builder'

async function render (showMetadata?: boolean, allowDownload = true, tags?: string | string[]) {
  const share: SharedLink = {
    key: 'test-key', keyType: KeyType.key, type: 'ALBUM', assets: [], expiresAt: null, showMetadata, allowDownload
  }
  let html = ''
  await gallery({
    req: { protocol: 'https', headers: { host: 'example.com' }, query: { tags } },
    header: () => {},
    send: (body: string) => { html = body }
  } as unknown as Response, share)
  const json = html.match(/<script type="application\/json" id="ipp-init">(.*?)<\/script>/s)![1]
  return { html, init: JSON.parse(json) }
}

describe('tag filter gallery controls', () => {
  beforeEach(() => {
    process.env.CONFIG = JSON.stringify({ ipp: { allowDownload: 1 } })
    loadConfig()
  })

  it('offers a disabled filter until the manifest loads for a metadata-enabled share', async () => {
    const { html, init } = await render(true)
    expect(init.tagsUrl).toBe('/share/tags/test-key')
    expect(html).toContain('id="tag-filter-toggle"')
    expect(html.match(/<button id="tag-filter-toggle"[^>]*>/)?.[0]).toContain('disabled')
    expect(html).toContain('Match all selected tags')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('id="tag-filter-retry"')
  })

  it.each([false, undefined])('does not expose a tag URL or controls when metadata permission is %s', async showMetadata => {
    const { html, init } = await render(showMetadata)
    expect(init).not.toHaveProperty('tagsUrl')
    expect(html).not.toContain('id="tag-filter"')
  })

  it('prepares a hidden matching-download button only when downloads are allowed', async () => {
    const allowed = await render(true)
    expect(allowed.html.match(/<button id="download-matching"[^>]*>/)?.[0]).toContain('hidden')
    const denied = await render(true, false)
    expect(denied.html).not.toContain('id="download-matching"')
  })

  it('waits for URL-selected tags before offering a whole-album download', async () => {
    const { html } = await render(true, true, ['Alice', 'Bob'])
    expect(html.match(/<a id="download-all"[^>]*>/)?.[0]).toContain('hidden')
    expect(html).toContain('Loading selected tags…')
  })

  it.each([false, undefined])('offers a clearable filter shell without exposing tags when metadata permission is %s', async showMetadata => {
    const { html, init } = await render(showMetadata, true, 'Alice')
    expect(init).not.toHaveProperty('tagsUrl')
    expect(html).toContain('id="tag-filter"')
    expect(html).toContain('Tags are unavailable for this shared link.')
    expect(html.match(/<a id="download-all"[^>]*>/)?.[0]).toContain('hidden')
  })
})
