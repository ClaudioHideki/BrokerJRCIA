import {expect,it} from 'vitest';
import {welcomeFlow} from '@jrc/contracts';
import {compareGraphs} from './graph-diff.js';
it('ignores node/edge and object-key order but retains ordered configuration arrays',()=>{
 const base=welcomeFlow(),next=structuredClone(base);
 base.nodes[1]!.data={options:['one','two'],nested:{a:1,b:2}};
 next.nodes[1]!.data={nested:{b:2,a:1},options:['one','two']};
 next.nodes.reverse();next.edges.reverse();expect(compareGraphs(base,next)).toEqual([]);
 next.nodes.find(node=>node.id===base.nodes[1]!.id)!.data.options=['two','one'];
 expect(compareGraphs(base,next)).toEqual([expect.objectContaining({kind:'configuration',field:'data.options'})]);
});
it('separates configuration, presentation and connection changes with before/after values',()=>{
 const base=welcomeFlow(),next=structuredClone(base),node=next.nodes[1]!;
 node.data.text='Changed';node.position.x+=40;node.label='Renamed';next.edges[0]!.target=next.nodes[2]!.id;
 const changes=compareGraphs(base,next);
 expect(changes.map(change=>change.kind)).toEqual(['configuration','presentation','presentation','connection']);
 expect(changes.find(change=>change.field==='data.text')).toMatchObject({before:base.nodes[1]!.data.text,after:'Changed'});
});
it('reports added and removed blocks and edges without mutating either graph',()=>{
 const base=welcomeFlow(),next=structuredClone(base);next.nodes[1]!.id='new';next.edges[0]!.id='new-edge';
 const snapshot=JSON.stringify([base,next]),changes=compareGraphs(base,next);
 expect(changes.filter(change=>change.kind==='added')).toHaveLength(2);
 expect(changes.filter(change=>change.kind==='removed')).toHaveLength(2);
 expect(JSON.stringify([base,next])).toBe(snapshot);
});
