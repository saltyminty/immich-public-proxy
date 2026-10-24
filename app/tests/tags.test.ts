import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssetType, KeyType, SharedLink } from '@ipp/core'
import { canReadTags, getTagManifest, publicAssetTags, TagFailure, tagFailureDiagnostic, tagManifestStore, TagManifestStore } from '../src/tags'
import { fetchShareByKey } from '../src/immich'

vi.mock('../src/immich', async importOriginal => ({
  ...await importOriginal<typeof import('../src/immich')>(),
  fetchShareByKey: vi.fn()
}))

function share (ids = ['photo-a', 'photo-b'], overrides: Partial<SharedLink> = {}): SharedLink {
  return {
    key: 'share-key',
    keyType: KeyType.key,
    type: 'ALBUM',
    showMetadata: true,
    expiresAt: null,
    assets: ids.map(id => ({ id, key: 'share-key', keyType: KeyType.key, type: AssetType.image, isTrashed: false })),
    ...overrides
  }
}

const tags = [{ id: 'tag-a', name: 'People/A' }]

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.mocked(fetchShareByKey).mockReset()
})

describe('public tag manifest', () => {
  it('whitelists only tag IDs and labels, preserving hierarchy and dropping all other metadata', () => {
    expect(publicAssetTags({
      tags: [
        { id: 'a', name: 'A', value: 'People/A', createdAt: 'private', color: 'red' },
        { id: 'b', name: 'B' },
        { id: 'a', name: 'A', value: 'People/A' }
      ],
      people: [{ name: 'Private person' }],
      exifInfo: { latitude: 42 },
      originalFileName: 'private.jpg'
    })).toEqual([{ id: 'a', name: 'People/A' }, { id: 'b', name: 'B' }])
    expect(publicAssetTags({ tags: [] })).toEqual([])
    expect(publicAssetTags({})).toEqual([])
    expect(() => publicAssetTags({ tags: [{ id: 'a' }] })).toThrow()
    expect(() => publicAssetTags({ tags: 'invalid' })).toThrow()
  })

  it('fails closed unless metadata is explicitly allowed and the share is unexpired', async () => {
    const load = vi.fn(async () => tags)
    const store = new TagManifestStore(load)
    for (const denied of [false, undefined]) {
      await expect(store.get(share([], { showMetadata: denied }))).rejects.toThrow()
    }
    await expect(store.get(share([], { expiresAt: new Date(Date.now() - 1).toISOString() }))).rejects.toThrow()
    expect(canReadTags(share([], { expiresAt: 'invalid' }))).toBe(false)
    expect(load).not.toHaveBeenCalled()
  })

  it('keeps untagged assets, coalesces visitors, and retains cached tags without a hard expiry', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async asset => asset.id === 'photo-a' ? tags : [])
    const store = new TagManifestStore(load)
    const [first, second] = await Promise.all([store.get(share()), store.get(share())])
    expect(first).toEqual({ tags, assets: [{ id: 'photo-a', tagIds: ['tag-a'] }, { id: 'photo-b', tagIds: [] }] })
    expect(second).toBe(first)
    expect(load).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(299_999)
    expect(await store.get(share())).toEqual(first)
    expect(load).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60_000)
    await store.get(share())
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('partitions cached data by key, key type, password, and current asset membership', async () => {
    const load = vi.fn(async () => tags)
    const store = new TagManifestStore(load)
    const first = await store.get(share(['a']))
    expect(await store.get(share(['a']))).toEqual(first)
    const otherShares = [
      share(['a'], { key: 'other-share' }),
      share(['a'], { keyType: KeyType.slug }),
      share(['a'], { password: 'correct-password' }),
      share(['b'])
    ]
    for (const other of otherShares) expect(await store.get(other)).not.toBe(first)
    expect(load).toHaveBeenCalledTimes(5)
    const changed = await store.get(share(['b']))
    expect(changed.assets.map(asset => asset.id)).toEqual(['b'])
    await expect(store.get(share(['a'], { showMetadata: false }))).rejects.toThrow()
  })

  it('discards partial failures and allows a complete retry', async () => {
    let fail = true
    const load = vi.fn(async asset => {
      if (asset.id === 'photo-b' && fail) throw new Error('upstream private error')
      return tags
    })
    const store = new TagManifestStore(load)
    await expect(store.get(share())).rejects.toThrow()
    fail = false
    const manifest = await store.get(share())
    expect(manifest.assets).toHaveLength(2)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('does not mark old tags fresh when uploads rebuild the manifest', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async () => tags)
    const store = new TagManifestStore(load)
    await store.get(share(['a']))
    await vi.advanceTimersByTimeAsync(299_000)
    await store.get(share(['a', 'b']))
    expect(load.mock.calls.map(([asset]) => asset.id)).toEqual(['a', 'b'])
    await vi.advanceTimersByTimeAsync(1001)
    const current = share(['a', 'b'])
    await store.get(current)
    expect(load.mock.calls.map(([asset]) => asset.id)).toEqual(['a', 'b'])
    const fresh = async () => current
    expect(store.refresh(current, fresh)).toBe('refreshing')
    await vi.waitFor(() => expect(store.refresh(current, fresh)).toBe('ready'))
    expect(load.mock.calls.map(([asset]) => asset.id)).toEqual(['a', 'b', 'a'])
  })

  it('purges observed removals so a re-added asset fetches its current tags', async () => {
    const load = vi.fn(async () => tags)
    const store = new TagManifestStore(load)
    await store.get(share(['a', 'b']))
    store.observeShare(share(['a']))
    load.mockResolvedValue([{ id: 'updated', name: 'Updated' }])
    const manifest = await store.get(share(['a', 'b']))
    expect(load).toHaveBeenCalledTimes(3)
    expect(manifest.assets.find(asset => asset.id === 'b')?.tagIds).toEqual(['updated'])
  })

  it.each(['membership', 'eviction'])('blocks old in-flight reads from repopulating cache after %s changes', async mode => {
    let release!: (value: typeof tags) => void
    const load = vi.fn(async () => new Promise<typeof tags>(resolve => { release = resolve }))
    const store = new TagManifestStore(load)
    const original = share(['a'], { key: 'original' })
    const pending = store.get(original)
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    if (mode === 'membership') {
      store.observeShare(share([], { key: original.key }))
    } else {
      for (let i = 0; i < 21; i++) store.observeShare(share(['a'], { key: 'other-' + i }))
    }
    store.observeShare(original)
    release(tags)
    await pending
    load.mockResolvedValue([{ id: 'new', name: 'New' }])
    expect((await store.get(original)).tags).toEqual([{ id: 'new', name: 'New' }])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('retries a transient failure once while retaining successful asset reads', async () => {
    const calls = new Map<string, number>()
    const load = vi.fn(async asset => {
      const count = (calls.get(asset.id) || 0) + 1
      calls.set(asset.id, count)
      if (asset.id === 'b' && count === 1) throw new TagFailure('upstream', 503)
      return tags
    })
    const store = new TagManifestStore(load)
    expect((await store.get(share(['a', 'b', 'c']))).assets).toHaveLength(3)
    expect(calls).toEqual(new Map([['a', 1], ['b', 2], ['c', 1]]))
  })

  it.each([
    new TagFailure('upstream', 401), new TagFailure('upstream', 403),
    new TagFailure('upstream', 404), new TagFailure('invalid-data')
  ])('does not retry authorization, missing assets, or malformed data: %s', async error => {
    const load = vi.fn(async () => { throw error })
    const store = new TagManifestStore(load)
    await expect(store.get(share(['a']))).rejects.toBe(error)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('preserves the first actual failure and emits only safe diagnostics', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new TagFailure('upstream', 503))
      .mockRejectedValueOnce(new TagFailure('network'))
    const store = new TagManifestStore(load)
    let error: unknown
    try { await store.get(share(['a'])) } catch (caught) { error = caught }
    expect(load).toHaveBeenCalledTimes(2)
    expect(tagFailureDiagnostic(error)).toMatchObject({ category: 'upstream', status: 503, completed: 0, total: 1 })
    expect(tagFailureDiagnostic(new Error('private URL/share-key/asset-id/tag-name'))).toEqual({ category: 'unknown' })
  })

  it('limits concurrent requests to two globally, including scans from different stores', async () => {
    let active = 0
    let peak = 0
    const load = vi.fn(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
      return tags
    })
    const first = new TagManifestStore(load)
    const second = new TagManifestStore(load)
    await Promise.all([
      first.get(share(['a', 'b', 'c'])),
      first.get(share(['d', 'e', 'f'])),
      second.get(share(['g', 'h', 'i']))
    ])
    expect(load).toHaveBeenCalledTimes(9)
    expect(peak).toBe(2)
  })

  it('aborts stalled requests and does not poison the next attempt', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    let stalled = true
    const load = vi.fn(async (_asset, signal: AbortSignal) => {
      signals.push(signal)
      if (stalled) return new Promise<typeof tags>(() => {})
      return tags
    })
    const store = new TagManifestStore(load, 1000, 100)
    const failed = expect(store.get(share())).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(301)
    await failed
    expect(signals.every(signal => signal.aborted)).toBe(true)
    stalled = false
    expect((await store.get(share())).assets).toHaveLength(2)
  })

  it('bounds the whole scan and rejects an album that expires while scanning', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      return tags
    })
    const bounded = new TagManifestStore(load, 25, 100)
    const failed = expect(bounded.get(share(['a', 'b', 'c', 'd']))).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(26)
    await failed
    const expiring = new TagManifestStore(load)
    const expired = expect(expiring.get(share(['a'], { expiresAt: new Date(Date.now() + 10).toISOString() }))).rejects.toThrow('access')
    await vi.advanceTimersByTimeAsync(30)
    await expired
  })

  it('bounds cache size and rejects excessively large manifests before fetching', async () => {
    const load = vi.fn(async () => [])
    const store = new TagManifestStore(load)
    const oversized = share()
    oversized.assets = new Array(20_001).fill(oversized.assets[0])
    await expect(store.get(oversized)).rejects.toThrow('capacity')
    expect(load).not.toHaveBeenCalled()
    for (let i = 0; i < 21; i++) await store.get(share(['a'], { key: 'bounded-' + i }))
    await store.get(share(['a'], { key: 'bounded-0' }))
    expect(load).toHaveBeenCalledTimes(22)
  })
})

