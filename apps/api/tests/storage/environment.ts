export const STORAGE_TEST_RELEASE='RELEASE.2025-09-07T16-13-09Z';
export const STORAGE_TEST_BINARY_SHA256='7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f';
export function requireStorageEnvironment(env:NodeJS.ProcessEnv=process.env){
 const required=(name:string,max:number)=>{const value=env[name];if(!value||value.length>max||value!==value.trim())throw Error('STORAGE_TEST_ENV_REQUIRED:'+name);return value;};
 const endpoint=required('TEST_STORAGE_ENDPOINT',512),bucket=required('TEST_STORAGE_BUCKET',63),profile=required('TEST_STORAGE_PROFILE',64),region=required('TEST_STORAGE_REGION',64);
 const access=required('TEST_STORAGE_ACCESS_KEY_ID',128),secret=required('TEST_STORAGE_SECRET_ACCESS_KEY',512);
 const release=required('TEST_STORAGE_SERVER_RELEASE',64),binarySha256=required('TEST_STORAGE_BINARY_SHA256',64);
 let url:URL;try{url=new URL(endpoint);}catch{throw Error('STORAGE_TEST_ENDPOINT_INVALID');}
 if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.protocol!=='http:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('STORAGE_TEST_ENDPOINT_INVALID');
 if(!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket))throw Error('STORAGE_TEST_BUCKET_INVALID');
 if(!/^[a-z][a-z0-9-]{0,63}$/.test(profile)||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(region))throw Error('STORAGE_TEST_DESTINATION_INVALID');
 if(release!==STORAGE_TEST_RELEASE||binarySha256!==STORAGE_TEST_BINARY_SHA256)throw Error('STORAGE_TEST_ARTIFACT_UNVERIFIED');
 return {endpoint,bucket,profile,region,access,secret,release,binarySha256};
}
