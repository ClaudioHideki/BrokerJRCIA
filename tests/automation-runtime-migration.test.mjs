import { readFile } from 'node:fs/promises';
import { describe,expect,it } from 'vitest';

const path=new URL('../apps/api/drizzle/migrations/0026_automation_runtime_v2.sql',import.meta.url);
describe('automation runtime v2 migration',()=>{
  it('declares every durable tenant table with RLS and an immutable version grant',async()=>{const sql=await readFile(path,'utf8');
    for(const table of ['automation_definitions','automation_versions','automation_bindings','automation_executions','automation_node_executions','automation_events','automation_waits','automation_outbox'])expect(sql).toContain(`'${table}'`);
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('GRANT SELECT,INSERT ON automation_versions TO jrc_app');expect(sql).not.toMatch(/GRANT[^;]*UPDATE[^;]*automation_versions/u);
    expect(sql).toContain("'UNKNOWN'");expect(sql).toContain('automation_worker_organizations');
  });
});
