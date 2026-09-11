/**
 * Static + behavioural check of the generated n8n workflow.
 *
 *   node scripts/verify-n8n.js
 *
 * The n8n Code nodes contain the routing and escalation policy projected out
 * of src/. That projection is generated, but "generated" is not "correct" -
 * the Code node runtime is a sandbox with its own globals ($json, $input,
 * $('Node Name').item) and no node builtins. This harness extracts each
 * node's jsCode, runs it against a faked runtime with the five fixtures, and
 * asserts the workflow reaches the same queues as the Node implementation.
 *
 * It catches the failure I actually care about: importing the workflow, then
 * discovering halfway through a demo that a Code node throws.
 */

import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const wf = JSON.parse(
  await readFile(new URL('../n8n/arcvault-triage.workflow.json', import.meta.url), 'utf8')
);
const expected = JSON.parse(
  await readFile(new URL('../output/queues.json', import.meta.url), 'utf8')
);

const nodeByName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const codeNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code');

let failures = 0;
const fail = (msg) => {
  console.log(`  FAIL  ${msg}`);
  failures++;
};
const pass = (msg) => console.log(`  ok    ${msg}`);

/* --------------------------- 1. static checks --------------------------- */

console.log('\nStatic checks');

// n8n's Code sandbox blocks node builtins unless explicitly allowed.
for (const n of codeNodes) {
  if (/\brequire\s*\(/.test(n.parameters.jsCode)) fail(`${n.name} uses require() - blocked by the Code sandbox`);
}
if (!codeNodes.some((n) => /\brequire\s*\(/.test(n.parameters.jsCode))) pass('no Code node uses require()');

// Every syntactically valid before we ever start n8n.
for (const n of codeNodes) {
  try {
    new vm.Script(`(async () => { ${n.parameters.jsCode} })`);
  } catch (e) {
    fail(`${n.name} has a syntax error: ${e.message}`);
  }
}
pass(`all ${codeNodes.length} Code nodes parse`);

// Credentials must be wired to something the user can fill in, not hardcoded.
for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest')) {
  if (/gsk_[A-Za-z0-9]{10,}/.test(JSON.stringify(n))) fail(`${n.name} contains a hardcoded API key`);
}
pass('no API key embedded in the workflow');

// The workflow must target the same models as .env. This check exists because
// it did not: after the model was switched in .env, the generated workflow
// still requested llama-3.3-70b-versatile, which 404s on this account - every
// HTTP node would have failed and every record would have hit the fail-safe.
const envText = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const envModel = /^LLM_MODEL=(.+)$/m.exec(envText)?.[1]?.trim();
const envSummary = /^LLM_SUMMARY_MODEL=(.+)$/m.exec(envText)?.[1]?.trim();
const wfText = JSON.stringify(wf);
for (const [label, model] of [['LLM_MODEL', envModel], ['LLM_SUMMARY_MODEL', envSummary]]) {
  if (!model) continue;
  if (wfText.includes(model)) pass(`workflow targets ${label} (${model})`);
  else fail(`workflow does not reference ${label} (${model}) - it will call a different model than the code`);
}

// gpt-oss spends reasoning tokens out of max_tokens; without this the briefing
// call returns an empty completion and the API reports json_validate_failed.
const groqBodies = [...wfText.matchAll(/reasoning_effort/g)].length;
if (groqBodies >= 2) pass('both LLM calls set reasoning_effort');
else fail(`only ${groqBodies} of 2 LLM calls set reasoning_effort - the briefing call can return empty`);

// Graph integrity.
for (const [from, conn] of Object.entries(wf.connections)) {
  if (!nodeByName[from]) fail(`connection from unknown node "${from}"`);
  for (const group of conn.main) for (const t of group) {
    if (!nodeByName[t.node]) fail(`connection to unknown node "${t.node}"`);
  }
}
const switchNode = nodeByName['Switch: Destination Queue'];
const switchOutputs = wf.connections['Switch: Destination Queue'].main.length;
const switchRules = switchNode.parameters.rules.values.length;
if (switchOutputs !== switchRules + 1) {
  fail(`Switch has ${switchRules} rules + fallback but ${switchOutputs} wired outputs`);
} else {
  pass(`Switch: ${switchRules} rules + 1 fallback = ${switchOutputs} wired outputs`);
}

/* ----------------------- 2. behavioural simulation ---------------------- */

console.log('\nBehavioural simulation (fake n8n runtime, real fixtures)');

/** Minimal stand-in for the n8n Code node runtime. */
function runCodeNode(name, json, priorItems = {}) {
  const node = nodeByName[name];
  const sandbox = {
    $json: json,
    $input: { all: () => [{ json }] },
    $: (nodeName) => ({ item: { json: priorItems[nodeName] ?? json } }),
    console,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    isFinite,
    parseFloat,
    RegExp,
  };
  const script = new vm.Script(`(() => { ${node.parameters.jsCode} })()`);
  return script.runInNewContext(sandbox, { timeout: 3000 }).json;
}

/** Replay the pipeline, substituting the recorded LLM answers for the calls. */
const records = JSON.parse(
  await readFile(new URL('../output/records.json', import.meta.url), 'utf8')
);

for (const rec of records) {
  const normalized = {
    id: rec.request_id,
    source: rec.source,
    received_at: rec.received_at,
    raw_message: rec.raw_message,
  };

  try {
    // Build Triage Prompt -> must produce a well-formed Groq body.
    const prompted = runCodeNode('Build Triage Prompt', normalized);
    if (!prompted.groq_body?.messages?.length) throw new Error('no groq_body.messages');
    if (prompted.groq_body.response_format?.type !== 'json_object')
      throw new Error('JSON mode not requested');

    // Validate Triage Output, fed the model answer this record was built from.
    const fakeLlmResponse = {
      model: rec.pipeline.model,
      usage: { total_tokens: rec.pipeline.total_tokens },
      choices: [
        {
          message: {
            content: JSON.stringify({
              category_scores: rec.category_scores,
              priority: rec.priority,
              core_issue: rec.core_issue,
              entities: rec.entities,
              urgency_signal: rec.urgency_signal,
              urgency_evidence: rec.urgency_evidence,
              customer_sentiment: rec.customer_sentiment,
              ambiguity_notes: rec.ambiguity_notes,
              suggested_next_action: rec.suggested_next_action,
            }),
          },
        },
      ],
    };
    const validated = runCodeNode('Validate Triage Output', fakeLlmResponse, {
      'Normalize Inbound': normalized,
      'Build Triage Prompt': prompted,
    });
    if (validated._schema_error) throw new Error(`schema error: ${validated._schema_error}`);

    const routed = runCodeNode('Route by Classification', validated);
    const escalated = runCodeNode('Escalation Check', routed);

    const finalQueue = escalated.escalation.destination_queue;
    const wanted = rec.destination_queue;

    if (finalQueue !== wanted) {
      fail(`${rec.request_id}: n8n routed to ${finalQueue}, Node implementation routed to ${wanted}`);
    } else if (escalated.escalation.escalated !== rec.escalated_for_human_review) {
      fail(`${rec.request_id}: escalation flag disagrees with the Node implementation`);
    } else {
      pass(`${rec.request_id} -> ${finalQueue}${escalated.escalation.escalated ? ' (escalated)' : ''}`);
    }
  } catch (e) {
    fail(`${rec.request_id}: ${e.message}`);
  }
}

/* -------------------------- 3. Switch coverage -------------------------- */

console.log('\nSwitch coverage');
const switchKeys = switchNode.parameters.rules.values.map(
  (v) => v.conditions.conditions[0].rightValue
);
for (const queue of Object.keys(expected)) {
  if (switchKeys.includes(queue)) pass(`"${queue}" has a Switch branch`);
  else fail(`"${queue}" is produced by routing but has NO Switch branch - it would fall through to Unrouted`);
}

console.log(
  failures === 0
    ? '\nAll checks passed - the workflow is safe to import and demo.\n'
    : `\n${failures} check(s) FAILED.\n`
);
process.exit(failures === 0 ? 0 : 1);
