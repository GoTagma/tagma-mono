import { Database } from 'bun:sqlite';

type SessionRow = {
  id: string;
  directory: string;
  metadata: string | null;
};

type MessageRow = {
  data: string;
};

const databasePath = process.argv[2];
const directoryNeedle = process.argv[3]?.toLowerCase();
if (!databasePath || !directoryNeedle) {
  throw new Error(
    'usage: bun scripts/tmp-opencode-agent-audit.ts <opencode.db> <directory-substring>',
  );
}

const db = new Database(databasePath, { readonly: true });
try {
  const sessions = db
    .query<SessionRow, [string]>(
      `select id, directory, metadata
         from session
        where parent_id is null and lower(directory) like ?
        order by time_updated desc`,
    )
    .all(`%${directoryNeedle}%`);
  const result = sessions.map((session) => {
    const agents = new Set<string>();
    const roles = new Set<string>();
    for (const message of db
      .query<MessageRow, [string]>('select data from message where session_id = ?')
      .all(session.id)) {
      try {
        const data = JSON.parse(message.data);
        if (typeof data?.agent === 'string') agents.add(data.agent);
        if (typeof data?.role === 'string') roles.add(data.role);
      } catch {
        // Ignore invalid rows; only classification fields are relevant.
      }
    }
    return {
      id: session.id,
      directory: session.directory,
      metadataKeys: (() => {
        try {
          const metadata = session.metadata ? JSON.parse(session.metadata) : null;
          return metadata && typeof metadata === 'object' ? Object.keys(metadata) : [];
        } catch {
          return ['<invalid-json>'];
        }
      })(),
      agents: [...agents].sort(),
      roles: [...roles].sort(),
    };
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  db.close();
}
