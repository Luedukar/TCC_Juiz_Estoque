# Sistema de Controle de Estoque

Aplicação para acompanhar produtos e saldos por meio de um ledger de movimentações. O projeto está dividido em uma API Node.js/TypeScript com PostgreSQL e uma interface React/TypeScript.

## Requisitos

- Node.js 20 ou superior e npm.
- PostgreSQL 14 ou superior.
- `psql` disponível no terminal para aplicar o schema e preparar o banco de teste.

## Configuração local

### 1. Banco de dados

Crie o banco de desenvolvimento e aplique o schema a partir da pasta raiz:

```powershell
createdb estoque
psql -d estoque -f schema.sql
```

Se seu usuário, senha, host ou porta do PostgreSQL forem diferentes dos valores de exemplo, ajuste a URL de conexão na configuração da API.

### 2. API

Na pasta raiz do projeto, instale as dependências e prepare o ambiente:

```powershell
npm install
Copy-Item .env.example .env
```

Edite `.env` e configure `DATABASE_URL`, `JWT_SECRET` (mínimo de 32 caracteres) e `CLIENT_ORIGIN`. A origem padrão do frontend é `http://localhost:5173`.

Cadastre o primeiro gerente. Gere um hash bcrypt para uma senha forte (substitua o texto de exemplo antes de executar):

```powershell
node -e "require('bcryptjs').hash('TROQUE_POR_UMA_SENHA_FORTE', 12).then(console.log)"
```

Use o hash retornado no lugar de `<HASH_BCRYPT>`:

```sql
INSERT INTO app_users (name, email, password_hash, role)
VALUES ('Gerente', 'gerente@empresa.com', '<HASH_BCRYPT>', 'MANAGER');
```

Execute o SQL no banco `estoque` com `psql`, depois inicie a API:

```powershell
npm run dev
```

A API fica disponível em `http://localhost:3000`.

### 3. Interface web

Em outro terminal:

```powershell
Set-Location frontend
npm install
Copy-Item .env.example .env.local
npm run dev
```

O frontend fica disponível em `http://localhost:5173`. `VITE_API_URL` em `frontend/.env.local` aponta para a API; reinicie o servidor Vite após alterar essa configuração.

## Testes automatizados

Os testes da API usam Jest e Supertest. Execute-os a partir da pasta raiz:

```powershell
npm test                 # unitários e integração (se o banco estiver configurado)
npm run test:unit        # somente unitários
npm run test:integration # somente integração HTTP/PostgreSQL
npm test -- --coverage   # relatório de cobertura Jest
```

### Banco de integração

Os testes de integração gravam usuários, produtos e movimentações. Configure um banco PostgreSQL **separado** do banco de desenvolvimento; não aponte `DATABASE_URL_TEST` para o banco normal. Crie e inicialize, por exemplo, `estoque_test`:

```powershell
createdb estoque_test
psql -d estoque_test -f schema.sql
```

Defina `DATABASE_URL_TEST` em `.env` (há um exemplo em `.env.example`) e execute `npm run test:integration`. Os fixtures usam identificadores aleatórios; os registros ficam no banco de teste porque o ledger é append-only. Sem `DATABASE_URL_TEST`, o Jest pula os testes de integração.

## Cobertura medida

Última medição local em 08/10/2026, com `npm test -- --coverage`:

| Área coberta | Testes | Resultado | Cobertura medida |
| --- | ---: | --- | ---: |
| Cálculo do saldo em `src/services/stock.ts` | 3 unitários | Passaram | 100% statements, branches, functions e lines |
| Entrada, saída, consulta do saldo e rejeição de saldo insuficiente pela API | 2 de integração | Não executados: `DATABASE_URL_TEST` não estava configurada | Não medida |

O relatório de cobertura atual inclui `src/services/**/*.ts`; portanto, os 100% referem-se ao serviço de cálculo do ledger e não à aplicação inteira. A última execução geral teve 3 testes aprovados e 2 testes de integração ignorados por falta do banco de teste.

## Endpoints disponíveis

- `POST /api/auth/login` — autenticação por e-mail e senha; retorna JWT.
- `POST /api/movements` — registra entrada ou saída. Ajustes são restritos ao gerente.
- `POST /api/movements/:id/reversal` — registra estorno; restrito ao gerente.
- `GET /api/movements` — consulta o extrato paginado. Custos aparecem apenas para gerente.
- `GET /api/movements/balances` — consulta saldo calculado e alerta de estoque de segurança.

As movimentações e suas linhas são append-only no banco. Uma correção deve criar um estorno vinculado ao evento original.

## Segurança e configuração

- JWT assinado por `JWT_SECRET`; defina um segredo aleatório e forte fora do ambiente local.
- `helmet`, CORS configurável, limite de tamanho do corpo, rate limiting global e limite adicional para login.
- O saldo não é atualizado por escrita direta: é calculado a partir do ledger.
- Não versione arquivos `.env`; `.gitignore` já os exclui.
