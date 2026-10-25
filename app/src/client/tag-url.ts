import type { TagIndex, TagOption } from './tag-index.js'

export function parseTagNames (search: string): string[] {
  const names = new Set<string>()
  for (const parameter of search.replace(/^\?/, '').split('&')) {
    const separator = parameter.indexOf('=')
    const key = separator < 0 ? parameter : parameter.slice(0, separator)
    if (new URLSearchParams(`key=${key}`).get('key') !== 'tags') continue
    const value = separator < 0 ? '' : parameter.slice(separator + 1)
    // Split before decoding so an encoded comma remains part of a tag name.
    for (const part of value.split(',')) {
      const name = new URLSearchParams(`value=${part}`).get('value')!
      if (name) names.add(name)
    }
  }
  return [...names]
}

export function withTagNames (href: string, names: string[]): string {
  const url = new URL(href)
  url.searchParams.delete('tags')
  for (const name of new Set(names)) {
    if (name) url.searchParams.append('tags', name)
  }
  return url.href
}

export function resolveTagNames (names: string[], tags: TagIndex['tags']): { selected: Set<string>, unavailable: TagOption[] } {
  const selected = new Set<string>()
  const unavailable: TagOption[] = []
  for (const name of new Set(names)) {
    if (!name) continue
    const matches = tags.filter(tag => tag.name === name)
    if (matches.length === 1) {
      selected.add(matches[0].id)
    } else {
      const id = `url-name:${name}`
      selected.add(id)
      unavailable.push({ id, name, unavailable: true })
    }
  }
  return { selected, unavailable }
}

export function resolveUnavailableTagNames (selected: Set<string>, previous: TagOption[], tags: TagIndex['tags']): Set<string> {
  return new Set([...selected].map(id => {
    const option = previous.find(option => option.id === id)
    if (!option?.unavailable || id !== `url-name:${option.name}`) return id
    const matches = tags.filter(tag => tag.name === option.name)
    return matches.length === 1 ? matches[0].id : id
  }))
}

export function selectedTagNames (selected: Set<string>, options: TagOption[]): string[] {
  const available = new Set(options.map(option => option.id))
  if ([...selected].some(id => !available.has(id))) throw new Error('Selected tag has no option')
  return [...new Set(options.filter(option => selected.has(option.id)).map(option => option.name))]
}
