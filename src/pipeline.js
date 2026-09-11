/**
 * The orchestrator. Six steps, in order, for one inbound request.
 *
 *   1 Ingestion   - handled by the caller (server.js webhook or index.js batch)
 *   2 Classification  \
 *   3 Enrichment       }  one LLM call (see prompts.js for why)
 *   4 Routing         - pure function, no LLM
 *   6 Escalation      - pure function, no LLM (runs before 5 so the summary
 *                       can tell the reader it was held for review)
 *   5 Structured output - second LLM call writes the queue-aware summary,
 *                       then the record is persisted by the sinks
 *
 * Failure policy: a request never disappears. If the model is unreachable or
 * returns something unusable, we emit a degraded record routed to
 * Human-Escalation with the failure recorded on it.
 */

import { createHash } from 'node:crypto';
import { completeJson, llmConfig } from './llm/client.js';
import {
  TRIAGE_SYSTEM_PROMPT,
  BRIEFING_SYSTEM_PROMPT,
  buildTriageUserPrompt,
  buildBriefingUserPrompt,
  PROMPT_VERSION,
} from './llm/prompts.js';
import { validateTriage, SchemaError } from './schema.js';
import { routeByClassification, slaTargetHours, QUEUES } from './routing/rules.js';
import { assessEscalation } from './routing/escalation.js';

/** Content-addressed id: re-delivering the same message is idempotent. */
export function recordId(request) {
  return (
    'rec_' +
    createHash('sha256')
      .update(`${request.source}|${request.raw_message}`)
      .digest('hex')
      .slice(0, 16)
  );
}

