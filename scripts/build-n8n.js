/**
 * Generates n8n/arcvault-triage.workflow.json from the SAME prompt and policy
 * modules the Node implementation uses.
 *
 * Why generate instead of hand-building in the n8n UI: a prompt that lives in
 * two places drifts within a week. The n8n canvas is the orchestration layer;
 * src/llm/prompts.js, src/routing/rules.js and src/routing/escalation.js stay
 * the single source of truth, and this script projects them onto the canvas.
 *
 *   node scripts/build-n8n.js
 */

import { writeFile } from 'node:fs/promises';
import {
  TRIAGE_SYSTEM_PROMPT,
  BRIEFING_SYSTEM_PROMPT,
  PROMPT_VERSION,
} from '../src/llm/prompts.js';
import { readFile } from 'node:fs/promises';

// Kept in step with .env. The briefing runs on the smaller model: summarising
// an already-structured record is an easier task than classifying free text,
// and on Groq it sits in a separate rate-limit bucket.
const MODEL = process.env.LLM_MODEL || 'openai/gpt-oss-120b';
const SUMMARY_MODEL = process.env.LLM_SUMMARY_MODEL || 'openai/gpt-oss-20b';
// gpt-oss spends internal reasoning tokens out of max_tokens; at the default
// effort the briefing call burns its whole budget thinking and returns an
// empty completion, which the API reports as json_validate_failed.
const REASONING_EFFORT = 'low';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const samples = JSON.parse(await readFile(new URL('../data/inbound.json', import.meta.url), 'utf8'));

let nodeSeq = 0;
const uid = (p) => `${p}-${(nodeSeq++).toString().padStart(2, '0')}`;

const code = (name, jsCode, position, mode = 'runOnceForEachItem') => ({
  parameters: { mode, jsCode },
  id: uid('code'),
  name,
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position,
});

const noop = (name, position, color = 7) => ({
  parameters: {},
  id: uid('noop'),
  name,
  type: 'n8n-nodes-base.noOp',
  typeVersion: 1,
  position,
  notesInFlow: true,
});

/**
 * @param batchIntervalMs  Pace requests so a batch run stays inside the
 *   provider's tokens-per-minute cap. Groq's free tier allows 8,000 TPM on
 *   gpt-oss-120b and the triage call costs ~2.6k, so ~3 per minute is the
 *   ceiling: without pacing, n8n fires all five items at once and every one
 *   after the second returns 429. This is the n8n-native equivalent of the
 *   rolling token budget in src/llm/client.js - cruder, because n8n can only
 *   space requests evenly rather than track actual usage, but enough to make
 *   a demo run deterministic. Raise the batch size and drop the interval on
 *   a paid tier.
 */
const groqCall = (name, position, maxTokens, temperature, model = MODEL, batchIntervalMs = 21000) => ({
  parameters: {
    method: 'POST',
    url: GROQ_URL,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.groq_body) }}',
    options: {
      timeout: 60000,
      batching: { batch: { batchSize: 1, batchInterval: batchIntervalMs } },
      response: { response: { neverError: false } },
    },
  },
  id: uid('http'),
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position,
  retryOnFail: true,
  maxTries: 5,
  waitBetweenTries: 15000,
  notes: `Groq ${model}, temperature ${temperature}, max_tokens ${maxTokens}, one request every ${batchIntervalMs / 1000}s to stay inside the free-tier token budget. Header Auth credential supplies "Authorization: Bearer <GROQ_API_KEY>".`,
});

/* ------------------------------------------------------------------ nodes */

