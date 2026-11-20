# Pi Bot

Um assistente de IA pessoal que vive no Telegram ou no WhatsApp: um container, um volume, nenhum painel web. Roda sobre o harness do [pi.dev](https://pi.dev). As ferramentas vêm do [Executor](https://executor.sh), do [Composio](https://composio.dev), do [Upsy](https://upsy.ai/docs) ou de um gateway MCP self-hosted.

**Status: Beta.** Pode ser usado no dia a dia; a configuração e os comandos ainda podem mudar entre as versões.

[Página do projeto](https://forge-z.github.io/pi-bot/)

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

1. **Setup gateway** — Telegram ou WhatsApp, um por instalação. Gravar um desliga o outro. Uma instalação sem escolha continua no Telegram. Perguntas de sim/não usam `(s/n)` e também aceitam sim, não, y, yes e no. No Telegram, o token do bot (oculto; Enter mantém o valor gravado) e os ids numéricos dos usuários permitidos. No WhatsApp, o número do dono com código do país e depois um QR ou um código de pareamento. O caminho completo está em [WhatsApp](#whatsapp).
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

Uma mensagem que abre um turno só ganha a reação 👀 se a resposta ainda não tiver saído depois de 4 segundos. `reaction_delay_ms` em `config.default.yaml` define essa espera; `$DATA_DIR/config.yaml` substitui. Uma resposta que sai antes cancela a reação, e o timer é limpo. `0` reage assim que a mensagem é aceita. Não há variável de ambiente para isso. O WhatsApp não envia essa reação.

Uma tarefa longa manda uma nota curta nesse mesmo chat antes do trabalho, nomeando o primeiro passo, e a resposta final vai sozinha. As notas seguintes são só para um resultado, um bloqueio ou uma mudança de plano: no máximo uma a cada 30 segundos e três nessa tarefa. Uma resposta rápida não manda essa nota. A nota é a ferramenta `progress`. Ela usa o mesmo caminho de entrega da resposta e não encerra o turno. Um run agendado não chama `progress` e continua em silêncio, a menos que chame `notify`. A reação 👀 continua esperando a resposta do turno.

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

### Subagentes

Desligado por padrão. Ligado, o modelo pode passar um trabalho somente leitura e autocontido (pesquisa ampla, leitura longa) para um `subagent` e guardar na conversa só a resposta final. O subagente usa o mesmo modelo, vê só as ferramentas MCP, e toda chamada MCP que não é leitura é recusada antes de ser enviada. O `/stop` também para os subagentes em execução. Ligue em `$DATA_DIR/config.yaml` e reinicie:

```yaml
subagents:
  enabled: true
```

Limites, regras e como medir o custo: [docs/subagents.md](docs/subagents.md).

## WhatsApp

Um gateway de telefone por instalação. A escolha é no `npm run setup`. Gravar WhatsApp desliga o Telegram, e gravar Telegram desliga o WhatsApp. Uma instalação que nunca escolheu continua no Telegram. O WhatsApp usa o [Baileys](https://github.com/WhiskeySockets/Baileys) e o [qrcode-terminal](https://github.com/gtanner/qrcode-terminal). O Baileys fala o WhatsApp Web não oficial, o que pode levar a restrição da conta. Nenhuma variável de ambiente nova é obrigatória para o container subir.

### Setup

```sh
docker exec -it <container> npm run setup
```

Abra **Setup gateway** e depois **2 - WhatsApp**.

Perguntas de sim ou não usam `(s/n) [s]` ou `(s/n) [n]`. `s`, `sim`, `y` e `yes` são sim. `n`, `no`, `nao` e `não` são não. Enter mantém a sugestão entre colchetes. Qualquer outro texto é perguntado de novo.

**1 - Allowed numbers** pede dígitos com código do país. O primeiro número é o do dono. Números extras são opcionais e separados por vírgula, por exemplo `15550001111,5500900000001`. Cada número tem de 8 a 15 dígitos. **Save and back** grava essa lista e seleciona o WhatsApp. O número do dono é obrigatório antes de gravar e antes de parear.

Um celular do Brasil é o código `55`, um DDD de dois dígitos e 8 dígitos. O número que se disca costuma ter um `9` logo depois do DDD, e o JID do WhatsApp de uma conta mais antiga é o mesmo número sem esse `9`: `5500900000001` e `550000000001` (DDD `00`). O setup grava os dígitos digitados, na lista e em `WHATSAPP_ALLOWED_USERS`. Não reescreve uma forma na outra. Quando uma mensagem chega, a lista de permitidos e a conta vinculada tratam essas duas formas como o mesmo número, então a mensagem não é descartada como `not-allowed` só porque um lado tem o `9`. O chat fica ligado ao JID que o WhatsApp enviou, que pode ser a forma mais curta, e a resposta vai para esse chat. O dígito extra só conta quando é um `9` imediatamente depois do DDD. `5500911111111` é outro número. Um número que não tenha exatamente uma dessas duas formas, inclusive um número de 13 dígitos cujo dígito depois do DDD não é `9`, é comparado como foi escrito. Um LID não é telefone e não é reescrito. O `npm run diagnose` e a linha `dropped inbound` mostram só os quatro últimos dígitos, então não mostram se o `9` está presente.

`WHATSAPP_ALLOWED_USERS` é opcional. Só é lida quando o gateway é o WhatsApp. Quando está definida, substitui a lista gravada. Sem ela, valem os números do setup. Um valor que não seja essa lista separada por vírgula impede a subida. Não é obrigatória para o container subir.

Enquanto o setup espera uma resposta, e enquanto espera o telefone conectar, o logger do Baileys fica em silêncio. As linhas de mensagem descartada não são impressas durante o pareamento, para não cobrirem o prompt. O que o terminal mostra até o telefone conectar é o QR ou o código.

### Pareamento e onde a sessão fica

**2 - Pair with QR** imprime um QR nesse terminal. Escaneie em Aparelhos conectados no WhatsApp. **3 - Pair with phone code** pergunta qual número vincular (Enter mantém o do dono) e depois imprime `WhatsApp pairing code: …`. O pareamento fica aberto até o telefone conectar. O prompt do menu é pausado nessa espera, para um prompt fechado não encerrar o processo antes do QR.

A sessão fica em `$DATA_DIR/whatsapp-auth/`. `creds.json` nesse diretório significa que o telefone está pareado. No container, `$DATA_DIR` é `/app/data`, no volume do Compose `pi_bot_data`. Ao lado da sessão, o volume também guarda `whatsapp-lid-map.json` (um LID ligado a um telefone) e `whatsapp-sent.json` (os últimos 200 ids enviados, por sete dias, para um eco do próprio envio continuar descartado depois de um reinício). Um volume novo e vazio não tem esses arquivos.

Se o gateway em execução já segura `$DATA_DIR/owner.lock`, o setup recusa uma segunda sessão e imprime `o gateway já mostra o QR nos logs`. Leia esse QR nos logs do container, ou pare o gateway antes de parear pelo setup.

### Quem pode enviar, e o prefixo `Pi: `

O dono, os números extras gravados com esse número e o próprio chat da conta vinculada podem enviar texto, imagem e nota de voz. A conta vinculada entra sempre, com ou sem a lista: o telefone dela (incluindo um sufixo de aparelho como `:31`), o LID dela e "mensagem para você mesmo". O bot responde no mesmo chat. Só nesse chat da própria conta o texto e a legenda começam com `Pi: `. Uma resposta que já começa com `Pi:` não ganha outro prefixo. Um chat com qualquer outro número permitido sai sem prefixo.

Grupos, transmissões de status, newsletters e qualquer outro número são ignorados. Um vídeo, um sticker ou um documento que não seja JPEG, PNG, WebP ou GIF recebe `Attachment received, but for now I only read images (photo or JPEG/PNG/WebP/GIF) and voice notes.` e não inicia um turno.

As respostas são texto puro, cortadas em 3800 caracteres. Um título Markdown vira `*título*`, `**negrito**` vira `*negrito*`, e `[rótulo](https://example.test)` vira `rótulo (https://example.test)`. Não há botões. O `ask_user` não é registrado no WhatsApp. Aprovações são uma lista numerada; responda com o número. Esse número é lido antes de um número de modelo, esforço ou agenda.

### Comandos

Não há menu no BotFather. O comando é texto no chat. `/help` e `/start` enviam esta lista. Os nomes continuam em inglês:

| Comando     | O que o WhatsApp faz                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/status`   | Estado, tokens e custo deste chat                                                                                                                                |
| `/stop`     | Cancela o trabalho pendente neste chat, e o texto ainda segue para o modelo. A legenda de uma foto ou nota de voz conta. `/cancel` não é comando                 |
| `/new`      | Nova conversa neste chat. A anterior permanece no volume. Resultados MCP incertos permanecem; `/resume` é que os dispensa. Este chat fica ligado à conversa nova |
| `/resume`   | Retoma uma tarefa presa, ou dispensa um resultado MCP incerto                                                                                                    |
| `/compact`  | Compacta este chat. O texto depois do comando é um foco opcional                                                                                                 |
| `/model`    | Lista numerada de modelos. Responda com o número. Palavras depois de `/model` não escolhem modelo; ainda assim abrem a lista                                     |
| `/thinking` | Lista numerada de esforço. Responda com o número                                                                                                                 |
| `/crons`    | Agendamentos deste chat. Responda com o número para ligar ou desligar um. Este comando não cria agendamento                                                      |
| `/help`     | A lista acima                                                                                                                                                    |

Uma mensagem que começa com `//` é texto, não comando. Uma barra é removida antes de o modelo ver, então `//status` chega como `/status`. Um comando desconhecido recebe a lista de ajuda e não inicia um turno. Foto ou nota de voz não é comando, exceto quando a legenda é `/stop`.

Para criar um agendamento, peça no chat. `/crons` só liga ou desliga um que já existe neste chat.

### Agendamentos e avisos

Um agendamento criado num chat de WhatsApp permanece nesse chat. O `notify` é entregue no chat de WhatsApp ligado à conversa. O run fica em silêncio se não chamar `notify`. O agendador sobe junto com o gateway de WhatsApp. O Telegram continua subindo o agendador dele no loop de polling. Subir qualquer um dos gateways cancela os envios pendentes do outro canal, registra `Inactive gateway: cancelled N pending deliveries.` e grava o motivo `gateway inativo`. Uma linha sem canal é tratada como Telegram.

### Upsy

O setup imprime o link de login do Upsy. Cole a URL final do navegador no chat de WhatsApp vinculado, a mesma cola que o Telegram aceita, mesmo se a página não carregar. O redirect é `http://127.0.0.1:33418/callback` e nada escuta nessa porta. Essa cola não vai para o modelo. A resposta volta no mesmo chat. Não existe comando `/login`. `npm run login` é só OAuth do ChatGPT/Codex, e `--aggregators upsy` não inicia o login.

### Docker

`docker compose up` monta `pi_bot_data` em `/app/data`. A sessão do Baileys só existe nesse volume. Um volume novo ou renomeado está vazio e precisa parear de novo. Para manter a sessão, pare o container e copie o volume antigo para o novo antes de subir. Enquanto o processo espera um QR, ou reconecta depois de uma queda que não é logout, o arquivo de saúde continua atual, então o Docker não reinicia o processo. O QR impresso pelo gateway em execução está em `docker compose logs`, não numa segunda sessão de setup.

### Quando algo falha

- **Parear de novo.** No setup, escolha **2** ou **3**. Se o gateway já está no ar, use o QR dos logs dele. Depois que o telefone conecta, o setup imprime `WhatsApp paired. The session stays on the data volume.`
- **Logout.** Se o telefone remove o aparelho vinculado, o processo continua de pé e registra `WhatsApp: session logged out. Pair again with npm run setup, or scan the QR in these logs.` O diretório `whatsapp-auth` é renomeado para `whatsapp-auth.loggedout-<timestamp>`, e um `whatsapp-auth` vazio é criado. O próximo QR sai nesses logs. Uma queda que não é logout reconecta sem encerrar o processo. Se o socket não abrir, o número no erro é mascarado, o processo continua de pé e outra reconexão é agendada.
- **`dropped inbound`.** Uma mensagem que não entra é uma linha: `WhatsApp: dropped inbound (<motivo>) ***<quatro últimos dígitos> remote=pn|lid|other alt=yes|no fromMe=true|false`. O motivo é `group`, `broadcast`, `echo` (envio do próprio bot), `not-allowed` (não é um número permitido nem a conta vinculada), `not-self` (a conta vinculada enviou para outra pessoa), `empty` ou `history` (uma sincronização antiga, não uma mensagem nova). Um evento vazio da própria conta vinculada não é registrado. O pareamento no setup não imprime essas linhas. Um envio que falha é `WhatsApp: send failed (...)`, com números longos mascarados. Numa instalação WhatsApp, `npm run diagnose` imprime os números mascarados nos quatro últimos dígitos e pula as checagens do Telegram.

## Comandos

No Telegram o app registra este menu ao subir. Não há o que configurar no BotFather. No WhatsApp os nomes são texto no chat. [WhatsApp](#whatsapp) é a lista que `/help` envia lá: `/crons` só liga ou desliga um agendamento desse chat. Os comandos são em inglês.

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

Voltar a imagem sem restaurar o backup deixa o ledger numa forma que a release anterior pode não ler. O Pi 1.6.0 mantém o schema SQLite 2 e grava `pi.tool` na versão 4 e `pi.generation` na versão 3; a imagem anterior bloqueia essas tarefas.

## Notas

- O harness é o Pi 1.6.0 (`pi-ai`, `pi-durable` e `chord`). As conversas ficam no `durable.sqlite`. O processo roda sem terminal, então um turno segue sem pedir Continue, Fork ou Cancel. A busca de MCP adiado encontra uma ferramenta cujo schema só nomeia um modelo por um `$ref` local. Os catálogos da OpenAI, da Azure e do Codex incluem GPT-6.2 Astra e GPT-6.2 Sol. O `/thinking` não oferece `off` nesses modelos. Uma conversa mantém o modelo que já estava salvo.
- Histórico, credenciais e o ledger são tão privados quanto o volume e o host.
- O assistente não tem shell, arquivo, patch nem browser próprios. O que volta do MCP é dado não confiável.
- `ask_user` posta uma pergunta no mesmo chat e tópico e encerra o turno. Até seis opções viram botões (`ask:<32 hex>:<índice>`). Um toque vira a mensagem seguinte (`Answer to: … -> …`). Digitar também vale como mensagem normal e os botões saem. Toque repetido ou velho não faz nada. Rotina agendada não pode perguntar. Esses botões não são cartões de aprovação.
- Ollama é a exceção da reserva compatível. Uma base em `ollama.com`, na porta `11434` ou com `/api` no caminho é consultada uma vez por modelo (`POST /api/show`, cerca de 2s, em cache). Se o modelo anuncia `thinking`, o `/thinking` oferece `off`, `low`, `medium` e `high`, ou os níveis nomeados dessa resposta. Um campo `reasoning` explícito em `LLM_MODELS` continua vencendo. A chamada envia `reasoning_effort` (`none` desliga o raciocínio). Falha na consulta deixa o modelo como estava.
- Um erro de MCP ou Executor que voltou fica com o modelo. O chat só é avisado quando uma escrita saiu sem resultado conhecido, uma vez, numa linha curta em português, com **Registrar verificação** e, quando há o que mostrar, **Detalhes**. Uma leitura que cai no transporte é tentada de novo duas vezes (40 ms, depois 80 ms). Uma escrita nunca é reenviada. `/status` lista o estado e não posta outro cartão.
- Depois que a pessoa aprova ou recusa um cartão MCP, o texto final desse turno seguinte é entregue no mesmo chat. Uma resposta vazia não envia nada. A conferência "Deu certo" / "Não rodou" não muda. Uma ferramenta que devolve só um id de tarefa, sem manifesto de job, não é promessa de voltar: o assistente consulta por cerca de 50 segundos, usa o job registrado, ou cria uma checagem única que chama `notify` neste chat. Veja [docs/jobs.md](docs/jobs.md).
- Notas de deploy: [docs/coolify.md](docs/coolify.md) e [docs/verification.md](docs/verification.md).
- English: [README.md](README.md).
