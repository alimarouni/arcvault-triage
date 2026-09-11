/**
 * Step 1 (ingestion) - webhook trigger.
 *
 *   npm run serve
 *   curl -X POST localhost:3000/intake -H "content-type: application/json" \
 *        -d '{"source":"email","raw_message":"..."}'
 *
 * The endpoint acknowledges in milliseconds and processes asynchronously.
 * That split is the point: an email gateway or web form must never wait on a
 * two-call LLM pipeline, and a 30-second webhook is a webhook that gets
 * retried, producing duplicates. The 202 + content-hash record id is the
 * smallest honest version of a real intake queue.
 */

import 'dotenv/config';
import express from 'express';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { processRequest, recordId } from './pipeline.js';

const app = express();
app.use(express.json({ limit: '256kb' }));

const STORE = resolve('output', 'records.json');
/** In-memory de-dupe for the life of the process; a real deployment puts this
 *  in Redis or a unique index on record_id. */
const seen = new Map();

async function appendRecord(record) {
  await mkdir(resolve('output'), { recursive: true });
  let existing = [];
  try {
    existing = JSON.parse(await readFile(STORE, 'utf8'));
  } catch {
    /* first write */
  }
  const idx = existing.findIndex((r) => r.record_id === record.record_id);
  if (idx === -1) existing.push(record);
  else existing[idx] = record;
  await writeFile(STORE, JSON.stringify(existing, null, 2) + '\n', 'utf8');
}

app.get('/health', (_req, res) => res.json({ ok: true, pending: seen.size }));

app.post('/intake', async (req, res) => {
  const { source, raw_message, id, received_at, from } = req.body ?? {};
  if (!raw_message || typeof raw_message !== 'string') {
    return res.status(400).json({ error: 'raw_message (string) is required' });
  }

  const request = {
    id: id ?? `WEB-${Date.now()}`,
    source: source ?? 'webhook',
    received_at: received_at ?? new Date().toISOString(),
    from: from ?? null,
    raw_message,
  };
  const rid = recordId(request);

  if (seen.has(rid)) {
    return res.status(200).json({ record_id: rid, status: 'duplicate_ignored' });
  }
  seen.set(rid, 'processing');

  res.status(202).json({
    record_id: rid,
    status: 'accepted',
    poll: `/records/${rid}`,
  });

  try {
    const record = await processRequest(request);
    await appendRecord(record);
    seen.set(rid, record);
  } catch (err) {
    seen.set(rid, { record_id: rid, error: err.message });
    console.error(`[${rid}] processing failed:`, err.message);
  }
});

app.get('/records/:id', (req, res) => {
  const rec = seen.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'unknown record_id' });
  if (rec === 'processing') return res.status(202).json({ status: 'processing' });
  res.json(rec);
});

app.get('/records', async (_req, res) => {
  try {
    res.json(JSON.parse(await readFile(STORE, 'utf8')));
  } catch {
    res.json([]);
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`ArcVault intake listening on http://localhost:${port}`);
  console.log(`  POST /intake        ingest one message`);
  console.log(`  GET  /records/:id   fetch one processed record`);
  console.log(`  GET  /records       fetch all`);
});
