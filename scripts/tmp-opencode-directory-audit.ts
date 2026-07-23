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
const directoryNeedle = process.argv[3]?.toLowerCase();
if (!databasePath || !directoryNeedle) {
  throw new Error(
    'usage: bun scripts/tmp-opencode-directory-audit.ts <opencode.db> <directory-substring>',
  );
}

const db = new Database(databasePath, { readonly: true });
try {
  const rows = db
    .query<SessionRow, [string]>(
      `select id, parent_id, directory, time_created, time_updated, metadata
         from session
        where lower(directory) like ?
        order by time_updated desc`,
    )
    .all(`%${directoryNeedle}%`);
  console.log(
    JSON.stringify(
      rows.map((row) => {
        let metadata: unknown;
        try {
          metadata = row.metadata ? JSON.parse(row.metadata) : undefined;
        } catch {
          metadata = '<invalid-json>';
        }
        return {
          id: row.id,
          parentID: row.parent_id,
          directory: row.directory,
          created: new Date(row.time_created).toISOString(),
          updated: new Date(row.time_updated).toISOString(),
          metadata,
        };
      }),
      null,
      2,
    ),
  );
} finally {
  db.close();
}
