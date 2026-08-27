import { writeAuthenticatedServerRecordSync } from '../../server/server-record-auth.js';

const [recordPath, workspaceTagmaDir, controlRoot, stageId, value] = process.argv.slice(2);
if (!recordPath || !workspaceTagmaDir || !controlRoot || !stageId || !value) {
  throw new Error('server-record-key-writer requires five arguments');
}

writeAuthenticatedServerRecordSync(
  recordPath,
  { workspaceTagmaDir, controlRoot, stageId, kind: 'stage-metadata' },
  { value },
);
