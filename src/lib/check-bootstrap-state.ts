/**
 * Development script: check attendant_state bootstrap entries in the DB.
 *
 * Quick diagnostic to verify that attendant_state records exist and show
 * the most recently updated entries. Useful when debugging cross-process
 * bootstrap scenarios or confirming that handshake state is being persisted.
 *
 * Run directly: ts-node src/lib/check-bootstrap-state.ts
 */

import { getDb, initDb } from '../library/client';

async function main() {
  const url = process.env.DATABASE_URL ?? 'postgresql://postgres:053435@localhost:5435/iranti_dev_db';
  initDb(url);
  const db = getDb();
  const rows = await db.knowledgeEntry.findMany({
    where: { key: 'attendant_state' },
    select: { entityId: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
    take: 10,
  });
  console.log(JSON.stringify(rows.map(r => ({ id: r.entityId, upd: r.updatedAt }))));
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
