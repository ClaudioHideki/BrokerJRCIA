import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';
import {loadPrivateMediaBackend} from '../../src/modules/messaging/private-media-config.js';

const root=fileURLToPath(new URL('../../../../',import.meta.url)),compose=resolve(root,'infra/dokploy/compose.yaml');
const fields=['MEDIA_STORAGE_DRIVER','MEDIA_S3_ENDPOINT','MEDIA_S3_BUCKET','MEDIA_S3_PROFILE','MEDIA_S3_REGION',
  'MEDIA_S3_ACCESS_KEY_ID','MEDIA_S3_SECRET_ACCESS_KEY','MEDIA_S3_DEDICATED_BUCKET','MEDIA_S3_REQUEST_TIMEOUT_MS'];
const owners=['api','worker','lifecycle-worker'];
function config(overrides:Record<string,string>={}){
  const source=readFileSync(compose,'utf8');
  const synthetic=Object.fromEntries([...source.matchAll(/\$\{([A-Z0-9_]+):\?[^}]*\}/g)].map(match=>[match[1],'synthetic-test-value']));
  Object.assign(synthetic,{JRC_API_IMAGE:'example.invalid/api:test',JRC_WEB_IMAGE:'example.invalid/web:test',
    EVOLUTION_ENGINE_IMAGE:'example.invalid/evolution:test',PUBLIC_ORIGIN:'https://broker.example.test',
    META_CREDENTIALS_JSON:'{}',META_ASSET_BINDINGS_JSON:'{}',TYPEBOT_ORIGINS_JSON:'{}',...overrides});
  const shell=Object.fromEntries(['PATH','SystemRoot','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','ProgramFiles']
    .filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
  const result=spawnSync('docker',['compose','--env-file',resolve(root,'infra/dokploy/.env.example'),'-f',compose,'config','--format','json'],
    {cwd:root,encoding:'utf8',windowsHide:true,env:{...shell,...synthetic},timeout:15000});
  expect(result.error).toBeUndefined();expect(result.status,result.stderr).toBe(0);
  return JSON.parse(result.stdout).services as Record<string,{environment:NodeJS.ProcessEnv}>;
}
it('preserves postgres operation with blank S3 fields and a dedicated lifecycle database role',()=>{
  const services=config();
  for(const name of owners){const env=services[name].environment;
    expect(env.MEDIA_STORAGE_DRIVER,name).toBe('postgres');
    for(const field of fields.slice(1))expect(env[field],`${name}:${field}`).toBe('');
    expect(loadPrivateMediaBackend(env)).toBeUndefined();
  }
  const life=services['lifecycle-worker'].environment;
  expect(life.LIFECYCLE_DATABASE_URL).toMatch(/^postgresql:\/\/jrc_lifecycle:/);
  expect(life.INTEGRATION_ENCRYPTION_KEY).toBe('synthetic-test-value');
  expect(life.MEDIA_STORAGE_BYTES_PER_ORGANIZATION).toBe('1073741824');
  for(const field of ['DATABASE_URL','AUTH_DATABASE_URL','PLATFORM_DATABASE_URL'])expect(life).not.toHaveProperty(field);
});
it('delivers private S3 configuration only to owners of media IO and lifecycle cleanup',()=>{
  const values={MEDIA_STORAGE_DRIVER:'s3',MEDIA_S3_ENDPOINT:'https://s3.example.test',MEDIA_S3_BUCKET:'broker-media-test',
    MEDIA_S3_PROFILE:'test-private-media',MEDIA_S3_REGION:'us-east-1',MEDIA_S3_ACCESS_KEY_ID:'synthetic-access',
    MEDIA_S3_SECRET_ACCESS_KEY:'synthetic-secret',MEDIA_S3_DEDICATED_BUCKET:'true',MEDIA_S3_REQUEST_TIMEOUT_MS:'9000'};
  const services=config(values);
  for(const [name,service] of Object.entries(services)){
    if(owners.includes(name)){expect(service.environment).toMatchObject(values);
      expect(loadPrivateMediaBackend(service.environment)).toMatchObject({profile:'test-private-media',requestTimeoutMs:9000});
    }else for(const field of fields)expect(service.environment??{},`${name}:${field}`).not.toHaveProperty(field);
  }
});
it('keeps an operator S3 value visible to reject a partial postgres configuration',()=>{
  const services=config({MEDIA_S3_ENDPOINT:'https://s3.example.test'});
  for(const name of owners){expect(services[name].environment.MEDIA_S3_ENDPOINT).toBe('https://s3.example.test');
    expect(()=>loadPrivateMediaBackend(services[name].environment)).toThrow();}
});
