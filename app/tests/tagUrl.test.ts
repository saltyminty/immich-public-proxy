import { describe, it, expect } from 'vitest'
import { parseTagNames, withTagNames, resolveTagNames, resolveUnavailableTagNames, selectedTagNames } from '../src/client/tag-url'
import { matchAllTags } from '../src/client/tag-index'
import type { GalleryItem } from '../src/shared/types'

describe('tag names in shared URLs', () => {
  it('accepts repeated tags and comma shorthand, deduplicated in first-seen order', () => {
    expect(parseTagNames('?tags=Alice,Bob&tags=Carol&tags=Alice&tags=Bob,David')).toEqual(['Alice', 'Bob', 'Carol', 'David'])
  })

  it('distinguishes literal comma separators from encoded commas in exact tag names', () => {
    expect(parseTagNames('?tags=Alice%2CBob,Carol&tags=Other%2ctag')).toEqual(['Alice,Bob', 'Carol', 'Other,tag'])
  })

  it('decodes Unicode, spaces, plus signs, ampersands and equals signs once', () => {
    expect(parseTagNames('?tags=%E5%B0%8F%E6%98%8E&tags=Alice+Smith&tags=C%2B%2B&tags=Salt%26Pepper&tags=a%3Db&tags=%252C')).toEqual([
      '小明', 'Alice Smith', 'C++', 'Salt&Pepper', 'a=b', '%2C'
    ])
  })

  it('matches only the exact decoded parameter name and preserves tag case and whitespace', () => {
    expect(parseTagNames('?Tags=ignored&%74ags=Alice&tags=alice&tags=+Alice+&??tags=ignored&tags%00=ignored')).toEqual([
      'Alice', 'alice', ' Alice '
    ])
  })

  it('ignores absent and empty values without inventing a filter', () => {
    expect(parseTagNames('')).toEqual([])
    expect(parseTagNames('?other=Alice&tags&tags=,,&tags=')).toEqual([])
    expect(parseTagNames('tags=,Alice,,&tags=Bob,')).toEqual(['Alice', 'Bob'])
  })

  it('tolerates malformed percent encoding with URLSearchParams replacement semantics', () => {
    expect(parseTagNames('?tags=%ZZ&tags=%FF&tags=100%')).toEqual(['%ZZ', '�', '100%'])
  })
})

describe('canonical filtered URLs', () => {
  const href = 'https://proxy.example/share/key?mode=grid&tags=old&%74ags=other&keep=a%26b&mode=list#photo-1'

  it('replaces every decoded tags parameter with repeated exact names and retains other values and the hash', () => {
    const result = withTagNames(href, ['Alice,Bob', '小明', 'Salt&Pepper', 'C++', 'Alice Smith', 'Alice,Bob', ''])
    const url = new URL(result)
    expect(url.origin + url.pathname).toBe('https://proxy.example/share/key')
    expect(url.searchParams.getAll('mode')).toEqual(['grid', 'list'])
    expect(url.searchParams.get('keep')).toBe('a&b')
    expect(url.hash).toBe('#photo-1')
    expect(url.searchParams.getAll('tags')).toEqual(['Alice,Bob', '小明', 'Salt&Pepper', 'C++', 'Alice Smith'])
    expect(result).toContain('tags=Alice%2CBob')
    expect(parseTagNames(url.search)).toEqual(['Alice,Bob', '小明', 'Salt&Pepper', 'C++', 'Alice Smith'])
  })

  it('clears all tag parameters while retaining unrelated query parameters and the hash', () => {
    const url = new URL(withTagNames(href, []))
    expect([...url.searchParams]).toEqual([['mode', 'grid'], ['keep', 'a&b'], ['mode', 'list']])
    expect(url.hash).toBe('#photo-1')
    expect(withTagNames('https://proxy.example/share/key?tags=Alice#photo-1', [])).toBe('https://proxy.example/share/key#photo-1')
  })

  it('preserves parameters whose names differ from tags by case', () => {
    expect(new URL(withTagNames('https://proxy.example/share/key?Tags=keep', ['Alice'])).searchParams.get('Tags')).toBe('keep')
  })

  it('round-trips names containing delimiters and preserves distinct exact names', () => {
    const names = ['Alice', 'alice', ' Alice ', 'one,two', 'one&two', 'one=two', 'one+two', 'one%two', 'one#two', '日本語😀']
    const url = new URL(withTagNames('https://proxy.example/share/key', names))
    expect(parseTagNames(url.search)).toEqual(names)
    expect(withTagNames(url.href, names)).toBe(url.href)
  })
})

