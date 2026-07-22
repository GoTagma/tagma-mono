import { Database } from 'bun:sqlite';

type SessionRow = {
  id: string;
  parent_id: string | null;
  directory: string;
  version: string;
  time_created: number;
  time_updated: number;
  metadata: string | null;
};

type DataRow = {
  id: string;
  session_id: string;
  message_id?: string;
  time_created: number;
  time_updated: number;
  data: string;
};

function parseData(data: string): Record<string, unknown> {
  try {
    const value = JSON.parse(data);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function messageSummary(row: DataRow) {
  const data = parseData(row.data);
  const time = data.time && typeof data.time === 'object' ? data.time : null;
  const error = data.error && typeof data.error === 'object' ? data.error : null;
  return {
    id: row.id,
    role: data.role,
    finish: data.finish,
    errorName: error ? (error as Record<string, unknown>).name : undefined,
    agent: data.agent,
    modelID:
      data.model && typeof data.model === 'object'
        ? (data.model as Record<string, unknown>).modelID
        : undefined,
    created: time ? (time as Record<string, unknown>).created : row.time_created,
    completed: time ? (time as Record<string, unknown>).completed : undefined,
    updated: row.time_updated,
  };
}

function partSummary(row: DataRow) {
  const data = parseData(row.data);
  const state = data.state && typeof data.state === 'object' ? data.state : null;
  const timingValue = state ? (state as Record<string, unknown>).time : null;
  const timing =
    timingValue && typeof timingValue === 'object'
      ? (timingValue as Record<string, unknown>)
      : null;
  const text = typeof data.text === 'string' ? data.text : '';
  return {
    id: row.id,
    messageId: row.message_id,
    type: data.type,
    tool: data.tool,
    status: state ? (state as Record<string, unknown>).status : undefined,
    textLength: text.length || undefined,
    started: timing?.start,
    completed: timing?.end,
    updated: row.time_updated,
  };
}

const db = new Database(
  'C:/Users/zhangyan_c/.local/share/opencode/opencode.db',
  { readonly: true },
);

const start = Date.parse('2026-07-22T00:00:00+08:00');
const end = Date.parse('2026-07-22T12:30:00+08:00');
const sessions = db
  .query<SessionRow, [number, number, string]>(
    `select id, parent_id, directory, version, time_created, time_updated, metadata
       from session
      where time_updated >= ? and time_updated < ? and lower(directory) like ?
      order by time_updated`,
  )
  .all(start, end, '%tagmamono%');

for (const session of sessions) {
  const messages = db
    .query<DataRow, [string]>(
      `select id, session_id, time_created, time_updated, data
         from message where session_id = ? order by time_created`,
    )
    .all(session.id);
  const parts = db
    .query<DataRow, [string]>(
      `select id, session_id, message_id, time_created, time_updated, data
         from part where session_id = ? order by time_created`,
    )
    .all(session.id);
  const metadata = session.metadata ? parseData(session.metadata) : {};
  console.log(
    JSON.stringify({
      session: {
        id: session.id,
        parentId: session.parent_id,
        directory: session.directory,
        version: session.version,
        created: new Date(session.time_created).toISOString(),
        updated: new Date(session.time_updated).toISOString(),
        metadataKeys: Object.keys(metadata),
        tagma:
          metadata.tagma && typeof metadata.tagma === 'object'
            ? metadata.tagma
            : undefined,
      },
      messages: messages.map(messageSummary),
      parts: parts.map(partSummary),
    }),
  );
}

db.close();
