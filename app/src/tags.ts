import { createHash } from 'crypto'
import { Asset, isKey, KeyType, SharedLink, slugLinksDisabled, TtlLruCache } from '@ipp/core'
import { assetFetchUrl, authHeadersForAsset, fetchShareByKey } from './immich'

export interface TagManifest {
  tags: Array<{ id: string, name: string }>
  assets: Array<{ id: string, tagIds: string[] }>
}

export type RefreshState = 'ready' | 'refreshing' | 'failed'

type AssetTags = TagManifest['tags']
interface CachedTags { tags: AssetTags, fetchedAt: number }
type LoadTags = (asset: Asset, signal: AbortSignal) => Promise<AssetTags>
type FailureCategory = 'access' | 'invalid-data' | 'network' | 'upstream' | 'request-timeout' | 'scan-timeout' | 'capacity' | 'membership-changing' | 'unknown'

/** Safe diagnostic vocabulary: never retain an upstream body, URL, key or ID. */
export class TagFailure extends Error {
  readonly category: FailureCategory
  readonly status?: number
  completed?: number
  total?: number
  elapsedMs?: number

  constructor (category: FailureCategory, status?: number) {
    super(category)
    this.category = category
    this.status = status
  }
}

function failure (error: unknown): TagFailure {
  return error instanceof TagFailure ? error : new TagFailure('unknown')
}

export function tagFailureDiagnostic (error: unknown): {
  category: string, status?: number, completed?: number, total?: number, elapsedMs?: number
} {
  const safe = failure(error)
  return {
    category: safe.category,
    ...(safe.status && safe.status >= 100 && safe.status <= 599 ? { status: safe.status } : {}),
    ...(safe.completed !== undefined ? { completed: safe.completed } : {}),
    ...(safe.total !== undefined ? { total: safe.total } : {}),
    ...(safe.elapsedMs !== undefined ? { elapsedMs: safe.elapsedMs } : {})
  }
}

/** The owner's share-level metadata permission also covers tag names. */
export function canReadTags (link: SharedLink): boolean {
  return link.showMetadata === true && (!link.expiresAt || Date.parse(link.expiresAt) > Date.now())
}

/** Only these two tag fields cross the public boundary; never return the asset DTO. */
export function publicAssetTags (detail: unknown): AssetTags {
  if (!detail || typeof detail !== 'object') throw new TagFailure('invalid-data')
  const tags = (detail as { tags?: unknown }).tags
  if (tags === undefined || tags === null) return []
  if (!Array.isArray(tags)) throw new TagFailure('invalid-data')
  const result = new Map<string, string>()
  for (const tag of tags) {
    if (!tag || typeof tag !== 'object' || typeof tag.id !== 'string' || !tag.id) throw new TagFailure('invalid-data')
    // value preserves the full path for nested Immich tags; name is the leaf.
    const name = typeof tag.value === 'string' && tag.value ? tag.value : tag.name
    if (typeof name !== 'string' || !name) throw new TagFailure('invalid-data')
    result.set(tag.id, name)
  }
  return [...result].map(([id, name]) => ({ id, name }))
}

function abortFailure (signal: AbortSignal): TagFailure {
  return signal.reason instanceof TagFailure ? signal.reason : new TagFailure('scan-timeout')
}

async function fetchAssetTags (asset: Asset, signal: AbortSignal): Promise<AssetTags> {
  let response: Response
  try {
    const headers = await authHeadersForAsset(asset)
    signal.throwIfAborted()
    response = await fetch(assetFetchUrl(asset, ''), { headers, signal })
  } catch (_) {
    throw signal.aborted ? abortFailure(signal) : new TagFailure('network')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new TagFailure('upstream', response.status)
  }
  let detail: unknown
  try {
    detail = await response.json()
  } catch (_) {
    throw signal.aborted ? abortFailure(signal) : new TagFailure('invalid-data')
  }
  return publicAssetTags(detail)
}

