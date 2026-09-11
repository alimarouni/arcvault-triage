# Workflow screenshots

Captured from a completed n8n execution of
[`../n8n/arcvault-triage.workflow.json`](../n8n/arcvault-triage.workflow.json)
— `Success in 1m 53s`, five inbound messages, all 22 nodes green.

| File | What it shows |
|---|---|
| `01-canvas.png` | The full workflow: three ingestion triggers, two LLM calls, the deterministic routing and escalation steps, and the six-way queue fan-out |
| `02-triage-output.png` | `Groq: Triage` output — the raw belief distribution in `category_scores`, extracted entities, and `urgency_evidence` quoted verbatim from the message |
| `03-routing.png` | `Route by Classification` — the matched `routing_rule` and its `routing_rationale` |
| `04-escalation.png` | `Escalation Check` on REQ-005 — `escalation_reasons` naming the blast-radius trigger that overrode the normal queue |
| `05-record.png` | `Assemble Record` — the complete structured record a downstream team consumes |
| `06-switch.png` | `Switch: Destination Queue` — all five records fanned out to their queues, with `Unrouted` empty |

The same records, as JSON: [`../output/n8n-records.json`](../output/n8n-records.json)
(produced by the n8n workflow) and [`../output/records.json`](../output/records.json)
(produced by the Node implementation).
