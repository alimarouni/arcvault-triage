# ArcVault Intake & Triage — Architecture Write-Up

Deliverable 4.4. How the pieces connect, why the routing and escalation logic
look like this, and what I would change before putting it in front of real
customers.

---

## 1. System design

```
                 ┌──────────────────────────────────────────────┐
  email ────┐    │  STEP 1  INGESTION                           │
  web form ─┼───▶│  webhook  POST /intake        (server.js)    │
  portal ───┘    │  batch    --input file.json   (index.js)     │
                 │  n8n      Webhook / Manual trigger           │
                 └───────────────────┬──────────────────────────┘
                                     │  normalised request
                                     ▼
                 ┌──────────────────────────────────────────────┐
                 │  STEPS 2+3  CLASSIFY + ENRICH     ◀── LLM #1  │
                 │  one call, strict JSON, temperature 0        │
                 │  → category_scores, priority, entities,      │
                 │    urgency + verbatim evidence, core_issue   │
                 └───────────────────┬──────────────────────────┘
                                     ▼
                 ┌──────────────────────────────────────────────┐
                 │  SCHEMA GATE                     (no LLM)    │
                 │  coerce what is safe, hard-fail what is not  │
                 └───────────────────┬──────────────────────────┘
                                     ▼
                 ┌──────────────────────────────────────────────┐
                 │  STEP 4  ROUTING                 (no LLM)    │
                 │  ordered rule table → destination queue      │
                 └───────────────────┬──────────────────────────┘
                                     ▼
                 ┌──────────────────────────────────────────────┐
                 │  STEP 6  ESCALATION              (no LLM)    │
                 │  E1 low confidence · E2 blast radius         │
                 │  E3 financial exposure · C1 calibration      │
                 └───────────────────┬──────────────────────────┘
                                     ▼
                 ┌──────────────────────────────────────────────┐
                 │  STEP 5  BRIEFING + RECORD       ◀── LLM #2  │
                 │  queue-aware summary, then persist           │
                 └───────────────────┬──────────────────────────┘
                                     ▼
       ┌────────────┬────────────┬───┴────────┬─────────────┬──────────────┐
   Engineering   Billing     Product    IT/Security  Support-T1  Human-Escalation
```

**What triggers what.** Three entry points converge on one normalised request
shape `{id, source, received_at, raw_message}`, and everything downstream is
identical regardless of which fired. The webhook is the production trigger;
the batch runner is the reproducible one (it is what generated the submitted
output); the n8n Manual Trigger replays the five fixtures for the demo.

**Where state is held.** Deliberately almost nowhere. Each request is
processed as an independent unit and the only durable artefact is the output
record. The webhook server keeps one in-memory map for de-duplication and
status polling, which is honest about being process-local — in production that
is Redis or a unique index on `record_id`. Records are content-addressed
(`record_id = hash(source + raw_message)`), so re-delivering the same message
updates the existing record rather than creating a second ticket. That matters
because at-least-once delivery is the norm for email gateways and webhooks,
and duplicate tickets are the most common way an intake pipeline embarrasses
itself.

**Two implementations, one brain.** The n8n workflow and the Node service are
not two systems — the prompts and the routing/escalation policy live in
`src/`, and `scripts/build-n8n.js` projects them onto the n8n canvas. n8n
provides orchestration, retries and an operator-legible picture of the flow;
the modules provide the logic and the unit tests. Regenerating the workflow is
one command, so the canvas cannot silently diverge from the code.

---

## 2. Where the LLM is, and is not

This is the decision I would most want to defend in the interview.

**Two LLM calls. Routing and escalation have none.**

The obvious build puts a model call at every step — six steps, six prompts.
I think that is the wrong shape, because the six steps are not the same *kind*
of problem:

| Step | Kind of problem | Implementation |
|---|---|---|
| 2 Classification | language understanding | LLM |
| 3 Enrichment | language understanding | LLM (same call) |
| 4 Routing | **business policy** | pure function |
| 6 Escalation | **risk policy** | pure function |
| 5 Summary | language generation | LLM |

