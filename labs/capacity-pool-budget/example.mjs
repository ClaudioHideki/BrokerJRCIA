import {assessPoolInventory} from './preflight.mjs';
import {buildCapacityReport} from '../../scripts/operations/capacity-report.mjs';

if(process.argv.length!==2){console.error('POOL_PREFLIGHT_EXAMPLE_USAGE');process.exitCode=1;}
else{
 const processes=[
  {name:'WEB',replicas:1,rolloutReplicas:0,pools:{API_APP:10,API_AUTH:10,API_PLATFORM:4}},
  ...['MESSAGING','AUTOMATION','AUTOMATION_IO','SCHEDULER','LIFECYCLE','PARTNER_EVENTS','HISTORY_IMPORT','HISTORY_SOURCE','MIGRATOR','EVOLUTION']
   .map(name=>({name,replicas:0,rolloutReplicas:0,pools:{}})),
 ];
 const workload={organizations:50,connections:50,monthlyConversations:0,messagesPerConversation:1,daysPerMonth:30,peakMultiplier:1,
  mediaFraction:0,meanMediaBytes:0,retentionDays:0};
 const omittedAuthPlatform=buildCapacityReport({schemaVersion:1,workload,pools:{maxConnections:30,reservedConnections:10,
  components:[{name:'API',replicas:1,maxPerReplica:10}]}}).sqlBudget;
 const complete=assessPoolInventory({schemaVersion:1,maxConnections:30,reservedConnections:10,processes});
 console.log(JSON.stringify({kind:'OFFLINE_SYNTHETIC_PLANNING_EXAMPLE',measuredConnections:null,sloValidated:false,pilotCapacityValidated:false,
  incompleteBaselineExample:omittedAuthPlatform,explicitInventory:complete},null,2));
}
