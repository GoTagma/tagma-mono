import { Database } from 'bun:sqlite';

type MetadataRow = {
  id: string;
  directory: string;
  metadata: string;
};

const databasePath = process.argv[2];
if (!databasePath) {
  throw new Error('usage: bun scripts/tmp-opencode-metadata-audit.ts <opencode.db>');
}

const db = new Database(databasePath, { readonly: true });
try {
  const rows = db
    .query<MetadataRow, []>(
      `select id, directory, metadata
         from session
        where parent_id is null and metadata is not null`,
    )
    .all();
  const shapes = new Map<
    string,
    { count: number; rootDirectoryCount: number; samples: Array<{ id: string; directory: string }> }
  >();
  for (const row of rows) {
    let metadata: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.metadata);
      metadata =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      metadata = { '<invalid-json>': true };
    }
    const shape = Object.keys(metadata).sort().join(',') || '<empty>';
    const current = shapes.get(shape) ?? { count: 0, rootDirectoryCount: 0, samples: [] };
    current.count += 1;
    if (!/[\\/]\.tagma[\\/]?$/.test(row.directory)) current.rootDirectoryCount += 1;
    if (current.samples.length < 5) current.samples.push({ id: row.id, directory: row.directory });
    shapes.set(shape, current);
  }
  console.log(
    JSON.stringify(
      [...shapes.entries()]
        .map(([shape, summary]) => ({ shape, ...summary }))
        .sort((left, right) => right.count - left.count),
      null,
      2,
    ),
  );
} finally {
  db.close();
}
