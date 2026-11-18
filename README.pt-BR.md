# Pi Bot

Um assistente de IA pessoal que vive no Telegram ou no WhatsApp: um container, um volume, nenhum painel web. Roda sobre o harness do [pi.dev](https://pi.dev). As ferramentas vêm do [Executor](https://executor.sh), do [Composio](https://composio.dev), do [Upsy](https://upsy.ai/docs) ou de um gateway MCP self-hosted.

**Status: Beta.** Pode ser usado no dia a dia; a configuração e os comandos ainda podem mudar entre as versões.

## Instalar

```sh
git clone https://github.com/forge-z/pi-bot.git
cd pi-bot
cp .env.example .env
docker compose up -d --build
```

Nenhuma variável de ambiente é obrigatória para o container subir. A imagem é somente leitura, fora o volume em `/app/data` (`app.sqlite` e `durable.sqlite`).

## Configurar

Rode o setup no container antes de usar o bot. Um container novo permanece no ar e saudável enquanto espera.

```sh
docker exec -it <container> npm run setup
```

O menu edita uma seção de cada vez. **Save and back** grava essa seção. **Save and restart gateway** recarrega o bot em execução a partir do volume.

1. **Setup gateway** — Telegram ou WhatsApp, um por instalação. Gravar um desliga o outro. Uma instalação sem escolha continua no Telegram. Perguntas de sim/não usam `(s/n)` e também aceitam sim, não, y, yes e no. No Telegram, o token do bot (oculto; Enter mantém o valor gravado) e os ids numéricos dos usuários permitidos. No WhatsApp, o número do dono com código do país (um celular brasileiro vale com ou sem o 9 extra depois do DDD; números extras separados por vírgula) e depois um QR ou um código de pareamento. A sessão fica no volume. O setup não abre uma segunda sessão enquanto o gateway está no ar.
2. **Text model** — um provedor oficial do pi-ai, ou `[0]` ChatGPT (OAuth Plus/Pro, sem chave de API). `npm run login` é só OAuth do ChatGPT/Codex.
3. **Image model**
4. **Audio model**
5. **MCP platform** — Composio, Executor, Upsy, Self-hosted, os dois (Executor e Composio), ou nenhum.

O Upsy (`https://upsy.ai/connect`) não tem chave de API. O setup imprime o link de login. Cole a URL final do navegador de volta, mesmo se a página não carregar. O redirect é `http://127.0.0.1:33418/callback` e nada escuta nessa porta. Os tokens ficam na credencial `mcp-upsy` do volume e são renovados sozinhos. A mesma cola funciona no Telegram ou no WhatsApp, no chat vinculado. No WhatsApp o aviso de login vai para esse chat. `--aggregators upsy` não inicia o login; só seleciona o Upsy quando já existe um refresh token. `npm run login` continua sendo ChatGPT/Codex e não é esse fluxo.

Self-hosted é uma URL MCP genérica, um token opcional (credencial `mcp-self-hosted`) e um header opcional. Header vazio envia `Authorization: Bearer`. Outro nome envia o token cru. Sem token, a chamada sai sem header de autenticação. Overrides opcionais, nenhum obrigatório: `SELF_HOSTED_MCP_URL`, `SELF_HOSTED_TOKEN`, `SELF_HOSTED_HEADER`. Uma URL definida liga o servidor mesmo quando o menu escolheu outra coisa. O Executor self-host (UsefulSoftwareCo/executor) fala Streamable HTTP em `<origin>/mcp` (CLI local `http://127.0.0.1:4312/mcp`, Docker `http://127.0.0.1:4400/mcp`) com personal access token ou API key local em `Authorization: Bearer`. O item Executor do menu continua sendo o que preserva o relay de aprovação e os jobs. O runelay fala Streamable HTTP em `<origin>/v1/mcp` (app local `http://127.0.0.1:4312/v1/mcp`) com chave `rnl_…` em `Authorization: Bearer`.

Os globs de escrita em `config.default.yaml` vencem os de leitura, então `get_or_create` é escrita. Um `execute` só é leitura quando cada `tools` é uma chamada reconhecida (`tools.a.b(...)` ou `pick("...")`). Alias ou `tools["a"]` contam como escrita. Não há entrada webhook para jobs assíncronos. O access token do Upsy não é copiado para o servidor; o login só o anexa quando a URL é a do Upsy. A descoberta recusa resource ou issuer que não batem com o pedido.

O Executor decide quais chamadas precisam de aprovação; o bot só encaminha essa pausa. Não há uma segunda aprovação a partir das listas de leitura/escrita. No chat, a pausa é o cartão que já existe. Num run agendado a chamada é enviada, e se o Executor devolver approval-required a ferramenta falha com `needs approval; not available in scheduled runs` mais o caminho da ferramenta. Não há cartão e não há resume. Um servidor sem lista `tools` própria usa as listas do Executor e a mesma regra. O Composio tem lista própria: uma escrita continua recusada antes do envio num run agendado. `writes=true` em `sandbox_code_task` continua esperando o cartão.

Não existe comando `/login`. O OAuth precisa de callback em localhost ou da URL de redirect colada.

Variáveis de ambiente são overrides opcionais. Quando uma está definida, ela vence o valor gravado no volume. `TZ` é o relógio do container (o horário dos logs). Cada agendamento guarda o próprio fuso IANA. O setup não grava `TZ`. Sem ela, o relógio fica em UTC. `WHATSAPP_ALLOWED_USERS` substitui os números gravados para o WhatsApp. Nenhuma variável nova é obrigatória para o container subir.

Ids de grupo e tópico (`TELEGRAM_ALLOWED_CHATS`) ficam só no ambiente. A reserva compatível (`LLM_BASE_URL` / `LLM_API_KEY`, menu **Other**) é ignorada quando já existe um setup oficial no volume.

### Sandbox

A tarefa longa de código é `sandbox_code_task` (Instabox por padrão). Ela fica desligada até o operador configurar. O config que vem no repositório não nomeia máquina, conta nem repositório.

- `INSTABOX_ACCOUNT_ID` e `INSTABOX_MACHINE_ID` são opcionais. Sem elas, a descoberta usa uma conta só quando existe exatamente uma vinculada, e uma máquina só quando existe exatamente uma em execução. Zero ou várias é um erro que lista o que encontrou. Não há nome de máquina padrão.
- `INSTABOX_REPO_ALLOWLIST` (ou `sandbox_code_task.allow.patterns` em `$DATA_DIR/config.yaml`) é a allowlist de repositórios. O padrão é vazio: nenhum repositório é permitido até você definir a lista. `owner/*` casa com esse dono. A variável de ambiente, quando definida, vence o arquivo.

`writes=true` (push, pull request ou comentário) espera o cartão de aprovação. Sem isso a tarefa é somente leitura: o runner não faz push, não abre pull request e não grava branch. Depois do clone, as credenciais de escrita do GitHub saem do alcance do agente e voltam quando o job termina. A máquina precisa das cópias do repositório de `scripts/instabox/start-job.sh` e `scripts/instabox/run-job.sh`. Veja [docs/jobs.md](docs/jobs.md).

As entregas no Telegram saem em HTML. Negrito em volta de código inline não deixa tag vazia. Se o Telegram responde HTTP 400 porque não conseguiu ler as entidades, a mesma entrega é enviada uma vez em texto puro, no mesmo chat, tópico e reply. Um 400 que não é de parse não é reenviado. O `description` do Telegram passa pelo redator antes do log e da linha que falhou. Tokens `Bearer` e `sk-` entram no mesmo redator que já cobre os segredos configurados, inclusive na linha de log do run agendado. Uma lista MCP gravada que ainda tenha `cuaViewer` falha a validação.

### Skills do operador

Instruções opcionais no volume valem para toda resposta, inclusive os runs agendados. Cada skill é uma pasta, por exemplo `$DATA_DIR/skills/weekly-review/SKILL.md`:

```md
---
name: weekly-review
description: O que verificar numa revisão semanal
---

Liste o que ainda está aberto na semana e o que pode esperar.
```

Liste as pastas em `$DATA_DIR/config.yaml`. A lista substitui o padrão, que é vazio:

```yaml
skills:
  always:
    - weekly-review
```

O prompt de sistema lista cada nome e descrição, nessa ordem, depois das instruções base e antes das seções de MCP. O modelo carrega o corpo com a ferramenta somente leitura `read_skill`. A lista é a mesma em toda resposta, inclusive nos runs agendados. Uma lista vazia, ou uma pasta de skills que não existe, deixa o prompt igual e não registra a ferramenta. Um nome ausente, frontmatter inválido ou arquivo ilegível é registrado no log e ignorado. Um nome desconhecido em `read_skill` devolve erro e nenhum corpo. O bot sobe mesmo assim.

## WhatsApp

Um gateway de telefone por instalação. O WhatsApp usa o [Baileys](https://github.com/WhiskeySockets/Baileys), que fala o WhatsApp Web não oficial. Isso pode levar a restrição da conta. O dono, os números extras gravados com esse número e o próprio chat da conta vinculada podem enviar texto, imagem e nota de voz. O bot responde nesse chat. O chat da própria conta vinculada sai com o prefixo `Pi: `; os outros chats não. Grupos, transmissões e qualquer outro número são ignorados.

As respostas são texto puro. Não há botões. Aprovações, `/model`, `/thinking` e `/crons` são listas numeradas. O `ask_user` não é oferecido no WhatsApp. Uma mensagem que começa com `//` vai como texto, não como comando (`//status` chega ao modelo como `/status`). `/stop` cancela este chat e também segue para o modelo. Um agendamento criado neste chat permanece neste chat: o `notify` é entregue aqui, e o run fica em silêncio se não chamar `notify`. Subir um gateway cancela os envios pendentes do outro canal. O agendador sobe junto com o gateway. Numa instalação WhatsApp, `npm run diagnose` imprime os números mascarados nos quatro últimos dígitos e pula as checagens do Telegram.

## Comandos

No Telegram o app registra este menu ao subir. Não há o que configurar no BotFather. No WhatsApp os mesmos comandos são texto na conversa. Os comandos são em inglês.

| Comando     | O que faz                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| `/model`    | Provedor e modelo deste tópico                                                                                  |
| `/thinking` | Esforço deste tópico                                                                                            |
| `/crons`    | Criar e administrar agendamentos                                                                                |
| `/new`      | Outra conversa neste tópico. A anterior permanece no volume                                                     |
| `/resume`   | Retoma uma tarefa presa: uma tarefa estacionada após crash, ou um resultado MCP incerto                         |
| `/stop`     | Para este tópico                                                                                                |
| `/compact`  | Compacta este tópico agora. O texto depois do comando é um foco opcional. Recusa enquanto o tópico está ocupado |
| `/status`   | Modelo, tokens e custo deste tópico, MCPs, a execução atual e a versão                                          |
| `/help`     | Esta lista                                                                                                      |

`/resume` dispensa um resultado MCP incerto sem repetir a chamada (a chamada pode já ter ocorrido) e continua uma tarefa que ficou estacionada depois de um crash. `/new` não limpa um resultado incerto.

Cada tópico nativo (tópico de forum) tem o próprio histórico, modelo e esforço.

## Atualizar

### Upgrading from pi-agent-tg

O serviço do Compose é `pi-bot` e o volume nomeado é `pi_bot_data`, ainda montado em `/app/data`. Um volume renomeado é um volume novo e vazio. Para manter os dados, pare o container, copie o volume antigo para o novo, faça o deploy e confira `/status`. Guarde o volume antigo como backup por alguns dias.

```sh
docker run --rm -v old:/from -v new:/to alpine cp -a /from/. /to/
```

`old` é o volume existente `pi_agent_tg_data` e `new` é `pi_bot_data`. Use os nomes de `docker volume ls` quando o Compose tiver acrescentado o prefixo do projeto.

Faça backup do volume antes de atualizar. O primeiro boot desta release migra `pending_jobs` acrescentando colunas. O `ALTER TABLE` do SQLite não tem migração de volta. Na subida, linhas antigas de `mcp_calls` cujo id começa com `mcp-stage:` são apagadas, e uma chamada que ficou `running` é reclassificada (`failed` se era leitura, `uncertain` se era escrita). O poller de jobs apaga em seguida as linhas de jobs já terminados com mais de 30 dias. Linhas abertas permanecem. Não há rollback desses dados: restaure o backup se precisar do volume anterior. A migração anterior do `durable.sqlite` para o schema 2, da release passada, também continua sem rollback.

Voltar a imagem sem restaurar o backup deixa o ledger numa forma que a release anterior pode não ler.

## Notas

- O harness é o Pi 1.5.2 (`pi-ai`, `pi-durable` e `chord`). As conversas ficam no `durable.sqlite`. O processo roda sem terminal, então um turno segue sem pedir Continue, Fork ou Cancel. A busca de MCP adiado encontra uma ferramenta cujo schema só nomeia um modelo por um `$ref` local.
- Histórico, credenciais e o ledger são tão privados quanto o volume e o host.
- O assistente não tem shell, arquivo, patch nem browser próprios. O que volta do MCP é dado não confiável.
- `ask_user` posta uma pergunta no mesmo chat e tópico e encerra o turno. Até seis opções viram botões (`ask:<32 hex>:<índice>`). Um toque vira a mensagem seguinte (`Answer to: … -> …`). Digitar também vale como mensagem normal e os botões saem. Toque repetido ou velho não faz nada. Rotina agendada não pode perguntar. Esses botões não são cartões de aprovação.
- Ollama é a exceção da reserva compatível. Uma base em `ollama.com`, na porta `11434` ou com `/api` no caminho é consultada uma vez por modelo (`POST /api/show`, cerca de 2s, em cache). Se o modelo anuncia `thinking`, o `/thinking` oferece `off`, `low`, `medium` e `high`, ou os níveis nomeados dessa resposta. Um campo `reasoning` explícito em `LLM_MODELS` continua vencendo. A chamada envia `reasoning_effort` (`none` desliga o raciocínio). Falha na consulta deixa o modelo como estava.
- Um erro de MCP ou Executor que voltou fica com o modelo. O chat só é avisado quando uma escrita saiu sem resultado conhecido, uma vez, numa linha curta em português, com **Registrar verificação** e, quando há o que mostrar, **Detalhes**. Uma leitura que cai no transporte é tentada de novo duas vezes (40 ms, depois 80 ms). Uma escrita nunca é reenviada. `/status` lista o estado e não posta outro cartão.
- Notas de deploy: [docs/coolify.md](docs/coolify.md) e [docs/verification.md](docs/verification.md).
- English: [README.md](README.md).
