/**
 * Batch runner - Step 1 (ingestion) via a file trigger.
 *
 *   npm run batch                       # processes data/inbound.json
 *   node src/index.js --input x.json    # any other batch
 *   node src/index.js --concurrency 1   # serialise (default 2, to stay inside
 *                                       # the Groq free-tier rate limit)
 *   node src/index.js --input data/edge-cases.json --out output/edge-cases
 */

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { processRequest } from './pipeline.js';
import { fileSink, webhookSink } from './sinks/index.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Small worker pool - enough parallelism to be quick, low enough to be polite. */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

async function main() {
  const inputPath = arg('input', 'data/inbound.json');
  const outDir = arg('out', 'output');
  const concurrency = Number(arg('concurrency', '1'));

  const requests = JSON.parse(await readFile(inputPath, 'utf8'));
  console.log(`ArcVault triage - ${requests.length} request(s) from ${inputPath}`);
  console.log('='.repeat(72));

  const t0 = Date.now();
  const records = await mapPool(requests, concurrency, (r) => processRequest(r));
  const elapsed = Date.now() - t0;

  const sinkResult = await fileSink(records, outDir);
  const hook = await webhookSink(records);

  console.log('\n' + '='.repeat(72));
  console.log('RUN SUMMARY');
  console.table(
    records.map((r) => ({
      id: r.request_id,
      category: r.category ?? '(failed)',
      priority: r.priority,
      conf: r.confidence_adjusted,
      queue: r.destination_queue,
      escalated: r.escalated_for_human_review ? 'YES' : '',
    }))
  );
  const tokens = records.reduce((n, r) => n + (r.pipeline.total_tokens || 0), 0);
  console.log(`Processed ${records.length} in ${elapsed}ms | ${tokens} tokens | ${sinkResult.escalated} escalated`);
  console.log(`Wrote ${sinkResult.all}`);
  console.log(`Wrote ${sinkResult.esc}`);
  if (!hook.skipped) console.log(`Mirrored to ${hook.url}`);

  const failed = records.filter((r) => r.pipeline.errors.length);
  if (failed.length) {
    console.log(`\n${failed.length} record(s) had pipeline errors:`);
    failed.forEach((r) => console.log(`  ${r.request_id}: ${r.pipeline.errors.join('; ')}`));
  }
}

main().catch((err) => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
