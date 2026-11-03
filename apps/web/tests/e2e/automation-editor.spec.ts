import {expect,test} from '@playwright/test';
import {welcomeFlow} from '@jrc/contracts';
import {signIn,expectNoAutomaticAccessibilityViolations} from './helpers.js';

test('compares immutable versions and explicitly copies history into the draft without publishing',async({page,isMobile})=>{
 test.setTimeout(90000);await signIn(page);await page.goto('/automations/new');
 await page.getByRole('textbox',{name:'Nome da automação'}).fill('Comparação de versões sintética');await page.getByRole('button',{name:'Criar e abrir editor'}).click();
 await page.getByRole('button',{name:'Configurar Boas-vindas'}).click();const message=page.locator('.flows-inspector').getByRole('textbox',{name:'Mensagem',exact:true});
 const original=await message.inputValue();
 // Publications are explicit setup actions in this isolated fixture, never part of copy.
 await page.getByRole('button',{name:'Publicar',exact:true}).click();await expect(page.getByText('Versão 1 publicada.',{exact:true})).toBeVisible();
 await message.fill('Mensagem histórica da segunda versão');await page.getByRole('button',{name:'Salvar',exact:true}).click();await expect(page.getByText('Rascunho salvo.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Publicar',exact:true}).click();await expect(page.getByText('Versão 2 publicada.',{exact:true})).toBeVisible();
 await message.fill('Alteração local que será substituída');
 const historyResponse=page.waitForResponse(response=>response.url().endsWith('/versions')&&response.request().method()==='GET');
 await page.getByRole('link',{name:'Histórico',exact:true}).click();const historyBefore=await (await historyResponse).json();
 await page.getByRole('combobox',{name:'Versão a consultar'}).selectOption('1');await page.getByRole('combobox',{name:'Comparar com'}).selectOption('2');
 await expect(page.getByText('Mensagem histórica da segunda versão',{exact:true})).toBeVisible();await expect(page.getByText(original,{exact:true})).toBeVisible();
 await expectNoAutomaticAccessibilityViolations(page);
 await test.info().attach('flow-version-comparison',{body:await page.screenshot({path:`test-results/flow-versions-${isMobile?'mobile':'desktop'}.png`,fullPage:true}),contentType:'image/png'});
 const writes:string[]=[];page.on('request',request=>{if(['POST','PUT','PATCH','DELETE'].includes(request.method()))writes.push(request.method()+' '+new URL(request.url()).pathname);});
 await page.getByRole('button',{name:'Copiar v1 para rascunho'}).click();await page.getByRole('button',{name:'Cancelar cópia'}).click();expect(writes).toEqual([]);
 await page.getByRole('button',{name:'Copiar v1 para rascunho'}).click();await page.getByRole('button',{name:'Confirmar cópia'}).click();
 await expect(page.getByText('v1 copiada para o rascunho. Revise no editor antes de publicar.')).toBeVisible();
 expect(writes).toHaveLength(1);expect(writes[0]).toMatch(/^PUT \/v1\/automations\/[a-f0-9-]+$/);
 await page.getByRole('link',{name:'← Editor',exact:true}).click();await page.getByRole('button',{name:'Configurar Boas-vindas'}).click();await expect(message).toHaveValue(original);
 await expect(page.locator('.flows-badge')).toContainText('v2');await expect(page.getByRole('button',{name:'Salvar',exact:true})).toBeDisabled();
 const unchangedHistory=page.waitForResponse(response=>response.url().endsWith('/versions')&&response.request().method()==='GET');await page.getByRole('link',{name:'Histórico',exact:true}).click();
 expect(await (await unchangedHistory).json()).toEqual(historyBefore);
});

