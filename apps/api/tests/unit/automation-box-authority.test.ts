import {it,expect} from 'vitest';
import {boxHandoffAuthorization} from '../../src/modules/automations/box-directory.js';
import {resolveBoxDirectory,resolveRouteHandoff} from '../../src/modules/automations/box-directory.js';
import {catalog,config} from './fixtures/box-routing.js';
it('retains team membership authority separately from the single external agent target',()=>{
 const directory=resolveBoxDirectory(config(),catalog(),new Map([[10,[{id:1,name:'Ana'}]]]),1),payload=resolveRouteHandoff(directory,'sales',1);
 const state={boxDirectory:directory,boxSelection:{routeKey:'sales',agentId:1,language:'pt'}};
 expect(boxHandoffAuthorization(state,payload)).toEqual({teamId:10,agentId:1});
 expect(()=>boxHandoffAuthorization(state,{...payload,target:{teamId:null,agentId:2}})).toThrow('FLOW_BOX_TARGET_CHANGED');
 expect(boxHandoffAuthorization({},payload)).toBeNull();
});
