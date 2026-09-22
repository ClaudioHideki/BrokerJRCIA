import type {CredentialTester} from './credentials.js';
import {createAutomationSafeHttp} from './safe-http.js';
import {executeReadOnlySql} from './sql.js';
const text=(value:unknown)=>typeof value==='string'?value:'';
export function createCredentialTester():CredentialTester{const request=createAutomationSafeHttp({});return {async test(type,secret){
 if(type==='POSTGRES'||type==='MYSQL'){const connectionString=text(secret.connectionString);if(!connectionString)throw new Error('CREDENTIAL_CONNECTION_STRING_REQUIRED');await executeReadOnlySql({type,connectionString,query:'SELECT 1 AS healthy',parameters:[],timeoutMs:5000,maxRows:1});return;}
 if(type==='AI_PROVIDER'){const baseUrl=text(secret.baseUrl),apiKey=text(secret.apiKey);if(!baseUrl||!apiKey)throw new Error('CREDENTIAL_AI_PROVIDER_INVALID');const origin=new URL(baseUrl).origin,response=await request({method:'GET',url:new URL('/v1/models',baseUrl).href,allowedOrigins:[origin],headers:{authorization:`Bearer ${apiKey}`},timeoutMs:5000,maxResponseBytes:256*1024});if(response.outcome!=='success')throw new Error('CREDENTIAL_AI_PROVIDER_REJECTED');return;}
 if(type==='BEARER'&&!text(secret.token))throw new Error('CREDENTIAL_BEARER_TOKEN_REQUIRED');
 if(type==='BASIC'&&(!text(secret.username)||!text(secret.password)))throw new Error('CREDENTIAL_BASIC_REQUIRED');
 if(type==='HTTP_HEADER'&&(!text(secret.name)||!text(secret.value)))throw new Error('CREDENTIAL_HEADER_REQUIRED');
 if(type==='GENERIC_JSON'&&!Object.keys(secret).length)throw new Error('CREDENTIAL_SECRET_REQUIRED');
 }};}
