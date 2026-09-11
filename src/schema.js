/**
 * Validation + coercion for LLM output.
 *
 * An LLM is an untrusted input source. Everything downstream of the model -
 * routing, escalation, the JSON we hand to another team - assumes a fixed
 * shape, so the boundary is enforced here rather than defensively re-checked
 * in five places.
 *
 * Policy: repair what is safely repairable (missing optional lists, a
 * confidence returned as "85%" instead of 0.85), and HARD FAIL on anything
 * that would change the meaning of the record (unknown category, missing
 * core_issue). A hard failure is not a crash - the pipeline turns it into a
 * record routed to Human Escalation with reason `schema_violation`, because a
 * malformed record is exactly the case a human should see.
 */

import { CATEGORIES, PRIORITIES } from './llm/prompts.js';

export class SchemaError extends Error {
  constructor(issues) {
    super(`Triage output failed validation: ${issues.join('; ')}`);
    this.name = 'SchemaError';
    this.issues = issues;
  }
}

const URGENCY = ['critical', 'elevated', 'routine'];
const AFFECTED = ['single', 'multiple', 'unknown'];
const SENTIMENT = ['calm', 'frustrated', 'urgent', 'neutral'];

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const strArr = (v) => arr(v).map((x) => String(x)).filter(Boolean);

function coerceConfidence(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Some models answer 85 when asked for 0.85.
    const n = v > 1 && v <= 100 ? v / 100 : v;
    return Math.min(1, Math.max(0, Math.round(n * 100) / 100));
  }
  if (typeof v === 'string') {
    const m = v.match(/-?\d+(\.\d+)?/);
    if (m) return coerceConfidence(Number(m[0]));
  }
  return null;
}

function coerceAmounts(v) {
  return arr(v)
    .map((a) => {
      if (a == null) return null;
      const value =
        typeof a.value === 'number'
          ? a.value
          : Number(String(a.value ?? '').replace(/[^0-9.\-]/g, ''));
      if (!Number.isFinite(value)) return null;
      return {
        value,
        currency: str(a.currency) ?? 'USD',
        context: str(a.context) ?? 'unspecified',
      };
    })
    .filter(Boolean);
}

const oneOf = (v, allowed, fallback = null) =>
  allowed.includes(v) ? v : fallback;

/**
 * Normalise the model's belief distribution over categories.
 *
 * Prompt v1.2 asked for a scalar `confidence` and the model returned 0.96 for
 * every single fixture - a self-reported confidence is a token prediction,
 * not a measurement, and it collapsed onto one value. v1.3 asks instead for a
 * distribution across all five categories, which is a comparative judgement
 * and something LLMs do far better. We take argmax as the decision, its score
 * as the confidence, and the gap to the runner-up as the decision margin.
 *
 * @returns {null|{category: string, confidence: number, scores: object,
 *                 runner_up: string|null, margin: number}}
 */
function deriveFromScores(rawScores) {
  if (!rawScores || typeof rawScores !== 'object') return null;
  const entries = Object.entries(rawScores)
    .filter(([k]) => CATEGORIES.includes(k))
    .map(([k, v]) => [k, Number(v)])
    .filter(([, v]) => Number.isFinite(v) && v >= 0);
  if (entries.length < 2) return null;

  // Renormalise rather than reject: models routinely return 0.99 or 1.02.
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total <= 0) return null;
  const norm = entries
    .map(([k, v]) => [k, Math.round((v / total) * 100) / 100])
    .sort((a, b) => b[1] - a[1]);

  return {
    category: norm[0][0],
    confidence: norm[0][1],
    scores: Object.fromEntries(norm),
    runner_up: norm[1]?.[0] ?? null,
    margin: Math.round((norm[0][1] - (norm[1]?.[1] ?? 0)) * 100) / 100,
  };
}

/** @throws {SchemaError} */
export function validateTriage(raw) {
  const issues = [];
  if (!raw || typeof raw !== 'object') throw new SchemaError(['output was not an object']);

  // v1.3 shape (distribution) preferred; v1.2 scalar shape still accepted so
  // an older prompt or a different provider can be swapped in without a code
  // change.
  const derived = deriveFromScores(raw.category_scores);

  const category = derived?.category ?? oneOf(str(raw.category), CATEGORIES);
  if (!category) issues.push(`category "${raw.category}" is not one of ${CATEGORIES.join(' | ')}`);

  const priority = oneOf(str(raw.priority), PRIORITIES);
  if (!priority) issues.push(`priority "${raw.priority}" is not one of ${PRIORITIES.join(' | ')}`);

  const confidence = derived?.confidence ?? coerceConfidence(raw.confidence);
  if (confidence === null) issues.push(`confidence "${raw.confidence}" is not a number in [0,1]`);

  const core_issue = str(raw.core_issue);
  if (!core_issue) issues.push('core_issue is empty');

  if (issues.length) throw new SchemaError(issues);

  const e = raw.entities && typeof raw.entities === 'object' ? raw.entities : {};

  return {
    category,
    priority,
    confidence,
    category_scores: derived?.scores ?? null,
    runner_up_category: derived?.runner_up ?? null,
    decision_margin: derived?.margin ?? null,
    core_issue,
    entities: {
      account_id: str(e.account_id),
      invoice_number: str(e.invoice_number),
      error_codes: strArr(e.error_codes),
      amounts: coerceAmounts(e.amounts),
      product_areas: strArr(e.product_areas),
      affected_users: oneOf(str(e.affected_users), AFFECTED, 'unknown'),
      first_observed: str(e.first_observed),
    },
    urgency_signal: oneOf(str(raw.urgency_signal), URGENCY, 'routine'),
    urgency_evidence: strArr(raw.urgency_evidence),
    customer_sentiment: oneOf(str(raw.customer_sentiment), SENTIMENT, 'neutral'),
    ambiguity_notes: str(raw.ambiguity_notes),
    suggested_next_action: str(raw.suggested_next_action) ?? 'Review message and assign an owner.',
  };
}

/** Shape guarantee for the record we persist - what a downstream team consumes. */
export const RECORD_FIELDS = [
  'record_id',
  'request_id',
  'source',
  'received_at',
  'processed_at',
  'raw_message',
  'category',
  'priority',
  'confidence',
  'confidence_adjusted',
  'core_issue',
  'entities',
  'urgency_signal',
  'urgency_evidence',
  'customer_sentiment',
  'ambiguity_notes',
  'suggested_next_action',
  'destination_queue',
  'routing_rule',
  'escalated_for_human_review',
  'escalation_reasons',
  'sla_target_hours',
  'summary',
  'pipeline',
];
