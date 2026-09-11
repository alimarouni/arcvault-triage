/**
 * Minimal OpenAI-compatible chat client.
 *
 * Works unchanged against Groq, OpenAI, Together, Mistral or a local Ollama
 * (`/v1` endpoint) - only LLM_BASE_URL and LLM_MODEL change. Keeping the
 * provider behind one 60-line module is deliberate: the assessment says "state
 * which model you used and why", and the honest answer is that the choice must
 * stay reversible.
 *
 * Responsibilities:
 *   - per-request timeout (a hung LLM must not hang the queue)
 *   - bounded retries with exponential backoff + jitter on 429/5xx/network
 *   - JSON-mode request, plus a fence-stripping repair pass for models that
 *     wrap JSON in markdown anyway
 *   - telemetry (latency, tokens) attached to every call for cost accounting
 */

const DEFAULTS = {
  baseUrl: process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1',
  model: process.env.LLM_MODEL || 'openai/gpt-oss-120b',
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 60000),
  maxRetries: Number(process.env.LLM_MAX_RETRIES || 5),
  /**
   * gpt-oss models emit internal reasoning tokens that count against
   * max_tokens. At "low" the answer still arrives; at the default the model
   * can spend the whole budget thinking and return an empty completion, which
   * the API then rejects as json_validate_failed. Ignored by providers that
   * do not implement it.
   */
  reasoningEffort: process.env.LLM_REASONING_EFFORT || 'low',
};

function apiKey() {
  const key =
    process.env.GROQ_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.LLM_API_KEY;
  if (!key) {
    throw new Error(
      'No API key found. Copy .env.example to .env and set GROQ_API_KEY.'
    );
  }
  return key;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------------------
 * Client-side token budget (proactive backpressure)
 *
 * The Groq free tier caps tokens-per-minute, not requests-per-minute, and the
 * triage prompt is ~1.9k tokens - so two concurrent records can breach the cap
 * on the first call. Retrying into a 429 works but wastes the whole latency
 * budget discovering a limit we already know.
 *
 * This is a rolling 60-second window over ESTIMATED tokens. Before each call
 * we reserve an estimate; if the window is full we wait exactly long enough
 * for the oldest reservation to age out. After the call we correct the
 * reservation with the real usage from the response. Retries remain as the
 * safety net for everything this cannot predict (other clients on the same
 * key, provider-side accounting drift).
 * ------------------------------------------------------------------------ */

const TPM_BUDGET = Number(process.env.LLM_TPM_BUDGET || 6500);
const WINDOW_MS = 60_000;
let reservations = []; // [{ at, tokens }]
let gate = Promise.resolve(); // serialises the reserve step only

const windowTokens = (now) => {
  reservations = reservations.filter((r) => now - r.at < WINDOW_MS);
  return reservations.reduce((s, r) => s + r.tokens, 0);
};

/** Rough but stable: ~4 characters per token, plus the completion ceiling. */
const estimateTokens = (system, user, maxTokens) =>
  Math.ceil((system.length + user.length) / 4) + maxTokens;

async function reserve(tokens, onWait) {
  const mine = gate.then(async () => {
    for (;;) {
      const now = Date.now();
      const used = windowTokens(now);
      if (used + tokens <= TPM_BUDGET || reservations.length === 0) {
        reservations.push({ at: now, tokens });
        return;
      }
      const waitMs = WINDOW_MS - (now - reservations[0].at) + 100;
      onWait?.(waitMs, used, tokens);
      await sleep(waitMs);
    }
  });
  gate = mine.catch(() => {});
  return mine;
}

/** Replace the estimate with what the provider actually charged. */
function settle(estimated, actual) {
  const entry = reservations.findLast((r) => r.tokens === estimated);
  if (entry && Number.isFinite(actual)) entry.tokens = actual;
}

/** Strip markdown fences / leading prose that some models emit despite JSON mode. */
export function extractJson(text) {
  const trimmed = String(text).trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to repair */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1));
  }
  throw new Error(`Model did not return JSON. Raw output: ${trimmed.slice(0, 300)}`);
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Free-tier Groq enforces a tokens-per-minute budget, and a 429 tells you
 * exactly how long to wait. Honouring that is strictly better than blind
 * exponential backoff: it is the difference between a run that finishes in 90
 * seconds and one that thrashes. Reads the Retry-After header, then falls
 * back to parsing "Please try again in 12.23s" out of the error body.
 */
function retryAfterMs(err) {
  const header = err.retryAfter;
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return Math.ceil(secs * 1000) + 250;
  }
  const m = /try again in ([\d.]+)\s*s/i.exec(err.message || '');
  if (m) return Math.ceil(Number(m[1]) * 1000) + 250;
  return null;
}

/**
 * @returns {Promise<{data: object, meta: {model: string, latency_ms: number,
 *          prompt_tokens: number, completion_tokens: number, attempts: number}}>}
 */
export async function completeJson({
  system,
  user,
  temperature = 0,
  maxTokens = 900,
  ...opts
}) {
  const cfg = { ...DEFAULTS, ...opts };
  const enqueuedAt = Date.now();
  let lastError;

  const estimate = estimateTokens(system, user, maxTokens);
  await reserve(estimate, (waitMs, used) =>
    console.warn(
      `  [llm] token budget ${used}/${TPM_BUDGET} in the last 60s - pausing ${Math.round(waitMs / 1000)}s before the next call`
    )
  );

  // Time spent waiting for the token budget is queue time, not model time.
  // Conflating them makes a 1.4s call look like a 58s one and hides which of
  // the two you would actually have to fix.
  const started = Date.now();
  const queuedMs = started - enqueuedAt;

  for (let attempt = 1; attempt <= cfg.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey()}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature,
          max_tokens: maxTokens,
          reasoning_effort: cfg.reasoningEffort,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        const err = new Error(`LLM HTTP ${res.status}: ${body.slice(0, 300)}`);
        err.status = res.status;
        err.retryAfter = res.headers.get('retry-after');
        throw err;
      }

      const payload = await res.json();
      const content = payload.choices?.[0]?.message?.content ?? '';
      settle(estimate, payload.usage?.total_tokens);
      return {
        data: extractJson(content),
        meta: {
          model: payload.model ?? cfg.model,
          latency_ms: Date.now() - started,
          queued_ms: queuedMs,
          prompt_tokens: payload.usage?.prompt_tokens ?? null,
          completion_tokens: payload.usage?.completion_tokens ?? null,
          attempts: attempt,
        },
      };
    } catch (err) {
      lastError = err;
      const retryable =
        err.name === 'AbortError' ||
        err.status === undefined || // network-level failure
        RETRYABLE_STATUS.has(err.status);
      if (!retryable || attempt === cfg.maxRetries) break;
      const backoff =
        retryAfterMs(err) ?? 400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      console.warn(
        `  [llm] attempt ${attempt} failed (HTTP ${err.status ?? 'net'}), waiting ${backoff}ms`
      );
      await sleep(backoff);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export const llmConfig = () => ({ ...DEFAULTS });
