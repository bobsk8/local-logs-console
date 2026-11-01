# Testar no F5 — roteiro rápido

## 1. Abrir

No VS Code do projeto, escolha **"Launch Extension (Sandbox)"** no painel Run and Debug e aperte **F5**.
Abre uma janela nova já nesta pasta, com só esta extensão ativa.

## 2. Rodar um cenário

1. `Ctrl+Shift+P` → **Local Logs Console: Run and Capture Command**
2. Digite o comando (ex.: `npm run all`) → Enter
3. O dashboard abre sozinho (ou `Ctrl+Alt+L`)

O comando fica salvo: na próxima vez ele aparece na lista, ou use `Ctrl+Alt+Shift+L` (roda o último).

## 3. O que conferir

| Comando | O que deve acontecer |
|---|---|
| `npm run all` | Roda vários cenários em sequência (bom primeiro teste) |
| `npm run nest` | `[Nest]` e `[RoutesResolver]` **inteiros**; cores somem; `ERROR` em vermelho |
| `npm run pino` | Coluna de hora com **hora real** (não `1730000000000`); `fatal` = ERROR; `status: 500` continua INFO |
| `npm run levels` | `0 errors`, `failover`, `errorHandler` = **INFO**; `TypeError` e `3 tests failed` = **ERROR**; `npm warn …` (stderr) = **WARN**; busca `stream:stderr` filtra o que veio do stderr |
| `npm run unicode` | `ação`, `coração ❤️`, `日本語`, emojis **sem `�`** |
| `npm run secrets` | Senhas/tokens viram `[REDACTED]` (selo 🛡 no detalhe); a URL da CDN e `prompt_tokens` **não** |
| `npm run stack` | Cada stack trace vira **uma linha só** com selo `+N`; ao abrir, o detalhe mostra os frames. Traceback do Python aparece como `ZeroDivisionError: …`. Busca `UserService` ou `stack:demo.js` encontra pelo frame |
| `npm run burst` | 15 mil linhas em ~3 s: o painel **não trava**, contadores sobem, rolagem fluida |
| `npm run live` | Fluxo contínuo. Teste: rolar para cima (para de seguir), `Ctrl+End` (volta), clicar/arrastar no histograma, botão **Stop** |
| `npm run prompt` | Digite `y` + Enter **no terminal** → aparece `you answered: "y"` |
| `npm run crash` | Terminal **não fecha**; dashboard mostra `Process exited with code 1` como ERROR; na sidebar a sessão fica com ✗ `exited 1` e botão **↻ restart** |

### Seguir um arquivo (rotação de log)

1. Rode `npm run tail` (captura normal ou em um terminal comum)
2. `Ctrl+Shift+P` → **Local Logs Console: Follow Log File** → `sandbox/logs/app.log`
3. A cada 40 linhas o arquivo é rotacionado: o dashboard deve continuar recebendo (`log rotated…`)

### Interface (com `npm run live` rodando)

- Abrir uma linha → painel de detalhe abre e a lista **continua no fim**
- Clicar num atributo do detalhe (ex.: `req.id`) → filtra só aquele request
- Busca: `level:error`, `since:1m`, `/GET \/users/`, e `(a|aa)+$` (deve ser recusada na hora, sem travar)
- Botão **📋 Paste** → digitar `/` na caixa de texto funciona
- **Clear** (clicar 2×) → limpa os logs, **mantém** a busca; sessões já encerradas somem da sidebar
- Sem nada rodando, o botão **Stop** fica desabilitado
- Trocar tema: `Ctrl+K Ctrl+T` → claro e alto contraste; a linha selecionada deve ficar legível
- Janela estreita (< 980 px) → detalhe vai para baixo, sem barra de redimensionar sobrando

### Novidades da 2.0

| O quê | Como testar | O que deve acontecer |
|---|---|---|
| Stack clicável | `npm run stack` → abra o `TypeError` → clique no link `…demo.js:69:…` da stack | Abre o `demo.js` na linha certa, ao lado do dashboard |
| Problems | Depois do `npm run stack`, `Ctrl+Shift+M` | Erro no `demo.js`, na linha que lançou; some ao dar **Clear** ou rodar de novo |
| F5 capturado | Nesta janela, Run and Debug → **Debug demo: stack traces** → F5 | Aparece um chip 🐞 com o nome da config e as linhas do programa, sem rodar comando |
| Scripts do projeto | `Ctrl+Shift+P` → **Run and Capture Command** | Lista "Scripts" com `nest`, `pino`, `live`… (rodam com `npm run`) |
| Reiniciar | Com `npm run live` rodando, `Ctrl+Alt+R` (de qualquer lugar) | Para e roda de novo; o chip mantém o filtro |
| Chips de captura | Rode 2 cenários | Clique num chip → só aquela captura; ⟳ / ■ funcionam; `exit 1` em vermelho no `crash` |
| Autocomplete | Na busca digite `lev` → `Tab` → `e` → `Tab` | Vira `level:error `; a lista **não** esvazia enquanto você digita |
| Live / Pausado | `npm run live`, aperte **Espaço** | Pílula vira "Paused" e aparece "N new ↓"; clicar volta ao vivo |
| Tempo | Aperte `t` (ou clique em "Time") | Relógio → "Δ Prev" (pausas > 1 s em amarelo) → "Since start" |
| Favoritos / erros | `b` numa linha, depois busque `is:bookmarked`; `e` / `Shift+E` | Só os favoritos; seleção pula de erro em erro |
| Detalhe | Abra uma linha → abas **Context** e **JSON** | Context mostra as linhas vizinhas da mesma captura; com `req.id`, "Show only this request" |
| Status bar | Feche/esconda o dashboard e rode `npm run crash` | `$(error) N` na status bar; zera ao abrir o dashboard |
| Restaurar | Com o dashboard aberto, `Ctrl+R` (Reload Window) | O painel volta sozinho, com filtros e seleção |
| Atalhos | `?` | Folha com todos os atalhos |

### Agentes de IA (MCP)

`Ctrl+Shift+P` → **Local Logs Console: Copy MCP Setup for Coding Agents…** e cole no seu agente.
Teste rápido via terminal: `bash ../scripts/mcp-smoke.sh <porta> <token>`.

### Performance (sem abrir o VS Code)

`npm run bench` (na raiz do projeto) mede a ingestão no host — meta: > 5 000 linhas/s.

## Dica

Se algo der errado, olhe **Output → Local Logs Console** e o **Debug Console** da janela original.
Mudou código? Ele recompila sozinho (watch) — na janela de teste use `Ctrl+R` para recarregar.
