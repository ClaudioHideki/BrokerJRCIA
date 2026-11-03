import {IntegrationFailureDiagnosticSchema} from '@jrc/contracts';
import {ChatwootError} from './chatwoot-client.js';

/** A last-failure observation, not proof that a remote mutation did not happen. */
export function createJobFailureDiagnostic(error:unknown,attempt:number,
 settlement:'RETRY_SCHEDULED'|'FAILED'|'UNKNOWN',at=new Date()){
 const observed=error instanceof ChatwootError?error.diagnostic:{phase:'UNKNOWN',method:null,httpStatus:null};
 return IntegrationFailureDiagnosticSchema.parse({version:1,...observed,attempt,settlement,failedAt:at.toISOString()});
}

/** Do not expose arbitrary JSON, remote bodies, URLs or legacy payload fields. */
export function readJobFailureDiagnostic(value:unknown){
 const result=IntegrationFailureDiagnosticSchema.safeParse(value);
 return result.success?result.data:null;
}
