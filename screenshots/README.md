# Workflow screenshots

Six captures from the n8n execution, showing each step with its real output.
Capture instructions are in [../docs/N8N-SETUP.md](../docs/N8N-SETUP.md).

| File | Shows |
|---|---|
| `01-canvas.png` | The full workflow — 22 nodes, ingestion through the six-way queue fan-out |
| `02-triage-output.png` | `Groq: Triage` on REQ-005 — `category_scores`, entities, `urgency_evidence` quotes |
| `03-routing.png` | `Route by Classification` — the rule id and rationale that decided the queue |
| `04-escalation.png` | `Escalation Check` on REQ-005 — `escalation_reasons` spelled out |
| `05-record.png` | `Assemble Record` — the full structured record |
| `06-switch.png` | `Switch: Destination Queue` — all five records fanned out to their queues |
