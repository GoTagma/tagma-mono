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
  throw new Error('usage: bun scripts/.tmp-opencode-session-audit.ts <opencode.db>');
}

const db = new Database(databasePath, { readonly: true });
try {
  const rows = db
    .query<SessionRow, []>(
      `select id, parent_id, directory, time_created, time_updated, metadata
         from session
        where parent_id is null
        order by time_updated desc`,
    )
    .all();

  const relevant = rows.filter((row) => {
    const haystack = `${row.directory}\n${row.metadata ?? ''}`.toLowerCase();
    return haystack.includes('tagma') || /[\\/]\.tagma[\\/]?$/.test(row.directory);
  });

  const byDirectory = new Map<
    string,
    { total: number; marked: number; newest: number; oldest: number }
  >();
  for (const row of relevant) {
    let marked = false;
    try {
      const metadata = row.metadata ? JSON.parse(row.metadata) : null;
      marked = !!metadata?.tagma;
    } catch {
      // Invalid metadata is relevant evidence, but it is not a valid marker.
    }
    const current = byDirectory.get(row.directory);
    byDirectory.set(row.directory, {
      total: (current?.total ?? 0) + 1,
      marked: (current?.marked ?? 0) + (marked ? 1 : 0),
      newest: Math.max(current?.newest ?? 0, row.time_updated),
      oldest: Math.min(current?.oldest ?? Number.POSITIVE_INFINITY, row.time_created),
    });
  }

  console.log(
    JSON.stringify(
      {
        byDirectory: [...byDirectory.entries()].map(([directory, counts]) => ({
          directory,
          ...counts,
          newest: new Date(counts.newest).toISOString(),
          oldest: new Date(counts.oldest).toISOString(),
        })),
        recentSessions: relevant.slice(0, 30).map((row) => {
          let tagma: unknown;
          try {
            const metadata = row.metadata ? JSON.parse(row.metadata) : null;
            tagma = metadata?.tagma;
          } catch {
            tagma = '<invalid-json>';
          }
          return {
            id: row.id,
            directory: row.directory,
            created: new Date(row.time_created).toISOString(),
            updated: new Date(row.time_updated).toISOString(),
            tagma,
          };
        }),
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
