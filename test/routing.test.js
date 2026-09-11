/**
 * The deterministic half of the pipeline is unit-tested; the LLM half is not.
 * That split is deliberate: routing and escalation are policy and must be
 * provably stable, while prompt quality is measured by the eval harness
 * (`npm run eval`, see docs/ARCHITECTURE.md) rather than by assertions.
 *
 *   node --test test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { routeByClassification, slaTargetHours, QUEUES } from '../src/routing/rules.js';
import {
  assessEscalation,
  disputedAmountUsd,
  keywordEvidence,
} from '../src/routing/escalation.js';
import { validateTriage, SchemaError } from '../src/schema.js';

const triage = (over = {}) => ({
  category: 'Bug Report',
  priority: 'Medium',
  confidence: 0.9,
  core_issue: 'Something is broken.',
  entities: {
    account_id: null,
    invoice_number: null,
    error_codes: [],
    amounts: [],
    product_areas: [],
    affected_users: 'single',
    first_observed: null,
  },
  urgency_signal: 'routine',
  urgency_evidence: [],
  customer_sentiment: 'neutral',
  ambiguity_notes: null,
  suggested_next_action: 'Investigate.',
  ...over,
});

/* --------------------------------- routing ------------------------------- */

test('each category reaches its owning queue', () => {
  const cases = [
    ['Incident/Outage', QUEUES.ENGINEERING],
    ['Bug Report', QUEUES.ENGINEERING],
    ['Billing Issue', QUEUES.BILLING],
    ['Feature Request', QUEUES.PRODUCT],
  ];
  for (const [category, queue] of cases) {
    assert.equal(routeByClassification(triage({ category })).destination_queue, queue);
  }
});

test('a security-flavoured technical question goes to IT/Security, a plain one to Tier 1', () => {
  const sso = triage({
    category: 'Technical Question',
    core_issue: 'Customer asks whether SSO with Okta is supported.',
    entities: { ...triage().entities, product_areas: ['authentication', 'SSO'] },
  });
  assert.equal(routeByClassification(sso).destination_queue, QUEUES.IT_SECURITY);

  const howTo = triage({
    category: 'Technical Question',
    core_issue: 'Customer asks how to rename a workspace.',
    entities: { ...triage().entities, product_areas: ['workspaces'] },
  });
  assert.equal(routeByClassification(howTo).destination_queue, QUEUES.SUPPORT);
});

test('routing is total: an unknown category still lands somewhere', () => {
  const r = routeByClassification(triage({ category: 'Something Unmapped' }));
  assert.equal(r.destination_queue, QUEUES.SUPPORT);
  assert.equal(r.routing_rule, 'R0-default-fallback');
});

test('SLA tightens with priority and collapses to 1h on escalation', () => {
  assert.equal(slaTargetHours('High', QUEUES.ENGINEERING), 4);
  assert.equal(slaTargetHours('Low', QUEUES.PRODUCT), 72);
  assert.equal(slaTargetHours('Low', QUEUES.ESCALATION), 1);
});

/* ------------------------------- escalation ------------------------------ */

const base = { destination_queue: QUEUES.ENGINEERING };

test('E1: confidence under the threshold escalates', () => {
  const r = assessEscalation({
    triage: triage({ confidence: 0.62 }),
    rawMessage: 'It is a bit odd, not sure what is wrong.',
    baseRoute: base,
  });
  assert.equal(r.escalated, true);
  assert.equal(r.destination_queue, QUEUES.ESCALATION);
  assert.match(r.reasons.join(' '), /low_confidence/);
  assert.equal(r.intended_queue, QUEUES.ENGINEERING, 'the would-be queue is preserved');
});

test('E2: outage language escalates even at high confidence', () => {
  const r = assessEscalation({
    triage: triage({ category: 'Incident/Outage', confidence: 0.98 }),
    rawMessage: 'The dashboard is down for all users since 2pm.',
    baseRoute: base,
  });
  assert.equal(r.escalated, true);
  assert.match(r.reasons.join(' '), /blast_radius/);
});