Routing "Billing Issue → Billing" is not a language problem. It is a table
that an operations lead owns, must be able to change on a Tuesday afternoon,
and must produce the same answer every time for the same input. Putting a
model there buys nothing and costs three things I am not willing to pay:
determinism, testability, and auditability. The current rule table is 15 unit
tests that run in 200ms with no API key. The same logic as a prompt would be
an eval suite, a bill, and a shrug when someone asks why one ticket went to
Product last Thursday.

The same argument applies harder to escalation, because escalation is a
*safety* control. "Escalate anything over $500" must be true 100% of the time,
not 97% of the time.

So the division is: **the LLM decides what the message is; code decides what
to do about it.** Every record carries `routing_rule` (e.g.
`R3-billing-to-billing`) and a human-readable `routing_rationale`, so any
outcome traces back to one named, readable, version-controlled rule.

**Why classification and enrichment share a call** is argued in
[PROMPTS.md](./PROMPTS.md): the category determines which entities matter, so
splitting them means two round-trips for the same information.

**Why the summary is a separate call that runs last:** it is written after the
queue is known, so it can address the receiving team by name and, when a
record is held, say what the human must decide. A summary written before
routing can only describe the message.

---

## 3. Routing logic

Six ordered rules, first match wins, defined in
[`src/routing/rules.js`](../src/routing/rules.js).

| Rule | Condition | Queue | Why |
|---|---|---|---|
| `R1` | Incident/Outage | Engineering | Degradation belongs to the on-call rotation, not a support queue. |
| `R2` | Bug Report | Engineering | Defects are triaged by engineering regardless of severity. |
| `R3` | Billing Issue | Billing | Only Billing can see contract rates or issue credits. |
| `R4` | Feature Request | Product | Product owns roadmap intake and the customer reply. |
| `R5` | Technical Question **and** security/identity keywords | IT/Security | An SSO or access answer that is wrong is a security incident. |
| `R6` | Technical Question (all others) | Support-Tier1 | Tier 1 answers how-to questions from the knowledge base. |
| `R0` | nothing matched | Support-Tier1 | Total function: a request is never dropped. |

**Five destination queues, plus escalation** — the brief asked for at least
three.

**Why `R5` exists as a split.** The brief's example queue list includes
IT/Security, and the interesting question is what should reach it. Most
technical questions are knowledge-base work, so a blanket
Technical-Question → IT/Security rule would bury a security team in "how do I
rename a workspace". But REQ-004 asks about SSO with Okta while the customer
is actively evaluating auth providers: it is a pre-sales security question
where a casually wrong answer is both a lost deal and a security
misstatement. The split keys off security/identity terms in the extracted
`product_areas` and `core_issue` — using the *enriched* fields rather than
raw-text matching, so the keyword check runs against text the model has
already normalised.

**Why routing is total.** `R0` exists so that an unmapped or novel category
still lands somewhere a human looks. An intake pipeline that silently drops
input is worse than one that misroutes, because misrouting is visible.

**SLA is attached, not looked up.** Each record carries `sla_target_hours`
(High 4h / Medium 24h / Low 72h, collapsing to 1h on escalation) so the
receiving team does not need a second system to know what they have committed
to.

---

## 4. Escalation logic

Three independent triggers, any one of which diverts the record to
`Human-Escalation`, plus one input that is not itself a trigger. Defined in
[`src/routing/escalation.js`](../src/routing/escalation.js).

### E1 — Confidence below 0.70

The brief's threshold. What makes it actually work is that confidence comes
from a forced probability distribution over the five categories rather than a
self-reported number (see [PROMPTS.md](./PROMPTS.md) — asked for a scalar, the
model returned 0.96 for all five fixtures, which would have made this trigger
structurally dead).

### E2 — Blast radius