test('builds, saves and simulates a menu with a captured response using only the editor',async({page,isMobile})=>{
  test.setTimeout(90000);
  page.setDefaultTimeout(15000);
  await signIn(page);
  await page.goto('/automations/new');
  await page.getByRole('textbox',{name:'Nome da automação'}).fill('URA sintética pelo editor');
  await page.getByRole('button',{name:'Criar e abrir editor'}).click();
  await expect(page.getByRole('heading',{name:'Editor de automação',exact:true})).toBeVisible();
  const inspector=page.locator('.flows-inspector');
  const palette=page.locator('.flows-palette');
  const selectNode=async(label:string)=>{
    await page.getByRole('tab',{name:'Editor',exact:true}).click();
    await page.getByRole('region',{name:'Canvas do flow',exact:true}).getByRole('button',{name:'Visão geral',exact:true}).click();
    await page.getByRole('button',{name:'Configurar '+label,exact:true}).click();
  };
  await palette.getByRole('button',{name:/^Menu textual/}).click();
  await inspector.getByRole('textbox',{name:'Nome do bloco'}).fill('Escolher setor');
  await inspector.getByRole('textbox',{name:'Mensagem do menu'}).fill('Qual setor você deseja?');
  await inspector.getByRole('button',{name:'Adicionar opção'}).click();
  await inspector.getByRole('textbox',{name:'Texto da opção 3'}).fill('Financeiro');
  await inspector.getByRole('combobox',{name:'Número da opção 2'}).selectOption('8');
  await inspector.getByRole('button',{name:'Mover opção 8 para cima'}).click();
  await palette.getByRole('button',{name:/^Capturar resposta/}).click();
  await inspector.getByRole('textbox',{name:'Nome do bloco'}).fill('Identificar cliente');
  await inspector.getByRole('textbox',{name:'Pergunta'}).fill('Como você se chama?');
  await inspector.getByRole('textbox',{name:'Variável',exact:true}).fill('nome');
  await palette.getByRole('button',{name:/^Condição/}).click();
  await inspector.getByRole('textbox',{name:'Nome do bloco'}).fill('Verificar nome');
  await inspector.getByRole('combobox',{name:'Campo',exact:true}).selectOption('nome');
  await inspector.getByRole('textbox',{name:'Valor',exact:true}).fill('Maria');
  await inspector.getByRole('combobox',{name:'Destino Sim',exact:true}).selectOption({label:'Boas-vindas'});
  await inspector.getByRole('combobox',{name:'Destino Não',exact:true}).selectOption({label:'Encerrar'});
  await selectNode('Identificar cliente');
  await inspector.getByRole('combobox',{name:'Destino Continuar',exact:true}).selectOption({label:'Verificar nome'});
  await selectNode('Escolher setor');
  for(const choice of ['8','1','3'])await inspector.getByRole('combobox',{name:'Destino Opção '+choice,exact:true}).selectOption({label:'Identificar cliente'});
  await selectNode('Mensagem recebida');
  await inspector.getByRole('combobox',{name:'Destino Continuar',exact:true}).selectOption({label:'Escolher setor'});
  await selectNode('Boas-vindas');
  await inspector.getByRole('textbox',{name:'Mensagem',exact:true}).fill('Olá, {{nome}}!');
  await page.getByRole('button',{name:'Salvar',exact:true}).click();
  await expect(page.getByText('Rascunho salvo.',{exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByText('6 blocos · 8 conexões')).toBeVisible();
  await page.getByRole('button',{name:'Validar',exact:true}).click();
  await expect(page.getByText('Automação válida.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Testar',exact:true}).click();
  const output=page.locator('.automation-drawer');
  await expect(output.getByText(/Qual setor você deseja/)).toBeVisible();
  await output.getByRole('textbox',{name:'Próxima resposta'}).fill('8');
  await output.getByRole('button',{name:'Enviar resposta no teste'}).click();
  await expect(output.getByText('Como você se chama?',{exact:true})).toBeVisible();
  await output.getByRole('textbox',{name:'Próxima resposta'}).fill('Maria');
  await output.getByRole('button',{name:'Enviar resposta no teste'}).click();
  await expect(output.getByText('Olá, Maria!',{exact:true})).toBeVisible();
  await expect(output.getByRole('textbox',{name:'Próxima resposta'})).toHaveCount(0);
  await selectNode('Escolher setor');
  await expect(inspector.getByRole('combobox',{name:'Destino Opção 8',exact:true})).toHaveValue(/.+/);
  await test.info().attach('automation-menu-created',{body:await page.screenshot({path:`test-results/automation-menu-${isMobile?'mobile':'desktop'}.png`,fullPage:true}),contentType:'image/png'});
});

test('150-block draft remains intact while navigating the editor and editing one block',async({page,isMobile})=>{
  test.setTimeout(90000);
  page.setDefaultTimeout(15000);
  await signIn(page);
  await page.goto('/automations/new');
  const graph=welcomeFlow();
  const start=graph.nodes.find(node=>node.type==='start')!;
  const welcome=graph.nodes.find(node=>node.type==='message')!;
  const end=graph.nodes.find(node=>node.type==='end')!;
  const extra=Array.from({length:147},(_,index)=>({id:`synthetic-${index+1}`,type:'message',label:`Sintético ${index+1}`,position:{x:80+((index+2)%15)*270,y:80+Math.floor((index+2)/15)*190},data:{text:`Mensagem ${index+1}`}}));
  graph.nodes=[start,welcome,...extra,end];
  graph.edges=graph.nodes.slice(0,-1).map((node,index)=>({id:`edge-${index}`,source:node.id,port:'next',target:graph.nodes[index+1]!.id}));
  const importInput=page.getByLabel('Arquivo JSON');
  await expect(importInput).toBeEnabled();
  await importInput.setInputFiles({name:'synthetic-150.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({format:'jrc-flows/1',flow:{name:'Teste sintético de 150 blocos',graph}}))});
  await expect(page.getByRole('heading',{name:'Revisar importação'})).toBeVisible();
  await page.getByRole('button',{name:'Importar rascunho e abrir editor'}).click();
  await expect(page.getByText('150 blocos · 149 conexões')).toBeVisible();
  await expect(page.getByRole('button',{name:'Salvar',exact:true})).toBeDisabled();
  const canvas=page.locator('.flows-canvas');
  const initial=await canvas.getAttribute('style');
  await page.getByRole('button',{name:'Aumentar zoom'}).click();
  await expect(canvas).not.toHaveAttribute('style',initial!);
  await page.getByRole('region',{name:'Canvas do flow',exact:true}).getByRole('button',{name:'Visão geral',exact:true}).click();
  await page.getByRole('button',{name:'Localizar início'}).click();
  await expect(page.getByRole('button',{name:'Configurar Mensagem recebida'}).locator('..')).toHaveClass(/flow-node--selected/);
  await expect(page.getByRole('button',{name:'Salvar',exact:true})).toBeDisabled();
  if(!isMobile){
    const viewport=page.locator('.flows-canvas-scroll');
    await viewport.scrollIntoViewIfNeeded();
    const point=await viewport.evaluate(element=>{
      const box=element.getBoundingClientRect();
      for(let y=Math.max(0,box.top)+30;y<Math.min(innerHeight,box.bottom)-40;y+=25){
        for(let x=Math.max(0,box.left)+30;x<Math.min(innerWidth,box.right)-40;x+=25){
          const hit=document.elementFromPoint(x,y);
          if(hit&&element.contains(hit)&&!hit.closest('.flow-node'))return {x,y};
        }
      }
      return null;
    });
    expect(point).not.toBeNull();
    const beforeWheel=await canvas.getAttribute('style');
    await page.mouse.move(point!.x,point!.y);await page.mouse.wheel(0,-200);
    await expect(canvas).not.toHaveAttribute('style',beforeWheel!);
    // Return to the same transform where hit testing proved a visible empty point.
    await page.getByRole('button',{name:'Localizar início'}).click();
    await viewport.scrollIntoViewIfNeeded();
    const beforePan=await canvas.getAttribute('style');
    await page.mouse.move(point!.x,point!.y);
    await page.mouse.down();await page.mouse.move(point!.x+20,point!.y+20,{steps:5});await page.mouse.up();
    await expect(canvas).not.toHaveAttribute('style',beforePan!);
    await page.getByRole('button',{name:'Localizar início'}).click();
  }else for(let step=0;step<5;step++)await page.getByRole('button',{name:'Diminuir zoom'}).click();
  await page.getByRole('button',{name:'Configurar Boas-vindas'}).click();
  const message=page.locator('.flows-inspector').getByRole('textbox',{name:'Mensagem',exact:true});
  await expect(message).toBeVisible();
  await message.fill('Mensagem sintética revisada');
  await expect(page.getByRole('button',{name:'Salvar',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Desfazer'}).click();
  await expect(message).not.toHaveValue('Mensagem sintética revisada');
  await page.getByRole('button',{name:'Refazer'}).click();
  await expect(message).toHaveValue('Mensagem sintética revisada');
  await page.getByRole('button',{name:'Salvar',exact:true}).click();
  await expect(page.getByText('Rascunho salvo.',{exact:true})).toBeVisible();
  const exportPending=page.waitForEvent('download');
  await page.getByRole('button',{name:'Exportar JSON'}).click();
  const exportFile=await exportPending;
  const stream=await exportFile.createReadStream();
  const chunks:Buffer[]=[];for await(const chunk of stream!)chunks.push(Buffer.from(chunk));
  const exported=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const exportedGraph=exported.flow?.graph??exported.graph;
  expect(exportedGraph.nodes.map((node:{id:string;position:unknown})=>({id:node.id,position:node.position})))
    .toEqual(graph.nodes.map(node=>({id:node.id,position:node.position})));
  await page.reload();
  await expect(page.getByText('150 blocos · 149 conexões')).toBeVisible();
  await page.getByRole('region',{name:'Canvas do flow',exact:true}).getByRole('button',{name:'Visão geral',exact:true}).click();
  await page.getByRole('button',{name:'Configurar Boas-vindas'}).click();
  await expect(message).toHaveValue('Mensagem sintética revisada');
  await test.info().attach('automation-editor-150-blocks',{body:await page.screenshot({path:`test-results/automation-editor-${isMobile?'mobile':'desktop'}.png`}),contentType:'image/png'});
});


test('four Flow areas keep canvas history and use scoped execution metrics with accessible tab navigation',async({page,isMobile})=>{
 test.setTimeout(90000);await signIn(page);await page.goto('/automations/new');
 await page.getByRole('textbox',{name:'Nome da automação'}).fill('Áreas do Flow sintético');await page.getByRole('button',{name:'Criar e abrir editor'}).click();
 const editor=page.getByRole('tab',{name:'Editor',exact:true});await expect(editor).toHaveAttribute('aria-selected','true');await expect(page.getByRole('tab')).toHaveCount(4);
 await editor.focus();await editor.press('ArrowRight');const configuration=page.getByRole('tab',{name:'Configurações',exact:true});await expect(configuration).toBeFocused();
 await page.getByRole('button',{name:'Configurar condições de entrada'}).click();await page.getByRole('combobox',{name:'Reexecução'}).selectOption('ONCE_PER_CONVERSATION');
 await page.getByRole('button',{name:'Salvar',exact:true}).click();await expect(page.getByText('Rascunho salvo.',{exact:true})).toBeVisible();
 await editor.click();await page.getByRole('button',{name:'Configurar Boas-vindas'}).click();const message=page.locator('.flows-inspector').getByRole('textbox',{name:'Mensagem',exact:true});const before=await message.inputValue();await message.fill('Mensagem de edição sintética');
 await configuration.click();await page.getByRole('tab',{name:'Playground',exact:true}).click();await editor.click();await expect(message).toHaveValue('Mensagem de edição sintética');await page.getByRole('button',{name:'Desfazer'}).click();await expect(message).toHaveValue(before);
 await page.getByRole('button',{name:'Testar',exact:true}).click();await expect(page.getByRole('tab',{name:'Playground',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByText('Teste local:',{exact:false})).toBeVisible();
 await page.getByRole('tab',{name:'Execuções',exact:true}).click();await expect(page.getByText('Nenhuma execução encontrada.',{exact:true})).toBeVisible();await expect(page.getByRole('definition').filter({hasText:'—'})).toHaveCount(1);
 await expectNoAutomaticAccessibilityViolations(page);
 await test.info().attach('flow-four-areas-executions',{body:await page.screenshot({path:`test-results/flow-four-areas-${isMobile?'mobile':'desktop'}.png`,fullPage:true}),contentType:'image/png'});
 await editor.click();await expect(message).toHaveValue(before);await expect(page.getByRole('button',{name:'Salvar',exact:true})).toBeDisabled();
});
