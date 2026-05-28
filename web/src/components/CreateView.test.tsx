import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { CreateView } from './CreateView'
import type { Draft } from '../types/creative'

const BASE_RECIPE = {
  recipe_id: 'recipe-1',
  draft_id: 'draft-1',
  angle: 'Benefits',
  persona: '45+ MX women',
  funnel_position: 'mid',
  hook: 'Dormir mejor sin pastillas',
  copy_outline: 'Problem, ritual, proof, CTA',
  visual_direction: 'Warm kitchen counter with cacao pouch visible',
  product: 'Calm Cacao',
  format: 'image',
  fal_model_hint: 'flux/dev',
  rationale: 'Sleep angle proven by winner 120211.',
  source_winner_ids: ['120211'],
}

const PROPOSED_DRAFT: Draft = {
  draft_id: 'draft-1',
  recipe_id: 'recipe-1',
  brand: 'DOSE OF',
  status: 'proposed',
  recipe: BASE_RECIPE,
  source_winner_ids: ['120211'],
  meta_ad_id: null,
  created_at: 100,
  updated_at: 100,
  assets: [],
}

const READY_DRAFT: Draft = { ...PROPOSED_DRAFT, status: 'ready', updated_at: 101 }

const ASSET_DRAFT: Draft = {
  ...PROPOSED_DRAFT,
  status: 'draft',
  updated_at: 102,
  assets: [
    {
      asset_id: 'asset-1',
      draft_id: 'draft-1',
      variant_idx: 0,
      mime_type: 'video/mp4',
      fal_model_used: 'fal-ai/kling-video/v1.6/standard/text-to-video',
      cost_usd: 0.31,
      created_at: 102,
      filename: 'variant-1.mp4',
      url: '/api/draft-assets/asset-1/file',
    },
  ],
}

