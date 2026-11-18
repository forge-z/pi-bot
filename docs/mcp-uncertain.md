# Resultado MCP incerto

Quando uma escrita MCP sai sem resultado conhecido (timeout, queda depois do envio, sessão perdida depois do envio), a linha em `mcp_calls` fica `uncertain`. Um resultado que voltou, mesmo com `isError`, ou um payload que falhou o schema, fica `failed`: o modelo vê o erro e o chat não é avisado. Isso fica no SQLite e sobrevive a reinício. A chamada não é reenviada. A incerteza bloqueia novas ações **naquele servidor**; outro servidor da mesma conversa continua. Uma leitura continua disponível, **não** fica incerta e **não** apaga a incerteza.

A lista leitura/escrita não decide a aprovação do Executor: quem decide é o Executor, e o bot só encaminha a pausa. A lista continua decidindo resultado incerto, timeout e se uma escrita pode ser repetida.

`/resume` marca todas as incertezas da conversa como `skipped` e registra no log. A resposta avisa, em inglês, que a chamada pode já ter sido executada (por exemplo, um e-mail pode ter saído) antes de o agente continuar. O mesmo comando também retoma uma tarefa estacionada por quedas, e faz as duas coisas numa resposta só quando as duas estão pendentes. O cartão de verificação sai uma vez, só para essa escrita sem resultado, e não volta no `/status`. `/status` só lista o estado. O cartão mostra servidor, ferramenta e, em Detalhes, o alvo e os parâmetros. Se o conteúdo teve de ser ocultado, os botões de confirmação não aparecem e o texto aponta `/resume` como saída.

## O que conta como leitura

A lista mora nos globs de `config.default.yaml` (`mcp_servers.*.tools.read` e `tools.write`), não num conjunto `KNOWN_READS`. Escrita tem precedência: `**.*create*`, `**.*send*`, `**.*delete*` e `**.*update*` são escrita mesmo quando o nome também casa com `**.get*` (`get_or_create`). `search`, `describe` e `skills` continuam leitura no código. O mesmo coletor de caminhos vale para um `call` direto, um lote `calls` e um envelope `execution`. O lote só é leitura se todo caminho coletado for leitura. Um `execute` ou `call` com código só é leitura se cada ocorrência de `tools` for uma chamada reconhecida (`tools.a.b(...)` ou `pick("...")`); um alias (`const g = tools.gmail`) ou colchetes (`tools["gmail"].send`) contam como escrita. `resume` nunca é leitura: o modelo não pode chamar `resume`; só a decisão humana em `decide` despacha.

## O que não é incerteza

`McpNotSentError` e `PolicyError` aconteceram antes do envio e ficam `failed`. Uma rejeição do Executor `InputInvalid` / `UnknownTool` (inclusive HTTP 422) sem `toolCalls` bem-sucedidos também fica `failed`, com um aviso de que nada foi despachado. Um erro de ferramenta que voltou (`isError`) e um resultado que não bate com o schema ficam `failed`. Incerto fica a escrita que saiu e não trouxe resultado: timeout, queda no meio, ou sessão perdida depois do envio. Uma leitura que cai no transporte é tentada de novo; uma escrita nunca é.

Linhas antigas `mcp-stage:*` são apagadas na subida. Um `running` de leitura vira `failed`; um `running` de escrita vira `uncertain`.

## Depois da aprovação

Aprovar ou recusar o cartão no chat abre um turno de sistema. O texto final desse turno é entregue no mesmo chat. Se não houver nada útil, a resposta vazia não é enviada. A conferência "Deu certo" / "Não rodou" não muda: o chat recebe só "Verificação registrada. Nada foi reenviado.", e o turno de sistema dessa conferência continua mudo.

English: Approving or declining the card in the chat starts a system turn whose final text is delivered in that chat. An empty reply is not sent. The "Deu certo" / "Não rodou" check is unchanged and stays silent apart from its own confirmation.
