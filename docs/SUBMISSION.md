# Submission checklist & email draft

## Before you send

- [ ] Push the repo to GitHub (public, or share with the recruiter)
- [ ] Add the 6 screenshots to `screenshots/` (see [N8N-SETUP.md](./N8N-SETUP.md))
- [ ] Confirm `.env` is **not** in the repo — `git ls-files | grep .env` should
      show only `.env.example`
- [ ] Replace `<GITHUB-URL>` in the email below
- [ ] Attach `output/records.json` directly to the email as well as linking it,
      so the reviewer can see the deliverable without cloning anything

## Email

**To:** your recruiting contact (Rahaf Sayegh)
**Subject:** `AI Engineer Assessment — Ali Marouni`

---

Hi Rahaf,

Thanks for sending this over — I enjoyed it. My submission is below.

**Repository:** <GITHUB-URL>

Everything is in that one repo:

| Deliverable | Where |
|---|---|
| 4.1 Working workflow | `n8n/arcvault-triage.workflow.json` (importable) + `screenshots/`, and the Node implementation runs end to end with `npm run batch` |
| 4.2 Structured output | `output/records.json` (attached to this email too) |
| 4.3 Prompt documentation | `docs/PROMPTS.md` |
| 4.4 Architecture write-up | `docs/ARCHITECTURE.md` |

**What I built.** An intake and triage pipeline covering all six steps, built
twice on purpose: an n8n workflow for orchestration and an operator-legible
picture of the flow, and a Node service that holds the logic and the tests.
The n8n canvas is generated from the Node modules, so the prompts and the
routing policy exist in exactly one place and cannot drift apart.

All five sample inputs process correctly and land in five different queues,
with REQ-005 diverted to human escalation on blast radius.

**Three decisions I would most like to talk through:**

1. **Two LLM calls, not six.** Classification and enrichment share one call;
   the summary is a second call that runs *after* routing, so it can address
   the receiving team by name and say what a human needs to decide. Routing
   and escalation have no LLM at all — they are business and risk policy, so
   they need to be deterministic, testable and auditable. They are pure
   functions covered by 15 unit tests that run in 200ms without an API key.

2. **My first prompt version was quietly broken and the fix was structural.**
   I asked the model for a confidence score with an anchored rubric. It
   returned 0.96 for all five inputs — including the one whose author opens
   with "I'm not sure if this is the right place to ask". Since the
   low-confidence escalation trigger keys off that number, the escalation path
   was structurally dead while the pipeline looked perfect. I changed the
   prompt to elicit a probability distribution across all five categories and
   derive the decision and confidence from it, which turns an introspective
   question the model can't answer into a comparative one it can. Confidence
   now spans 0.40–0.96 and the trigger works.

3. **I added five adversarial inputs**, because the sample set has no
   genuinely ambiguous message and I wanted to show the escalation paths
   firing for different reasons. One of them is a prompt-injection attempt
   that instructs the classifier to file a total outage as a low-priority
   feature request — a contact form is an untrusted input channel, and the
   classifier ignores it.

I've documented my assumptions where the brief left room for judgement — the
most significant is that I read "billing error > $500" as the *disputed*
amount rather than the invoice total, which is why the $1,240-vs-$980 sample
routes normally instead of escalating. That's a one-line change if ArcVault
would rather have it the other way, and both readings are unit tested.

I used Claude Code as a pair-programmer throughout, as you suggested. Happy to
walk through what it got wrong and what I had to correct — the confidence
collapse above is the most interesting example, and the reasoning behind every
architectural decision is written up in `docs/`.

Happy to do a live walkthrough if that's useful.

Best regards,
Ali Marouni

---

## Likely interview questions, and where the answer lives

| They'll ask | Your answer |
|---|---|
| Why not an LLM for routing? | ARCHITECTURE.md §2 — policy vs language; determinism, testability, auditability. 15 tests run without an API key. |
| What did the AI get wrong? | Three things, in increasing order of how much they mattered. (1) It targeted a Groq model that wasn't on my account — cheap to spot, the API said so. (2) It set `max_tokens: 220` on the summary call; `gpt-oss` spends reasoning tokens out of that budget, so the model returned an empty completion and the API reported it as `json_validate_failed` — a misleading error, since the JSON wasn't malformed, there wasn't any. (3) The real one: when I changed the triage prompt to emit a distribution, it updated the Node validator but not the n8n one. The workflow would have failed schema validation on all five records and dumped them into the fail-safe queue — a demo that looks catastrophically broken. I found it by writing `scripts/verify-n8n.js`, which simulates the n8n Code-node runtime and asserts the workflow reaches the same queues as the code. That's the lesson: two implementations need a test that they agree, not just a generator that claims they do. |
| Why is REQ-003 not escalated? | ARCHITECTURE.md §4 E3 — disputed delta ($260) vs gross ($1,240). Stated assumption, tested both ways, one constant to change. |
| How do you know the prompt is good? | `npm run eval` — reports accuracy **and** run-to-run consistency separately, because a prompt can be accurate and still flip between runs. |
| What breaks first at 10k/day? | ARCHITECTURE.md §6 — cost: ~2,576 tokens/record, ~74% of it a static prefix, so prompt caching first. Reliability: the missing durable queue between ingest and processing. |
| Why two implementations? | n8n gives orchestration and a picture an operator can read; code gives logic and tests. The canvas is generated from the code so they can't diverge. |
| What would you do first with another week? | Feedback capture — one field on the ticket asking whether triage was right. It's the labelled dataset, the drift monitor and the fine-tuning corpus. Nothing else compounds like it. |
