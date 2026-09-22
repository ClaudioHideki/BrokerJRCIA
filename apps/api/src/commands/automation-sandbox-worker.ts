import {parentPort,workerData} from 'node:worker_threads';
import {evaluateSandboxedJavaScript} from '../modules/automation-integrations/sandbox.js';
try{parentPort?.postMessage({ok:true,value:await evaluateSandboxedJavaScript(workerData as {code:string;input:unknown})});}catch(error){parentPort?.postMessage({ok:false,error:error instanceof Error?error.message:'AUTOMATION_SANDBOX_FAILED'});}
