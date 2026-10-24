import { describe, it, expect } from 'vitest'
import { sourceOffer } from '../src/version'

const revision = '0123456789abcdef0123456789abcdef01234567'
const repository = 'https://github.com/saltyminty/immich-public-proxy'

describe('public source revision', () => {
  it('links the exact full commit at the fixed public fork', () => {
    expect(sourceOffer(revision, true)).toEqual({ url: repository + '/tree/' + revision, exactRevision: true })
  })

  it('normalises hexadecimal case without changing the commit', () => {
    expect(sourceOffer(revision.toUpperCase(), true).url).toBe(repository + '/tree/' + revision)
  })

  it('allows local development without claiming a matching source revision', () => {
    expect(sourceOffer(undefined, false)).toEqual({ url: repository, exactRevision: false })
    expect(sourceOffer('', false)).toEqual({ url: repository, exactRevision: false })
  })

  it.each([undefined, ''])('requires a source revision in production: %s', value => {
    expect(() => sourceOffer(value, true)).toThrow('SOURCE_REVISION')
  })

  it.each([
    revision.slice(0, 7),
    revision + '0',
    revision + '\n',
    ' ' + revision,
    'g'.repeat(40),
    '../main',
    'https://example.com/source',
    'javascript:alert(1)'
  ])('rejects invalid revision input in every mode: %j', value => {
    expect(() => sourceOffer(value, true)).toThrow('SOURCE_REVISION')
    expect(() => sourceOffer(value, false)).toThrow('SOURCE_REVISION')
  })
})
