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

Expect roughly 2–4 minutes on the free tier: the Groq free plan caps
`gpt-oss-120b` at 8,000 tokens/minute and each record uses ~2,600 across two
calls. The HTTP nodes are configured with `retryOnFail`, 3 tries, 1.5s
between, which absorbs the 429s. If a node still exhausts its retries, click
**Execute Workflow** again — records are content-addressed, so re-running is
safe.

> The Node implementation handles this better: it paces itself with a rolling
> 60-second token budget instead of discovering the limit through 429s. n8n
> has no equivalent built-in, which is a genuine limitation of doing the
> orchestration there rather than in code — noted in ARCHITECTURE.md §6.

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