const nodes = [
  /* --- Step 1: ingestion -------------------------------------------- */
  {
    parameters: {},
    id: uid('trigger'),
    name: 'Manual Trigger (demo run)',
    type: 'n8n-nodes-base.manualTrigger',
    typeVersion: 1,
    position: [-560, 80],
  },
  {
    parameters: {
      httpMethod: 'POST',
      path: 'arcvault-intake',
      responseMode: 'lastNode',
      options: {},
    },
    id: uid('trigger'),
    name: 'Webhook: /arcvault-intake',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [-560, 300],
    webhookId: 'arcvault-intake-001',
    notes: 'Production trigger. POST {"source":"email","raw_message":"..."}',
  },
  code(
    'Load 5 Sample Requests',
    `// Step 1 - ingestion (demo path). The webhook path carries real traffic;
// this node replays the five assessment fixtures so the whole workflow can be
// executed with one click.
return ${JSON.stringify(samples, null, 2)}.map(json => ({ json }));`,
    [-340, 80],
    'runOnceForAllItems'
  ),
  code(
    'Normalize Inbound',
    `// One shape from here on, whichever trigger fired.
const b = $json.body ?? $json;
return {
  json: {
    id: b.id ?? ('WEB-' + Date.now()),
    source: b.source ?? 'webhook',
    received_at: b.received_at ?? new Date().toISOString(),
    raw_message: String(b.raw_message ?? b.message ?? '').trim(),
  }
};`,
    [-120, 190]
  ),

  /* --- Steps 2+3: classification + enrichment ------------------------ */
  code(
    'Build Triage Prompt',
    `// Steps 2 + 3 in one call. Category, priority, confidence and entity
// extraction are mutually informing, so splitting them would double latency
// and cost for no accuracy gain.
const SYSTEM = ${JSON.stringify(TRIAGE_SYSTEM_PROMPT)};

const user = [
  'source: ' + $json.source,
  'received_at: ' + ($json.received_at ?? 'unknown'),
  'message: """',
  $json.raw_message,
  '"""',
  '',
  'Return the triage JSON object now.'
].join('\\n');

return {
  json: {
    ...$json,
    prompt_version: ${JSON.stringify(PROMPT_VERSION)},
    groq_body: {
      model: ${JSON.stringify(MODEL)},
      temperature: 0,
      max_tokens: 1600,
      reasoning_effort: ${JSON.stringify(REASONING_EFFORT)},
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
    },
  }
};`,
    [100, 190]
  ),
  groqCall('Groq: Triage', [320, 190], 1600, 0),
  code(
    'Validate Triage Output',
    `// The LLM is an untrusted input source. Enum violations are a hard failure;
// shape omissions and a confidence returned as 85 instead of 0.85 are repaired.
const CATEGORIES = ['Bug Report','Feature Request','Billing Issue','Technical Question','Incident/Outage'];
const PRIORITIES = ['Low','Medium','High'];
const req = $('Normalize Inbound').item.json;

let raw;
try {
  const content = $json.choices[0].message.content;
  raw = typeof content === 'string' ? JSON.parse(content) : content;
} catch (e) {
  return { json: { ...req, _schema_error: 'model did not return parsable JSON: ' + e.message } };
}

const conf = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.]/g, ''));
  if (!isFinite(n)) return null;
  return Math.min(1, Math.max(0, Math.round((n > 1 && n <= 100 ? n / 100 : n) * 100) / 100));
};

// Prompt v1.3 returns a belief distribution rather than a scalar confidence
// (v1.2 asked for a number and the model returned 0.96 for every fixture,
// which silently disabled the low-confidence escalation trigger). Argmax is
// the decision, its score is the confidence, the gap to second place is the
// margin. The v1.2 scalar shape is still accepted as a fallback.
const derive = (scores) => {
  if (!scores || typeof scores !== 'object') return null;
  const rows = Object.entries(scores)
    .filter(([k]) => CATEGORIES.includes(k))
    .map(([k, v]) => [k, Number(v)])
    .filter(([, v]) => isFinite(v) && v >= 0);
  if (rows.length < 2) return null;
  const total = rows.reduce((s, [, v]) => s + v, 0);
  if (total <= 0) return null;
  const norm = rows.map(([k, v]) => [k, Math.round((v / total) * 100) / 100])
                   .sort((a, b) => b[1] - a[1]);
  return {
    category: norm[0][0],
    confidence: norm[0][1],
    scores: Object.fromEntries(norm),
    runner_up: norm[1] ? norm[1][0] : null,
    margin: Math.round((norm[0][1] - (norm[1] ? norm[1][1] : 0)) * 100) / 100,
  };
};

const d = derive(raw.category_scores);
const category = d ? d.category : raw.category;
const confidence = d ? d.confidence : conf(raw.confidence);

const issues = [];
if (!CATEGORIES.includes(category)) issues.push('bad category: ' + category);
if (!PRIORITIES.includes(raw.priority)) issues.push('bad priority: ' + raw.priority);
if (confidence === null || confidence === undefined) issues.push('bad confidence: ' + raw.confidence);
if (!raw.core_issue) issues.push('core_issue empty');
if (issues.length) return { json: { ...req, _schema_error: issues.join('; ') } };

const e = raw.entities ?? {};
return {
  json: {
    ...req,
    prompt_version: $('Build Triage Prompt').item.json.prompt_version,
    model: $json.model ?? ${JSON.stringify(MODEL)},
    tokens_triage: $json.usage?.total_tokens ?? null,
    triage: {
      category: category,
      priority: raw.priority,
      confidence: confidence,
      category_scores: d ? d.scores : null,
      runner_up_category: d ? d.runner_up : null,
      decision_margin: d ? d.margin : null,
      core_issue: raw.core_issue,
      entities: {
        account_id: e.account_id ?? null,
        invoice_number: e.invoice_number ?? null,
        error_codes: e.error_codes ?? [],
        amounts: e.amounts ?? [],
        product_areas: e.product_areas ?? [],
        affected_users: ['single','multiple','unknown'].includes(e.affected_users) ? e.affected_users : 'unknown',
        first_observed: e.first_observed ?? null,
      },
      urgency_signal: ['critical','elevated','routine'].includes(raw.urgency_signal) ? raw.urgency_signal : 'routine',
      urgency_evidence: raw.urgency_evidence ?? [],
      customer_sentiment: raw.customer_sentiment ?? 'neutral',
      ambiguity_notes: raw.ambiguity_notes ?? null,
      suggested_next_action: raw.suggested_next_action ?? 'Review and assign an owner.',
    },
  }
};`,
    [540, 190]
  ),

  /* --- Step 4: routing ------------------------------------------------ */
  code(
    'Route by Classification',
    `// Step 4 - deterministic. The LLM decides WHAT the message is; this table
// decides WHERE it goes. No model call: routing is business policy and must be
// auditable, testable and changeable without touching a prompt.
const SECURITY = /\\b(sso|saml|okta|oauth|scim|authentication|auth|mfa|2fa|security|permissions|encryption)\\b/i;

if ($json._schema_error) {
  return { json: { ...$json, route: { destination_queue: 'Human-Escalation', routing_rule: 'R-fail-safe',
    routing_rationale: 'Triage output failed validation; the request is never dropped.' } } };
}

const t = $json.triage;
const areas = [...(t.entities.product_areas ?? []), t.core_issue ?? ''].join(' ');

const TABLE = [
  { id: 'R1-incident-to-engineering', hit: t.category === 'Incident/Outage', queue: 'Engineering',
    why: 'Service degradation is owned by the on-call engineering rotation.' },
  { id: 'R2-bug-to-engineering', hit: t.category === 'Bug Report', queue: 'Engineering',
    why: 'Defects are triaged by engineering regardless of severity.' },
  { id: 'R3-billing-to-billing', hit: t.category === 'Billing Issue', queue: 'Billing',
    why: 'Only Billing can inspect contract rates and issue credits.' },
  { id: 'R4-feature-to-product', hit: t.category === 'Feature Request', queue: 'Product',
    why: 'Product owns roadmap intake and the customer response.' },
  { id: 'R5-security-question-to-it-security', hit: t.category === 'Technical Question' && SECURITY.test(areas), queue: 'IT/Security',
    why: 'Identity and access questions require a security-reviewed answer.' },
  { id: 'R6-technical-question-to-support', hit: t.category === 'Technical Question', queue: 'Support-Tier1',
    why: 'General how-to questions are answered by Tier 1 from the knowledge base.' },
];

const rule = TABLE.find(r => r.hit) ?? { id: 'R0-default-fallback', queue: 'Support-Tier1',
  why: 'No rule matched; defaulted to Tier 1 so the request is never dropped.' };

return { json: { ...$json, route: { destination_queue: rule.queue, routing_rule: rule.id, routing_rationale: rule.why } } };`,
    [760, 190]
  ),

  /* --- Step 6: escalation (runs BEFORE the summary, on purpose) -------- */
  code(
    'Escalation Check',
    `// Step 6 - three triggers plus one calibration input. Runs before the
// summary so the briefing can tell the reader the record was held.
const THRESHOLD = 0.70;
const BILLING_USD = 500;
const PENALTY = 0.15;

if ($json._schema_error) {
  return { json: { ...$json, escalation: { escalated: true, reasons: ['schema_violation: ' + $json._schema_error],
    confidence_adjusted: 0, destination_queue: 'Human-Escalation', intended_queue: null } } };
}

const t = $json.triage;
const msg = $json.raw_message;
const reasons = [];

const OUTAGE = [/\\boutage\\b/i, /\\bdown for (all|every|multiple)\\b/i, /\\b(all|every) users?\\b/i,
  /\\bmultiple users?\\b/i, /\\bwidespread\\b/i, /\\bnobody can\\b/i, /\\bno one can\\b/i,
  /\\bcompletely (down|unavailable|broken)\\b/i, /\\bservice (is )?(down|unavailable)\\b/i];

const KEYWORDS = {
  'Billing Issue': [/\\binvoice\\b/i, /\\bcharge[ds]?\\b/i, /\\bbilling\\b/i, /\\brefund\\b/i, /\\bcontract rate\\b/i, /\\$\\s?[\\d,]+/],
  'Incident/Outage': OUTAGE,
  'Bug Report': [/\\berror\\b/i, /\\b[45]\\d{2}\\b/, /\\bbroken\\b/i, /\\bnot working\\b/i, /\\bfails?\\b/i, /\\bbug\\b/i],
  'Feature Request': [/\\bwe'?d love\\b/i, /\\bfeature\\b/i, /\\bability to\\b/i, /\\bplease add\\b/i, /\\bwould be (great|nice|useful)\\b/i, /\\bsupport for\\b/i],
  'Technical Question': [/\\bis there a way\\b/i, /\\bhow (do|can|would) (i|we)\\b/i, /\\bdoes .* support\\b/i, /\\bcan we\\b/i, /\\bevaluating\\b/i, /\\bnot sure if\\b/i],
};

// C1 - calibration cross-check: a self-reported confidence is a token
// prediction, not evidence. Penalise it when cheap lexical evidence disagrees.
const evidence = Object.entries(KEYWORDS).filter(([, ps]) => ps.some(p => p.test(msg))).map(([c]) => c);
let confidence = t.confidence;
if (evidence.length && !evidence.includes(t.category)) {
  confidence = Math.max(0, Math.round((confidence - PENALTY) * 100) / 100);
  reasons.push('calibration_mismatch: lexical evidence suggests ' + evidence.join('/') +
    ' but model chose ' + t.category + '; confidence reduced to ' + confidence.toFixed(2));
}

// E1 - low confidence
if (confidence < THRESHOLD) reasons.push('low_confidence: ' + confidence.toFixed(2) + ' is below the ' + THRESHOLD + ' threshold');

// E2 - blast radius
const hit = OUTAGE.find(p => p.test(msg));
if (hit) reasons.push('blast_radius: message matches outage language (' + hit.source + ') - needs an incident owner, not a queue');
else if (t.entities.affected_users === 'multiple') reasons.push('blast_radius: model reported multiple affected users');

// E3 - financial exposure on the DISPUTED amount, not the invoice total
const vals = (t.entities.amounts ?? []).map(a => Math.abs(Number(a.value))).filter(n => isFinite(n));
const disputed = vals.length === 0 ? 0 : vals.length === 1 ? vals[0] : Math.max(...vals) - Math.min(...vals);
if (t.category === 'Billing Issue' && disputed >= BILLING_USD)
  reasons.push('financial_exposure: disputed amount $' + disputed.toLocaleString() + ' meets the $' + BILLING_USD + ' review threshold');

const escalated = reasons.some(r => !r.startsWith('calibration_mismatch'));

return { json: { ...$json, escalation: { escalated, reasons, confidence_adjusted: confidence,
  destination_queue: escalated ? 'Human-Escalation' : $json.route.destination_queue,
  intended_queue: $json.route.destination_queue } } };`,
    [980, 190]
  ),

  /* --- Step 5: summary + record --------------------------------------- */
  code(
    'Build Briefing Prompt',
    `// The summary is written AFTER routing so it can address the team that
// actually receives it, and can say plainly when a record was held for review.
const SYSTEM = ${JSON.stringify(BRIEFING_SYSTEM_PROMPT)};
const e = $json.escalation;
const t = $json.triage ?? {};

const user = [
  'TRIAGE RECORD',
  'destination_queue: ' + e.destination_queue,
  'escalated_for_human_review: ' + e.escalated,
  'escalation_reasons: ' + JSON.stringify(e.reasons),
  'category: ' + (t.category ?? 'UNKNOWN - triage failed'),
  'priority: ' + (t.priority ?? 'High'),
  'confidence: ' + e.confidence_adjusted,
  'core_issue: ' + (t.core_issue ?? 'Automated triage failed for this message.'),
  'entities: ' + JSON.stringify(t.entities ?? {}),
  'urgency_signal: ' + (t.urgency_signal ?? 'elevated'),
  'suggested_next_action: ' + (t.suggested_next_action ?? 'Classify manually.'),
  '',
  'ORIGINAL MESSAGE (for tone and detail only, do not add new facts)',
  '"""', $json.raw_message, '"""',
  '',
  'Return the summary JSON now.'
].join('\\n');

return { json: { ...$json, groq_body: {
  model: ${JSON.stringify(SUMMARY_MODEL)}, temperature: 0.2, max_tokens: 800,
  reasoning_effort: ${JSON.stringify(REASONING_EFFORT)},
  response_format: { type: 'json_object' },
  messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
} } };`,
    [1200, 190]
  ),
  groqCall('Groq: Briefing', [1420, 190], 800, 0.2, SUMMARY_MODEL, 2000),
  code(
    'Assemble Record',
    `// Step 5 - the structured record a downstream team consumes.
const src = $('Escalation Check').item.json;
const t = src.triage ?? {};
const e = src.escalation;
const r = src.route ?? {};

let summary;
try {
  summary = JSON.parse($json.choices[0].message.content).summary;
} catch {
  summary = e.destination_queue + ': ' + (t.core_issue ?? 'Triage failed.') +
    ' Priority ' + (t.priority ?? 'High') + ' (confidence ' + e.confidence_adjusted + ').';
}

const SLA = e.destination_queue === 'Human-Escalation' ? 1 : ({ High: 4, Medium: 24, Low: 72 }[t.priority] ?? 24);

// Content-addressed id so a re-delivered message is idempotent. n8n's Code
// sandbox blocks node builtins, so this is a plain FNV-1a rather than SHA-256;
// the Node implementation uses SHA-256 and the ids are therefore not
// comparable across the two runtimes - noted in ARCHITECTURE.md.
const fnv = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
};
const key = src.source + '|' + src.raw_message;
const hash = fnv(key) + fnv(key.split('').reverse().join(''));

return { json: {
  record_id: 'rec_' + hash,
  request_id: src.id,
  source: src.source,
  received_at: src.received_at,
  processed_at: new Date().toISOString(),
  raw_message: src.raw_message,

  category: t.category ?? null,
  priority: t.priority ?? 'High',
  confidence: t.confidence ?? 0,
  confidence_adjusted: e.confidence_adjusted,

  category_scores: t.category_scores ?? null,
  runner_up_category: t.runner_up_category ?? null,
  decision_margin: t.decision_margin ?? null,

  core_issue: t.core_issue ?? null,
  entities: t.entities ?? null,
  urgency_signal: t.urgency_signal ?? 'elevated',
  urgency_evidence: t.urgency_evidence ?? [],
  customer_sentiment: t.customer_sentiment ?? 'neutral',
  ambiguity_notes: t.ambiguity_notes ?? null,
  suggested_next_action: t.suggested_next_action ?? 'Classify manually.',

  destination_queue: e.destination_queue,
  intended_queue: e.intended_queue,
  routing_rule: r.routing_rule ?? 'R-fail-safe',
  routing_rationale: r.routing_rationale ?? null,
  escalated_for_human_review: e.escalated,
  escalation_reasons: e.reasons,
  sla_target_hours: SLA,

  summary,
  pipeline: {
    prompt_version: src.prompt_version ?? ${JSON.stringify(PROMPT_VERSION)},
    model: src.model ?? ${JSON.stringify(MODEL)},
    summary_model: ${JSON.stringify(SUMMARY_MODEL)},
    llm_calls: 2,
    orchestrator: 'n8n',
    schema_error: src._schema_error ?? null,
  },
} };`,
    [1640, 190]
  ),

  /* --- fan-out to queues (Step 4 made visible) ------------------------- */
  {
    parameters: {
      rules: {
        values: [
          ['Human-Escalation', 'Human-Escalation'],
          ['Engineering', 'Engineering'],
          ['Billing', 'Billing'],
          ['Product', 'Product'],
          ['IT/Security', 'IT/Security'],
          ['Support-Tier1', 'Support-Tier1'],
        ].map(([value, key], i) => ({
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [
              {
                id: `cond-${i}`,
                leftValue: '={{ $json.destination_queue }}',
                rightValue: value,
                operator: { type: 'string', operation: 'equals' },
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: key,
        })),
      },
      options: { fallbackOutput: 'extra', renameFallbackOutput: 'Unrouted' },
    },
    id: uid('switch'),
    name: 'Switch: Destination Queue',
    type: 'n8n-nodes-base.switch',
    typeVersion: 3.2,
    position: [1860, 190],
  },
  noop('Human-Escalation Queue', [2100, -140]),
  noop('Engineering Queue', [2100, -20]),
  noop('Billing Queue', [2100, 100]),
  noop('Product Queue', [2100, 220]),
  noop('IT/Security Queue', [2100, 340]),
  noop('Support-Tier1 Queue', [2100, 460]),
  noop('Unrouted (should be empty)', [2100, 580]),

  /* --- persistence ------------------------------------------------------ */
  code(
    'Collect Records',
    `// Every queue branch converges here. Note that n8n runs a node once per
// incoming connection, so this node shows one run per queue that received a
// record rather than a single combined table - click through the runs to see
// all of them. A Merge node would combine them into one, at the cost of six
// more wires on the canvas; the JSON deliverable in output/records.json is
// the combined view, so the extra nodes did not earn their place here.
return $input.all();`,
    [2340, 190],
    'runOnceForAllItems'
  ),
  {
    parameters: {
      method: 'POST',
      url: 'https://webhook.site/REPLACE-WITH-YOUR-UUID',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'X-ArcVault-Queue', value: '={{ $json.destination_queue }}' },
          { name: 'X-ArcVault-Escalated', value: '={{ $json.escalated_for_human_review }}' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json) }}',
      options: {},
    },
    id: uid('http'),
    name: 'Mirror to Downstream (webhook.site)',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [2560, 190],
    disabled: true,
    notes: 'Disabled by default. Paste your webhook.site unique URL and enable to demo a downstream handoff.',
  },
];

