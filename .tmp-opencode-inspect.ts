import { Database } from 'bun:sqlite';

const db = new Database(
  'C:/Users/zhangyan_c/.local/share/opencode/opencode.db',
  { readonly: true },
);

console.log(
  JSON.stringify(
    db
      .query("select name, sql from sqlite_master where type = 'table' order by name")
      .all(),
    null,
    2,
  ),
);
db.close();
