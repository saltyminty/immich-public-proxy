import { describe, it, expect } from 'vitest'
import { indexTagManifest, matchAllTags, reconcileTagOptions, sameGalleryItems } from '../src/client/tag-index'
import type { GalleryItem, TagResponse } from '../src/shared/types'

const items: GalleryItem[] = ['both', 'alice', 'bob', 'untagged'].map(id => ({
  id, type: 'IMAGE', previewUrl: '', thumbnailUrl: '', downloadFilename: ''
}))
const manifest: TagResponse = {
  refreshState: 'ready',
  tags: [{ id: 'b', name: 'Bob' }, { id: 'a', name: 'Alice' }],
  assets: [
    { id: 'both', tagIds: ['a', 'b'] },
    { id: 'alice', tagIds: ['a'] },
    { id: 'bob', tagIds: ['b'] },
    { id: 'untagged', tagIds: [] }
  ]
}

const ids = (selected: string[]) => matchAllTags(items, new Set(selected), indexTagManifest(manifest, items)).map(item => item.id)

describe('complete tag index and AND filtering', () => {
  it('shows every item, including untagged items, with no selection', () => {
    expect(ids([])).toEqual(['both', 'alice', 'bob', 'untagged'])
  })

  it('matches one tag and preserves gallery order', () => {
    expect(ids(['a'])).toEqual(['both', 'alice'])
  })

  it('requires every selected tag, rather than any selected tag', () => {
    expect(ids(['a', 'b'])).toEqual(['both'])
    expect(ids(['b', 'a'])).toEqual(['both'])
  })

  it('can return an empty intersection and then restore the complete gallery', () => {
    const selected = new Set(['a', 'missing'])
    const index = indexTagManifest(manifest, items)
    expect(matchAllTags(items, selected, index)).toEqual([])
    selected.clear()
    expect(matchAllTags(items, selected, index)).toBe(items)
  })

  it('sorts tag names alphabetically without modifying their text', () => {
    const index = indexTagManifest(manifest, items)
    expect(index.tags.map(tag => tag.name)).toEqual(['Alice', 'Bob'])
    const markup = '</script><img src=x onerror=alert(1)>'
    expect(indexTagManifest({ ...manifest, tags: [{ id: 'b', name: markup }, manifest.tags[1]] }, items).tags.some(tag => tag.name === markup)).toBe(true)
  })

  it('rejects a missing asset rather than treating incomplete metadata as untagged', () => {
    expect(() => indexTagManifest({ ...manifest, assets: manifest.assets.slice(1) }, items)).toThrow()
  })

  it.each([
    null,
    {},
    { ...manifest, refreshState: undefined },
    { ...manifest, refreshState: 'unexpected' },
    { ...manifest, tags: [{ id: 'a', name: 5 }] },
    { ...manifest, tags: [...manifest.tags, manifest.tags[0]] },
    { ...manifest, assets: [...manifest.assets, manifest.assets[0]] },
    { ...manifest, assets: [{ id: 'both', tagIds: ['unknown'] }, ...manifest.assets.slice(1)] },
    { ...manifest, assets: [{ id: 'both', tagIds: 'a' }, ...manifest.assets.slice(1)] }
  ])('rejects malformed or inconsistent manifest %j', value => {
    expect(() => indexTagManifest(value, items)).toThrow()
  })

  it('accepts newer album additions but only offers tags on displayed items', () => {
    const newer = {
      ...manifest,
      tags: [...manifest.tags, { id: 'c', name: 'Carol' }],
      assets: [...manifest.assets, { id: 'new', tagIds: ['c'] }]
    }
    expect(indexTagManifest(newer, items).tags.map(tag => tag.id)).toEqual(['a', 'b'])
  })
})

describe('refresh reconciliation', () => {
  it.each(['ready', 'refreshing', 'failed'])('accepts complete %s responses without dropping cached items', refreshState => {
    const index = indexTagManifest({ ...manifest, refreshState }, items)
    expect(index.refreshState).toBe(refreshState)
    expect(matchAllTags(items, new Set(['a', 'b']), index).map(item => item.id)).toEqual(['both'])
  })

  it('retains a removed selected tag and its last name, without broadening the AND filter', () => {
    const selected = new Set(['a', 'b'])
    const refreshed = {
      ...manifest,
      tags: [{ id: 'a', name: 'Alice' }],
      assets: manifest.assets.map(asset => ({ ...asset, tagIds: asset.tagIds.filter(id => id !== 'b') }))
    }
    const index = indexTagManifest(refreshed, items)
    const options = reconcileTagOptions(index.tags, manifest.tags, selected)
    expect(options).toEqual([{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob', unavailable: true }])
    expect(matchAllTags(items, selected, index)).toEqual([])
    expect(reconcileTagOptions(index.tags, options, selected)).toEqual(options)
    selected.delete('b')
    expect(reconcileTagOptions(index.tags, options, selected)).toEqual([{ id: 'a', name: 'Alice' }])
    expect(matchAllTags(items, selected, index).map(item => item.id)).toEqual(['both', 'alice'])
  })

  it('updates renamed tags by ID and restores availability when a tag returns', () => {
    const options = reconcileTagOptions([{ id: 'b', name: 'Robert' }], [{ id: 'b', name: 'Bob', unavailable: true }], new Set(['b']))
    expect(options).toEqual([{ id: 'b', name: 'Robert' }])
  })

  it('drops unselected old tags and adds new tags in alphabetical order', () => {
    expect(reconcileTagOptions([{ id: 'c', name: 'Carol' }, { id: 'a', name: 'Alice' }], manifest.tags, new Set())).toEqual([
      { id: 'a', name: 'Alice' }, { id: 'c', name: 'Carol' }
    ])
  })

  it('recognises identical visible IDs without relying on array identity', () => {
    expect(sameGalleryItems(items, [...items])).toBe(true)
    expect(sameGalleryItems(items, items.slice(1))).toBe(false)
    expect(sameGalleryItems(items, [...items].reverse())).toBe(false)
  })
})