describe('stale-while-revalidate tag cache', () => {
  const newer = [{ id: 'new', name: 'Updated' }]

  it('serves stale data immediately, coalesces refreshes, and publishes only after final validation', async () => {
    vi.useFakeTimers()
    const link = share(['a', 'b'])
    const load = vi.fn(async () => tags)
    const store = new TagManifestStore(load)
    const old = await store.get(link)
    await vi.advanceTimersByTimeAsync(300_000)
    let releaseRead!: (value: typeof tags) => void
    load.mockImplementation(async asset => asset.id === 'a' ? newer : new Promise(resolve => { releaseRead = resolve }))
    let releaseValidation!: (value: SharedLink) => void
    const fresh = vi.fn()
      .mockResolvedValueOnce(link)
      .mockImplementationOnce(async () => new Promise(resolve => { releaseValidation = resolve }))
    expect(store.refresh(link, fresh)).toBe('refreshing')
    expect(store.refresh(link, fresh)).toBe('refreshing')
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(4))
    expect(await store.get(link)).toEqual(old)
    expect(fresh).toHaveBeenCalledTimes(1)
    releaseRead(newer)
    await vi.waitFor(() => expect(fresh).toHaveBeenCalledTimes(2))
    expect(await store.get(link)).toEqual(old)
    releaseValidation(link)
    await vi.waitFor(() => expect(store.refresh(link, fresh)).toBe('ready'))
    expect((await store.get(link)).tags).toEqual(newer)
    expect(load).toHaveBeenCalledTimes(4)
  })

  it('retains all old tags after a partial refresh failure and applies a sixty-second cooldown', async () => {
    vi.useFakeTimers()
    let failureTime = 0
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { failureTime = Date.now() })
    const link = share(['a', 'b'])
    const load = vi.fn(async () => tags)
    const store = new TagManifestStore(load)
    const old = await store.get(link)
    await vi.advanceTimersByTimeAsync(300_000)
    load.mockImplementation(async asset => {
      if (asset.id === 'b') throw new TagFailure('upstream', 503)
      return newer
    })
    const fresh = async () => link
    expect(store.refresh(link, fresh)).toBe('refreshing')
    await vi.waitFor(() => expect(store.refresh(link, fresh)).toBe('failed'))
    expect(await store.get(link)).toEqual(old)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][1]).toMatchObject({ category: 'upstream', status: 503 })
    expect(load).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(failureTime + 60_000 - Date.now() - 1)
    expect(store.refresh(link, fresh)).toBe('failed')
    load.mockResolvedValue(newer)
    await vi.advanceTimersByTimeAsync(1)
    expect(store.refresh(link, fresh)).toBe('refreshing')
    await vi.waitFor(() => expect(store.refresh(link, fresh)).toBe('ready'))
    expect((await store.get(link)).tags).toEqual(newer)
  })

  it('bounds a stalled background refresh without discarding usable old tags', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const link = share(['a'])
    const load = vi.fn(async () => tags)
    const store = new TagManifestStore(load, 50, 100)
    const old = await store.get(link)
    await vi.advanceTimersByTimeAsync(300_000)
    load.mockImplementation(async () => new Promise(() => {}))
    const fresh = async () => link
    expect(store.refresh(link, fresh)).toBe('refreshing')
    await vi.advanceTimersByTimeAsync(51)
    expect(store.refresh(link, fresh)).toBe('failed')
    expect(await store.get(link)).toEqual(old)
    expect(warn.mock.calls[0][1]).toMatchObject({ category: 'scan-timeout' })
  })

  it('never publishes a refresh when final metadata permission is revoked', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const link = share(['a'])
    const load = vi.fn(async () => tags)
    const store = new TagManifestStore(load)
    const old = await store.get(link)
    await vi.advanceTimersByTimeAsync(300_000)
    load.mockResolvedValue(newer)
    const fresh = vi.fn().mockResolvedValueOnce(link).mockResolvedValue({ ...link, showMetadata: false })
    store.refresh(link, fresh)
    await vi.waitFor(() => expect(store.refresh(link, fresh)).toBe('failed'))
    expect(await store.get(link)).toEqual(old)
    expect(fresh).toHaveBeenCalledTimes(2)
  })

  it.each(['membership', 'eviction'])('ignores delayed validation from a job cancelled by %s', async mode => {
    vi.useFakeTimers()
    const link = share(['a'])
    const load = vi.fn(async () => tags)
    const store = new TagManifestStore(load)
    await store.get(link)
    await vi.advanceTimersByTimeAsync(300_000)
    let release!: (value: SharedLink) => void
    const fresh = vi.fn(async () => new Promise<SharedLink>(resolve => { release = resolve }))
    store.refresh(link, fresh)
    if (mode === 'membership') store.observeShare(share([]))
    else for (let i = 0; i < 21; i++) store.observeShare(share([], { key: 'eviction-' + i }))
    const replacement = share(['a', 'b'])
    load.mockResolvedValue(newer)
    await store.get(replacement)
    expect(load).toHaveBeenCalledTimes(3)
    release(link)
    await vi.advanceTimersByTimeAsync(0)
    expect((await store.get(replacement)).tags).toEqual(newer)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('checks generation synchronously before publishing after final validation', async () => {
    vi.useFakeTimers()
    const link = share(['a'])
    const load = vi.fn(async () => tags)
    const store = new TagManifestStore(load)
    await store.get(link)
    await vi.advanceTimersByTimeAsync(300_000)
    const observe = store.observeShare.bind(store)
    let observations = 0
    vi.spyOn(store, 'observeShare').mockImplementation(current => {
      const result = observe(current)
      if (++observations === 3) queueMicrotask(() => observe(share([])))
      return result
    })
    load.mockResolvedValue(newer)
    store.refresh(link, async () => link)
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.snapshot(link)).toBeUndefined()
    await store.get(link)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('prioritizes missing foreground assets while preserving the global two-request limit', async () => {
    vi.useFakeTimers()
    const link = share(['a', 'b', 'c'])
    let active = 0
    let peak = 0
    type Release = () => void
    const releases = new Map<string, Release>()
    const order: string[] = []
    const load = vi.fn(async () => tags)
    const store = new TagManifestStore(load)
    await store.get(link)
    await vi.advanceTimersByTimeAsync(300_000)
    load.mockImplementation(async asset => {
      order.push(asset.id)
      active++
      peak = Math.max(peak, active)
      if (asset.id === 'a' || asset.id === 'b') await new Promise<void>(resolve => { releases.set(asset.id, resolve) })
      active--
      return newer
    })
    const fresh = async () => link
    store.refresh(link, fresh)
    await vi.waitFor(() => expect(order).toEqual(['a', 'b']))
    const foreground = store.get(share(['x'], { key: 'other-share' }))
    releases.get('a')!()
    await foreground
    expect(order[2]).toBe('x')
    releases.get('b')!()
    await vi.waitFor(() => expect(store.refresh(link, fresh)).toBe('ready'))
    expect(peak).toBe(2)
  })
})

describe('fresh tag request authorization and membership', () => {
  function stubAssetTags () {
    const fetch = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({ tags: [{ id: url.includes('/photo-a?') ? 'tag-a' : 'tag-b', name: 'Tag' }] })
    }))
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  it('never returns a removed asset or its exclusive tags from a warm manifest', async () => {
    let current = share(['photo-a', 'photo-b'], { key: 'membership-removal-test' })
    vi.mocked(fetchShareByKey).mockImplementation(async () => ({ valid: true, link: current }))
    const load = stubAssetTags()
    const first = await getTagManifest(current.key)
    expect(first.assets).toHaveLength(2)
    expect(first.tags.map(tag => tag.id)).toEqual(['tag-a', 'tag-b'])
    expect(await getTagManifest(current.key)).toEqual(first)
    expect(load).toHaveBeenCalledTimes(2)

    current = share(['photo-a'], { key: current.key })
    const updated = await getTagManifest(current.key)
    expect(updated.assets).toEqual([{ id: 'photo-a', tagIds: ['tag-a'] }])
    expect(updated.tags).toEqual([{ id: 'tag-a', name: 'Tag' }])
    // Even the warm read does fresh complete lookups before and after return.
    expect(fetchShareByKey).toHaveBeenCalledTimes(6)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it.each([
    { before: ['photo-a', 'photo-b'], after: ['photo-a'] },
    { before: ['photo-a'], after: ['photo-a', 'photo-b'] }
  ])('reconciles membership changes during a scan: $before -> $after', async ({ before, after }) => {
    const key = 'concurrent-membership-' + before.length
    vi.mocked(fetchShareByKey)
      .mockResolvedValueOnce({ valid: true, link: share(before, { key }) })
      .mockResolvedValue({ valid: true, link: share(after, { key }) })
    const load = stubAssetTags()
    const manifest = await getTagManifest(key)
    expect(manifest.assets.map(asset => asset.id)).toEqual(after)
    expect(load).toHaveBeenCalledTimes(2)
    expect(fetchShareByKey).toHaveBeenCalledTimes(3)
  })

  it('reconciles an upload during scanning and fetches only the added asset', async () => {
    const key = 'upload-during-scan'
    let current = share(['photo-a'], { key })
    vi.mocked(fetchShareByKey).mockImplementation(async () => ({ valid: true, link: current }))
    const load = vi.fn(async () => {
      current = share(['photo-a', 'photo-b'], { key })
      return { ok: true, json: async () => ({ tags }) }
    })
    vi.stubGlobal('fetch', load)
    const manifest = await getTagManifest(key)
    expect(manifest.assets.map(asset => asset.id)).toEqual(['photo-a', 'photo-b'])
    expect(load).toHaveBeenCalledTimes(2)
    expect(fetchShareByKey).toHaveBeenCalledTimes(3)
  })

  it('bounds continuously changing membership to three complete reconciliation passes', async () => {
    const key = 'continuous-upload-test'
    let count = 0
    vi.mocked(fetchShareByKey).mockImplementation(async () => ({
      valid: true, link: share(Array.from({ length: ++count }, (_, i) => 'photo-' + i), { key })
    }))
    const load = stubAssetTags()
    await expect(getTagManifest(key)).rejects.toThrow('membership-changing')
    expect(fetchShareByKey).toHaveBeenCalledTimes(4)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('does not reset the overall deadline during reconciliation', async () => {
    vi.useFakeTimers()
    const key = 'bounded-reconciliation-test'
    let count = 0
    vi.mocked(fetchShareByKey).mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 30_000))
      return { valid: true, link: share(Array.from({ length: ++count }, (_, i) => 'photo-' + i), { key }) }
    })
    stubAssetTags()
    const result = expect(getTagManifest(key)).rejects.toThrow('scan-timeout')
    await vi.advanceTimersByTimeAsync(90_001)
    await result
    expect(fetchShareByKey).toHaveBeenCalledTimes(3)
  })

  it('returns the new index with ready when refresh completes during final response authorization', async () => {
    vi.useFakeTimers()
    const link = share(['photo-a'], { key: 'publication-during-response' })
    let polling = false
    let pollCalls = 0
    let releasePoll!: (value: { valid: boolean, link: SharedLink }) => void
    vi.mocked(fetchShareByKey).mockImplementation(async () => {
      if (polling && ++pollCalls === 2) return new Promise(resolve => { releasePoll = resolve })
      return { valid: true, link }
    })
    const load = vi.fn(async () => ({ ok: true, json: async () => ({ tags }) }))
    vi.stubGlobal('fetch', load)
    expect((await getTagManifest(link.key)).refreshState).toBe('ready')
    await vi.advanceTimersByTimeAsync(300_000)
    let releaseAsset!: () => void
    const updated = [{ id: 'updated', name: 'Changed' }]
    load.mockImplementation(async () => {
      await new Promise<void>(resolve => { releaseAsset = resolve })
      return { ok: true, json: async () => ({ tags: updated }) }
    })
    expect((await getTagManifest(link.key)).refreshState).toBe('refreshing')
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    polling = true
    const response = getTagManifest(link.key)
    await vi.waitFor(() => expect(pollCalls).toBe(2))
    releaseAsset()
    await vi.waitFor(() => expect(tagManifestStore.refresh(link, async () => link)).toBe('ready'))
    releasePoll({ valid: true, link })
    expect(await response).toMatchObject({ tags: updated, refreshState: 'ready' })
  })

  it('requires fresh metadata permission even when a manifest is warm', async () => {
    const current = share(['photo-a'], { key: 'permission-revoked-test' })
    vi.mocked(fetchShareByKey).mockResolvedValue({ valid: true, link: current })
    const load = stubAssetTags()
    await getTagManifest(current.key)
    vi.mocked(fetchShareByKey).mockResolvedValue({ valid: true, link: { ...current, showMetadata: false } })
    await expect(getTagManifest(current.key)).rejects.toThrow('access')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid keys and password-required shares before scanning', async () => {
    const load = stubAssetTags()
    await expect(getTagManifest('../invalid')).rejects.toThrow('access')
    expect(fetchShareByKey).not.toHaveBeenCalled()
    vi.mocked(fetchShareByKey).mockResolvedValue({ valid: true, passwordRequired: true })
    await expect(getTagManifest('locked-key', 'wrong-password')).rejects.toThrow('access')
    expect(fetchShareByKey).toHaveBeenCalledWith('locked-key', 'wrong-password', KeyType.key)
    expect(load).not.toHaveBeenCalled()
  })
})
