import {createHash,createHmac} from 'node:crypto';

/** Test-only creation of the exact disposable bucket after MinIO tmpfs restart.
 * No policy, ACL, lock, lifecycle or existing object is changed. */
export async function initializeHistoryLabBucket({labOnly,endpoint,accessKeyId,secretAccessKey}) {
  const url=new URL(endpoint);
  if(labOnly!==true||process.env.HISTORY_LAB2_E2E!=='true'||url.protocol!=='http:'||url.hostname!=='127.0.0.1'
    ||url.pathname!=='/'||url.username||url.password||url.hash||url.search)throw Error('UNSAFE_HISTORY_LAB_STORAGE');
  url.pathname='/synthetic-broker-history-20261112';
  const sha=value=>createHash('sha256').update(value).digest('hex'),hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
  const date=new Date().toISOString().replace(/[:-]|\.\d{3}/gu,''),day=date.slice(0,8),scope=`${day}/us-east-1/s3/aws4_request`;
  const signed='host;x-amz-content-sha256;x-amz-date',hash=sha('');
  const canonical=['PUT',url.pathname,'',`host:${url.host}\nx-amz-content-sha256:${hash}\nx-amz-date:${date}\n`,signed,hash].join('\n');
  const key=hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`,day),'us-east-1'),'s3'),'aws4_request');
  const signature=createHmac('sha256',key).update(['AWS4-HMAC-SHA256',date,scope,sha(canonical)].join('\n')).digest('hex');
  const result=await fetch(url,{method:'PUT',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'x-amz-date':date,'x-amz-content-sha256':hash,
    authorization:`AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`}});
  if(result.status===200){await result.body?.cancel();return;}
  if(result.status===409&&(await result.text()).includes('<Code>BucketAlreadyOwnedByYou</Code>'))return;
  throw Error(`SYNTHETIC_STORAGE_INITIALIZATION_${result.status}`);
}
