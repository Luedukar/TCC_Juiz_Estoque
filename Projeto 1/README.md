# Sistema de Controle de Estoque

API e aplicação web para controle de estoque de uma loja, com PostgreSQL,
Node.js/TypeScript e React. Este repositório contém o schema inicial do banco,
uma API Express e um dashboard web.

## Requisitos

- Node.js 22.12+ (o frontend usa Vite 8)
- npm
- PostgreSQL 13+
- `pgcrypto` disponível para a role que aplica o schema

PostgreSQL e `psql` não são instalados pelo npm. O banco local de integração é
opcional para executar a suíte unitária.

## Instalação e configuração

### 1. Backend e banco de dados

Na raiz do projeto, instale as dependências:

```powershell
npm install
```

Crie um banco e aplique o schema. No PowerShell, por exemplo:

```powershell
createdb inventory
psql -d inventory -f schema.sql
```

O schema instala `pgcrypto`, cria usuários, fornecedores, categorias, produtos,
saldos e o livro de movimentações. A role que executa o script precisa poder
criar a extensão, ou `pgcrypto` deve ser instalado previamente por um
administrador do PostgreSQL.

Crie a configuração local a partir do exemplo:

```powershell
Copy-Item .env.example .env
```

Edite `.env`:

```dotenv
DATABASE_URL=postgresql://inventory_user:change-me@localhost:5432/inventory
JWT_SECRET=use-a-random-secret-with-at-least-32-characters
PORT=3000
NODE_ENV=development
```

Use uma senha JWT aleatória de pelo menos 32 caracteres e não a versione.

### 2. Criar o primeiro usuário

O projeto ainda não tem uma rota de cadastro de usuários. Crie inicialmente um
gerente de forma administrativa. Gere um hash bcrypt:

```powershell
node -e "require('bcryptjs').hash('troque-esta-senha', 12).then(console.log)"
```

Insira o usuário no banco, substituindo o hash gerado:

```sql
INSERT INTO users (name, email, password_hash, role)
VALUES ('Gerente', 'gerente@sualoja.com.br', '<HASH_BCRYPT_GERADO>', 'manager');
```

Não armazene a senha em texto puro. Em produção, faça a criação inicial com um
procedimento administrativo seguro.

### 3. Frontend

Em outro terminal:

```powershell
Set-Location frontend
npm install
Copy-Item .env.example .env
npm run dev
```

O Vite inicia a aplicação em `http://localhost:5173` e encaminha `/api` para
`http://localhost:3000`. Inicie o backend em outro terminal, a partir da raiz:

```powershell
npm run dev
```

Para compilar o frontend:

```powershell
Set-Location frontend
npm run build
```

Em produção, publique o frontend atrás de um reverse proxy HTTPS que encaminhe
`/api` ao backend na mesma origem. O proxy e a terminação TLS devem ser
configurados para o ambiente de implantação; o servidor Express não configura
CORS nem TLS nesta etapa.

## API implementada

Todos os endpoints abaixo, exceto login, exigem
`Authorization: Bearer <accessToken>`. O token expira em oito horas.

| Método | Rota | Descrição |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Autentica e retorna token e dados básicos do usuário. |
| `GET` | `/api/auth/me` | Consulta o usuário ativo associado ao token. |
| `POST` | `/api/movements?type=in` | Registra uma entrada de estoque. |
| `POST` | `/api/movements?type=out` | Registra uma saída de estoque. |
| `POST` | `/api/movements/:id/reversal` | Registra o estorno de uma movimentação. |
| `GET` | `/api/products/:id/balance` | Consulta saldo atual de um produto. |
| `GET` | `/api/products/:id/kardex` | Consulta movimentações, mais recentes primeiro. |
| `GET` | `/api/inventory/low-stock` | Lista produtos ativos no estoque de segurança ou abaixo dele. |

Exemplo de entrada:

```json
{
  "productId": "UUID_DO_PRODUTO",
  "quantity": 12,
  "reason": "Recebimento de compra",
  "reference": "PED-123"
}
```

Quantidade deve ser positiva e pode ter até três casas decimais. O servidor
registra o usuário autenticado e o horário. As operações de movimentação e
saldo são transacionais; saídas que excedem o saldo são rejeitadas com `409`.
Movimentações são imutáveis no banco e podem ser compensadas com um estorno.

Erros da API usam o formato:

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "Insufficient stock for this movement"
  }
}
```

O endpoint de login aplica rate limit de 10 tentativas por janela de 15 minutos
por IP. O acesso autenticado atual permite os endpoints de estoque tanto a
gerentes quanto a estoquistas; endpoints de cadastro/edição administrativa e
políticas completas de acesso a custos ainda não foram implementados.

## Testes automatizados

Na raiz do projeto:

```powershell
npm run typecheck
npm run build
npm test
```

Comandos específicos:

```powershell
npm run test:unit
npm run test:integration
```

### Cobertura funcional dos testes

| Suíte | Casos | O que verifica |
| --- | ---: | --- |
| Unitária, `tests/unit/inventory.test.ts` | 10 | Cálculo de entrada e saída; saldo zero; precisão de três casas; saldo negativo; quantidades inválidas, infinitas ou com precisão excedente. |
| Integração, `tests/integration/movements.test.ts` | 2 | Entrada seguida de saída, saldo, Kardex e usuário auditado; rejeição de saída sem saldo e ausência de movimento parcial. |

Na validação realizada durante esta entrega, os 10 testes unitários passaram. Os
dois testes de integração foram descobertos, mas não executados, porque o
ambiente não tinha PostgreSQL local nem Docker disponível. Portanto, o resultado
de `npm test` foi **10 aprovados e 2 ignorados**. A suíte de integração usa o
schema PostgreSQL real e não deve ser considerada validada até ser executada com
um banco de teste.

### Executar integração em banco descartável

Crie um banco dedicado cujo nome contenha `test`, por exemplo
`inventory_test`, aplique ou disponibilize `pgcrypto` e configure `TEST_DATABASE_URL`
em `.env`:

```dotenv
TEST_DATABASE_URL=postgresql://inventory_user:change-me@localhost:5432/inventory_test
```

Então rode:

```powershell
npm run test:integration
```

A suíte cria um schema isolado com nome aleatório, aplica `schema.sql`, executa
os casos e remove somente esse schema ao final. A role precisa poder criar e
remover schemas e instalar `pgcrypto` caso a extensão ainda não esteja
disponível. Por segurança, a URL é recusada se o nome do banco não contiver
`test`, a menos que `ALLOW_NON_TEST_DATABASE=true` seja definido explicitamente.
Use exclusivamente um banco descartável.

Os números acima descrevem os cenários cobertos funcionalmente, não uma
porcentagem de cobertura de linhas ou branches. A coleta de cobertura percentual
de código ainda não está configurada.

## Estrutura principal

```text
schema.sql
src/                 API Express, autenticação e cálculo de saldo
tests/unit/          Testes unitários
tests/integration/   Testes da API com PostgreSQL
frontend/            Aplicação React, Vite e Tailwind CSS
```
