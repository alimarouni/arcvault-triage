# Prompt Documentation

Deliverable 4.3. Every prompt in the pipeline, why it is shaped that way, what
I traded away, and what I would change with more time.

The prompts live in [`src/llm/prompts.js`](../src/llm/prompts.js) and nowhere
else. The n8n workflow is **generated** from that file by
[`scripts/build-n8n.js`](../scripts/build-n8n.js), so the orchestrator and the
code implementation cannot drift apart. A prompt that exists in two places is
a prompt that is wrong in one of them within a week.

There are **two** LLM calls, not six. Which steps get a model call, and which
get plain code, is the single most consequential design decision in this
assessment, so it is argued in full in
[ARCHITECTURE.md §2](./ARCHITECTURE.md#2-where-the-llm-is-and-is-not).

---

## Prompt 1 — Triage (classification + enrichment)

**Where:** `TRIAGE_SYSTEM_PROMPT`, covering assessment Steps 2 and 3.
**Settings:** `temperature 0`, `response_format: json_object`, `max_tokens 1600`,
`reasoning_effort: low`.
**Version:** `triage-v1.3` (stamped onto every record as `pipeline.prompt_version`).

### Structure

| Section | Purpose |
|---|---|
| Role line | "You are a classifier, not an assistant" — kills the instinct to greet, apologise or offer solutions. |
| `# CATEGORIES` | The five labels, each with a one-line operational definition rather than just a name. |
| `# DISAMBIGUATION RULES` | An **ordered** first-match-wins list for the pairs that actually collide. |
| `# PRIORITY RUBRIC` | Impact-anchored, with an explicit instruction that tone is not impact. |
| `# CATEGORY SCORES` | A forced probability distribution across all five categories (see below). |
| `# ENTITY EXTRACTION` | Field-by-field, with "never invent" stated and `null` made the correct answer. |
| `# URGENCY SIGNAL` | A level plus **verbatim quotes** as evidence. |
| `# OUTPUT CONTRACT` | The exact JSON keys, "and no others". |
| `# WORKED EXAMPLE` | One full input/output pair. |

### Why it is shaped this way

**Ordered disambiguation rules instead of category descriptions alone.** The
five categories overlap in exactly the places this dataset probes. REQ-005 is
a bug *and* an outage. REQ-003 could be read as a billing complaint or a
software defect producing a wrong number. REQ-004 asks for something that does
not exist, which is both a question and a feature request. Descriptions alone
leave the model to break those ties differently each time. An ordered list
makes the tie-break a stated policy — blast radius beats defect, money beats
mechanism, a question beats the feature it implies — so the behaviour is
predictable and, more importantly, *arguable*. When a business stakeholder
disagrees with a routing outcome, I can point at rule 2 and change rule 2.

**Priority is decoupled from tone.** Support text is emotional and models
reward emotion with severity. REQ-005 is calm and is the real emergency;
REQ-003 is polite and involves money. The rubric defines priority purely by
blocked work, revenue/compliance exposure and user count, and then says
outright that priority is not how emotional the message sounds.

**Entities are extract-only, with `null` made explicit.** The failure mode I
care about is a plausible hallucinated identifier: an invented account id in a
ticket is worse than an absent one, because a human will act on it. So the
prompt says "only identifiers that literally appear", "never invent, normalise
or complete", and makes `null`/`[]` the *correct* answer for an absent field
rather than a failure. In every run, REQ-002 and REQ-004 correctly returned
`account_id: null` rather than guessing from the sender domain.

**Urgency must be quoted, not asserted.** `urgency_evidence` holds verbatim
spans from the message. This is cheap grounding: it is measurably harder for a
model to fabricate an urgency level when it has to produce the words that
justify it, and the reviewer gets to audit the judgement in one glance. On
REQ-005 it returned `["Your dashboard stopped loading for us around 2pm EST.",
"Multiple users affected."]` — which is the whole argument for High priority,
shown rather than claimed.

**One worked example, and not one of the five fixtures.** A single example
pins the output shape and the terseness of `core_issue`. I deliberately used a
sixth, invented message (a CSV import error) rather than one of the assessment
inputs, because few-shotting on your eval set measures the example, not the
prompt.

### The change I am most glad I made: distribution instead of confidence

**v1.2 asked the model for a `confidence` float with a five-band rubric and
an explicit "do not default to 0.9".** It returned **0.96 for all five
fixtures.** Not roughly similar — identical, including for REQ-004, whose
author literally opens with "I'm not sure if this is the right place to ask".

That is not a tuning problem, it is a category error on my part. A
self-reported confidence is a token prediction shaped by how confident the
*prose* sounds, not a measurement of anything. And because Step 6's
low-confidence trigger keys off that number, a collapsed confidence silently
disables the entire human-escalation path. The pipeline would have looked
perfect on these five inputs while being structurally unable to escalate.

**v1.3 asks instead for `category_scores`: 1.00 of belief distributed across
all five categories, summing to 1.** The code takes argmax as the decision,
its score as the confidence, and the gap to the runner-up as
`decision_margin`. This works because it converts an introspective question
the model cannot answer ("how sure are you?") into a comparative one it
answers well ("how does Bug Report compare to Feature Request here?").

Measured effect, same model, same temperature, same fixtures:

| | v1.2 | v1.3 |
|---|---|---|
| Confidence on the 5 fixtures | 0.96, 0.96, 0.96, 0.96, 0.96 | 0.92 – 0.96 |
| Confidence on the 5 edge cases | *(not run)* | **0.40 – 0.96** |
| Records that escalate on low confidence | 0 (structurally impossible) | 2 of 5 edge cases |

The edge-case suite is the real evidence. `EDGE-003` ("hi. it's broken. please
fix asap. thanks") scores **0.45** and escalates. `EDGE-005`, which contains a
genuine outage *and* a genuine overcharge, splits **0.60 / 0.40** between
Incident/Outage and Billing Issue — which is the correct description of that
message. The number finally carries information.

As a bonus, `runner_up_category` is free once you have a distribution, and it
is genuinely useful downstream: it tells the human reviewer what the second
opinion was without another model call.

### Tradeoffs I accepted

- **The prompt is long (~1,900 tokens) and it is resent on every message.**
  At 10k tickets/day that is the dominant cost line. I took the hit because
  accuracy on ambiguous input is the whole point of the exercise, and because
  the fix is known and boring (see Phase 2: prompt caching, then distil to a
  fine-tuned small model once you have labelled volume).
- **Classification and enrichment share one call.** Splitting them would let
  me tune each independently and retry them independently. They are merged
  because the category determines which entities matter, so a split forces the
  extraction step to either re-read the message blind or receive the category
  anyway — two round-trips for the same information. I would revisit this only
  if entity extraction needed a different (cheaper) model than classification.
- **Five categories, no "Other".** The assessment fixes the five. A real
  deployment needs an explicit "Unclassifiable" label, because forcing a
  distribution over five wrong options produces a flat distribution that
  *looks* like ambiguity between five real things. Today the low-confidence
  path catches this case correctly but describes it imprecisely.
- **`reasoning_effort: low`.** Required, not chosen: `gpt-oss` models spend
  internal reasoning tokens out of `max_tokens`, and at the default setting
  the briefing call burned its entire budget thinking and returned an empty
  completion, which the API rejects as `json_validate_failed`. Worth knowing
  that "the model returned nothing" and "the model returned bad JSON" can be
  the same error code.

---

## Prompt 2 — Briefing (the human-readable summary)

**Where:** `BRIEFING_SYSTEM_PROMPT`, covering the summary half of Step 5.
**Settings:** `temperature 0.2`, `response_format: json_object`, `max_tokens 800`,
on the **smaller** model (`gpt-oss-20b`).

### Why it is a separate call, and why it runs last

The summary is written **after** routing and escalation have been decided, and
that ordering is the point. A summary written before routing can only describe
the message. A summary written after routing can be addressed to the specific
team that is about to read it, justify why it arrived in their queue, and — if
the record was held — say plainly what the human has to decide.

Compare the two things the pipeline actually produces for REQ-005:

> `core_issue` (from Prompt 1, audience-neutral):
> "Dashboard fails to load for multiple users since around 2pm EST."

> `summary` (from Prompt 2, written for the queue it landed in):
> "Human-Escalation queue: Dashboard fails to load for multiple users since
> around 2pm EST. It landed here at High priority because the system detected
> outage language and flagged it for human review. A human must decide whether
> to assign an incident owner and confirm the scope before the team acts."

The second is the one that saves the on-shift engineer thirty seconds, and it
is only writable because routing already happened.

### Why it is shaped this way

- **The reader is specified, not implied.** "An on-shift engineer, billing
  analyst or product manager who has 10 seconds and has never seen this
  customer before." Naming the reader does more for output quality than any
  number of style adjectives.
- **A fixed three-beat structure** (what happened → why this queue at this
  priority → what the human must decide, if held). Ordering the sentences
  removes the main source of variance in free-text generation.
- **It is fed the structured record, not just the raw message.** The raw
  message is passed too, but explicitly labelled "for tone and detail only, do
  not add new facts". The summary is a *rendering* of the record; anything in
  it that is not in the record is a hallucination by definition, which makes
  the failure easy to spot in review.
- **A hard "do not state the category as settled" rule for escalated
  records.** Without it the model writes confident prose about a classification
  the system has explicitly declined to trust, which is precisely the wrong
  signal to send a reviewer.
- **Temperature 0.2, not 0.** This is the only output a human reads as prose.
  A little freedom reads better, and there is no downstream parser to break —
  the JSON wrapper is the contract, the sentence inside it is not.
- **It runs on the smaller model.** Summarising an already-structured record
  is a much easier task than classifying free text. It is cheaper, faster, and
  — on this provider — sits in a *separate rate-limit bucket*, which is what
  actually keeps a free-tier batch run inside its token budget.

### Tradeoffs I accepted

- **A second call adds latency and a second failure point.** Mitigated rather
  than avoided: if the briefing call fails, the pipeline emits a deterministic
  template summary built from fields it already has, logs `summary_failed`, and
  keeps the record. A missing sentence must never sink a correct triage.
- **No length enforcement in code.** The prompt says 2–3 sentences and under
  70 words; nothing validates it. Cheap to add, and I would add it before
  production, because a downstream UI will have a fixed-height card.
- **JSON-wrapping a single string is slightly wasteful.** It buys a uniform
  parse path for both calls, which is worth more than the tokens.

---

## What I would change with more time

1. **Build the labelled set before touching the prompt again.** Five fixtures
   plus five edge cases is enough to catch a collapsed confidence; it is not
   enough to tune a rubric. 200 real tickets with human labels turns every
   claim above into a measurement. `scripts/eval.js` already reports accuracy
   *and* run-to-run consistency separately — it just needs data.
2. **Add "Unclassifiable" as a sixth category**, so genuine off-topic input is
   distinguishable from genuine five-way ambiguity.
3. **Move the escalation keywords out of the code and into config.** The
   outage patterns and the `$500` threshold are business policy that an ops
   lead should own. They are constants in `escalation.js` today because a
   config service is not the interesting part of this exercise.
4. **Split the priority judgement out and measure it separately.** Priority
   was the least stable field across runs (REQ-001 moved between Medium and
   High). That is defensible — a single blocked user genuinely sits on the
   boundary — but "defensible" should be replaced by "measured, and stable at
   the boundary I chose".
5. **Test the prompt against adversarial input as a matter of routine.**
   `EDGE-004` is a prompt-injection attempt that instructs the classifier to
   file a total outage as a Low-priority feature request. The current prompt
   resists it (it classified Incident/Outage, High, and escalated) but that is
   a property I verified once, not a property I enforce. It belongs in CI,
   because a contact form is an untrusted input channel that anyone on the
   internet can write to.