const IMAGE_ASSET_DRAFT: Draft = {
  ...PROPOSED_DRAFT,
  status: 'draft',
  updated_at: 103,
  assets: [
    {
      asset_id: 'asset-image-1',
      draft_id: 'draft-1',
      variant_idx: 0,
      mime_type: 'image/png',
      fal_model_used: 'fal-ai/flux/dev',
      cost_usd: 0.04,
      created_at: 103,
      filename: 'variant-1.png',
      url: '/api/draft-assets/asset-image-1/file',
    },
  ],
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    return impl(String(input), init)
  }))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('CreateView', () => {
  test('renders pending recipes and draft gallery for the selected brand', async () => {
    mockFetch(async url => {
      if (url.startsWith('/api/drafts?')) {
        return okResponse({ drafts: [PROPOSED_DRAFT, ASSET_DRAFT] })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<CreateView brand="DOSE OF" />)

    await waitFor(() => {
      expect(screen.getAllByText(/Dormir mejor sin pastillas/).length).toBeGreaterThan(0)
    })
    expect(screen.getByText(/1 pending/i)).toBeInTheDocument()
    expect(screen.getByText(/1 draft assets/i)).toBeInTheDocument()
    expect(screen.getByTestId('draft-card')).toBeInTheDocument()
  })

  test('copy prompt prepares the draft and writes to clipboard', async () => {
    mockFetch(async (url, init) => {
      if (url.startsWith('/api/drafts?')) return okResponse({ drafts: [PROPOSED_DRAFT] })
      if (url === '/api/drafts/draft-1/prepare' && init?.method === 'POST') {
        return okResponse({ prompt: 'ChatGPT prompt body', draft: READY_DRAFT })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const user = userEvent.setup()
    render(<CreateView brand="DOSE OF" />)

    await user.click(await screen.findByRole('button', { name: /copy chatgpt prompt/i }))

    await waitFor(async () => {
      await expect(navigator.clipboard.readText()).resolves.toBe('ChatGPT prompt body')
    })
    expect(screen.getByRole('status')).toHaveTextContent(/prompt copied/i)
    expect(screen.getByRole('button', { name: /copy chatgpt prompt/i })).toHaveTextContent(/copied/i)
    expect(fetch).toHaveBeenCalledWith('/api/drafts/draft-1/prepare', expect.objectContaining({ method: 'POST' }))
  })

  test('upload saves a manual ChatGPT asset into the gallery', async () => {
    mockFetch(async (url, init) => {
      if (url.startsWith('/api/drafts?')) return okResponse({ drafts: [PROPOSED_DRAFT] })
      if (url === '/api/drafts/draft-1/upload' && init?.method === 'POST') {
        expect(init.body).toBeInstanceOf(FormData)
        return okResponse({ draft: ASSET_DRAFT })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const user = userEvent.setup()
    const { container } = render(<CreateView brand="DOSE OF" />)
    await screen.findByText(/Dormir mejor sin pastillas/)

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(fileInput, new File(['image'], 'creative.png', { type: 'image/png' }))

    await waitFor(() => {
      expect(screen.getByTestId('draft-card')).toBeInTheDocument()
    })
    expect(screen.getByText(/kling-video/)).toBeInTheDocument()
  })

  test('generate video posts to fal route and renders the returned asset', async () => {
    mockFetch(async (url, init) => {
      if (url.startsWith('/api/drafts?')) return okResponse({ drafts: [PROPOSED_DRAFT] })
      if (url === '/api/drafts/draft-1/generate-video' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ variant_count: 1 })
        return okResponse({ draft: ASSET_DRAFT })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const user = userEvent.setup()
    render(<CreateView brand="DOSE OF" />)

    await user.click(await screen.findByRole('button', { name: /generate fal\.ai video/i }))

    await waitFor(() => {
      expect(screen.getByTestId('draft-card')).toBeInTheDocument()
    })
    expect(screen.getByText('$0.31')).toBeInTheDocument()
  })

  test('generate image posts to fal route and renders the returned static asset', async () => {
    mockFetch(async (url, init) => {
      if (url.startsWith('/api/drafts?')) return okResponse({ drafts: [PROPOSED_DRAFT] })
      if (url === '/api/drafts/draft-1/generate-image' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ variant_count: 1 })
        return okResponse({ draft: IMAGE_ASSET_DRAFT })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const user = userEvent.setup()
    render(<CreateView brand="DOSE OF" />)

    await user.click(await screen.findByRole('button', { name: /generate static image/i }))

    await waitFor(() => {
      expect(screen.getByTestId('draft-card')).toBeInTheDocument()
    })
    expect(screen.getByText(/flux\/dev/)).toBeInTheDocument()
    expect(screen.getByText('$0.04')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/static image ready/i)
  })

  test('discard hides a gallery draft from the active view', async () => {
    mockFetch(async (url, init) => {
      if (url.startsWith('/api/drafts?')) return okResponse({ drafts: [ASSET_DRAFT] })
      if (url === '/api/drafts/draft-1' && init?.method === 'PATCH') {
        expect(JSON.parse(String(init.body))).toEqual({ status: 'discarded' })
        return okResponse({ draft: { ...ASSET_DRAFT, status: 'discarded' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const user = userEvent.setup()
    render(<CreateView brand="DOSE OF" />)
    await screen.findByTestId('draft-card')

    await user.click(screen.getByRole('button', { name: /discard dormir mejor/i }))

    await waitFor(() => {
      expect(screen.queryByTestId('draft-card')).not.toBeInTheDocument()
    })
  })

  test('reject hides a pending recipe and sends feedback reason', async () => {
    mockFetch(async (url, init) => {
      if (url.startsWith('/api/drafts?')) return okResponse({ drafts: [PROPOSED_DRAFT] })
      if (url === '/api/drafts/draft-1' && init?.method === 'PATCH') {
        expect(JSON.parse(String(init.body))).toEqual({
          status: 'discarded',
          rejection_reason: 'Too close to the cacao ritual.',
        })
        return okResponse({
          draft: {
            ...PROPOSED_DRAFT,
            status: 'discarded',
            rejection_reason: 'Too close to the cacao ritual.',
            rejected_at: 200,
          },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const user = userEvent.setup()
    render(<CreateView brand="DOSE OF" />)

    await user.click(await screen.findByRole('button', { name: /reject dormir mejor/i }))
    const dialog = await screen.findByRole('dialog')
    const reason = within(dialog).getByLabelText(/rejection reason/i)
    await user.clear(reason)
    await user.type(reason, 'Too close to the cacao ritual.')
    await user.click(within(dialog).getByRole('button', { name: /^reject$/i }))

    await waitFor(() => {
      expect(screen.queryByTestId('recipe-card')).not.toBeInTheDocument()
    })
    expect(screen.getByRole('status')).toHaveTextContent(/future analyze runs/i)
  })
})