function abortable<T> (promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(abortFailure(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortFailure(signal))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Bounds the caller's wait, including uncached share enumeration. */
async function beforeDeadline<T> (promise: Promise<T>, deadline: number): Promise<T> {
  if (Date.now() >= deadline) {
    promise.catch(() => {})
    throw new TagFailure('scan-timeout')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new TagFailure('scan-timeout')), deadline - Date.now())
  try {
    return await abortable(promise, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/** A process-wide limit, shared by every album scan and every visitor. */
class TagRequestPool {
  private active = 0
  private readonly foreground: Array<() => void> = []
  private readonly background: Array<() => void> = []

  async run<T> (task: () => Promise<T>, signal: AbortSignal, background = false): Promise<T> {
    const queue = background ? this.background : this.foreground
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener('abort', abort)
        this.active++
        resolve()
      }
      const abort = () => {
        const index = queue.indexOf(start)
        if (index >= 0) queue.splice(index, 1)
        reject(abortFailure(signal))
      }
      if (signal.aborted) return reject(abortFailure(signal))
      signal.addEventListener('abort', abort, { once: true })
      queue.push(start)
      this.pump()
    })
    try {
      signal.throwIfAborted()
      return await abortable(task(), signal)
    } finally {
      this.active--
      this.pump()
    }
  }

  private pump () {
    while (this.active < 2 && (this.foreground.length || this.background.length)) {
      (this.foreground.shift() || this.background.shift())!()
    }
  }
}

const requestPool = new TagRequestPool()
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const authNamespace = (link: SharedLink) => hash([link.keyType, link.key, link.password ?? ''])

interface Membership {
  ids: Set<string>
  generation: number
}

interface RefreshJob {
  controller: AbortController
  state: RefreshState
  retryAt: number
}

/**
 * Compact tags remain in bounded memory until removal, LRU eviction or restart.
 * After five minutes they are still usable while an authorized request starts
 * an atomic background refresh. No periodic work runs without a visitor.
 * Authorization and complete membership are read afresh for every response.
 */
export class TagManifestStore {
  private readonly assets = new TtlLruCache<CachedTags>({ ttlMs: Infinity, max: 20_000 })
  private readonly memberships = new Map<string, Membership>()
  private generation = 0
  private readonly refreshes = new Map<string, RefreshJob>()
  private readonly inFlight = new Map<string, Promise<TagManifest>>()
  private readonly loadTags: LoadTags
  private readonly scanTimeoutMs: number
  private readonly requestTimeoutMs: number

  constructor (loadTags: LoadTags = fetchAssetTags, scanTimeoutMs = 90_000, requestTimeoutMs = 8_000) {
    this.loadTags = loadTags
    this.scanTimeoutMs = scanTimeoutMs
    this.requestTimeoutMs = requestTimeoutMs
  }

  /** Purge observed removals, including when the final reconciliation fails. */
  observeShare (link: SharedLink): Membership {
    if (link.assets.length > 20_000) throw new TagFailure('capacity')
    const namespace = authNamespace(link)
    const previous = this.memberships.get(namespace)
    const ids = new Set(link.assets.map(asset => asset.id))
    const unchanged = previous && previous.ids.size === ids.size && [...ids].every(id => previous.ids.has(id))
    const membership = unchanged ? previous : { ids, generation: ++this.generation }
    if (previous && !unchanged) {
      this.cancelRefresh(namespace)
      for (const id of previous.ids) if (!ids.has(id)) this.assets.delete(namespace + ':' + id)
    }
    this.memberships.delete(namespace)
    this.memberships.set(namespace, membership)
    if (this.memberships.size > 20) {
      const oldest = this.memberships.entries().next().value!
      this.cancelRefresh(oldest[0])
      for (const id of oldest[1].ids) this.assets.delete(oldest[0] + ':' + id)
      this.memberships.delete(oldest[0])
    }
    return membership
  }

  async get (link: SharedLink, deadline = Date.now() + this.scanTimeoutMs): Promise<TagManifest> {
    if (!canReadTags(link)) throw new TagFailure('access')
    if (link.assets.length > 20_000) throw new TagFailure('capacity')
    if (Date.now() >= deadline) throw new TagFailure('scan-timeout')
    const membership = this.observeShare(link)
    const namespace = authNamespace(link)
    const key = namespace + ':' + membership.generation
    const pending = this.inFlight.get(key)
    if (pending) return beforeDeadline(pending, deadline)
    if (this.inFlight.size >= 20) throw new TagFailure('capacity')
    const scan = this.build(link, namespace, membership, deadline).then(manifest => {
      if (!canReadTags(link)) throw new TagFailure('access')
      return manifest
    }).finally(() => { this.inFlight.delete(key) })
    this.inFlight.set(key, scan)
    return scan
  }

  /** A non-yielding snapshot to pair current data with its refresh status. */
  snapshot (link: SharedLink): TagManifest | undefined {
    const namespace = authNamespace(link)
    const tags = new Map<string, string>()
    const assets: TagManifest['assets'] = []
    for (const asset of link.assets) {
      const entry = this.assets.get(namespace + ':' + asset.id)
      if (!entry) return undefined
      for (const tag of entry.tags) tags.set(tag.id, tag.name)
      assets.push({ id: asset.id, tagIds: entry.tags.map(tag => tag.id) })
    }
    return {
      tags: [...tags].map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
      assets
    }
  }

  private async readTags (asset: Asset, namespace: string, membership: Membership, signal: AbortSignal, staged?: Map<string, CachedTags>): Promise<AssetTags> {
    const key = namespace + ':' + asset.id
    const reusable = (entry?: CachedTags) => entry && (!staged || Date.now() - entry.fetchedAt < 300_000)
    const cached = this.assets.get(key)
    if (reusable(cached)) return cached!.tags
    return requestPool.run(async () => {
      // Foreground work may have supplied a fresh value while we queued.
      const ready = this.assets.get(key)
      if (reusable(ready)) return ready!.tags
      let firstError: TagFailure | undefined
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController()
        const abort = () => controller.abort(abortFailure(signal))
        signal.addEventListener('abort', abort, { once: true })
        const timer = setTimeout(() => controller.abort(new TagFailure('request-timeout')), this.requestTimeoutMs)
        try {
          const tags = await abortable(this.loadTags(asset, controller.signal), controller.signal)
          // An old scan cannot repopulate data after membership changed or its
          // namespace was evicted/recreated, even if the asset later reappears.
          const entry = { tags, fetchedAt: Date.now() }
          if (staged) staged.set(key, entry)
          else if (this.memberships.get(namespace) === membership) this.assets.set(key, entry)
          return tags
        } catch (error) {
          const safe = failure(error)
          firstError ??= safe
          const transient = safe.category === 'network' || safe.category === 'request-timeout' ||
            (safe.category === 'upstream' && (safe.status === 429 || (safe.status || 0) >= 500))
          if (signal.aborted || !transient || attempt === 1) throw firstError
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
        }
        await abortable(new Promise(resolve => setTimeout(resolve, 100)), signal)
      }
      throw firstError || new TagFailure('unknown')
    }, signal, !!staged)
  }

  private async build (link: SharedLink, namespace: string, membership: Membership, deadline: number, staged?: Map<string, CachedTags>, parentSignal?: AbortSignal): Promise<TagManifest> {
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new TagFailure('scan-timeout')), Math.max(0, deadline - started))
    const abort = () => controller.abort(abortFailure(parentSignal!))
    parentSignal?.addEventListener('abort', abort, { once: true })
    if (parentSignal?.aborted) abort()
    // Hold a stable view while foreground assembly yields between assets; a
    // background publication cannot mix two generations into one response.
    const snapshot = staged ? undefined : new Map(link.assets.map(asset => [asset.id, this.assets.get(namespace + ':' + asset.id)]))
    const tags = new Map<string, string>()
    const assets: TagManifest['assets'] = new Array(link.assets.length)
    let next = 0
    let completed = 0
    let firstError: TagFailure | undefined
    const worker = async () => {
      while (next < link.assets.length) {
        controller.signal.throwIfAborted()
        const index = next++
        try {
          const asset = link.assets[index]
          const cached = snapshot?.get(asset.id)
          const found = cached ? cached.tags : await this.readTags(asset, namespace, membership, controller.signal, staged)
          for (const tag of found) tags.set(tag.id, tag.name)
          assets[index] = { id: link.assets[index].id, tagIds: found.map(tag => tag.id) }
          completed++
        } catch (error) {
          firstError ??= failure(error)
          controller.abort(firstError)
          throw firstError
        }
      }
    }
    try {
      const results = await Promise.allSettled([worker(), worker()])
      if (results.some(result => result.status === 'rejected')) throw firstError || abortFailure(controller.signal)
      return {
        tags: [...tags].map(([id, name]) => ({ id, name }))
          .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
        assets
      }
    } catch (error) {
      const safe = failure(error)
      safe.completed = completed
      safe.total = link.assets.length
      safe.elapsedMs = Date.now() - started
      throw safe
    } finally {
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', abort)
    }
  }

  private cancelRefresh (namespace: string) {
    this.refreshes.get(namespace)?.controller.abort(new TagFailure('membership-changing'))
    this.refreshes.delete(namespace)
  }

  /** Start at most one refresh per authorization namespace; never await it. */
  refresh (link: SharedLink, freshShare: () => Promise<SharedLink>): RefreshState {
    if (!canReadTags(link)) throw new TagFailure('access')
    const membership = this.observeShare(link)
    const namespace = authNamespace(link)
    const previous = this.refreshes.get(namespace)
    if (previous?.state === 'refreshing') return 'refreshing'
    const stale = link.assets.some(asset => {
      const cached = this.assets.get(namespace + ':' + asset.id)
      return !cached || Date.now() - cached.fetchedAt >= 300_000
    })
    if (!stale) return 'ready'
    if (previous?.state === 'failed' && Date.now() < previous.retryAt) return 'failed'

    const job: RefreshJob = { controller: new AbortController(), state: 'refreshing', retryAt: 0 }
    this.refreshes.set(namespace, job)
    const deadline = Date.now() + this.scanTimeoutMs
    const validate = async () => {
      const current = await beforeDeadline(freshShare(), deadline)
      if (!canReadTags(current)) throw new TagFailure('access')
      if (job.controller.signal.aborted || this.refreshes.get(namespace) !== job || this.memberships.get(namespace) !== membership) {
        throw new TagFailure('membership-changing')
      }
      if (this.observeShare(current) !== membership) throw new TagFailure('membership-changing')
    }
    const run = async () => {
      await validate()
      const staged = new Map<string, CachedTags>()
      await this.build(link, namespace, membership, deadline, staged, job.controller.signal)
      await validate()
      if (this.memberships.get(namespace) !== membership || this.refreshes.get(namespace) !== job || job.controller.signal.aborted) {
        throw new TagFailure('membership-changing')
      }
      // No await inside publication: visitors see all old values or all new
      // values. Newer foreground reads must not be replaced by an older stage.
      for (const [key, entry] of staged) {
        const existing = this.assets.get(key)
        if (!existing || existing.fetchedAt <= entry.fetchedAt) this.assets.set(key, entry)
      }
    }
    run().then(() => {
      if (this.refreshes.get(namespace) === job) this.refreshes.delete(namespace)
    }, error => {
      // Membership changes/evictions deliberately cancel obsolete jobs.
      if (this.refreshes.get(namespace) !== job) return
      job.state = 'failed'
      job.retryAt = Date.now() + 60_000
      console.warn('Tag refresh failed', tagFailureDiagnostic(error))
    })
    return 'refreshing'
  }
}

