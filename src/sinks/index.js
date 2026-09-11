/**
 * Step 5 (persistence) - where records land.
 *
 * Two sinks, both optional, both fire-and-report:
 *   - fileSink    ./output/records.json + ./output/escalation-queue.json
 *   - webhookSink POSTs each record to a webhook.site URL, standing in for a
 *                 downstream ticketing system.
 *
 * A sink failure is logged onto the run summary but never fails the pipeline -
 * losing the mirror copy is not a reason to lose the triage.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function fileSink(records, outDir = 'output') {
  const all = resolve(outDir, 'records.json');
  const esc = resolve(outDir, 'escalation-queue.json');
  const byQueue = resolve(outDir, 'queues.json');

  await mkdir(dirname(all), { recursive: true });

  const escalated = records.filter((r) => r.escalated_for_human_review);
  const grouped = records.reduce((acc, r) => {
    (acc[r.destination_queue] ??= []).push(r.request_id);
    return acc;
  }, {});

  await writeFile(all, JSON.stringify(records, null, 2) + '\n', 'utf8');
  await writeFile(esc, JSON.stringify(escalated, null, 2) + '\n', 'utf8');
  await writeFile(byQueue, JSON.stringify(grouped, null, 2) + '\n', 'utf8');

  return { all, esc, byQueue, escalated: escalated.length };
}

export async function webhookSink(records, url = process.env.WEBHOOK_SINK_URL) {
  if (!url) return { skipped: true, reason: 'WEBHOOK_SINK_URL not set' };
  const results = [];
  for (const record of records) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ArcVault-Queue': record.destination_queue,
          'X-ArcVault-Escalated': String(record.escalated_for_human_review),
        },
        body: JSON.stringify(record),
      });
      results.push({ request_id: record.request_id, status: res.status });
    } catch (err) {
      results.push({ request_id: record.request_id, error: err.message });
    }
  }
  return { skipped: false, url, results };
}
