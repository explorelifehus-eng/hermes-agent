import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { $composerAttachments, $composerDraft, type ComposerAttachment } from '@/store/composer'
import { $gatewayState } from '@/store/session'
import { $sessionStates } from '@/store/session-states'

import { reloadOntoServedBundle, setBundleReloadForTests, startServedBundleWatch } from './webapp-bundle'

type BundleWindow = { __HERMES_WEBAPP_BUNDLE__?: string; hermesDesktop?: unknown }
const win = window as unknown as BundleWindow

const reload = vi.fn()
let served: { current: boolean; id: null | string } | Error = { current: true, id: 'new' }

const api = vi.fn(async () => {
  if (served instanceof Error) {
    throw served
  }

  return served
})

function bootOn(id: string | undefined, host: 'browser' | 'electron' = 'browser'): void {
  document.documentElement.dataset.hermesDesktopHost = host

  if (id === undefined) {
    delete win.__HERMES_WEBAPP_BUNDLE__
  } else {
    win.__HERMES_WEBAPP_BUNDLE__ = id
  }
}

const busy = (patch: Partial<ClientSessionState>) => ({
  s1: { busy: false, needsInput: false, ...patch } as ClientSessionState
})

beforeEach(() => {
  win.hermesDesktop = { api }
  setBundleReloadForTests(reload)
  served = { current: true, id: 'new' }
  bootOn('old')
})

afterEach(() => {
  reload.mockReset()
  api.mockClear()
  setBundleReloadForTests(null)
  sessionStorage.clear()
  $sessionStates.set({})
  $composerDraft.set('')
  $composerAttachments.set([])
  $gatewayState.set('idle')
  delete document.documentElement.dataset.hermesDesktopHost
  delete win.__HERMES_WEBAPP_BUNDLE__
  delete win.hermesDesktop
})

describe('reloadOntoServedBundle', () => {
  it('reloads an idle tab once its gateway serves a new, current bundle', async () => {
    await reloadOntoServedBundle()

    expect(api).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/webapp/bundle' }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('keeps a working tab when the served bundle is a stale one a rebuild could not replace', async () => {
    served = { current: false, id: 'new' }
    await reloadOntoServedBundle()

    expect(reload).not.toHaveBeenCalled()
  })

  it('does nothing while the tab already runs the served bundle, or no bundle is served', async () => {
    served = { current: true, id: 'old' }
    await reloadOntoServedBundle()
    served = { current: false, id: null }
    await reloadOntoServedBundle()
    served = new Error('gateway offline')
    await reloadOntoServedBundle()

    expect(reload).not.toHaveBeenCalled()
  })

  it('never reloads native Desktop or a page no server named a bundle for', async () => {
    bootOn('old', 'electron')
    await reloadOntoServedBundle()
    bootOn(undefined)
    await reloadOntoServedBundle()

    expect(api).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads at most once per served bundle, so a page that keeps booting the old one cannot loop', async () => {
    await reloadOntoServedBundle()
    // The reload landed on a page that still names the old bundle (a cached page in a proxy).
    await reloadOntoServedBundle()

    expect(reload).toHaveBeenCalledTimes(1)

    served = { current: true, id: 'newer' }
    await reloadOntoServedBundle()

    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('never reloads without storage for the loop guard', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('denied')
      }
    })

    try {
      await reloadOntoServedBundle()
    } finally {
      vi.unstubAllGlobals()
    }

    expect(reload).not.toHaveBeenCalled()
  })

  it.each([
    ['a running turn', () => $sessionStates.set(busy({ busy: true }))],
    ['a turn the backend reports live', () => $sessionStates.set(busy({ turnLive: true }))],
    ['a sent prompt awaiting its reply', () => $sessionStates.set(busy({ awaitingResponse: true }))],
    ['a prompt waiting on the user', () => $sessionStates.set(busy({ needsInput: true }))],
    ['unsent composer text', () => $composerDraft.set('half a thought')],
    ['an unsent attachment', () => $composerAttachments.set([{ id: 'a' } as ComposerAttachment])]
  ])('waits through %s and reloads once the tab is idle', async (_name, makeBusy) => {
    makeBusy()
    await reloadOntoServedBundle()

    expect(reload).not.toHaveBeenCalled()

    $sessionStates.set({})
    $composerDraft.set('')
    $composerAttachments.set([])
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })
})

describe('startServedBundleWatch', () => {
  it('asks on every gateway (re)connect and once a minute', async () => {
    vi.useFakeTimers()

    try {
      served = { current: true, id: 'old' }
      const stop = startServedBundleWatch()
      $gatewayState.set('open')
      expect(api).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(api).toHaveBeenCalledTimes(2)

      stop()
      await vi.advanceTimersByTimeAsync(60_000)
      $gatewayState.set('closed')
      $gatewayState.set('open')
      expect(api).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('watches nothing on native Desktop', () => {
    bootOn('old', 'electron')
    const stop = startServedBundleWatch()
    $gatewayState.set('open')
    stop()

    expect(api).not.toHaveBeenCalled()
  })
})
