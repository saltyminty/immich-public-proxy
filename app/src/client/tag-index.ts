import type { GalleryItem, TagManifest, TagResponse } from '../shared/types.js'

export interface TagIndex {
  tags: TagManifest['tags']
  assetTags: Map<string, Set<string>>
  refreshState: TagResponse['refreshState']
}

export function indexTagManifest (value: unknown, items: GalleryItem[]): TagIndex {
  const invalid = () => { throw new Error('Incomplete tag index') }
  if (!value || typeof value !== 'object') return invalid()
  const manifest = value as TagResponse
  if (!['ready', 'refreshing', 'failed'].includes(manifest.refreshState)) return invalid()
  if (!Array.isArray(manifest.tags) || !Array.isArray(manifest.assets)) return invalid()
  const tags = new Map<string, { id: string, name: string }>()
  for (const tag of manifest.tags) {
    if (!tag || typeof tag.id !== 'string' || !tag.id || typeof tag.name !== 'string' || !tag.name || tags.has(tag.id)) return invalid()
    tags.set(tag.id, { id: tag.id, name: tag.name })
  }
  const assetTags = new Map<string, Set<string>>()
  for (const asset of manifest.assets) {
    if (!asset || typeof asset.id !== 'string' || !asset.id || assetTags.has(asset.id) || !Array.isArray(asset.tagIds)) return invalid()
    if (asset.tagIds.some(id => typeof id !== 'string' || !tags.has(id))) return invalid()
    assetTags.set(asset.id, new Set(asset.tagIds))
  }
  if (items.some(item => !assetTags.has(item.id))) return invalid()
  // A cached gallery can predate an album addition; only offer tags used by
  // the items actually present in this page, without treating removals as untagged.
  const usedTags = new Set(items.flatMap(item => [...assetTags.get(item.id)!]))
  return {
    tags: [...tags.values()].filter(tag => usedTags.has(tag.id)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.id.localeCompare(b.id)),
    assetTags,
    refreshState: manifest.refreshState
  }
}

export function matchAllTags (items: GalleryItem[], selected: Set<string>, index: TagIndex): GalleryItem[] {
  if (!selected.size) return items
  return items.filter(item => {
    const tags = index.assetTags.get(item.id)
    return tags && [...selected].every(id => tags.has(id))
  })
}

export interface TagOption {
  id: string
  name: string
  unavailable?: boolean
}

export function reconcileTagOptions (tags: TagManifest['tags'], previous: TagOption[], selected: Set<string>): TagOption[] {
  const next: TagOption[] = tags.map(tag => ({ ...tag }))
  const available = new Set(tags.map(tag => tag.id))
  for (const tag of previous) {
    if (selected.has(tag.id) && !available.has(tag.id)) next.push({ ...tag, unavailable: true })
  }
  return next.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.id.localeCompare(b.id))
}

export function sameGalleryItems (first: GalleryItem[], second: GalleryItem[]): boolean {
  return first.length === second.length && first.every((item, position) => item.id === second[position].id)
}
