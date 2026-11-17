import {text} from 'node:stream/consumers';
let content=await text(process.stdin);
for(const[key,value]of Object.entries(process.env)){
  if(/KEY|TOKEN|SECRET|PASSWORD|ACCESS/iu.test(key)&&value?.length>=6)content=content.split(value).join('[REDACTED]');
}
const sensitive=/api_access_token|adminToken|agentToken|authorization|X-History-Lab-Key|encrypted_token|access_token["':=]|password["':=]|secret["':=]/iu;
process.stdout.write(content.split('\n').map(line=>sensitive.test(line)?'[REDACTED credential-bearing log line]':line).join('\n'));
