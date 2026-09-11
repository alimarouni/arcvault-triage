/**
 * Step 6 - Human escalation.
 *
 * Three independent triggers, any one of which diverts the record to the
 * Human-Escalation queue instead of its normal destination:
 *
 *   E1  Low confidence      - the model is not sure enough to act on.
 *   E2  Blast radius        - outage language or multi-user impact.
 *   E3  Financial exposure  - a disputed amount at or above a money threshold.
 *
 * Plus one input to E1 that is not itself a trigger:
 *
 *   C1  Calibration check   - a self-reported confidence is not evidence, it is
 *                             a token prediction. We cross-check the model's
 *                             category against cheap deterministic keyword
 *                             evidence and apply a penalty when they disagree,
 *                             which can push a borderline record under the
 *                             threshold. This catches the dangerous failure
 *                             mode: confidently wrong.
 *
 * Every trigger writes a human-readable reason onto the record. "Escalated"
 * with no reason is useless to the person who picks it up.
 */

import { QUEUES } from './rules.js';

export const CONFIDENCE_THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD || 0.7);
export const BILLING_ESCALATION_USD = Number(process.env.BILLING_ESCALATION_USD || 500);

/** Miscalibration penalty applied when keyword evidence contradicts the model. */
const CALIBRATION_PENALTY = 0.15;

const OUTAGE_PATTERNS = [
  /\boutage\b/i,
  /\bdown for (all|every|multiple)\b/i,
  /\b(all|every) users?\b/i,
  /\bmultiple users?\b/i,
  /\bwidespread\b/i,
  /\bnobody can\b/i,
  /\bno one can\b/i,
  /\bcompletely (down|unavailable|broken)\b/i,
  /\bservice (is )?(down|unavailable)\b/i,
];

/** Cheap lexical evidence per category. Intentionally crude - it is a
 *  disagreement detector, not a classifier. */
const CATEGORY_KEYWORDS = {
  'Billing Issue': [/\binvoice\b/i, /\bcharge[ds]?\b/i, /\bbilling\b/i, /\brefund\b/i, /\bcontract rate\b/i, /\$\s?[\d,]+/],
  'Incident/Outage': OUTAGE_PATTERNS,
  'Bug Report': [/\berror\b/i, /\b[45]\d{2}\b/, /\bbroken\b/i, /\bnot working\b/i, /\bfails?\b/i, /\bbug\b/i],
  'Feature Request': [/\bwe'?d love\b/i, /\bfeature\b/i, /\bability to\b/i, /\bplease add\b/i, /\bwould be (great|nice|useful)\b/i, /\bsupport for\b/i],
  'Technical Question': [/\bis there a way\b/i, /\bhow (do|can|would) (i|we)\b/i, /\bdoes .* support\b/i, /\bcan we\b/i, /\bevaluating\b/i, /\bnot sure if\b/i],
};

/** @returns {string[]} categories with at least one lexical hit. */
export function keywordEvidence(message) {
  return Object.entries(CATEGORY_KEYWORDS)
    .filter(([, patterns]) => patterns.some((p) => p.test(message)))
    .map(([category]) => category);
}

/**
 * The disputed amount, not the gross amount.
 *
 * ASSUMPTION (documented in ARCHITECTURE.md): when a message contains two or
 * more figures we read it as "billed X, expected Y" and treat |X - Y| as the
 * money at risk. A $1,240 invoice against a $980 contract rate is a $260
 * dispute, not a $1,240 one. With a single figure we have nothing to compare
 * against, so the figure itself is the exposure.
 */
export function disputedAmountUsd(amounts = []) {
  const values = amounts
    .filter((a) => (a.currency ?? 'USD').toUpperCase() === 'USD')
    .map((a) => Math.abs(Number(a.value)))
    .filter(Number.isFinite);
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  return Math.max(...values) - Math.min(...values);
}

/**
 * @returns {{escalated: boolean, reasons: string[], confidence_adjusted: number,
 *            destination_queue?: string}}
 */
export function assessEscalation({ triage, rawMessage, baseRoute }) {
  const reasons = [];

  // C1 - calibration cross-check (adjusts confidence, never escalates alone)
  const evidence = keywordEvidence(rawMessage);
  let confidence = triage.confidence;
  if (evidence.length > 0 && !evidence.includes(triage.category)) {
    confidence = Math.max(0, Math.round((confidence - CALIBRATION_PENALTY) * 100) / 100);
    reasons.push(
      `calibration_mismatch: lexical evidence suggests ${evidence.join('/')} but model chose ${triage.category}; confidence reduced by ${CALIBRATION_PENALTY} to ${confidence.toFixed(2)}`
    );
  }

  // E1 - low confidence
  if (confidence < CONFIDENCE_THRESHOLD) {
    reasons.push(
      `low_confidence: ${confidence.toFixed(2)} is below the ${CONFIDENCE_THRESHOLD} threshold`
    );
  }

  // E2 - blast radius
  const outageHit = OUTAGE_PATTERNS.find((p) => p.test(rawMessage));
  if (outageHit) {
    reasons.push(
      `blast_radius: message matches outage language (${outageHit.source}) - needs an incident owner, not a queue`
    );
  } else if (triage.entities?.affected_users === 'multiple') {
    reasons.push('blast_radius: model reported multiple affected users');
  }

  // E3 - financial exposure
  const disputed = disputedAmountUsd(triage.entities?.amounts);
  if (triage.category === 'Billing Issue' && disputed >= BILLING_ESCALATION_USD) {
    reasons.push(
      `financial_exposure: disputed amount $${disputed.toLocaleString()} meets the $${BILLING_ESCALATION_USD} review threshold`
    );
  }

  // A calibration note on its own is information, not an escalation.
  const escalated = reasons.some((r) => !r.startsWith('calibration_mismatch'));

  return {
    escalated,
    reasons,
    confidence_adjusted: confidence,
    destination_queue: escalated ? QUEUES.ESCALATION : baseRoute.destination_queue,
    /** Kept so the human reviewer can see where it WOULD have gone. */
    intended_queue: baseRoute.destination_queue,
  };
}