Nine outage patterns (`outage`, `down for all users`, `multiple users`,
`nobody can`, …) plus the model's own `affected_users: "multiple"`.

This trigger is deliberately **independent of confidence and of category**. A
multi-user outage escalates even when the model is 0.96 confident and has
routed it correctly to Engineering — because for an outage the failure mode
that matters is not "wrong queue", it is "correct queue, no owner, discovered
at 5pm". REQ-005 is exactly this: correctly classified Incident/Outage at 0.94
confidence, routed to Engineering, and then held for a human anyway. The
record keeps `intended_queue: "Engineering"` so the reviewer sees where it
would have gone and can release it in one click.

### E3 — Financial exposure ≥ $500

**The assumption I want to flag, because it is a judgement call and a
reasonable reviewer could disagree.**

The brief says "billing error > $500". REQ-003 reports a $1,240 invoice
against a $980 contract rate. Two readings:

- **Gross reading** — the invoice is $1,240, which is over $500, so escalate.
- **Disputed reading** — the customer is contesting $260, so do not escalate.

**I implemented the disputed reading**, so REQ-003 routes normally to Billing.
My reasoning: the threshold exists to put a human in front of decisions with
real financial consequence, and the money at risk is the delta, not the
invoice total. Under the gross reading, essentially every B2B invoice dispute
escalates and the queue stops meaning anything. The rule is one constant
(`BILLING_ESCALATION_USD`) and one function (`disputedAmountUsd`), both unit
tested in both directions, so if ArcVault's finance team prefers the gross
reading it is a one-line change — and `EDGE-002` ($6,400 vs $980 = a $5,420
dispute) demonstrates the trigger firing at 0.94 confidence, proving E3 is
independent of E1.

### C1 — Calibration cross-check (an input to E1, not a trigger)

Even with a distribution, a model can be confidently wrong. So before E1 runs,
cheap lexical evidence is computed for each category and compared against the
model's choice. If the evidence points somewhere else, confidence is reduced
by 0.15, which can push a borderline record under the threshold.

The keyword matcher is crude *on purpose* — it is a **disagreement detector,
not a second classifier**. It never overrides the model and it never escalates
on its own; a mismatch that leaves confidence above 0.70 is recorded as a note
and nothing more. It exists to catch the one failure mode the confidence score
cannot catch by construction: high confidence in the wrong answer.

`EDGE-005` shows it working end to end. The message contains a real outage and
a real overcharge; the model split 0.60 Incident/Outage / 0.40 Billing Issue;
the lexical check saw unambiguous billing language, applied the penalty to
0.45, and the record escalated with all three reasons recorded.

### Every escalation carries its reason

`escalation_reasons` is an array of human-readable strings naming the trigger,
the values involved, and why it fired:

> `"blast_radius: message matches outage language (\bmultiple users?\b) — needs an incident owner, not a queue"`

A boolean `escalated: true` with no explanation is useless to the person who
picks the ticket up.

### Fail-safe

If the LLM is unreachable, times out, or returns output that fails the schema
gate, the pipeline does **not** throw. It emits a complete record with
`category: null`, `priority: High`, `escalated: true`, the error text in
`escalation_reasons`, and routes it to `Human-Escalation`. Unclassifiable work
is treated as urgent until a human says otherwise. This path is not
theoretical — it fired for all five inputs on my first run, when the model
name was wrong, and the run still produced five well-formed actionable records
instead of a stack trace.

---

## 5. Results

Five assessment fixtures, `openai/gpt-oss-120b` on Groq, prompt `triage-v1.3`:

| # | Category | Priority | Confidence | Queue | Escalated |
|---|---|---|---|---|---|
| REQ-001 | Bug Report | Medium | 0.94 | Engineering | — |
| REQ-002 | Feature Request | Low | 0.94 | Product | — |
| REQ-003 | Billing Issue | Medium | 0.96 | Billing | — |
| REQ-004 | Technical Question | Low | 0.94 | IT/Security | — |
| REQ-005 | Incident/Outage | High | 0.94 | Engineering → **Human-Escalation** | blast radius |