test('E3: the threshold is on the disputed amount, not the invoice total', () => {
  // $1,240 billed against a $980 contract = a $260 dispute -> no escalation.
  const small = assessEscalation({
    triage: triage({
      category: 'Billing Issue',
      confidence: 0.95,
      entities: {
        ...triage().entities,
        amounts: [
          { value: 1240, currency: 'USD', context: 'invoiced' },
          { value: 980, currency: 'USD', context: 'contract rate' },
        ],
      },
    }),
    rawMessage: 'Invoice #8821 shows $1,240 but our contract rate is $980/month.',
    baseRoute: { destination_queue: QUEUES.BILLING },
  });
  assert.equal(small.escalated, false);
  assert.equal(small.destination_queue, QUEUES.BILLING);

  // $4,000 billed against a $980 contract = a $3,020 dispute -> escalate.
  const large = assessEscalation({
    triage: triage({
      category: 'Billing Issue',
      confidence: 0.95,
      entities: {
        ...triage().entities,
        amounts: [
          { value: 4000, currency: 'USD', context: 'invoiced' },
          { value: 980, currency: 'USD', context: 'contract rate' },
        ],
      },
    }),
    rawMessage: 'Invoice #9002 shows $4,000 but our contract rate is $980/month.',
    baseRoute: { destination_queue: QUEUES.BILLING },
  });
  assert.equal(large.escalated, true);
  assert.match(large.reasons.join(' '), /financial_exposure/);
});

test('disputedAmountUsd: delta for pairs, face value for a lone figure', () => {
  assert.equal(disputedAmountUsd([]), 0);
  assert.equal(disputedAmountUsd([{ value: 900, currency: 'USD' }]), 900);
  assert.equal(
    disputedAmountUsd([
      { value: 1240, currency: 'USD' },
      { value: 980, currency: 'USD' },
    ]),
    260
  );
});

test('C1: a calibration mismatch lowers confidence but does not escalate on its own', () => {
  const r = assessEscalation({
    // Model says Feature Request; the text is unmistakably about an invoice.
    triage: triage({ category: 'Feature Request', confidence: 0.92 }),
    rawMessage: 'Invoice #55 charged us $120 more than our contract rate.',
    baseRoute: { destination_queue: QUEUES.PRODUCT },
  });
  assert.equal(r.confidence_adjusted, 0.77, 'penalty applied');
  assert.equal(r.escalated, false, 'still above threshold, so it is a note, not a block');
  assert.match(r.reasons.join(' '), /calibration_mismatch/);
});

test('C1 can tip a borderline record over the escalation line', () => {
  const r = assessEscalation({
    triage: triage({ category: 'Feature Request', confidence: 0.8 }),
    rawMessage: 'Invoice #55 charged us $120 more than our contract rate.',
    baseRoute: { destination_queue: QUEUES.PRODUCT },
  });
  assert.equal(r.confidence_adjusted, 0.65);
  assert.equal(r.escalated, true);
});

test('keywordEvidence is a disagreement detector, not a classifier', () => {
  assert.deepEqual(keywordEvidence('Invoice #8821 was charged twice'), ['Billing Issue']);
  assert.deepEqual(keywordEvidence('hello there'), []);
});

/* -------------------------------- schema --------------------------------- */

test('confidence returned as a percentage is coerced, not rejected', () => {
  const out = validateTriage({ ...triage(), confidence: 85 });
  assert.equal(out.confidence, 0.85);
});

test('missing optional collections default instead of throwing', () => {
  const out = validateTriage({
    category: 'Bug Report',
    priority: 'Low',
    confidence: 0.9,
    core_issue: 'x',
    entities: { account_id: 'acct_1' },
  });
  assert.deepEqual(out.entities.error_codes, []);
  assert.equal(out.entities.affected_users, 'unknown');
  assert.equal(out.urgency_signal, 'routine');
});

test('an out-of-enum category is a hard failure', () => {
  assert.throws(
    () => validateTriage({ ...triage(), category: 'Refund Please' }),
    SchemaError
  );
});

test('a missing core_issue is a hard failure', () => {
  assert.throws(() => validateTriage({ ...triage(), core_issue: '   ' }), SchemaError);
});
