import {expect,it,vi} from 'vitest';
import {recordManualAttendanceTakeover} from '../../src/modules/attendance/manual-takeover.js';
it('records a manual HUMAN decision even when the handoff already paused local mode',async()=>{
  const query=vi.fn(async(sql:string)=>({rows:sql.includes('SELECT channel_id')?[{channel_id:'channel'}]:[],rowCount:1}));
  await recordManualAttendanceTakeover({query} as never,'tenant','conversation');
  const sql=query.mock.calls.map(c=>c[0]).join('\n');
  expect(sql).toContain("state='HUMAN',revision=revision+1");
  expect(sql).toContain('CHATWOOT_ATTENDANCE_CONTROL');
  expect(sql).toContain("'HUMAN_ACTIVE'");
});
it('does not cross a missing or foreign conversation scope',async()=>{
  const query=vi.fn(async()=>({rows:[],rowCount:0}));
  await recordManualAttendanceTakeover({query} as never,'tenant-b','conversation-a');expect(query).toHaveBeenCalledTimes(1);
});