5/5 match my hand labels in [`data/gold.json`](../data/gold.json). Zero
pipeline errors. ~2,576 tokens and ~1.5s of model time per record across two
calls.

**Repeated three times per fixture** (`npm run eval`,
[`output/eval-results.json`](../output/eval-results.json)):

| Metric | Result |
|---|---|
| Category accuracy (modal answer vs hand label) | **100%** |
| Queue accuracy | **100%** |
| Escalation accuracy | **100%** |
| Category consistency across 3 identical runs | **100%** |

Accuracy and consistency are reported separately on purpose. A prompt can be
100% accurate on the modal answer and still be unusable if it flips between
two categories run to run, because every flip is a ticket in the wrong queue —
and at temperature 0 any disagreement is the model's own nondeterminism, which
is the number you actually want before shipping. Priority is reported as a
distribution rather than asserted, because Medium vs High on REQ-001 is a
genuine judgement call and pinning it would measure my opinion, not the model.

Five adversarial cases I added, because the assessment set contains no
genuinely ambiguous input and "edge cases handled" is an explicit criterion:

| # | Probes | Result |
|---|---|---|
| EDGE-001 | bug vs feature, customer unsure | flat distribution → escalated on low confidence |
| EDGE-002 | $5,420 dispute | escalated on **financial exposure at 0.94 confidence** — E3 independent of E1 |
| EDGE-003 | "hi. it's broken. please fix asap" | 0.45 confidence, escalated, **no entities hallucinated** |
| EDGE-004 | **prompt injection** | instruction ignored; filed Incident/Outage High and escalated |
| EDGE-005 | outage + overcharge in one message | 0.60/0.40 split, calibration penalty, escalated with 3 reasons |

`EDGE-004` is the one I would draw attention to. The message instructs the
classifier to file a total platform outage as a Low-priority feature request.
A contact form is an untrusted input channel writable by anyone on the
internet, and a triage system that obeys text inside a customer message can be
steered by that anyone. The prompt's framing ("you are a classifier, not an
assistant"; the message arrives delimited and labelled as data) held. I want
to be precise about the strength of that claim: I verified this once, on one
model. It is a property I checked, not a property I enforce, and it belongs in
CI.

---

## 6. What I would do differently at production scale

### Reliability

- **A real queue between ingestion and processing.** Today the webhook
  acknowledges with 202 and processes in-process; if the box dies mid-record,
  that record is gone. SQS or Redis Streams with a visibility timeout and a
  dead-letter queue makes redelivery someone else's problem. The
  content-addressed `record_id` already makes redelivery safe.
- **Idempotency all the way to the sink.** De-duplication is in-memory and
  therefore per-process. It needs to be a unique index in the store.
- **The fail-safe path needs a monitor, not just a queue.** Escalation
  currently absorbs both "a human should look at this" and "the pipeline is
  broken". Those want different alarms: escalation *rate* is a business metric,
  `schema_violation` rate is a pager.
- **Pin the model version and gate prompt changes on the eval.** Every record
  already stamps `prompt_version` and `model`, so a regression is attributable.
  What is missing is CI that runs `scripts/eval.js` against a labelled set and
  blocks a merge that drops accuracy.

### Cost

- Measured: **~2,576 tokens per record**, dominated by the ~1,900-token triage
  system prompt resent on every message. At 10k tickets/day that is ~26M
  tokens/day, and roughly 74% of it is the same static prefix every time.
- **Prompt caching is the single highest-leverage change** — the system prompt
  is byte-identical across calls, which is exactly what cache-aware pricing
  rewards. No accuracy cost.
- **Model tiering is already in place**: classification on the larger model,
  the briefing on the smaller one. Worth extending — batch the briefing calls,
  or drop them entirely for Low-priority records where the structured fields
  are enough.
