import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { state } from '../src/client/state'
import { resetGalleryLayout } from '../src/client/virtualisation'

vi.mock('../src/client/tiles', () => ({ createTile: () => null }))

describe('filtering at an unchanged gallery width', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { innerHeight: 800 })
    state.container = {
      clientWidth: 900,
      style: {},
      getBoundingClientRect: () => ({ top: 0 }),
      appendChild: vi.fn()
    } as unknown as HTMLElement
    state.groupByDate = false
    state.lastContainerW = 900
    state.layout = [{ index: 0, left: 0, top: 0, width: 900, height: 500 }]
    state.items = [{ id: 'new-item', type: 'IMAGE', previewUrl: '', thumbnailUrl: '', downloadFilename: '', width: 1000, height: 1000 }]
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    state.container = null
    state.items = []
    state.layout = []
    state.headers = []
    state.lastContainerW = 0
    state.renderedTiles.clear()
    state.renderedHeaders.clear()
    state.stickyTiles.clear()
  })

  it('discards stale index-based tiles and recomputes geometry for the filtered items', () => {
    const removeTile = vi.fn()
    const removeHeader = vi.fn()
    state.renderedTiles.set(0, { remove: removeTile } as unknown as HTMLAnchorElement)
    state.renderedHeaders.set('old', { remove: removeHeader } as unknown as HTMLElement)
    state.stickyTiles.add(42)
    resetGalleryLayout()
    expect(removeTile).toHaveBeenCalledOnce()
    expect(removeHeader).toHaveBeenCalledOnce()
    expect(state.stickyTiles.size).toBe(0)
    expect(state.layout).toEqual([{ index: 0, left: 0, top: 0, width: 235, height: 235 }])
    expect(state.container!.style.height).toBe('235px')
  })

  it('clears the gallery height and layout when no items match', () => {
    state.items = []
    resetGalleryLayout()
    expect(state.layout).toEqual([])
    expect(state.headers).toEqual([])
    expect(state.container!.style.height).toBe('0px')
  })
})