export async function processRequest(request, { log: rawLog = console.log } = {}) {
  const log = (msg) => rawLog(`[${request.id}] ${msg}`);
  const startedAt = Date.now();
  const cfg = llmConfig();
  const pipeline = {
    prompt_version: PROMPT_VERSION,
    model: cfg.model,
    llm_calls: 0,
    total_tokens: 0,
    errors: [],
  };

  log(`ingest   <- ${request.source}: "${request.raw_message.slice(0, 58)}..."`);

  /* --- Steps 2 & 3: classification + enrichment ------------------------- */
  let triage;
  try {
    const { data, meta } = await completeJson({
      system: TRIAGE_SYSTEM_PROMPT,
      user: buildTriageUserPrompt(request),
      temperature: 0,
      maxTokens: 1600,
    });
    pipeline.llm_calls += 1;
    pipeline.total_tokens += (meta.prompt_tokens ?? 0) + (meta.completion_tokens ?? 0);
    pipeline.triage_latency_ms = meta.latency_ms;
    pipeline.triage_queued_ms = meta.queued_ms;
    triage = validateTriage(data);
    log(`classify -> ${triage.category} / ${triage.priority} / conf ${triage.confidence}` +
      (triage.runner_up_category ? ` (vs ${triage.runner_up_category} ${(triage.confidence - triage.decision_margin).toFixed(2)})` : ''));
  } catch (err) {
    const kind = err instanceof SchemaError ? 'schema_violation' : 'llm_unavailable';
    pipeline.errors.push(`${kind}: ${err.message}`);
    log(`!! ${kind} - emitting degraded record for human review`);
    return degradedRecord(request, kind, err, pipeline, startedAt);
  }

  /* --- Step 4: routing --------------------------------------------------- */
  const baseRoute = routeByClassification(triage);
  log(`route    -> ${baseRoute.destination_queue} (${baseRoute.routing_rule})`);

  /* --- Step 6: escalation (before the summary, on purpose) --------------- */
  const escalation = assessEscalation({
    triage,
    rawMessage: request.raw_message,
    baseRoute,
  });
  if (escalation.escalated) {
    log(`ESCALATE -> ${QUEUES.ESCALATION}: ${escalation.reasons.join(' | ')}`);
  }

  /* --- Step 5: queue-aware summary + final record ------------------------ */
  let summary;
  try {
    const { data, meta } = await completeJson({
      system: BRIEFING_SYSTEM_PROMPT,
      user: buildBriefingUserPrompt({
        request,
        triage,
        routing: {
          destination_queue: escalation.destination_queue,
          escalated: escalation.escalated,
          escalation_reasons: escalation.reasons,
        },
      }),
      temperature: 0.2, // a touch of freedom: this text is read by a human
      maxTokens: 800,
      // Model tiering: summarising a structured record is a far easier task
      // than classifying free text, so it runs on the smaller model. Cheaper,
      // faster, and on a separate provider rate-limit bucket - which is what
      // actually keeps a free-tier batch run inside its token budget.
      ...(process.env.LLM_SUMMARY_MODEL ? { model: process.env.LLM_SUMMARY_MODEL } : {}),
    });
    pipeline.llm_calls += 1;
    pipeline.total_tokens += (meta.prompt_tokens ?? 0) + (meta.completion_tokens ?? 0);
    pipeline.summary_latency_ms = meta.latency_ms;
    pipeline.summary_queued_ms = meta.queued_ms;
    summary = String(data.summary ?? '').trim();
  } catch (err) {
    // A missing summary must not sink an otherwise good record.
    pipeline.errors.push(`summary_failed: ${err.message}`);
    summary = `${escalation.destination_queue}: ${triage.core_issue} Priority ${triage.priority} (confidence ${escalation.confidence_adjusted}). Automated summary unavailable - see core_issue and entities.`;
  }

  pipeline.total_latency_ms = Date.now() - startedAt;

  return {
    record_id: recordId(request),
    request_id: request.id,
    source: request.source,
    received_at: request.received_at ?? null,
    processed_at: new Date().toISOString(),
    raw_message: request.raw_message,

    category: triage.category,
    priority: triage.priority,
    confidence: triage.confidence,
    confidence_adjusted: escalation.confidence_adjusted,

    category_scores: triage.category_scores,
    runner_up_category: triage.runner_up_category,
    decision_margin: triage.decision_margin,

    core_issue: triage.core_issue,
    entities: triage.entities,
    urgency_signal: triage.urgency_signal,
    urgency_evidence: triage.urgency_evidence,
    customer_sentiment: triage.customer_sentiment,
    ambiguity_notes: triage.ambiguity_notes,
    suggested_next_action: triage.suggested_next_action,

    destination_queue: escalation.destination_queue,
    intended_queue: escalation.intended_queue,
    routing_rule: baseRoute.routing_rule,
    routing_rationale: baseRoute.routing_rationale,
    escalated_for_human_review: escalation.escalated,
    escalation_reasons: escalation.reasons,
    sla_target_hours: slaTargetHours(triage.priority, escalation.destination_queue),

    summary,
    pipeline,
  };
}

/** Emitted when the LLM step cannot produce a usable record. */
function degradedRecord(request, kind, err, pipeline, startedAt) {
  pipeline.total_latency_ms = Date.now() - startedAt;
  return {
    record_id: recordId(request),
    request_id: request.id,
    source: request.source,
    received_at: request.received_at ?? null,
    processed_at: new Date().toISOString(),
    raw_message: request.raw_message,

    category: null,
    priority: 'High', // unknown work is treated as urgent until a human says otherwise
    confidence: 0,
    confidence_adjusted: 0,

    category_scores: null,
    runner_up_category: null,
    decision_margin: null,

    core_issue: null,
    entities: null,
    urgency_signal: 'elevated',
    urgency_evidence: [],
    customer_sentiment: 'neutral',
    ambiguity_notes: `Automated triage failed (${kind}).`,
    suggested_next_action: 'Classify manually and re-submit to the pipeline.',

    destination_queue: QUEUES.ESCALATION,
    intended_queue: null,
    routing_rule: 'R-fail-safe',
    routing_rationale: 'Triage could not complete; the request is never dropped.',
    escalated_for_human_review: true,
    escalation_reasons: [`${kind}: ${err.message.slice(0, 240)}`],
    sla_target_hours: 1,

    summary: `Human-Escalation: automated triage failed for this ${request.source} message (${kind}). The message is unclassified and needs manual review before it can be routed.`,
    pipeline,
  };
}
