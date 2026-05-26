// 6 Vitest tests for AnalyzeView (Task 2.11 / decision 10A).
// Coverage: empty CTA / fetch on click / recipe card render /
// 401-Re-auth flow / regenerate bypass / non-401 error banner.

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { AnalyzeView } from './AnalyzeView'

const RECIPE = {
  recipe_id: 'r1',
  angle: 'Benefits',
  persona: '45+ MX women',
  funnel_position: 'mid',
  hook: '¿Dormir mejor sin pastillas?',
  copy_outline: '...',
  visual_direction: '...',
  product: 'Calm Cacao',
  format: 'image',
  fal_model_hint: 'flux/dev',
  rationale: 'Sleep angle proven by winner 120211.',
  source_winner_ids: ['120211'],
}

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  // window.fetch lives on globalThis under happy-dom.
  vi.stubGlobal('fetch', vi.fn(impl))
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('AnalyzeView', () => {
  test('shows Generate CTA when no recipes loaded yet', () => {
    render(<AnalyzeView brand="DOSE OF" />)
    expect(
      screen.getByRole('button', { name: /generate recipes/i }),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('recipe-card')).not.toBeInTheDocument()
  })

  test('click Generate posts to /api/recipes/analyze with brand body', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    mockFetch(async () => okResponse({ recipes: [RECIPE] }))

    render(<AnalyzeView brand="DOSE OF" />)
    await user.click(screen.getByRole('button', { name: /generate recipes/i }))

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1)
    })
    const [url, init] = (fetch as any).mock.calls[0]
    expect(url).toBe('/api/recipes/analyze')
    expect(init.method).toBe('POST')
    const sent = JSON.parse(init.body)
    expect(sent.brand).toBe('DOSE OF')
    expect(sent.include_video_frames).toBe(false)
    expect(sent.regenerate).toBe(false)
  })

  test('renders one recipe card per result after fetch resolves', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    mockFetch(async () =>
      okResponse({
        recipes: [RECIPE, { ...RECIPE, recipe_id: 'r2', hook: 'Cacao caliente, mente quieta' }],
      }),
    )

    render(<AnalyzeView brand="DOSE OF" />)
    await user.click(screen.getByRole('button', { name: /generate recipes/i }))

    await waitFor(() => {
      expect(screen.getAllByTestId('recipe-card')).toHaveLength(2)
    })
    expect(screen.getByText(/¿Dormir mejor sin pastillas\?/)).toBeInTheDocument()
    expect(screen.getByText(/Cacao caliente, mente quieta/)).toBeInTheDocument()
  })

  test('Open in Create action surfaces persisted draft id', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onSendToCreate = vi.fn()
    mockFetch(async () => okResponse({ recipes: [{ ...RECIPE, draft_id: 'draft-1' }] }))

    render(<AnalyzeView brand="DOSE OF" onSendToCreate={onSendToCreate} />)
    await user.click(screen.getByRole('button', { name: /generate recipes/i }))
    await user.click(await screen.findByRole('button', { name: /open .* in create/i }))

    expect(onSendToCreate).toHaveBeenCalledWith('draft-1')
  })

  test('401 ClaudeAuthExpired renders the Re-authenticate card with copy command', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    mockFetch(async () =>
      errorResponse(401, { detail: { error: 'claude_auth_expired', message: 'Session expired' } }),
    )

    render(<AnalyzeView brand="DOSE OF" />)
    await user.click(screen.getByRole('button', { name: /generate recipes/i }))

    await waitFor(() => {
      expect(screen.getByText(/claude session expired/i)).toBeInTheDocument()
    })
    expect(
      screen.getByRole('button', { name: /copy claude auth login command/i }),
    ).toBeInTheDocument()
  })

  test('Regenerate button reposts with regenerate=true', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    mockFetch(async () => okResponse({ recipes: [RECIPE] }))

    render(<AnalyzeView brand="DOSE OF" />)
    await user.click(screen.getByRole('button', { name: /generate recipes/i }))

    await waitFor(() => {
      expect(screen.getAllByTestId('recipe-card')).toHaveLength(1)
    })

    await user.click(screen.getByRole('button', { name: /regenerate recipes/i }))

    await waitFor(() => {
      expect((fetch as any).mock.calls.length).toBe(2)
    })
    const secondBody = JSON.parse((fetch as any).mock.calls[1][1].body)
    expect(secondBody.regenerate).toBe(true)
  })

  test('non-401 failure surfaces error banner, no Re-auth card', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    mockFetch(async () =>
      errorResponse(500, { detail: 'claude CLI exit 2: rate limited' }),
    )

    render(<AnalyzeView brand="DOSE OF" />)
    await user.click(screen.getByRole('button', { name: /generate recipes/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/rate limited/i)
    expect(screen.queryByText(/claude session expired/i)).not.toBeInTheDocument()
  })
})
