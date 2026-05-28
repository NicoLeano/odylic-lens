import { useEffect, useState } from 'react'
import { Ban, X } from 'lucide-react'

const DEFAULT_REASON = 'Not differentiated enough.'

export function RejectRecipeDialog({
  hook,
  busy = false,
  onCancel,
  onConfirm,
}: {
  hook: string
  busy?: boolean
  onCancel: () => void
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState(DEFAULT_REASON)

  useEffect(() => {
    setReason(DEFAULT_REASON)
  }, [hook])

  function submit() {
    onConfirm(reason.trim() || DEFAULT_REASON)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reject-recipe-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 px-4"
    >
      <section className="glass rounded-lg w-full max-w-sm p-4 flex flex-col gap-3 shadow-xl border border-white/35">
        <header className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="h-8 w-8 rounded-full bg-red-50 text-red-600 inline-flex items-center justify-center flex-shrink-0">
              <Ban size={14} />
            </span>
            <div className="min-w-0">
              <h3 id="reject-recipe-title" className="text-sm font-medium text-text-primary">
                Reject recipe
              </h3>
              <p className="text-xs text-text-muted truncate">{hook}</p>
            </div>
          </div>
          <button
            onClick={onCancel}
            disabled={busy}
            className="h-10 w-10 rounded-full inline-flex items-center justify-center glass glass-hover text-text-muted hover:text-text-primary disabled:opacity-50"
            aria-label="Close rejection dialog"
          >
            <X size={14} />
          </button>
        </header>
        <label className="text-xs text-text-secondary flex flex-col gap-1.5">
          Rejection reason
          <textarea
            value={reason}
            onChange={event => setReason(event.target.value)}
            rows={3}
            disabled={busy}
            className="w-full rounded-lg border border-black/10 bg-white/70 px-3 py-2 text-sm text-text-primary outline-none focus:border-text-primary/40 disabled:opacity-50 resize-none"
          />
        </label>
        <footer className="flex justify-end gap-2 pt-1">
          <button
            onClick={onCancel}
            disabled={busy}
            className="min-h-10 px-3 rounded-full text-xs glass glass-hover disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="min-h-10 px-3 rounded-full text-xs bg-text-primary text-white inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            <Ban size={12} />
            Reject
          </button>
        </footer>
      </section>
    </div>
  )
}
