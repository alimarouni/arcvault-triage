# Running the n8n workflow (10 minutes)

The workflow at [`../n8n/arcvault-triage.workflow.json`](../n8n/arcvault-triage.workflow.json)
is generated from the Node modules by `npm run build:n8n`, so it uses the same
prompts and the same routing and escalation policy as the code.

## 1. Start n8n

No Docker needed — n8n runs on Node directly:

```bash
npx n8n
```

First run downloads n8n (a few minutes). It then serves on
**http://localhost:5678**. Create the local owner account it asks for; it is
local-only and takes 20 seconds.

## 2. Import the workflow

1. Open http://localhost:5678
2. Top-right **⋯** menu → **Import from File**
3. Choose `n8n/arcvault-triage.workflow.json`

You should see 22 nodes laid out left to right.

## 3. Add the Groq credential

Both HTTP Request nodes (`Groq: Triage` and `Groq: Briefing`) use a generic
**Header Auth** credential.

1. Click **Groq: Triage**
2. Under *Credential for Header Auth* → **Create new credential**
3. Fill in:
   - **Name:** `Authorization`
   - **Value:** `Bearer gsk_your_key_here`  ← the word `Bearer`, a space, then the key
4. Save it as e.g. "Groq API"
5. Open **Groq: Briefing** and select the same credential from the dropdown

## 4. Run it

Click **Execute Workflow** (bottom centre). The Manual Trigger replays all
five assessment fixtures.

**Expect about 2 minutes.** The Groq free tier caps `gpt-oss-120b` at 8,000
tokens/minute and the triage call costs ~2.6k, so the `Groq: Triage` node is
configured to send **one request every 21 seconds**
(*Options → Batching*, batch size 1). Without that pacing n8n fires all five
items at once and everything after the second returns 429. `Groq: Briefing`
runs on the smaller model in a separate rate-limit bucket and is paced at 2s.
Both nodes also retry 5 times, 15s apart, as a safety net.

This whole path was verified headlessly before you touched it:

```
npx n8n import:workflow --input=n8n/arcvault-triage.workflow.json
npx n8n execute --id arcvault-triage-001
```

…which completed with `"status": "success"` and produced all five queues.

> The Node implementation paces itself better: a rolling 60-second budget over
> actual token usage, rather than a fixed interval. n8n can only space requests
> evenly. That is a real limitation of putting the orchestration in n8n rather
> than in code — noted in ARCHITECTURE.md §6.

## 5. What you should see

All five records flow through and fan out at **Switch: Destination Queue**:

| Output branch | Record |
|---|---|
| Engineering | REQ-001 |
| Billing | REQ-003 |
| Product | REQ-002 |
| IT/Security | REQ-004 |
| Human-Escalation | REQ-005 |
| Unrouted | *(empty — it exists so nothing can be dropped)* |

`Collect Records` runs **once per queue branch** that received a record, not
once overall — n8n executes a node once per incoming connection. Click through
the runs to see all five. The combined view is `output/records.json`.

## 6. Optional: a real downstream sink

1. Open https://webhook.site and copy your unique URL
2. In n8n open **Mirror to Downstream (webhook.site)**, paste it into *URL*
3. Enable the node (it ships disabled) and re-run

All five records POST to webhook.site with `X-ArcVault-Queue` and
`X-ArcVault-Escalated` headers — a live demo of the handoff to a ticketing
system.

## 7. The webhook trigger

The demo path uses the Manual Trigger. The production path is the **Webhook:
/arcvault-intake** node:

```bash
curl -X POST http://localhost:5678/webhook-test/arcvault-intake \
  -H "content-type: application/json" \
  -d '{"source":"email","raw_message":"Invoice #9001 charged us twice."}'
```

Click **Listen for test event** on the webhook node first, then send the
request.

---

## Screenshots to capture

Six shots, in this order:

1. **The full canvas**, zoomed to fit — shows all 22 nodes and the fan-out.
2. **`Groq: Triage` output** on REQ-005 — expand the JSON to show
   `category_scores`, entities and `urgency_evidence` with its verbatim quotes.
3. **`Route by Classification` output** — shows `routing_rule` and
   `routing_rationale`.
4. **`Escalation Check` output on REQ-005** — the `escalation_reasons` array
   with the blast-radius reason spelled out.
5. **`Assemble Record` output** — the complete structured record, all fields.
6. **`Switch: Destination Queue`** — the branch counts, showing REQ-005 going
   to Human-Escalation while the other four fan out normally.

Save them into `screenshots/` as `01-canvas.png` … `06-switch.png`.
