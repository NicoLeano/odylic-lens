/**
 * Tiny fetch wrapper that always sends cookies (for our session cookie)
 * and surfaces backend errors as throw-able Error objects with .status.
 */

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    ...init,
  });
  let body: unknown = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      (body && typeof body === "object" && "detail" in (body as any) && (body as any).detail) ||
      (body && typeof body === "object" && "message" in (body as any) && (body as any).message) ||
      res.statusText;
    throw new ApiError(res.status, String(msg), body);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
};

// ---------- typed endpoints ----------

export interface AuthStatus {
  app_configured: boolean;
  logged_in: boolean;
  meta_api_version: string;
  app_id_preview?: string | null;
  redirect_uri?: string;
  config_source?: "env" | "file" | "unset";
}

export interface CredentialCheck {
  ok: boolean;
  error?: string;
  code?: number;
  type?: string;
  hint?: string;
  redirect_uri?: string;
  note?: string;
}

export interface Me {
  fb_user_id: string;
  connection: { expires_at: number | null; granted_scopes: string | null; updated_at: number } | null;
  days_remaining: number | null;
  warn_expiring_soon: boolean;
}

export interface AdAccount {
  account_id: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  business_id: string | null;
  business_name: string | null;
  status: number | null;
  friendly_name: string | null;
  hidden: number | null;
}

export interface AccountSummary {
  account_id: string;
  window: { since: string; until: string };
  applied_windows: string;
  summary: {
    spend: number;
    impressions: number;
    clicks: number;
    reach: number;
    ctr: number;
    cpm: number;
    cpc: number;
    leads_all: number;
    cost_per_lead_all: number;
    purchases_all: number;
    cost_per_purchase_all: number;
    purchase_value_all: number;
    roas_all: number;
  };
}

export interface AdRow {
  ad_id: string;
  ad_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  effective_status: string | null;
  configured_status: string | null;
  updated_time: string | null;
  created_time: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpm: number;
  cpc: number;
  frequency: number;
  leads_all: number;
  cost_per_lead_all: number;
  purchases_all: number;
  cost_per_purchase_all: number;
  purchase_value_all: number;
  roas_all: number;
  creative: {
    id: string | null;
    name: string | null;
    thumbnail_url: string | null;
    image_url: string | null;
    video_id: string | null;
    title: string | null;
    body: string | null;
    call_to_action_type: string | null;
    link_url: string | null;
    object_story_spec: unknown;
  } | null;
}

export interface QcFlag {
  severity: "critical" | "error" | "warn" | "info";
  msg: string;
}

export interface QcReport {
  account_id: string;
  window: { since: string; until: string };
  flags: QcFlag[];
  account_meta?: { currency?: string; timezone?: string; status?: number; disable_reason?: number };
  active_ad_count?: number;
  spending_ad_count_in_window?: number;
  paused_but_in_window?: number;
  active_but_no_spend?: number;
  pixels?: Array<{ id?: string; name?: string; last_fired_time?: string; hours_since_last_fired?: number }>;
  severity_counts?: Record<string, number>;
}

export interface IntegrationStatus {
  provider: string;
  configured: boolean;
  last_4: string | null;
  updated_at: number | null;
}

