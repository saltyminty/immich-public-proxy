import { state } from './state.js'
import { parseTagNames, resolveTagNames, resolveUnavailableTagNames, selectedTagNames, withTagNames } from './tag-url.js'
import { downloadAssets, exitSelectMode } from './selection.js'
import { resetGalleryLayout } from './virtualisation.js'
import { indexTagManifest, matchAllTags, reconcileTagOptions, sameGalleryItems, type TagIndex, type TagOption } from './tag-index.js'

const POLL_INTERVAL_MS = 2000
const POLL_WINDOW_MS = 120000

export function setupTagFilter (url: string | undefined, initialNames: string[], onInitialReady?: () => void) {
  const root = document.getElementById('tag-filter')
  const toggle = document.getElementById('tag-filter-toggle') as HTMLButtonElement
  const panel = document.getElementById('tag-filter-panel')
  const options = document.getElementById('tag-filter-options')
  const clear = document.getElementById('tag-filter-clear') as HTMLButtonElement
  const status = document.getElementById('tag-filter-status')
  const retry = document.getElementById('tag-filter-retry') as HTMLButtonElement
  const empty = document.getElementById('tag-filter-empty')
  const downloadAll = document.getElementById('download-all')
  const downloadMatching = document.getElementById('download-matching') as HTMLButtonElement | null
  if (!root || !toggle || !panel || !options || !clear || !status || !retry || !empty) return

  const initialSelection = resolveTagNames(initialNames, [])
  const selected = initialSelection.selected
  const optionElements = new Map<string, { label: HTMLLabelElement, checkbox: HTMLInputElement, name: HTMLSpanElement }>()
  let tagOptions: TagOption[] = initialSelection.unavailable
  let requestedNames: string[] | undefined = initialNames
  let displayedUrlNames = initialNames
  let initialCompleted = false
  let index: TagIndex | undefined
  let pendingIndex: TagIndex | undefined
  let loading = false
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let pollDeadline = 0
  let notice = ''

  function setOpen (open: boolean) {
    panel!.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
  }

  function showStatus () {
    const count = index
      ? selected.size
        ? state.items.length + ' of ' + state.allItems.length + ' items match'
        : index.tags.length ? state.allItems.length + ' items' : 'No tags in this album.'
      : ''
    status!.textContent = [count, notice].filter(Boolean).join(' · ')
  }

  function syncUrl () {
    const names = selectedTagNames(selected, tagOptions)
    const next = withTagNames(window.location.href, names)
    if (next !== window.location.href) history.replaceState(history.state, '', next)
    displayedUrlNames = names
  }

  function resolveSelection (names: string[]) {
    const resolved = resolveTagNames(names, index?.tags || [])
    selected.clear()
    resolved.selected.forEach(id => selected.add(id))
    tagOptions = resolved.unavailable
  }

  function updateResults (userChange = false) {
    const matching = index ? matchAllTags(state.allItems, selected, index) : selected.size ? [] : state.allItems
    const changed = !sameGalleryItems(matching, state.items)
    if (changed || userChange) exitSelectMode()
    if (changed) state.items = matching
    const active = selected.size > 0
    clear.disabled = !active
    toggle.textContent = active ? 'Filter by tags (' + selected.size + ')' : 'Filter by tags'
    showStatus()
    empty!.hidden = !index || state.items.length > 0 || !active
    if (downloadAll && downloadMatching) {
      downloadAll.hidden = active
      downloadMatching.hidden = !active
      downloadMatching.disabled = !index || state.items.length === 0
      downloadMatching.textContent = 'Download matching (' + state.items.length + ')'
    }
    if (changed) resetGalleryLayout()
  }

  function renderOptions () {
    if (!index) return
    tagOptions = reconcileTagOptions(index.tags, tagOptions, selected)
    const active = document.activeElement
    const focusedId = active instanceof HTMLInputElement && options!.contains(active) ? active.value : undefined
    const retained = new Set(tagOptions.map(tag => tag.id))
    for (const [id, entry] of optionElements) {
      if (!retained.has(id)) {
        entry.label.remove()
        optionElements.delete(id)
      }
    }
    tagOptions.forEach((tag, position) => {
      let entry = optionElements.get(tag.id)
      if (!entry) {
        const label = document.createElement('label')
        const checkbox = document.createElement('input')
        const name = document.createElement('span')
        checkbox.type = 'checkbox'
        checkbox.value = tag.id
        checkbox.addEventListener('change', () => {
          if (!index) return
          if (checkbox.checked) selected.add(tag.id)
          else selected.delete(tag.id)
          initialCompleted = true
          renderOptions()
          updateResults(true)
          syncUrl()
        })
        label.append(checkbox, name)
        entry = { label, checkbox, name }
        optionElements.set(tag.id, entry)
      }
      entry.checkbox.checked = selected.has(tag.id)
      entry.name.textContent = tag.name + (tag.unavailable ? ' (no longer available)' : '')
      const atPosition = options!.children[position + 1]
      if (atPosition !== entry.label) options!.insertBefore(entry.label, atPosition || null)
    })
    toggle.disabled = tagOptions.length === 0
    if (focusedId) (optionElements.get(focusedId)?.checkbox || toggle).focus({ preventScroll: true })
  }

  function applyIndex (next: TagIndex) {
    index = next
    if (requestedNames !== undefined) {
      resolveSelection(requestedNames)
      requestedNames = undefined
    } else {
      const resolved = resolveUnavailableTagNames(selected, tagOptions, index.tags)
      selected.clear()
      resolved.forEach(id => selected.add(id))
    }
    renderOptions()
    updateResults()
    syncUrl()
    if (!initialCompleted) {
      initialCompleted = true
      onInitialReady?.()
    }
  }

  function applyRequestedNames () {
    if (requestedNames === undefined) return
    if (index) applyIndex(index)
    else {
      resolveSelection(requestedNames)
      updateResults()
      syncUrl()
    }
  }

  state.lightbox?.on('destroy', () => {
    // PhotoSwipe clears its active instance after its destroy listeners run.
    queueMicrotask(() => {
      if (pendingIndex) {
        const next = pendingIndex
        pendingIndex = undefined
        applyIndex(next)
      } else applyRequestedNames()
    })
  })

  window.addEventListener('popstate', () => {
    const names = parseTagNames(window.location.search)
    if (names.length === displayedUrlNames.length && names.every(name => displayedUrlNames.includes(name))) return
    requestedNames = names
    displayedUrlNames = names
    initialCompleted = true
    if (!state.lightbox?.pswp && !state.lightbox?.shouldOpen) applyRequestedNames()
  })

  function stopPolling () {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = undefined
    pollDeadline = 0
  }

  function clearTagAccess () {
    stopPolling()
    index = undefined
    pendingIndex = undefined
    setOpen(false)
    for (const entry of optionElements.values()) entry.label.remove()
    optionElements.clear()
    toggle.disabled = true
    clear.disabled = selected.size === 0
    if (downloadMatching) downloadMatching.disabled = true
    notice = selected.size ? 'Selected tags are unavailable. Retry or clear filters.' : 'Tags are unavailable. Retry or reload this page.'
    retry.hidden = false
    showStatus()
  }

  function pollAgain () {
    if (!pollDeadline) pollDeadline = Date.now() + POLL_WINDOW_MS
    if (Date.now() + POLL_INTERVAL_MS >= pollDeadline) {
      stopPolling()
      notice = 'Showing saved tags. Try again later.'
      retry.hidden = false
      showStatus()
      return
    }
    pollTimer = setTimeout(() => {
      pollTimer = undefined
      loadTags()
    }, POLL_INTERVAL_MS)
  }

  async function loadTags () {
    if (loading || !url) return
    loading = true
    retry.disabled = true
    retry.hidden = true
    if (!index) toggle.disabled = true
    notice = index ? 'Updating tags…' : selected.size ? 'Loading selected tags…' : 'Loading tags… You can keep browsing.'
    showStatus()
    try {
      const timeout = pollDeadline ? Math.max(1, pollDeadline - Date.now()) : 110000
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeout) })
      if (!response.ok) {
        clearTagAccess()
        return
      }
      let next: TagIndex
      try {
        next = indexTagManifest(await response.json(), state.allItems)
      } catch (_) {
        clearTagAccess()
        return
      }
      notice = next.refreshState === 'refreshing'
        ? 'Updating tags…'
        : next.refreshState === 'failed' ? 'Showing saved tags. Try again later.' : ''
      if (state.lightbox?.pswp || state.lightbox?.shouldOpen) {
        pendingIndex = next
        showStatus()
      } else {
        pendingIndex = undefined
        applyIndex(next)
      }
      if (next.refreshState === 'refreshing') pollAgain()
      else {
        stopPolling()
        retry.hidden = next.refreshState !== 'failed'
      }
    } catch (_) {
      stopPolling()
      notice = index || pendingIndex
        ? 'Showing saved tags. Try again later.'
        : selected.size ? 'Selected tags could not be loaded. Retry or clear filters.' : 'Tags could not be loaded. Retry or reload this page.'
      retry.hidden = false
      showStatus()
    } finally {
      loading = false
      retry.disabled = false
    }
  }

  toggle.addEventListener('click', () => setOpen(panel.hidden))
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) {
      setOpen(false)
      toggle.focus()
      event.preventDefault()
    }
  })
  document.addEventListener('click', event => {
    if (!root.contains(event.target as Node)) setOpen(false)
  })
  root.addEventListener('focusout', event => {
    if (event.relatedTarget && !root.contains(event.relatedTarget as Node)) setOpen(false)
  })
  clear.addEventListener('click', () => {
    initialCompleted = true
    requestedNames = index ? undefined : []
    selected.clear()
    renderOptions()
    updateResults(true)
    syncUrl()
    if (!index) {
      notice = !url ? 'Tags are unavailable for this shared link.' : loading ? 'Loading tags… You can keep browsing.' : 'Tags are unavailable. Retry or reload this page.'
      showStatus()
    }
  })
  downloadMatching?.addEventListener('click', () => {
    if (index && selected.size) downloadAssets(state.items.map(item => item.id))
  })
  retry.addEventListener('click', () => {
    stopPolling()
    loadTags()
  })
  updateResults()
  if (url) loadTags()
  else {
    notice = selected.size ? 'Tags are unavailable for this shared link. Clear filters to view all items.' : 'Tags are unavailable for this shared link.'
    retry.hidden = true
    showStatus()
  }
}