describe('URL tag selection resolution', () => {
  const tags = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Alice' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'alice' },
    { id: '33333333-3333-4333-8333-333333333333', name: 'Bob' },
    { id: '44444444-4444-4444-8444-444444444444', name: 'Bob' }
  ]

  it('resolves unique exact names only, preserving distinct case and removing duplicate requests', () => {
    const result = resolveTagNames(['alice', 'Alice', 'alice', ''], tags)
    expect([...result.selected]).toEqual([tags[1].id, tags[0].id])
    expect(result.unavailable).toEqual([])
  })

  it('retains missing and ambiguous names as explicit unavailable selections', () => {
    const result = resolveTagNames(['Alice', 'Bob', 'Missing', 'Bob', 'ALICE'], tags)
    expect([...result.selected]).toEqual([tags[0].id, 'url-name:Bob', 'url-name:Missing', 'url-name:ALICE'])
    expect(result.unavailable).toEqual([
      { id: 'url-name:Bob', name: 'Bob', unavailable: true },
      { id: 'url-name:Missing', name: 'Missing', unavailable: true },
      { id: 'url-name:ALICE', name: 'ALICE', unavailable: true }
    ])
    expect(result.unavailable.every(option => !/^[0-9a-f-]{36}$/i.test(option.id))).toBe(true)
  })

  it.each(['Bob', 'Missing'])('keeps an unresolved %s name from broadening an AND filter', name => {
    const items: GalleryItem[] = [{ id: 'photo', type: 'IMAGE', previewUrl: '', thumbnailUrl: '', downloadFilename: '' }]
    const index = { tags, assetTags: new Map([['photo', new Set(tags.map(tag => tag.id))]]), refreshState: 'ready' as const }
    expect(matchAllTags(items, resolveTagNames(['Alice', name], tags).selected, index)).toEqual([])
  })

  it('handles punctuation and Unicode in unavailable IDs without collisions between names', () => {
    const result = resolveTagNames(['小明', '%E5%B0%8F%E6%98%8E', 'a,b', 'a%2Cb'], [])
    expect(result.selected.size).toBe(4)
    expect(result.unavailable.map(option => option.name)).toEqual(['小明', '%E5%B0%8F%E6%98%8E', 'a,b', 'a%2Cb'])
  })
})

describe('unavailable URL names after refresh', () => {
  it('resolves a missing name when a fresh index provides exactly one match without mutating the input', () => {
    const initial = resolveTagNames(['Alice', 'Bob'], [{ id: 'a', name: 'Alice' }])
    const tags = [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }]
    const options = [{ id: 'a', name: 'Alice' }, ...initial.unavailable]
    const refreshed = resolveUnavailableTagNames(initial.selected, options, tags)
    expect([...refreshed]).toEqual(['a', 'b'])
    expect([...initial.selected]).toEqual(['a', 'url-name:Bob'])
    expect(options[1]).toEqual({ id: 'url-name:Bob', name: 'Bob', unavailable: true })
  })

  it('resolves a previously ambiguous name when only one exact match remains', () => {
    const initial = resolveTagNames(['Bob'], [{ id: 'b1', name: 'Bob' }, { id: 'b2', name: 'Bob' }])
    expect([...resolveUnavailableTagNames(initial.selected, initial.unavailable, [{ id: 'b2', name: 'Bob' }])]).toEqual(['b2'])
  })

  it('retains resolved IDs through renames and removals even if another tag adopts the old name', () => {
    const previous = [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob', unavailable: true }]
    const tags = [{ id: 'a', name: 'Alicia' }, { id: 'new-a', name: 'Alice' }, { id: 'new-b', name: 'Bob' }]
    expect([...resolveUnavailableTagNames(new Set(['a', 'b']), previous, tags)]).toEqual(['a', 'b'])
  })

  it('retains unresolved selections when names remain missing or ambiguous', () => {
    const initial = resolveTagNames(['Missing', 'Bob'], [])
    const tags = [{ id: 'b1', name: 'Bob' }, { id: 'b2', name: 'Bob' }]
    const refreshed = resolveUnavailableTagNames(initial.selected, initial.unavailable, tags)
    expect([...refreshed]).toEqual(['url-name:Missing', 'url-name:Bob'])
    expect(refreshed).not.toBe(initial.selected)
  })

  it('requires an exact name match during refresh', () => {
    const initial = resolveTagNames(['Alice'], [])
    expect([...resolveUnavailableTagNames(initial.selected, initial.unavailable, [{ id: 'a', name: 'alice' }])]).toEqual(['url-name:Alice'])
  })

  it('only resolves selected unavailable options created with the matching synthetic ID', () => {
    const previous = [
      { id: 'url-name:Alice', name: 'Alice' },
      { id: 'url-name:Bob', name: 'Robert', unavailable: true },
      { id: 'url-name:Carol', name: 'Carol', unavailable: true }
    ]
    const selected = new Set(['url-name:Alice', 'url-name:Bob', 'url-name:Missing'])
    const tags = [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Robert' }, { id: 'c', name: 'Carol' }, { id: 'm', name: 'Missing' }]
    expect([...resolveUnavailableTagNames(selected, previous, tags)]).toEqual([...selected])
  })

  it('does not redirect an ID once its URL name has resolved', () => {
    const initial = resolveTagNames(['Alice'], [])
    const resolved = resolveUnavailableTagNames(initial.selected, initial.unavailable, [{ id: 'a', name: 'Alice' }])
    const previous = [{ id: 'a', name: 'Alice' }]
    expect([...resolveUnavailableTagNames(resolved, previous, [{ id: 'other', name: 'Alice' }])]).toEqual(['a'])
  })
})

describe('selection names for copying', () => {
  it('uses option order rather than selection insertion order and includes unavailable names', () => {
    const options = [
      { id: 'a', name: 'Alice' },
      { id: 'b', name: 'Bob' },
      { id: 'url-name:Missing', name: 'Missing', unavailable: true }
    ]
    expect(selectedTagNames(new Set(['url-name:Missing', 'b', 'a']), options)).toEqual(['Alice', 'Bob', 'Missing'])
    expect(selectedTagNames(new Set(), options)).toEqual([])
  })

  it('deduplicates identical names while preserving exact case differences', () => {
    expect(selectedTagNames(new Set(['a', 'b', 'c']), [
      { id: 'a', name: 'Alice' }, { id: 'b', name: 'Alice' }, { id: 'c', name: 'alice' }
    ])).toEqual(['Alice', 'alice'])
  })

  it('fails rather than silently omitting a selected ID absent from the options', () => {
    expect(() => selectedTagNames(new Set(['a', 'lost']), [{ id: 'a', name: 'Alice' }])).toThrow('Selected tag has no option')
  })
})
