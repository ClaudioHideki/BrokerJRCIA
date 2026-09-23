
import {expect,test} from '@playwright/test';
import {welcomeFlow} from '@jrc/contracts';
import {signIn,expectNoAutomaticAccessibilityViolations} from './helpers.js';
test('caixa QR, rascunho JSON, publicação, vínculo e arquivamento na jornada atual',async({page,isMobile})=>{
 test.setTimeout(60000);await signIn(page);if(isMobile)await page.goto('/channels');else await page.getByRole('link',{name:'Caixas de entrada',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Caixas de entrada'})).toBeVisible();
 await page.getByRole('link',{name:'+ Conectar WhatsApp'}).click();await page.getByRole('button',{name:/WhatsApp por QR Code/}).click();
 const name='QA caixa '+(isMobile?'mobile':'desktop');await page.getByLabel('Nome da conexão').fill(name);await page.getByRole('button',{name:'Criar conexão'}).click();
 await expect(page.getByRole('heading',{name})).toBeVisible();const boxUrl=page.url();
 await page.getByRole('button',{name:'Gerar QR Code'}).click();await expect(page.getByRole('img',{name:'QR Code para conectar o WhatsApp'})).toBeVisible();
 await expect(page.getByText('Conectado',{exact:true})).toBeVisible({timeout:12000});
 await page.goto('/legacy/flows');await expect(page).toHaveURL(new RegExp('/automations$'));await page.getByRole('link',{name:'Nova automação'}).click();
 const graph=welcomeFlow();graph.nodes.forEach(n=>{n.position.x-=5000;n.position.y-=3000;});graph.nodes.find(n=>n.type==='message')!.data.text='';
 await page.getByLabel('Arquivo JSON').setInputFiles({name:'qa.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({format:'jrc-flows/1',flow:{name:'QA automação '+name,graph}}))});
 await expect(page.getByRole('heading',{name:'Revisar importação'})).toBeVisible();await page.getByRole('button',{name:'Importar rascunho e abrir editor'}).click();
 await expect(page.getByRole('button',{name:'Configurar Boas-vindas'})).toBeVisible();await page.getByRole('button',{name:'Publicar',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();
 await page.getByRole('button',{name:'Configurar Boas-vindas'}).click();await page.getByLabel('Mensagem',{exact:true}).fill('Olá, teste JRC.');await page.getByRole('button',{name:'Salvar',exact:true}).click();await expect(page.getByText('Rascunho salvo.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Publicar',exact:true}).click();await expect(page.getByText('Versão 1 publicada.')).toBeVisible();
 await expectNoAutomaticAccessibilityViolations(page);
 await page.goto(boxUrl);await page.getByLabel('Automação publicada').selectOption({label:'QA automação '+name+' · v1'});await page.getByRole('button',{name:'Vincular automação',exact:true}).click();await expect(page.getByText('Automação vinculada. Novas mensagens usarão esta versão.')).toBeVisible();
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Desvincular automação'}).click();await expect(page.getByText('Vínculo atualizado.')).toBeVisible();
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Desconectar',exact:true}).click();await expect(page.getByText('WhatsApp desconectado.',{exact:true})).toBeVisible();
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Arquivar cadastro'}).click();await expect(page.getByRole('button',{name:'Restaurar cadastro'})).toBeVisible();
 await page.getByRole('link',{name:'← Caixas de entrada'}).click();await expect(page.getByRole('heading',{name,exact:true})).toHaveCount(0);
 await page.getByLabel('Mostrar arquivadas').check();await expect(page.getByRole('heading',{name,exact:true})).toBeVisible();
});
