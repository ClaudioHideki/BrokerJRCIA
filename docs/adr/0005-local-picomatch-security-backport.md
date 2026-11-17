# 0005 — Backport local da proteção de extglob do picomatch

Data: 17/11/2026. Status: implementado na candidata; CI/release pendentes.

A candidata de áudio e8f83c4 passou no E2E real de laboratório, mas a CI
44143082504 falhou em npm audit devido ao GHSA-fc5q-39xc-vjpf da dependência
de desenvolvimento picomatch 4.0.7. Auditoria de produção estava limpa.
O registry não oferecia versão corrigida; PR upstream 194 declara que
+(*a) continua vulnerável. Nenhuma exceção de advisory foi autorizada/aplicada.

Decisão: manter o gate npm audit, preservar licença/proveniência e usar
fork local 4.0.7+jrc.1 com guard adicional no fallback já existente. Root
devDependency/override e lockfile devem apontar todos os consumidores ao
fork; Docker precisa incluí-lo antes de npm ci. Metadados de build não
representam release upstream nem certificação externa do fork.

Cinco casos com timeout foram reproduzidos antes do patch. Os testes
posteriores cobrem execução limitada em subprocessos, globs usuais, classes
de caracteres, achatamento seguro e resolução efetiva das dependências.
Padrões repetidos ambíguos com wildcard passam a ser literais. Configuração
do produto não deve desabilitar maxExtglobRecursion. Ver vendor/picomatch/JRC-PATCH.md.

Remover o fork quando existir versão oficial que resolva o advisory, após
reproduzir a regressão e validar compatibilidade do novo lockfile. A análise
do advisory Baileys da engine é uma frente separada; esta decisão não
atualiza Evolution, sessão WhatsApp ou receiver LAB2.
