import {expect,test} from '@playwright/test';
import {signIn,expectNoAutomaticAccessibilityViolations} from './helpers.js';
import {platformTestCredentials} from './platform-fixture.js';

test('empresa abre chamado, equipe recebe e responde, empresa acompanha e resolve',async({page,browser},testInfo)=>{
  const title=`Ajuda na conexão ${testInfo.project.name}`;
  await signIn(page);
  await page.goto('/suporte');
  await expect(page.getByRole('heading',{name:'Suporte JRC'})).toBeVisible();
  await page.getByLabel('Assunto',{exact:true}).fill(title);
  await page.getByLabel('Descreva o problema').fill('Canal sintético precisa de verificação.');
  await page.getByRole('button',{name:'Abrir chamado',exact:true}).click();
  await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
  const context=await browser.newContext({baseURL:testInfo.project.use.baseURL});
  const staff=await context.newPage();
  try {
    const credentials=platformTestCredentials(testInfo.project.name);
    await staff.goto('/jrc');
    await staff.getByLabel('E-mail JRC').fill(credentials.email);
    await staff.getByLabel('Senha',{exact:true}).fill(credentials.password);
    await staff.getByRole('button',{name:'Entrar na administração'}).click();
    await expect(staff.getByRole('heading',{name:'Visão geral',exact:true})).toBeVisible();
    await staff.goto('/jrc/suporte');
    await expect(staff.getByRole('heading',{name:'Chamados recebidos'})).toBeVisible();
    await staff.getByRole('button').filter({hasText:title}).click();
    await staff.getByRole('button',{name:'Assumir atendimento'}).click();
    await expect(staff.getByRole('combobox',{name:'Situação',exact:true})).toHaveValue('IN_PROGRESS');
    await staff.getByLabel('Resposta',{exact:true}).fill('Conexão conferida pela equipe JRC.');
    await staff.getByRole('button',{name:'Enviar resposta'}).click();
    await expect(staff.getByRole('region',{name:'Histórico do chamado'}).getByRole('list').getByText('Conexão conferida pela equipe JRC.',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Atualizar histórico'}).click();
    await expect(page.getByRole('region',{name:'Histórico do chamado'}).getByRole('list').getByText('Conexão conferida pela equipe JRC.',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Marcar como resolvido'}).click();
    await expect(page.getByRole('region',{name:'Histórico do chamado'}).getByText('Resolvido',{exact:true})).toBeVisible();
    await expectNoAutomaticAccessibilityViolations(page);
    await expectNoAutomaticAccessibilityViolations(staff);
  } finally {await context.close();}
});
