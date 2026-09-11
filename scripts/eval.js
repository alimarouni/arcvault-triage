/**
 * Prompt eval harness.
 *
 *   node scripts/eval.js --runs 3
 *
 * "The prompt works" is not a claim you can make from one run. This replays
 * every fixture N times and reports two different things that are easy to
 * conflate:
 *
 *   ACCURACY     does the modal answer match the hand label in data/gold.json
 *   CONSISTENCY  does the model give the SAME answer across identical runs
 *
 * A prompt can be 100% accurate and still unusable if it flips between two
 * categories run to run, because every flip is a ticket in the wrong queue.
 * Temperature is 0, so any disagreement here is the model's own nondeterminism
 * and is exactly the number worth knowing before shipping.
 */

import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { processRequest } from '../src/pipeline.js';
import { PROMPT_VERSION } from '../src/llm/prompts.js';
import { llmConfig } from '../src/llm/client.js';

const argOf = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const mode = (xs) => {
  const counts = xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
};
const pct = (n) => `${(n * 100).toFixed(0)}%`;

const runs = Number(argOf('runs', '3'));
const requests = JSON.parse(await readFile('data/inbound.json', 'utf8'));
const gold = JSON.parse(await readFile('data/gold.json', 'utf8')).labels;

console.log(`Eval: ${requests.length} fixtures x ${runs} runs | prompt ${PROMPT_VERSION} | model ${llmConfig().model}\n`);

const rows = [];
const silent = () => {};

for (const req of requests) {
  const observed = [];
  for (let i = 0; i < runs; i++) {
    observed.push(await processRequest(req, { log: silent }));
  }

  const cats = observed.map((r) => r.category);
  const queues = observed.map((r) => r.destination_queue);
  const escs = observed.map((r) => r.escalated_for_human_review);
  const prios = observed.map((r) => r.priority);

  const [modalCat, catN] = mode(cats);
  const [modalQueue, queueN] = mode(queues);
  const expected = gold[req.id] ?? {};

  rows.push({
    id: req.id,
    expected_category: expected.category ?? '-',
    modal_category: modalCat,
    accurate: expected.category ? (modalCat === expected.category ? 'PASS' : 'FAIL') : '-',
    category_consistency: pct(catN / runs),
    modal_queue: modalQueue,
    queue_ok: expected.destination_queue
      ? modalQueue === expected.destination_queue ? 'PASS' : 'FAIL'
      : '-',
    queue_consistency: pct(queueN / runs),
    escalation_ok:
      expected.escalated === undefined
        ? '-'
        : escs.every((e) => e === expected.escalated) ? 'PASS' : 'FAIL',
    priorities: [...new Set(prios)].join('/'),
    mean_conf: (observed.reduce((s, r) => s + r.confidence, 0) / runs).toFixed(2),
    mean_adj_conf: (observed.reduce((s, r) => s + r.confidence_adjusted, 0) / runs).toFixed(2),
  });

  console.log(
    `${req.id}  ${modalCat.padEnd(20)} -> ${modalQueue.padEnd(17)} ` +
      `acc:${rows.at(-1).accurate}  consistency:${rows.at(-1).category_consistency}  conf:${rows.at(-1).mean_conf}`
  );
}

console.log('');
console.table(rows);

const accuracy = rows.filter((r) => r.accurate === 'PASS').length / rows.length;
const queueAcc = rows.filter((r) => r.queue_ok === 'PASS').length / rows.length;
const escAcc = rows.filter((r) => r.escalation_ok === 'PASS').length / rows.length;
const consistency =
  rows.reduce((s, r) => s + parseFloat(r.category_consistency) / 100, 0) / rows.length;

console.log(`\nCategory accuracy   ${pct(accuracy)}`);
console.log(`Queue accuracy      ${pct(queueAcc)}`);
console.log(`Escalation accuracy ${pct(escAcc)}`);
console.log(`Category consistency across ${runs} identical runs: ${pct(consistency)}`);

await writeFile(
  'output/eval-results.json',
  JSON.stringify(
    {
      prompt_version: PROMPT_VERSION,
      model: llmConfig().model,
      runs_per_fixture: runs,
      ran_at: new Date().toISOString(),
      category_accuracy: accuracy,
      queue_accuracy: queueAcc,
      escalation_accuracy: escAcc,
      category_consistency: consistency,
      rows,
    },
    null,
    2
  ) + '\n',
  'utf8'
);
console.log('\nWrote output/eval-results.json');
