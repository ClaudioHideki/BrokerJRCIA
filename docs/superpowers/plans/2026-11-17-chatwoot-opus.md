# Áudio Ogg/Opus — diagnóstico e execução

Escopo: concluir a pendência AUDIO-20261117 preservando origem, escopo,
custódia e UNKNOWN. Base Broker d2fec926 (funcional 4919ace); LAB2 main
89779191, consultadas novamente em 17/11. Checkout isolado, sem alterações
no checkout anterior. Nenhuma migration ou mudança de engine prevista.

## Evidência somente leitura

O anexo sintético de 440 bytes foi registrado pelo Active Storage como
audio/opus. GET do objeto assinável pelo serviço retornou HTTP 200,
Content-Type audio/opus, assinaturas OggS e OpusHead presentes e SHA256
48f09d4efd9964155445fece39c9b430619b92ead036cc834bb2f519a4171213fb.
Não registrar URL assinada ou credenciais. Imagem e PDF tinham os tipos
image/png e application/pdf. O Broker rejeita audio/opus em mediaKind.

## TDD e gates

- [x] RED: 13 testes, 11 negativos aprovados e 2 positivos falharam com
  MEDIA_TYPE_UNSUPPORTED antes de editar produto.
- [x] GREEN: normalização local ao download canônico de audio/opus para
  audio/ogg apenas com descritor audio e identificação Ogg/Opus válida;
  preservar bytes e todos os fences existentes.
- Verificação local: 52 testes em cinco arquivos aprovados (18 casos Opus),
  typecheck e git diff --check aprovados. CI e aceite continuam pendentes.
- [ ] Regressões de mídias, build/typecheck e CI do SHA final.
- [ ] Imagem e runtime verificados separadamente após gates.
- [ ] Novo áudio sintético nas conversas autorizadas; não repetir lote
  entregue, não alterar FAILED/UNKNOWN manualmente.
- [ ] Aceite no WhatsApp e JRC, segundo contato e inspeção de runtime.

O fixture synthetic-opus.ogg é o tom sintético anteriormente autorizado,
sem conteúdo de cliente. Não aceitar octet-stream ou application/ogg por
inferência. A normalização não amplia mediaKind globalmente.

## Reconciliação concorrente

Durante o envio da candidata a main avançou para f6b9ce010dbe92b27462f68eab96cbb019198c9f
(handoff humano genérico e contratos intake). Merge seletivo automático no
checkout isolado preservou esse incremento e o reparo de áudio no mesmo
cliente. Nove arquivos de testes, 87 casos aprovados após a composição;
typecheck e diff check aprovados. CI da candidata anterior a485840 não
substitui CI desta composição. Revalidar também LAB2 e runtime antes de release.
