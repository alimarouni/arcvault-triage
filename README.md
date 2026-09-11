# ArcVault — AI Intake & Triage Pipeline

Valsoft AI Engineer technical assessment. An agentic workflow that ingests
unstructured customer messages, classifies and enriches them with an LLM,
routes them to the right queue with deterministic rules, and holds anything
risky for a human.

Built twice on purpose: an **n8n workflow** for orchestration and an
operator-legible picture of the flow, and a **Node service** that holds the
logic and the tests. The n8n canvas is *generated* from the Node modules, so
the prompts and the routing policy exist in exactly one place.

---

## The five assessment inputs, end to end

| # | Source | Category | Priority | Confidence | Destination | Escalated |
|---|---|---|---|---|---|---|
| REQ-001 | Email | Bug Report | Medium | 0.94 | Engineering | — |
| REQ-002 | Web Form | Feature Request | Low | 0.94 | Product | — |
| REQ-003 | Support Portal | Billing Issue | Medium | 0.96 | Billing | — |
| REQ-004 | Email | Technical Question | Low | 0.94 | IT/Security | — |
| REQ-005 | Web Form | Incident/Outage | High | 0.94 | Engineering → **Human-Escalation** | blast radius |

5/5 against the hand labels in [`data/gold.json`](data/gold.json), zero
pipeline errors. Full records: [`output/records.json`](output/records.json).

Repeated 3× per fixture (`npm run eval`): **100% category accuracy, 100% queue
accuracy, 100% escalation accuracy, 100% run-to-run consistency.** Accuracy and
consistency are measured separately, because a prompt can be accurate on the
modal answer and still flip between runs — and every flip is a ticket in the
wrong queue.

Plus five adversarial cases I added ([`data/edge-cases.json`](data/edge-cases.json)),
because the assessment set contains no genuinely ambiguous input — including a
**prompt-injection attempt**, which the classifier ignores.

---

## Deliverables

| Assessment item | Where |
|---|---|
| 4.1 Working workflow | [`n8n/arcvault-triage.workflow.json`](n8n/arcvault-triage.workflow.json) (importable) + [`screenshots/`](screenshots/) + this repo runs end to end |
| 4.2 Structured output | [`output/records.json`](output/records.json), [`output/escalation-queue.json`](output/escalation-queue.json) |
| 4.3 Prompt documentation | [`docs/PROMPTS.md`](docs/PROMPTS.md) |
| 4.4 Architecture write-up | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |

---

## Run it

```bash
cp .env.example .env       # add your GROQ_API_KEY (free: console.groq.com)
npm install

npm test                   # 15 unit tests — no API key required
npm run batch              # the 5 fixtures      -> output/records.json
npm run edge               # the 5 edge cases    -> output/edge-cases/
npm run eval               # accuracy + run-to-run consistency
npm run serve              # webhook trigger on :3000
npm run build:n8n          # regenerate the n8n workflow from src/ (+ verify)
npm run verify:n8n         # assert the workflow agrees with the code
```

Webhook ingestion:

```bash
curl -X POST localhost:3000/intake -H "content-type: application/json" -d "{\"source\":\"email\",\"raw_message\":\"Invoice #9001 charged us twice this month.\"}"
```

Returns `202` with a `record_id` immediately and processes asynchronously — an
intake webhook that blocks on a two-call LLM pipeline is an intake webhook that
gets retried, which produces duplicate tickets.

---

## The six required steps

| Step | Implementation | LLM? |
|---|---|---|
| 1 Ingestion | webhook (`src/server.js`), batch file (`src/index.js`), n8n trigger | — |
| 2 Classification | `category_scores` over 5 categories + priority | **yes** (call 1) |
| 3 Enrichment | entities, urgency + verbatim evidence, `core_issue` | **yes** (same call) |
| 4 Routing | 6 ordered rules → 5 queues, total function | no |
| 6 Escalation | 3 triggers + a calibration cross-check | no |
| 5 Structured output | queue-aware summary, then persisted | **yes** (call 2) |

**Two LLM calls, not six.** Routing and escalation are business and risk
policy, not language problems: they must be deterministic, testable and
auditable, so they are pure functions covered by unit tests that run in 200ms
without an API key. The LLM decides *what the message is*; code decides *what
to do about it*. Argued in full in
[ARCHITECTURE.md §2](docs/ARCHITECTURE.md#2-where-the-llm-is-and-is-not).

---

## Three things worth a look

**The confidence score was broken and the fix was structural.** v1.2 asked the
model for a `confidence` float with an anchored rubric. It returned **0.96 for
all five fixtures** — including the one whose author opens with "I'm not sure
if this is the right place to ask". Since Step 6's low-confidence trigger keys
off that number, the escalation path was structurally dead while looking
perfect. v1.3 asks for a **probability distribution across all five
categories** instead and derives the decision, the confidence and the margin
from it — a comparative judgement rather than an introspective one. Confidence
now spans 0.40–0.96 and the trigger fires. Detail in
[PROMPTS.md](docs/PROMPTS.md#the-change-i-am-most-glad-i-made-distribution-instead-of-confidence).

**Escalation explains itself.** Every held record carries the trigger, the
values involved and the reason in plain English, plus `intended_queue` so the
reviewer can see where it would have gone:

> `"blast_radius: message matches outage language (\bmultiple users?\b) — needs an incident owner, not a queue"`

**Nothing is ever dropped.** If the model is unreachable or returns
unparseable output, the pipeline emits a complete record marked
`priority: High`, `escalated: true`, with the error attached, routed to
Human-Escalation. That path is not theoretical — it fired for all five inputs
on my first run (wrong model name) and still produced five well-formed,
actionable records instead of a stack trace.

---

## Repo layout

```
src/
  index.js            batch runner (file trigger)
  server.js           webhook ingestion, 202 + async processing
  pipeline.js         the 6-step orchestrator
  schema.js           LLM output validation: coerce the safe, fail the unsafe
  llm/prompts.js      BOTH prompts — single source of truth
  llm/client.js       provider-agnostic client: retries, timeout, token budget
  routing/rules.js    the routing table
  routing/escalation.js  escalation triggers + calibration cross-check
  sinks/index.js      file + webhook.site persistence
scripts/
  build-n8n.js        generates the n8n workflow from src/
  verify-n8n.js       simulates the n8n runtime; asserts both agree
  eval.js             accuracy AND run-to-run consistency
test/routing.test.js  15 tests, no API key needed
docs/                 PROMPTS.md, ARCHITECTURE.md, N8N-SETUP.md
```

**Model:** `openai/gpt-oss-120b` on Groq's free tier, with
`openai/gpt-oss-20b` for the summary call. The provider sits behind one
~60-line OpenAI-compatible module, so switching to OpenAI, Mistral or a local
Ollama is two environment variables.

*Built with Claude Code as a pair-programmer; every architectural decision,
and the diagnosis of the confidence collapse, is documented with its
reasoning in [`docs/`](docs/).*
