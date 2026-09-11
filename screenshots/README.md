# Workflow screenshots

Captured from a completed execution of
[`../n8n/arcvault-triage.workflow.json`](../n8n/arcvault-triage.workflow.json)
— five inbound messages, `Success in 1m 53s`.

| File | What it shows |
|---|---|
| `01-canvas.png` | The full workflow: two ingestion triggers (manual replay + webhook), the two LLM calls, the deterministic routing and escalation steps between them, and the six-way queue fan-out. |
| `02-triage-output.png` | `Groq: Triage`. Left: the assembled request, including `reasoning_effort: low` and JSON mode. Right: the raw model output for REQ-001 — the belief distribution `Bug Report 0.94 / Technical Question 0.03 / Feature Request 0.01 / Billing Issue 0.01 / Incident-Outage 0.01`, which is what the confidence and decision margin are derived from. |
| `03-routing.png` | `Route by Classification`. The ordered rule table in the middle pane, and on the right the derived `category`, `confidence`, `runner_up_category: Technical Question` and `decision_margin: 0.91`. No LLM call in this step. |
| `04-escalation.png` | `Escalation Check`. The three escalation triggers and the calibration cross-check, with the thresholds visible as constants (`THRESHOLD = 0.70`, `BILLING_USD = 500`, `PENALTY = 0.15`). Shown on REQ-001, which passes all three and is not escalated. |
| `05-record.png` | `Assemble Record`. Left: the briefing model's summary. Right: the complete structured record a downstream team consumes — category, priority, both confidence values, the score distribution, entities, routing and escalation fields. |
| `06-switch.png` | `Switch: Destination Queue`. The output tabs show the fan-out — `Human-Escalation (1)`, `Engineering (1)`, `Billing (1)`, `Product (1)` … — with REQ-005 open in the Human-Escalation branch: an `Incident/Outage` at `0.94` confidence, diverted from Engineering on blast radius rather than on low confidence. |

The same records as JSON: [`../output/n8n-records.json`](../output/n8n-records.json)
(from the n8n workflow) and [`../output/records.json`](../output/records.json)
(from the Node implementation).