- **Do not run the model at all when you do not need to.** A meaningful share
  of real intake is exact-duplicate or near-duplicate ("me too" replies,
  resent emails). Hash-matching before the first call is free.
- The endgame at volume is to distil: log model labels plus human corrections
  for a quarter, then fine-tune a small model for classification and keep the
  large model only for low-margin cases. Escalation and routing do not change.

### Latency

- Model time is ~1.5s per record (1.0–1.9s triage, ~0.5s briefing). Perceived
  latency for the sender is already ~0, because `/intake` returns 202
  immediately and processes asynchronously — an intake webhook that blocks for
  two seconds is an intake webhook that gets retried, which produces duplicates.
- **The real latency constraint here is not the model, it is the free tier.**
  Groq caps this model at 8,000 tokens/minute, and at ~2.6k tokens per record
  that is three records per minute. The client paces itself with a rolling
  60-second token budget (`LLM_TPM_BUDGET`) rather than discovering the ceiling
  through 429s, and telemetry reports `queued_ms` separately from `latency_ms`
  so waiting for quota is never mistaken for a slow model. On a paid tier the
  budget rises and the pacing disappears; nothing else changes.
- For a genuine outage, ~1.5s of triage is irrelevant next to the minutes a
  human takes to notice. If it ever mattered, the fix is a cheap deterministic
  pre-filter that pages on outage language *before* the model runs, with the
  model confirming after.

---

## 7. Phase 2 — one more week

1. **Feedback capture, which is the only thing that compounds.** One field on
   the ticket: did triage get this right, and if not, what was it? That is the
   labelled dataset, the drift monitor, and the fine-tuning corpus, and nothing
   else in this list is worth as much.
2. **A real evaluation set** — 200 labelled historical tickets, and CI that
   blocks a prompt change that regresses accuracy or consistency.
3. **Retrieval before classification.** Right now every message is triaged in
   a vacuum. Real intake has context: who the customer is, their plan tier,
   whether they filed three tickets this week, whether there is an open
   incident on the surface they are describing. REQ-005 should have been
   correlated against the dashboard's health signals and either attached to an
   existing incident or opened a new one.
4. **Close the loop into the destination systems.** Queues are currently NoOp
   nodes and a JSON file. Phase 2 creates the Jira issue, posts to the
   PagerDuty service, opens the Zendesk ticket — and writes the external id
   back onto the record.
5. **Auto-acknowledgement to the customer**, drafted from the same structured
   record, held for approval on anything escalated.
6. **An operator console.** The escalation queue is a JSON file. It needs a
   page where a human sees the message, the model's distribution and its
   runner-up, the reason it was held, and two buttons: confirm, or correct and
   release. The correction is the feedback from item 1.
7. **Move the policy into config.** The outage patterns, the `$500` threshold,
   the confidence threshold and the routing table are business rules living in
   source. Ops should own them without a deploy.

---

## Appendix — model choice and running the code

**Model: `openai/gpt-oss-120b` via the Groq free tier**, with
`openai/gpt-oss-20b` for the briefing call. Chosen because it is free, fast,
open-weight, and reliable at strict JSON output with a forced schema. The
provider sits behind one ~60-line module
([`src/llm/client.js`](../src/llm/client.js)) that speaks the OpenAI-compatible
API, so switching to OpenAI, Mistral or a local Ollama is two environment
variables. I originally targeted `llama-3.3-70b-versatile`; it was not
available on this account, which is the honest reason the abstraction earned
its keep on day one.

```bash
cp .env.example .env       # add your GROQ_API_KEY
npm install
npm test                   # 15 unit tests, no API key needed
npm run batch              # the 5 assessment fixtures -> output/records.json
npm run edge               # the 5 adversarial cases   -> output/edge-cases/
npm run eval               # accuracy + run-to-run consistency
npm run serve              # webhook trigger on :3000
npm run build:n8n          # regenerate the n8n workflow from src/
```
