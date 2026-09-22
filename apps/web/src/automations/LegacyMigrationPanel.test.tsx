// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client.js';
import { LegacyMigrationPanel } from './LegacyMigrationPanel.js';

const states = ['CONVERTED','WAITING_FOR_DRAIN','MANAGED','LEGACY','CONFLICT','ROLLED_BACK'] as const;
const data = states.map((status,index) => ({
  source:'BROKER_FLOW_V1', sourceId:`flow-${index}`, automationId:`automation-${index}`,
  sourceVersion:index+1, sourceChecksum:'a'.repeat(64), targetChecksum:index===3?null:'b'.repeat(64),
  status, bindingCount:index, liveExecutionCount:status==='WAITING_FOR_DRAIN'?2:0,
  report:status==='LEGACY'?{errors:['AUTOMATION_GRAPH_UNSUPPORTED']}:{versions:index+1},
  updatedAt:'2026-09-22T12:00:00.000Z',
}));

function client(role:'OWNER'|'ADMIN'|'VIEWER'='OWNER') {
  const request=vi.fn(async(path:string,init?:RequestInit)=>{
    if(path==='/v1/automations/migrations/legacy'&&!init?.method)return {data,metrics:{legacyFlows:6,legacyExecutions:2,legacyBindings:3,conversionFailures:1}};
    if(path==='/v1/automations/migrations/legacy'&&init?.method==='POST')return {count:6};
    if(path.endsWith('/cutover'))return {status:'MANAGED'};
    if(path.endsWith('/rollback'))return {status:'ROLLED_BACK'};
    throw new Error(`Unexpected ${path}`);
  }) as ApiClient['request'];
  return {request,role};
}

describe('LegacyMigrationPanel',()=>{
  it('shows every migration state, checksums, counts and conversion errors',async()=>{
    const api=client();
    render(<LegacyMigrationPanel client={{request:api.request} as ApiClient} role={api.role}/>);
    for(const state of states)expect(await screen.findByText(state)).toBeInTheDocument();
    expect(screen.getByText('2 execuções vivas')).toBeInTheDocument();
    expect(screen.getByText('AUTOMATION_GRAPH_UNSUPPORTED')).toBeInTheDocument();
    expect(screen.getAllByText(/aaaaaaaaaaaa/).length).toBeGreaterThan(0);
    expect(screen.getByText('6 fluxos legados')).toBeInTheDocument();
  });

  it('offers contextual safe actions only to OWNER or ADMIN',async()=>{
    const api=client('ADMIN');
    vi.spyOn(window,'confirm').mockReturnValue(true);
    render(<LegacyMigrationPanel client={{request:api.request} as ApiClient} role={api.role}/>);
    fireEvent.click(await screen.findByRole('button',{name:'Migrar próximo lote'}));
    await screen.findByText('Lote processado. Revise os estados antes do cutover.');
    fireEvent.click(screen.getAllByRole('button',{name:'Concluir migração'})[0]!);
    await screen.findByText('Cutover verificado.');
    fireEvent.click(screen.getAllByRole('button',{name:'Reverter para fluxo legado'})[0]!);
    await waitFor(()=>expect(api.request).toHaveBeenCalledWith(expect.stringMatching(/\/cutover$/),expect.objectContaining({method:'POST'})));
    expect(api.request).toHaveBeenCalledWith(expect.stringMatching(/\/rollback$/),expect.objectContaining({method:'POST'}));
  });

  it('keeps incompatible flows visible and hides mutation actions from VIEWER',async()=>{
    const api=client('VIEWER');
    render(<LegacyMigrationPanel client={{request:api.request} as ApiClient} role={api.role}/>);
    expect(await screen.findByText('AUTOMATION_GRAPH_UNSUPPORTED')).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Migrar próximo lote'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Concluir migração'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Reverter para fluxo legado'})).not.toBeInTheDocument();
  });
});