export const tagManifestStore = new TagManifestStore()

/**
 * Reconcile concurrent uploads against fresh complete share membership, up to
 * three passes with one 90-second deadline. Each pass reuses successful asset
 * reads. Only a complete index matching the final authorized membership escapes.
 */
export async function getTagManifest (key: string, password?: string, keyType = KeyType.key): Promise<TagManifest & { refreshState: RefreshState }> {
  const started = Date.now()
  const deadline = started + 90_000
  try {
    if (!isKey(key) || slugLinksDisabled(keyType)) throw new TagFailure('access')
    const freshShare = async () => {
      const result = await fetchShareByKey(key, password, keyType)
      if (!result.valid || result.passwordRequired || !result.link || !canReadTags(result.link)) throw new TagFailure('access')
      return result.link
    }
    let link = await beforeDeadline(freshShare(), deadline)
    for (let pass = 0; pass < 3; pass++) {
      const manifest = await tagManifestStore.get(link, deadline)
      const current = await beforeDeadline(freshShare(), deadline)
      tagManifestStore.observeShare(current)
      const indexed = new Set(manifest.assets.map(asset => asset.id))
      if (current.assets.length === indexed.size && current.assets.every(asset => indexed.has(asset.id))) {
        const latest = tagManifestStore.snapshot(current) || manifest
        return { ...latest, refreshState: tagManifestStore.refresh(current, freshShare) }
      }
      link = current
    }
    throw new TagFailure('membership-changing')
  } catch (error) {
    const safe = failure(error)
    safe.elapsedMs = Date.now() - started
    throw safe
  }
}
