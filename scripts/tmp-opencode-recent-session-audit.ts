import { Database } from 'bun:sqlite';

type SessionRow = {
  id: string;
  parent_id: string | null;
  directory: string;
  time_created: number;
  time_updated: number;
  metadata: string | null;
};

const databasePath = process.argv[2];
if (!databasePath) {
  throw new Error('usage: bun scripts/tmp-opencode-recent-session-audit.ts <opencode.db>');
}

const db = new Database(databasePath, { readonly: true });
try {
  const rows = db
    .query<SessionRow, []>(
      `select id, parent_id, directory, time_created, time_updated, metadata
         from session
        where parent_id is null
        order by time_updated desc
        limit 100`,
    )
    .all();
  console.log(
    JSON.stringify(
      rows.map((row) => ({
        id: row.id,
        directory: row.directory,
        created: new Date(row.time_created).toISOString(),
        updated: new Date(row.time_updated).toISOString(),
        metadataKeys: (() => {
          try {
            const metadata = row.metadata ? JSON.parse(row.metadata) : null;
            return metadata && typeof metadata === 'object' ? Object.keys(metadata) : [];
          } catch {
            return ['<invalid-json>'];
          }
        })(),
      })),
      null,
      2,
    ),
  );
} finally {
  db.close();
}
