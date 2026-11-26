# Entrega de entradas novas com pendência anterior do mesmo contato

Uma tentativa de envio à caixa pode perder a resposta após a gravação remota. O Broker preserva essa tentativa em UNKNOWN para conciliação. Quando uma mensagem individual nova chega por QR e já existe vínculo com a conversa remota, o Broker registra o destino junto com o primeiro evento durável.

O worker pode entregar essa nova mensagem independentemente da tentativa anterior quando ambas pertencem ao mesmo contato, conversa e destino comprovados. Essa entrega exige o protocolo de recibo idempotente do JRC Conversas. Uma falha de consulta da capacidade preserva o trabalho para nova tentativa. O worker verifica novamente o vínculo antes do envio.

Importações, eventos repetidos e trabalhos antigos não recebem a marca de admissão. A decisão vale por conexão e organização. Os testes em PostgreSQL cobrem perda de resposta, repetição, capacidade indisponível e mudança do vínculo.