/* ------------------------------------------------------------ connections */

const main = (to, index = 0) => ({ main: [[{ node: to, type: 'main', index }]] });

const connections = {
  'Manual Trigger (demo run)': main('Load 5 Sample Requests'),
  'Load 5 Sample Requests': main('Normalize Inbound'),
  'Webhook: /arcvault-intake': main('Normalize Inbound'),
  'Normalize Inbound': main('Build Triage Prompt'),
  'Build Triage Prompt': main('Groq: Triage'),
  'Groq: Triage': main('Validate Triage Output'),
  'Validate Triage Output': main('Route by Classification'),
  'Route by Classification': main('Escalation Check'),
  'Escalation Check': main('Build Briefing Prompt'),
  'Build Briefing Prompt': main('Groq: Briefing'),
  'Groq: Briefing': main('Assemble Record'),
  'Assemble Record': main('Switch: Destination Queue'),
  'Switch: Destination Queue': {
    main: [
      [{ node: 'Human-Escalation Queue', type: 'main', index: 0 }],
      [{ node: 'Engineering Queue', type: 'main', index: 0 }],
      [{ node: 'Billing Queue', type: 'main', index: 0 }],
      [{ node: 'Product Queue', type: 'main', index: 0 }],
      [{ node: 'IT/Security Queue', type: 'main', index: 0 }],
      [{ node: 'Support-Tier1 Queue', type: 'main', index: 0 }],
      [{ node: 'Unrouted (should be empty)', type: 'main', index: 0 }],
    ],
  },
  'Human-Escalation Queue': main('Collect Records'),
  'Engineering Queue': main('Collect Records'),
  'Billing Queue': main('Collect Records'),
  'Product Queue': main('Collect Records'),
  'IT/Security Queue': main('Collect Records'),
  'Support-Tier1 Queue': main('Collect Records'),
  'Unrouted (should be empty)': main('Collect Records'),
  'Collect Records': main('Mirror to Downstream (webhook.site)'),
};

const workflow = {
  // A stable top-level id: the n8n UI generates one on import, but the CLI
  // importer (`n8n import:workflow --input=...`) requires it and fails with
  // a NOT NULL constraint without it. Fixed rather than random so re-importing
  // updates the same workflow instead of creating duplicates.
  id: 'arcvault-triage-001',
  name: 'ArcVault - AI Intake & Triage',
  nodes,
  connections,
  active: false,
  settings: { executionOrder: 'v1' },
  pinData: {},
  tags: [],
  versionId: 'v1',
};

const out = new URL('../n8n/arcvault-triage.workflow.json', import.meta.url);
await writeFile(out, JSON.stringify(workflow, null, 2) + '\n', 'utf8');
console.log(`Wrote ${nodes.length} nodes -> n8n/arcvault-triage.workflow.json`);
