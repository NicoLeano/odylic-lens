import { useEffect, useRef, useState } from 'react'

// Tiny purpose-built virtualization hook for the Ad Analysis card grid.
// Not a general-purpose replacement for react-window. just enough to
// render only the rows intersecting the viewport (plus a small buffer
// ahead/behind) so a 100+ ad list paints instantly.
//
// Shape:
//   {
//     hostRef:     ref you attach to the scrolling <div>
//     sentinelRef: ref you attach to a zero-height element INSIDE hostRef;
//                  used as the measurement anchor for IntersectionObserver
//     paddingTop / paddingBottom: apply to the grid wrapper so total height
//                  reflects un-rendered rows (prevents scroll collapse)
//     visibleStart / visibleEnd: [start, end) slice indices to render
//   }
//
// Strategy:
//   - Measure the current row height by sampling the first rendered card
//     via ResizeObserver. We re-measure whenever the grid layout mutates.
//   - Compute rowsPerRow from host width / card min width (derived from
//     the column count supplied by the caller. simpler than parsing
//     Tailwind grid classes).
//   - Listen to `scroll` on the nearest scroll ancestor (defaults to
//     window). Each scroll fires a cheap index recomputation via rAF.
//
// We intentionally keep this dependency-free so bundle size stays flat.

export type VirtualGrid = {
  hostRef: React.RefObject<HTMLDivElement | null>
  sentinelRef: React.RefObject<HTMLDivElement | null>
  visibleStart: number
  visibleEnd: number
  paddingTop: number
  paddingBottom: number
}

type Options = {
  total: number
  colsPerRow: number
  estimatedRowHeight: number
  overscanRows?: number
}

// Walk up until we find an element with a non-static overflow setting, else
// fall back to the document scrolling element.
function findScrollParent(el: HTMLElement | null): HTMLElement | Window {
  let node: HTMLElement | null = el?.parentElement || null
  while (node) {
    const style = window.getComputedStyle(node)
    const overflowY = style.overflowY
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
      return node
    }
    node = node.parentElement
  }
  return window
}

function scrollTopOf(scroller: HTMLElement | Window): number {
  if (scroller === window) {
    return window.scrollY || document.documentElement.scrollTop || 0
  }
  return (scroller as HTMLElement).scrollTop
}

function viewportHeightOf(scroller: HTMLElement | Window): number {
  if (scroller === window) {
    return window.innerHeight
  }
  return (scroller as HTMLElement).clientHeight
}

export function useVirtualGrid({
  total,
  colsPerRow,
  estimatedRowHeight,
  overscanRows = 2,
}: Options): VirtualGrid {
  const hostRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [rowHeight, setRowHeight] = useState(estimatedRowHeight)
  const [visibleStart, setVisibleStart] = useState(0)
  const [visibleEnd, setVisibleEnd] = useState(Math.min(total, colsPerRow * 6))
  const rowHeightRef = useRef(rowHeight)
  const colsRef = useRef(colsPerRow)
  const totalRef = useRef(total)
  rowHeightRef.current = rowHeight
  colsRef.current = colsPerRow
  totalRef.current = total

  // Recompute the visible window. Pulled out of the scroll handler so we
  // can also invoke on resize / row-height changes without re-binding.
  const recompute = () => {
    const host = hostRef.current
    if (!host) return
    const scroller = findScrollParent(host)
    const scrollTop = scrollTopOf(scroller)
    const vh = viewportHeightOf(scroller)
    const hostRect = host.getBoundingClientRect()
    // Offset of the grid top from the scroller's scroll origin. For window
    // scroll, rect.top is viewport-relative so we add scrollY; for an
    // inner scroller we use offsetTop relative to the scroller.
    let hostOffsetTop: number
    if (scroller === window) {
      hostOffsetTop = hostRect.top + scrollTop
    } else {
      const scrollerRect = (scroller as HTMLElement).getBoundingClientRect()
      hostOffsetTop = hostRect.top - scrollerRect.top + scrollTop
    }

    const pxAboveViewport = Math.max(0, scrollTop - hostOffsetTop)
    const pxVisible = vh + Math.max(0, hostOffsetTop - scrollTop)

    const rh = Math.max(1, rowHeightRef.current)
    const cols = Math.max(1, colsRef.current)
    const firstRow = Math.max(0, Math.floor(pxAboveViewport / rh) - overscanRows)
    const rowsInView = Math.ceil(pxVisible / rh) + overscanRows * 2
    const lastRow = firstRow + rowsInView

    const start = Math.max(0, firstRow * cols)
    const end = Math.min(totalRef.current, lastRow * cols)
    setVisibleStart(start)
    setVisibleEnd(end)
  }

  // Scroll + resize listeners. rAF-throttled so a flick doesn't blast
  // React with setState calls; one update per frame is plenty.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const scroller = findScrollParent(host)

    let rafId = 0
    const onChange = () => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        recompute()
      })
    }

    recompute()
    scroller.addEventListener('scroll', onChange, { passive: true })
    window.addEventListener('resize', onChange)
    return () => {
      scroller.removeEventListener('scroll', onChange as EventListener)
      window.removeEventListener('resize', onChange)
      if (rafId) cancelAnimationFrame(rafId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-run the visible-window math when inputs shift (new data, resized
  // grid columns). Cheap. doesn't touch the DOM.
  useEffect(() => {
    recompute()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total, colsPerRow, rowHeight])

  // Measure row height from the first rendered card. If the grid hasn't
  // painted yet (empty slice) we fall back to the estimate.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const ro = new ResizeObserver(() => {
      const firstCard = host.querySelector<HTMLElement>('[data-vcard]')
      if (!firstCard) return
      const h = firstCard.getBoundingClientRect().height
      if (h > 0 && Math.abs(h - rowHeightRef.current) > 2) {
        setRowHeight(h + 8 /* gap-2 */)
      }
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  const totalRows = Math.ceil(total / Math.max(1, colsPerRow))
  const firstVisibleRow = Math.floor(visibleStart / Math.max(1, colsPerRow))
  const lastVisibleRow = Math.ceil(visibleEnd / Math.max(1, colsPerRow))
  const paddingTop = firstVisibleRow * rowHeight
  const paddingBottom = Math.max(0, (totalRows - lastVisibleRow) * rowHeight)

  return {
    hostRef,
    sentinelRef,
    visibleStart,
    visibleEnd,
    paddingTop,
    paddingBottom,
  }
}

// Ballpark card heights at each zoom level. The measurement pass refines
// these live. these values just prevent an ugly first-frame jump when the
// hook mounts before the ResizeObserver has a reading.
export const ZOOM_ROW_HEIGHT_GUESS: Record<number, number> = {
  1: 180,
  2: 220,
  3: 260,
  4: 320,
  5: 400,
}

// Tailwind grid class → max cols-per-row at 2xl breakpoint. Used by the
// virtualization math to figure out how many cards fit on one row without
// measuring every card. If the breakpoint we're at renders fewer cols, the
// recompute loop sees the smaller rendered-row-height and re-measures.
export const ZOOM_COLS_AT_XL: Record<number, number> = {
  1: 10,
  2: 8,
  3: 7,
  4: 6,
  5: 5,
}
