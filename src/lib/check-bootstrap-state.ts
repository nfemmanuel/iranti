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