export const endpoints = {
  authStatus: () => api.get<AuthStatus>("/api/auth/status"),
  authStart: () => api.get<{ authorize_url: string }>("/api/auth/start"),
  authConfigure: (body: { app_id: string; app_secret: string; redirect_uri?: string }) =>
    api.post<{ ok: boolean; app_id_preview: string; redirect_uri: string }>("/api/auth/configure", body),
  authCheck: () => api.get<CredentialCheck>("/api/auth/check"),
  authUnconfigure: () => api.post<{ ok: boolean }>("/api/auth/unconfigure"),
  logout: () => api.post<{ ok: boolean }>("/api/auth/logout"),
  disconnect: () => api.post<{ ok: boolean }>("/api/auth/disconnect"),
  me: () => api.get<Me>("/api/auth/me"),

  // Third-party integrations (Atria, Anthropic).
  // The backend NEVER returns the plaintext key; we only get a masked
  // last-4 preview, used to show "Connected · ends in ...abcd" in the UI.
  // (OpenAI was removed in v0.2 — audio transcription now runs on-device
  // via @huggingface/transformers, no hosted fallback.)
  listIntegrations: () => api.get<{ integrations: IntegrationStatus[] }>("/api/integrations/"),
  getAtria: () => api.get<IntegrationStatus>("/api/integrations/atria"),
  saveAtria: (body: { api_key: string }) =>
    api.post<{ ok: true; provider: "atria"; last_4: string | null }>("/api/integrations/atria", body),
  removeAtria: () =>
    request<{ ok: true; provider: "atria" }>("/api/integrations/atria", { method: "DELETE" }),

  // Anthropic — powers Deep profile generation in Brand Settings and the
  // AI-tagged columns (sentiment, angle/persona/template) in Creative
  // Analysis. Without a key set, those features show "—" instead of data.
  getAnthropic: () => api.get<IntegrationStatus>("/api/integrations/anthropic"),
  saveAnthropic: (body: { api_key: string }) =>
    api.post<{ ok: true; provider: "anthropic"; last_4: string | null }>("/api/integrations/anthropic", body),
  removeAnthropic: () =>
    request<{ ok: true; provider: "anthropic" }>("/api/integrations/anthropic", { method: "DELETE" }),

  refreshAccounts: () => api.post<{ count: number; accounts: AdAccount[] }>("/api/accounts/refresh"),
  listAccounts: (includeHidden = false) =>
    api.get<{ count: number; accounts: AdAccount[]; hint?: string }>(
      `/api/accounts?include_hidden=${includeHidden}`
    ),
  patchAccount: (id: string, body: { friendly_name?: string; hidden?: boolean }) =>
    api.patch<{ ok: boolean }>(`/api/accounts/${encodeURIComponent(id)}?${new URLSearchParams(body as any)}`),

  summary: (id: string, since: string, until: string, activeOnly = true) =>
    api.get<AccountSummary>(
      `/api/accounts/${encodeURIComponent(id)}/summary?since=${since}&until=${until}&active_only=${activeOnly}`
    ),
  ads: (id: string, since: string, until: string, activeOnly = true) =>
    api.get<{ ads: AdRow[]; count: number; applied_windows: string }>(
      `/api/accounts/${encodeURIComponent(id)}/ads?since=${since}&until=${until}&active_only=${activeOnly}`
    ),
  breakdown: (id: string, since: string, until: string, breakdowns: string, activeOnly = true) =>
    api.get<{ rows: any[]; count: number; applied_windows: string }>(
      `/api/accounts/${encodeURIComponent(id)}/breakdown?since=${since}&until=${until}&breakdowns=${encodeURIComponent(
        breakdowns
      )}&active_only=${activeOnly}`
    ),
  qc: (id: string, since: string, until: string) =>
    api.get<QcReport>(`/api/accounts/${encodeURIComponent(id)}/qc?since=${since}&until=${until}`),

  // Local audio transcription (mlx-whisper / faster-whisper). The engine
  // is selected at API startup; /status reports which one (or whether
  // none is installed).
  transcribeStatus: () => api.get<TranscribeStatus>("/api/transcribe/status"),
  transcribe: (body: { url?: string; ad_id?: string }) =>
    api.post<TranscribeResult>("/api/transcribe", body),
};

export interface TranscribeStatus {
  engine: "mlx-whisper" | "faster-whisper" | "unavailable";
  device: "mps" | "cpu" | "cuda";
  model_loaded: boolean;
  model: string | null;
  platform: string;
  is_apple_silicon: boolean;
  install_hint: string | null;
}

export interface TranscribeSegment {
  start: number;
  end: number;
  text: string;
  words?: Array<{ word: string; start: number; end: number }>;
}

export interface TranscribeResult {
  text: string;
  segments: TranscribeSegment[];
  language: string;
  duration_sec: number;
  engine: string;
  model: string;
  no_speech?: boolean;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
export function daysAgoIso(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
export function formatCurrency(n: number | null | undefined, currency = "USD"): string {
  if (n == null || isNaN(n)) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return n.toFixed(0);
  }
}
export function formatNumber(n: number | null | undefined, digits = 0): string {
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(n);
}
export function formatPct(n: number | null | undefined, digits = 2): string {
  if (n == null || isNaN(n)) return "—";
  return `${n.toFixed(digits)}%`;
}
