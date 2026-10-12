# Controle de Estoque

Sistema web de controle de estoque para pequeno e médio varejo: catálogo de produtos, movimentações
(entrada/saída/estorno) com saldo em tempo real, alertas de estoque mínimo, Kardex e trilha de auditoria imutável.

- **Backend:** Node.js + NestJS 11 + PostgreSQL (driver `pg`, sem ORM)
- **Frontend:** React 19 + TypeScript + Vite + Tailwind 4 (TanStack Query, react-router)
- **Testes:** Jest + Supertest (backend, banco real) e Vitest + Testing Library (frontend)

> **Estado do projeto (leia antes de usar).** O que existe e foi testado está descrito neste documento, com números
> medidos. Duas limitações importantes: **(1)** não há telas nem rotas de API para cadastrar/editar produtos e
> fornecedores — o catálogo é carregado por SQL (veja `docs/seed-demo.sql`); as tabelas, regras e views já existem no banco;
> **(2)** a interface não foi verificada visualmente em um navegador real (só por testes automatizados em jsdom).
> A lista completa está em [Limitações](#12-limitações-conhecidas-e-próximos-passos).

---

## Sumário

1. [Arquitetura e estrutura de pastas](#1-arquitetura-e-estrutura-de-pastas)
2. [Pré-requisitos](#2-pré-requisitos)
3. [Instalação e execução local](#3-instalação-e-execução-local)
4. [Variáveis de ambiente](#4-variáveis-de-ambiente)
5. [Perfis e permissões (RBAC)](#5-perfis-e-permissões-rbac)
6. [API: rotas, formato de erro e códigos](#6-api-rotas-formato-de-erro-e-códigos)
7. [Regras garantidas pelo banco de dados](#7-regras-garantidas-pelo-banco-de-dados)
8. [Resiliência do frontend](#8-resiliência-do-frontend)
9. [Atalhos de teclado e leitor de código de barras](#9-atalhos-de-teclado-e-leitor-de-código-de-barras)
10. [Testes automatizados](#10-testes-automatizados)
11. [Segurança e checklist de produção](#11-segurança-e-checklist-de-produção)
12. [Limitações conhecidas e próximos passos](#12-limitações-conhecidas-e-próximos-passos)
13. [Solução de problemas](#13-solução-de-problemas)

---

## 1. Arquitetura e estrutura de pastas

```
Navegador (React SPA) ──HTTP/JSON──▶ API NestJS ──SQL──▶ PostgreSQL
 outbox + cache offline               JWT · RBAC · rate limit    triggers (saldo, imutabilidade, auditoria)
```

A regra de negócio mais sensível (saldo nunca negativo, movimentação nunca alterada/apagada, estorno válido) fica
**no banco**, em triggers. A API traduz os erros do banco para respostas padronizadas, então mesmo um acesso direto ao
banco não consegue burlar essas regras.

```
estoque-controle/
├── README.md
├── docs/
│   ├── schema.sql          DDL completo: tipos, tabelas, triggers, views (fonte única do schema)
│   ├── diagrama-er.mmd     Diagrama ER em Mermaid
│   └── seed-demo.sql       Dados de demonstração (6 produtos, 12 movimentações)
├── backend/
│   ├── src/                auth/ stock/ common/ config/ database/ health/ scripts/
│   ├── test/               unit/ db/ integration/ helpers/
│   ├── COVERAGE-REPORT.txt Relatório de cobertura gerado pelo Jest
│   └── .env.example
└── frontend/
    ├── src/                pages/ components/ lib/
    └── .env.example
```

Diagrama ER: abra `docs/diagrama-er.mmd` em qualquer visualizador Mermaid (ex.: <https://mermaid.live>).

## 2. Pré-requisitos

| Ferramenta | Versão |
|---|---|
| Node.js | 20 ou superior (testado com a versão LTS atual) |
| npm | 10 ou superior |
| PostgreSQL | 16 (o schema usa recursos do 14+) |
| Extensões do PostgreSQL | `citext`, `pg_trgm`, `pgcrypto`/`gen_random_uuid` (já incluídas no pacote `contrib`; o `schema.sql` as ativa) |

Para rodar a suíte de testes, o usuário do banco precisa poder **criar bancos de dados** (cada arquivo de teste usa um
banco descartável).

## 3. Instalação e execução local

Todos os comandos abaixo foram executados a partir de uma cópia limpa do projeto durante a validação desta entrega.

### 3.1 Banco de dados

```bash
# como superusuário (ex.: postgres)
psql -c "CREATE ROLE estoque LOGIN PASSWORD 'estoque' CREATEDB;"
psql -c "CREATE DATABASE estoque OWNER estoque;"

# aplica o schema (tabelas, triggers e views)
psql postgres://estoque:estoque@localhost:5432/estoque -v ON_ERROR_STOP=1 -f docs/schema.sql
```

> Se o `schema.sql` falhar ao criar extensões, rode-o com um superusuário ou crie as extensões antes
> (`CREATE EXTENSION citext; CREATE EXTENSION pg_trgm;`).

### 3.2 Backend

```bash
cd backend
cp .env.example .env          # edite DATABASE_URL e, principalmente, JWT_SECRET (32+ caracteres)
npm ci
npm run build

# primeiro usuário (Gerente). A senha vem de variável de ambiente para não ficar no histórico do shell
NEW_USER_PASSWORD='uma-senha-forte' npm run user:create -- gerente@exemplo.com "Nome do Gerente" GERENTE
NEW_USER_PASSWORD='uma-senha-forte' npm run user:create -- estoquista@exemplo.com "Nome do Estoquista" ESTOQUISTA

npm start                     # API em http://localhost:3000/api
```

Verificação rápida: `curl http://localhost:3000/api/health` → `{"status":"ok","time":"..."}`.

### 3.3 Dados de demonstração (opcional)

Precisa existir ao menos um usuário `GERENTE` (as movimentações iniciais ficam atribuídas a ele, para a auditoria).
O script pode ser executado mais de uma vez sem duplicar nada.

```bash
psql postgres://estoque:estoque@localhost:5432/estoque -v ON_ERROR_STOP=1 -f docs/seed-demo.sql
```

Cria 6 produtos com código de barras EAN-13 válido e situações variadas:

| SKU | Saldo | Mínimo | Situação |
|---|---:|---:|---|
| CAFE-500 | 70 | 20 | OK |
| ARROZ-5 | 8 | 15 | Abaixo do mínimo |
| FEIJAO-1 | 20 | 30 | Abaixo do mínimo |
| ACUCAR-1 | 0 | 25 | Zerado |
| OLEO-900 | 25 | 20 | OK |
| LEITE-1 | 50 | 40 | OK |

### 3.4 Frontend

```bash
cd frontend
npm ci
npm run dev                   # http://localhost:5173 (o Vite encaminha /api para http://localhost:3000)
```

Para build de produção: `npm run build` (gera `frontend/dist`). Se a API estiver em outro endereço, veja
`VITE_API_URL` e `API_PROXY` em [Variáveis de ambiente](#4-variáveis-de-ambiente).

Entre com o e-mail e a senha do usuário criado no passo 3.2.

## 4. Variáveis de ambiente

### Backend (`backend/.env`)

| Variável | Padrão | Descrição |
|---|---|---|
| `DATABASE_URL` | — (obrigatória) | String de conexão PostgreSQL |
| `JWT_SECRET` | — (obrigatória) | Segredo de assinatura; **mínimo 32 caracteres**, senão a API não sobe |
| `JWT_ACCESS_TTL_SECONDS` | `900` | Validade do token de acesso (15 min) |
| `REFRESH_TTL_DAYS` | `7` | Validade do refresh token |
| `BCRYPT_ROUNDS` | `12` | Custo do hash de senha |
| `PORT` | `3000` | Porta HTTP |
| `CORS_ORIGINS` | `http://localhost:5173` | Origens permitidas, separadas por vírgula |
| `TRUST_PROXY` | `false` | Atrás de proxy/balanceador, informe o nº de proxies (ex.: `1`) para o rate limit enxergar o IP real |
| `RATE_LIMIT_DEFAULT` | `120` | Requisições por minuto por IP (geral) |
| `RATE_LIMIT_AUTH` | `10` | Requisições por minuto por IP nas rotas de login/refresh/logout |
| `LOG_REQUESTS` | `true` (`false` em testes) | Uma linha JSON por requisição (sem query string nem dados sensíveis) |
| `DATABASE_SSL` | `false` | Ativa SSL na conexão com o banco |
| `PG_POOL_MAX` | `10` | Tamanho do pool de conexões |

Valores numéricos inválidos (`abc`, `-1`, `1.5`) e segredo curto fazem a API **falhar na subida** com mensagem clara.

### Frontend (`frontend/.env`)

| Variável | Padrão | Descrição |
|---|---|---|
| `VITE_API_URL` | `/api` | URL base da API em produção (inclua a origem do frontend em `CORS_ORIGINS`) |
| `API_PROXY` | `http://localhost:3000` | Destino do proxy do servidor de desenvolvimento |

## 5. Perfis e permissões (RBAC)

| Capacidade | Gerente | Estoquista |
|---|:---:|:---:|
| Entrar, renovar sessão, ver o próprio perfil | ✔ | ✔ |
| Consultar saldos, alertas, Kardex e movimentações | ✔ | ✔ |
| Registrar entradas e saídas | ✔ | ✔ |
| Ver **custos** (custo unitário das entradas) | ✔ | ✘ (campo omitido na resposta) |
| Informar custo ao registrar uma entrada | ✔ | ✘ (403 `FORBIDDEN_FIELD`) |
| **Estornar** uma movimentação | ✔ | ✘ (403 `FORBIDDEN`) |

A ordem dos guards globais é: limite de requisições → autenticação JWT → perfil. Rotas sem `@Public()` exigem token.

## 6. API: rotas, formato de erro e códigos

Base: `/api`. Autenticação por `Authorization: Bearer <accessToken>`.

| Método e rota | Perfil | Descrição |
|---|---|---|
| `GET /health` | público | Estado da API e do banco (sem limite de requisições) |
| `POST /auth/login` | público | `{email, password}` → `accessToken`, `refreshToken` |
| `POST /auth/refresh` | público | Troca o refresh token (rotação; reuso tardio revoga a família inteira) |
| `POST /auth/logout` | público | Revoga o refresh token |
| `GET /auth/me` | autenticado | Dados do usuário logado |
| `POST /stock/movements` | Gerente, Estoquista | Registra ENTRADA/SAÍDA |
| `POST /stock/movements/:id/reversal` | **Gerente** | Estorna uma movimentação (cria a inversa) |
| `GET /stock/movements` | autenticado | Lista movimentações (filtros: produto, tipo, período) |
| `GET /stock/kardex` | autenticado | Kardex de um produto, com saldo após cada movimentação |
| `GET /stock/balances` | autenticado | Saldos e situação (`q` busca por nome/SKU/código de barras; `status`) |
| `GET /stock/alerts` | autenticado | Produtos zerados ou abaixo do mínimo, com a falta (`shortfall`) |

**Registrar movimentação** — corpo de `POST /stock/movements`:

```json
{ "type": "SAIDA", "barcode": "7891000100103", "quantity": 2, "reason": "VENDA" }
```

- Identifique o produto por **exatamente um** entre `productId`, `barcode` ou `sku`.
- Motivos de entrada: `COMPRA`, `DEVOLUCAO_CLIENTE`, `AJUSTE_INVENTARIO`, `OUTRO`.
  Motivos de saída: `VENDA`, `DEVOLUCAO_FORNECEDOR`, `PERDA_AVARIA`, `AJUSTE_INVENTARIO`, `OUTRO`.
- Quantidade: > 0, até 3 casas decimais. `unitCost` (só Gerente, só entradas): até 2 casas.
- **`Idempotency-Key`** (cabeçalho, UUID): reenviar a mesma chave devolve a movimentação original com o cabeçalho
  `Idempotent-Replayed: true`, em vez de lançar duas vezes. Usada pelo frontend ao reenviar a fila offline.
  Se outra pessoa já usou a chave: 409 `IDEMPOTENCY_KEY_CONFLICT`.

**Formato padronizado de erro** (todas as falhas, inclusive as inesperadas):

```json
{ "error": { "code": "INSUFFICIENT_STOCK", "message": "estoque insuficiente (saldo 1, solicitado 2)",
             "details": null, "requestId": "…", "timestamp": "…" } }
```

O `requestId` também vem no cabeçalho `X-Request-Id` (o cliente pode enviar o seu, se tiver formato seguro).
Erros internos nunca expõem detalhes técnicos.

| HTTP | Códigos |
|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_JSON`, `INVALID_FIELD`, `INVALID_REASON`, `PRODUCT_IDENTIFIER_REQUIRED`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_VALUE` |
| 401 | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `INVALID_REFRESH_TOKEN`, `REFRESH_TOKEN_REUSED` |
| 403 | `FORBIDDEN`, `FORBIDDEN_FIELD` |
| 404 | `PRODUCT_NOT_FOUND`, `MOVEMENT_NOT_FOUND` |
| 409 | `DUPLICATE` (ex.: estornar duas vezes), `IMMUTABLE_RECORD`, `IDEMPOTENCY_KEY_CONFLICT` |
| 422 | `INSUFFICIENT_STOCK`, `INVALID_REVERSAL`, `PRODUCT_UNAVAILABLE`, `CONSTRAINT_VIOLATION`, `REFERENCE_NOT_FOUND` |
| 429 | `RATE_LIMITED` (com `Retry-After`) |
| 503 | `DB_UNAVAILABLE`, `DB_TIMEOUT`, `RETRYABLE_CONFLICT` (com `Retry-After` quando o banco está fora) |
| 500 | `INTERNAL_ERROR` |

## 7. Regras garantidas pelo banco de dados

| Regra | Como é garantida | Erro |
|---|---|---|
| Saldo nunca negativo; cálculo sem corrida | Trigger trava a linha do produto (`FOR UPDATE`) e recalcula o saldo | `ST001` → 422 |
| Movimentação **nunca** é alterada ou apagada | Triggers bloqueiam UPDATE, DELETE e TRUNCATE em `stock_movements` e `audit_log` | `ST003` → 409 |
| Correção só por estorno | Estorno = nova movimentação inversa, mesmo produto e quantidade; um estorno não pode ser estornado; um item só pode ser estornado uma vez | `ST002` → 422 / `23505` → 409 |
| Saldo só muda via movimentação | Trigger recusa UPDATE direto em `products.current_stock` | `ST005` |
| Produto inativo não movimenta | Trigger | `ST004` → 422 |
| Quantidade > 0 | Trigger e CHECK | `23514` → 422 |
| Auditoria: data/hora, tipo e usuário em toda movimentação | `audit_log` preenchido por trigger; usuário vem de `app.current_user_id`, definido por transação | — |
| Kardex em ordem real de gravação | `created_at` recebe `clock_timestamp()` já com o lock da linha | — |
| Reenvio não duplica | `idempotency_key` única | replay |

## 8. Resiliência do frontend

- **Cliente HTTP:** timeout de 10 s; até 2 novas tentativas com espera crescente para GET e POST idempotente;
  renovação de token em *single-flight* (várias requisições com token vencido disparam uma única renovação).
- **Servidor indisponível:** erro 5xx sem o envelope padrão (ex.: proxy fora do ar) é tratado como "indisponível", com
  tela própria e botão de nova tentativa — não uma tela quebrada.
- **Monitor de conexão:** após 2 falhas seguidas o app se declara offline e passa a checar `/health` com intervalo
  crescente (4 s → 15 s); ao voltar, avisa e retoma.
- **Lançamentos sem conexão (outbox):** entradas e saídas ficam numa fila em `localStorage`, cada uma com sua
  `Idempotency-Key`, e são reenviadas automaticamente quando a conexão volta, sem duplicar.
  A busca de produto usa um **cache local** dos produtos já consultados.
- **Mensagens:** todo erro vira texto em português dizendo o que houve e o que fazer.
- **Estoque insuficiente** e demais erros de negócio **não** entram na fila (seriam recusados de novo).

## 9. Atalhos de teclado e leitor de código de barras

Um leitor USB funciona como teclado: basta focar o campo de código e ler; o `Enter` enviado pelo leitor localiza o produto.

| Atalho | Ação |
|---|---|
| `Alt+1` … `Alt+4` | Navegar entre as telas |
| `Alt+E` / `Alt+S` | Lançamento de Entrada / Saída |
| `Ctrl+Enter` | Confirmar o lançamento |
| `Esc` | Voltar ao campo do leitor |
| `/` | Focar a busca |

## 10. Testes automatizados

### 10.1 Como executar

```bash
# Backend (precisa do PostgreSQL; o usuário do banco precisa poder criar bancos)
cd backend
export TEST_DATABASE_URL=postgres://estoque:estoque@localhost:5432/postgres   # padrão se omitido
npm test                # suíte completa (324 testes)
npm run test:unit       # só os testes unitários, sem banco
npm run test:cov        # com relatório de cobertura (texto, html e lcov em backend/coverage/)
npm run typecheck       # checagem de tipos, incluindo os arquivos de teste

# Frontend (não precisa de banco nem de API)
cd frontend
npm test                # 78 testes
npm run test:cov        # com cobertura
npx tsc -b              # checagem de tipos
```

**Como o backend é testado:** o `global-setup` cria uma vez um banco-modelo com o `docs/schema.sql` aplicado; cada arquivo
de teste recebe uma **cópia própria desse banco**, então os testes são isolados e podem rodar em paralelo. A aplicação
NestJS sobe de verdade (mesma configuração do `main.ts`) e é chamada com Supertest — não há mocks do banco nos testes de
banco e de integração. Um proxy TCP de teste permite **derrubar a conexão com o banco** para simular indisponibilidade.

### 10.2 Backend — 324 testes, 10 suítes, todos passando

| Camada | Arquivo | Testes | O que verifica |
|---|---|---:|---|
| Unitário | `unit/pg-errors.spec.ts` | 30 | Tradução de cada erro do PostgreSQL (ST001–ST005, 23xxx, 22xxx, 40xxx, 57xxx, classes 08/53, falhas de rede) para status e código padronizados |
| Unitário | `unit/exceptions-filter.spec.ts` | 15 | Envelope de erro; JSON malformado → `INVALID_JSON`; 429 com `Retry-After`; erro desconhecido nunca vaza detalhe; 503 com `Retry-After` |
| Unitário | `unit/guards.spec.ts` | 18 | Guard JWT (ausente, malformado, expirado, assinatura errada, algoritmo diferente) e guard de perfis |
| Unitário | `unit/dto-and-mapper.spec.ts` | 31 | Validação de entrada (limites, tipos, casas decimais, UUID, datas) e ocultação de custos para o Estoquista |
| Unitário | `unit/stock-service.spec.ts` | 27 | Regras do serviço: identificação do produto, motivos válidos por tipo, custo só para Gerente, replay idempotente, conflito de chave |
| Unitário | `unit/infra.spec.ts` | 23 | Configuração (falha rápida), `requestId` e log por requisição, transação (BEGIN/COMMIT/ROLLBACK, descarte de conexão morta), erro de conexão ociosa não derruba o processo |
| Banco | `db/balance.spec.ts` | 37 | Saldo, estoque insuficiente, produto inativo, quantidade inválida, bloqueio de alteração direta do saldo, views de saldo, alerta e Kardex |
| Banco | `db/ledger.spec.ts` | 31 | Imutabilidade (UPDATE/DELETE/TRUNCATE recusados), regras de estorno, auditoria preenchida, **concorrência** (50 saídas simultâneas nunca deixam saldo negativo) e ordem do Kardex sob concorrência |
| Integração | `integration/stock-api.spec.ts` | 71 | API ponta a ponta: lançamentos, estorno, idempotência, filtros e paginação do Kardex/saldos/alertas, busca, erros padronizados, queda do banco → 503 e recuperação |
| Integração | `integration/auth-security.spec.ts` | 41 | Login, refresh com rotação e reuso, logout, tokens adulterados/expirados, RBAC por rota, rate limit (geral e de login), cabeçalhos de segurança (helmet), CORS |

**Cobertura do backend** (`jest --coverage`, provedor v8, código de `src/` exceto `main.ts` e `scripts/`):

| Instruções | Ramos | Funções | Linhas |
|---:|---:|---:|---:|
| **100%** | **95,87%** | **100%** | **100%** |

Todos os arquivos têm 100% de linhas. Os ramos não cobertos (4,13%) são defesas que não dá para acionar de forma
realista (ex.: valores padrão de variáveis opcionais). Relatório por arquivo: `backend/COVERAGE-REPORT.txt`.

> Cobertura mede o que foi executado, não se as verificações são boas. Por isso foi feita também **checagem por
> mutação manual**: o código real foi quebrado de propósito (ex.: remover o lock do saldo, desligar a imutabilidade,
> aceitar token sem verificar assinatura) e os testes falharam como esperado.

### 10.3 Frontend — 78 testes, 7 arquivos, todos passando

| Arquivo | Testes | O que verifica |
|---|---:|---|
| `lib/__tests__/http.test.ts` | 13 | Timeout, novas tentativas, só repete requisição segura/idempotente, renovação de token única, 401 → sessão expirada, 5xx sem envelope = indisponível, `Retry-After` |
| `lib/__tests__/connection.test.ts` | 5 | Monitor: 2 falhas → offline, sondagem do `/health` com espera crescente, retorno |
| `lib/__tests__/outbox.test.ts` | 7 | Fila offline: enfileirar, reenviar na ordem, `Idempotency-Key` por item, descarte de erro de negócio, persistência |
| `lib/__tests__/ean.test.ts` | 6 | Dígito verificador EAN-13/EAN-8 e geração do código de barras |
| `lib/__tests__/errors-cache.test.ts` | 20 | Mensagens de erro em português (rede, limite, credenciais, permissão, sessão) e cache local de produtos (busca exata × parcial, limite, armazenamento corrompido/indisponível) |
| `pages/__tests__/pages.test.tsx` | 9 | Tela de lançamento: leitor/Enter, entrada e saída, quantidade inválida, envio sem conexão vai para a fila |
| `pages/__tests__/screens.test.tsx` | 18 | Banner de conexão, tela de servidor indisponível, login (erros e acesso), Kardex por perfil (botão de estorno só para Gerente), Saldos (situação em palavras, filtros) |

**Cobertura do frontend** (`vitest --coverage`, provedor v8, todo `src/` exceto testes e `main.tsx`):

| Instruções | Ramos | Funções | Linhas |
|---:|---:|---:|---:|
| **73,58%** | **73,99%** | **63,70%** | **75,75%** |

| Área | Instruções | Observação |
|---|---:|---|
| `lib/` (HTTP, conexão, fila, cache, erros) | 75,35% | Núcleo de resiliência: `http` 91%, `connection` 87%, `outbox` 85%, `productCache` 90% |
| `pages/` | 83,25% | Movimento 81%, Kardex 88%, Saldos 81%, Login 91%, Dashboard 73% |
| `components/` | 63,33% | `ProductFinder` 52% (busca por teclado/leitor só parcialmente testada) |

**Sem nenhum teste automatizado (0%):** `App.tsx` (rotas), `Layout.tsx` (menu e atalhos globais), `AuthContext.tsx`,
`api.ts` (funções de chamada à API), `useOutboxSync.ts` (envio automático da fila ao voltar a conexão).
As peças que esses arquivos usam (cliente HTTP, fila, monitor) são testadas isoladamente, mas a **integração entre elas
no navegador não é**.

### 10.4 Defeitos reais que os testes encontraram (e foram corrigidos)

1. **Ordem do Kardex sob concorrência** — com `now()` (início da transação), duas movimentações simultâneas podiam
   aparecer fora da ordem real de aplicação. Corrigido com `clock_timestamp()` dentro do trigger, já com o lock do produto.
2. **Quantidade negativa** retornava "estoque insuficiente" (`ST001`) em vez de erro de validação — o trigger agora
   recusa quantidade ≤ 0 (`23514`) antes de calcular saldo.
3. **Reenvio de estorno** devolvia 409 em vez do resultado original: o reenvio viola duas unicidades ao mesmo tempo
   (chave de idempotência e `reversal_of_id`) e o PostgreSQL reporta só uma. O serviço passou a tratar as duas.
4. **Queda do banco** gerava 500 e um erro de pool sem tratamento que podia derrubar o processo; agora responde 503
   com `Retry-After` e o erro de conexão ociosa é registrado sem encerrar a API.
5. **Mensagens de erro de login/JSON malformado/429** fora do padrão do envelope — padronizadas.

### 10.5 Verificações manuais e de fumaça (não fazem parte de `npm test`)

- Roteiro de fumaça de 51 checagens contra a API real (login, RBAC, lançamentos, estorno, idempotência, limite de
  requisições, erros) — todas passaram.
- Validação da instalação a partir de cópia limpa: `npm ci`, build, checagem de tipos, suítes de testes, schema, criação
  de usuários, seed (executado duas vezes, sem duplicar), subida da API, login dos dois perfis, `/stock/alerts`,
  `/stock/balances` e recusa do estorno pelo Estoquista (403).

### 10.6 O que os testes **não** cobrem

- **Aparência e uso em navegador real:** nenhum teste visual, de responsividade, de leitor de código de barras físico ou de
  acessibilidade automatizada (o ambiente de desenvolvimento não conseguiu instalar um navegador de teste).
- **Carga e desempenho:** não houve teste de carga nem de volume grande de movimentações.
- **Rate limit em vários servidores:** o limite é em memória, por processo (veja o checklist abaixo).
- **Rotas de produtos e fornecedores:** não existem, portanto não são testadas (as regras de banco dessas tabelas
  existem no schema, mas só as de movimentação têm testes dedicados).
- **Telas sem teste:** as listadas ao fim de 10.3.

## 11. Segurança e checklist de produção

Implementado: JWT HS256 de 15 min; refresh token de 7 dias guardado só como hash SHA-256, com rotação, tolerância de 10 s
para reenvio e revogação em massa se um token já usado reaparecer fora dessa janela; senhas com bcrypt; `helmet`; CORS por
lista; validação rigorosa de entrada (`class-validator`, campos desconhecidos recusados); consultas sempre parametrizadas;
limite de requisições (120/min geral, 10/min nas rotas de autenticação, por IP); erros sem vazamento de detalhes;
`requestId` em todas as respostas e nos logs; auditoria imutável.

Antes de colocar em produção:

- [ ] Definir `JWT_SECRET` aleatório e único (32+ caracteres) e **nunca** versionar o `.env`.
- [ ] Servir tudo por **HTTPS** (proxy reverso) e ajustar `TRUST_PROXY` conforme o número de proxies.
- [ ] Ajustar `CORS_ORIGINS` para o endereço real do frontend.
- [ ] Usar um usuário do banco **sem** privilégio de superusuário/criação de bancos (o de testes é diferente do da aplicação).
- [ ] Rate limit está **em memória**: com mais de uma instância da API, cada uma conta separado. Use um repositório
      compartilhado (ex.: Redis) ou aplique o limite também no proxy.
- [ ] Os tokens ficam no armazenamento do navegador; revise esse risco (XSS) para o seu cenário ou migre para cookies `HttpOnly`.
- [ ] Backups do PostgreSQL e política de retenção — a auditoria é imutável, então a tabela só cresce.
- [ ] Rodar `npm audit` periodicamente (a instalação limpa acusou avisos de dependências de desenvolvimento no backend).
- [ ] Monitorar `/api/health` e centralizar os logs JSON.

## 12. Limitações conhecidas e próximos passos

- **Sem cadastro de produtos e fornecedores** (telas e rotas). O catálogo entra por SQL; é o próximo passo natural, e a
  proteção de custo (somente Gerente) já está pronta no mapeamento das respostas.
- **Sem gestão de usuários** pela interface (use `npm run user:create`).
- **Sem relatório de reposição por fornecedor** na interface (os alertas já informam a falta por produto).
- **Interface não verificada visualmente** em navegador real; cobertura de testes do frontend de 73,6% (ver 10.3).
- **Sem teste de carga.**
- **Fila offline** vive no `localStorage` do navegador: limpar os dados do site apaga lançamentos ainda não enviados.
- Rate limit em memória (ver checklist).

## 13. Solução de problemas

| Sintoma | Causa provável e solução |
|---|---|
| API não sobe: `JWT_SECRET ... 32 caracteres` | Segredo curto ou ausente no `.env` |
| API não sobe: `DATABASE_URL` | Variável ausente; confira o `.env` (o `npm start` lê o arquivo `.env` da pasta `backend/`) |
| `npm run user:create` diz que o arquivo não existe | Rode `npm run build` antes |
| `permission denied to create extension` | Aplique o `schema.sql` com superusuário |
| Testes: `permission denied to create database` | O usuário de `TEST_DATABASE_URL` precisa do privilégio `CREATEDB` |
| Frontend mostra "servidor indisponível" | API fora do ar ou `API_PROXY`/`VITE_API_URL` apontando para o lugar errado |
| Erro de CORS no navegador | Inclua a origem do frontend em `CORS_ORIGINS` |
| `429 RATE_LIMITED` ao testar login repetidamente | Limite de 10/min por IP nas rotas de autenticação; aguarde o `Retry-After` |
| Seed: "Crie antes um usuário GERENTE" | Rode o passo 3.2 antes do 3.3 |
