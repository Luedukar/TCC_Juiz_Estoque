-- =====================================================================
-- schema.sql — Sistema de Controle de Estoque e Inventário
-- PostgreSQL 14+
--
-- Princípios:
--   * Saldo (products.current_stock) só muda via INSERT em stock_movements
--     (trigger atômico com lock de linha) — nunca por UPDATE direto.
--   * stock_movements e audit_log são imutáveis (sem UPDATE/DELETE/TRUNCATE).
--     Correções são feitas por ESTORNO (nova linha apontando para a original).
--   * Custos (cost_price, unit_cost) são ocultados no nível da API para o
--     perfil ESTOQUISTA; as views v_product_balances / v_low_stock não
--     expõem nenhum campo de custo.
--
-- SQLSTATEs customizados (para a API mapear em erros HTTP padronizados):
--   ST001 = estoque insuficiente            (-> 422)
--   ST002 = estorno inválido                (-> 422)
--   ST003 = registro imutável               (-> 405/409)
--   ST004 = produto inexistente ou inativo  (-> 404/422)
--   ST005 = alteração direta de saldo       (-> 500, bug de aplicação)
--
-- A aplicação deve, a cada transação de escrita, executar:
--   SELECT set_config('app.current_user_id', '<uuid-do-usuario>', true);
-- para que a auditoria registre quem fez a alteração.
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;    -- e-mail / SKU case-insensitive
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- busca rápida por nome

-- ---------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('GERENTE', 'ESTOQUISTA');

CREATE TYPE movement_type AS ENUM ('ENTRADA', 'SAIDA');

CREATE TYPE movement_reason AS ENUM (
    'COMPRA',
    'VENDA',
    'DEVOLUCAO_CLIENTE',
    'DEVOLUCAO_FORNECEDOR',
    'PERDA_AVARIA',
    'AJUSTE_INVENTARIO',
    'ESTORNO',
    'OUTRO'
);

-- ---------------------------------------------------------------------
-- Funções utilitárias
-- ---------------------------------------------------------------------
CREATE FUNCTION fn_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- Usuários e sessões (JWT)
-- ---------------------------------------------------------------------
CREATE TABLE users (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name          varchar(120) NOT NULL,
    email         citext      NOT NULL UNIQUE,
    password_hash text        NOT NULL,                  -- bcrypt/argon2, nunca texto puro
    role          user_role   NOT NULL DEFAULT 'ESTOQUISTA',
    is_active     boolean     NOT NULL DEFAULT true,     -- usuários não são apagados, só desativados
    last_login_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- Refresh tokens (guardamos apenas o hash; access token JWT é curto e stateless)
CREATE TABLE refresh_tokens (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text        NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    ip         inet,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- Fornecedores
-- ---------------------------------------------------------------------
CREATE TABLE suppliers (
    id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    name         varchar(160) NOT NULL,
    tax_id       varchar(18)  UNIQUE,                    -- CNPJ/CPF
    contact_name varchar(120),
    email        citext,
    phone        varchar(30),
    notes        text,
    is_active    boolean      NOT NULL DEFAULT true,
    created_at   timestamptz  NOT NULL DEFAULT now(),
    updated_at   timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX idx_suppliers_name_trgm ON suppliers USING gin (name gin_trgm_ops);

CREATE TRIGGER trg_suppliers_updated_at
    BEFORE UPDATE ON suppliers
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------
-- Catálogo de produtos
-- ---------------------------------------------------------------------
CREATE TABLE products (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    sku           citext        NOT NULL UNIQUE,
    barcode       varchar(14)   UNIQUE,                  -- EAN-8, UPC-A, EAN-13, GTIN-14
    name          varchar(200)  NOT NULL,
    description   text,
    unit          varchar(10)   NOT NULL DEFAULT 'UN',   -- UN, KG, CX, L...
    cost_price    numeric(12,2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),   -- somente GERENTE
    sale_price    numeric(12,2) NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
    safety_stock  numeric(14,3) NOT NULL DEFAULT 0 CHECK (safety_stock >= 0), -- estoque mínimo/segurança
    current_stock numeric(14,3) NOT NULL DEFAULT 0 CHECK (current_stock >= 0),-- mantido pelo trigger
    is_active     boolean       NOT NULL DEFAULT true,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT ck_products_barcode_format CHECK (barcode IS NULL OR barcode ~ '^[0-9]{8,14}$')
);

CREATE INDEX idx_products_name_trgm ON products USING gin (name gin_trgm_ops);
CREATE INDEX idx_products_low_stock ON products (current_stock, safety_stock) WHERE is_active;

CREATE TRIGGER trg_products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- Proteção: saldo só pode ser alterado de dentro do trigger de movimentação
-- (pg_trigger_depth() >= 2). Qualquer UPDATE/INSERT direto com saldo diferente é recusado.
CREATE FUNCTION fn_guard_product_stock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'ST005: o saldo do produto só pode ser alterado por movimentações de estoque'
            USING ERRCODE = 'ST005';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_products_guard_stock_upd
    BEFORE UPDATE ON products
    FOR EACH ROW
    WHEN (OLD.current_stock IS DISTINCT FROM NEW.current_stock)
    EXECUTE FUNCTION fn_guard_product_stock();

CREATE TRIGGER trg_products_guard_stock_ins
    BEFORE INSERT ON products
    FOR EACH ROW
    WHEN (NEW.current_stock <> 0)
    EXECUTE FUNCTION fn_guard_product_stock();

-- Produto x Fornecedor (N:N)
CREATE TABLE product_suppliers (
    product_id     uuid          NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
    supplier_id    uuid          NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    supplier_sku   varchar(50),
    last_cost      numeric(12,2) CHECK (last_cost >= 0),            -- somente GERENTE
    lead_time_days integer       CHECK (lead_time_days >= 0),
    is_preferred   boolean       NOT NULL DEFAULT false,
    PRIMARY KEY (product_id, supplier_id)
);

-- no máximo um fornecedor preferencial por produto
CREATE UNIQUE INDEX uq_product_preferred_supplier
    ON product_suppliers (product_id) WHERE is_preferred;

CREATE INDEX idx_product_suppliers_supplier ON product_suppliers (supplier_id);

-- ---------------------------------------------------------------------
-- Movimentações de estoque (livro-razão imutável / base do Kardex)
-- ---------------------------------------------------------------------
CREATE TABLE stock_movements (
    id              bigint          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id      uuid            NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    type            movement_type   NOT NULL,
    reason          movement_reason NOT NULL DEFAULT 'OUTRO',
    quantity        numeric(14,3)   NOT NULL CHECK (quantity > 0),
    signed_quantity numeric(14,3)   GENERATED ALWAYS AS (
                        CASE WHEN type = 'ENTRADA' THEN quantity ELSE -quantity END
                    ) STORED,
    balance_before  numeric(14,3)   NOT NULL,            -- preenchido pelo trigger
    balance_after   numeric(14,3)   NOT NULL,            -- preenchido pelo trigger
    unit_cost       numeric(12,2)   CHECK (unit_cost >= 0),   -- entradas; somente GERENTE
    supplier_id     uuid            REFERENCES suppliers(id) ON DELETE RESTRICT,
    document_ref    varchar(60),                          -- nº NF, pedido, etc.
    notes           text,
    reversal_of_id  bigint          UNIQUE REFERENCES stock_movements(id) ON DELETE RESTRICT,
    idempotency_key uuid            UNIQUE,               -- evita duplicidade em reenvio após falha de rede
    user_id         uuid            NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at      timestamptz     NOT NULL DEFAULT now(),

    CONSTRAINT ck_mov_balance_math     CHECK (balance_after = balance_before + signed_quantity),
    CONSTRAINT ck_mov_balance_nonneg   CHECK (balance_after >= 0),
    CONSTRAINT ck_mov_reversal_reason  CHECK ((reversal_of_id IS NOT NULL) = (reason = 'ESTORNO'))
);

CREATE INDEX idx_mov_kardex     ON stock_movements (product_id, created_at, id);
CREATE INDEX idx_mov_created_at ON stock_movements (created_at);
CREATE INDEX idx_mov_user       ON stock_movements (user_id, created_at);
CREATE INDEX idx_mov_supplier   ON stock_movements (supplier_id) WHERE supplier_id IS NOT NULL;

-- Aplica a movimentação: trava o produto, valida, calcula saldos e atualiza o saldo atual.
CREATE FUNCTION fn_apply_stock_movement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_stock  numeric(14,3);
    v_active boolean;
    v_orig   stock_movements%ROWTYPE;
BEGIN
    -- o CHECK da tabela só roda depois deste trigger; validamos antes para que uma quantidade
    -- inválida nunca seja confundida com "estoque insuficiente"
    IF NEW.quantity <= 0 THEN
        RAISE EXCEPTION 'a quantidade deve ser maior que zero' USING ERRCODE = '23514';
    END IF;

    -- lock de linha: serializa movimentações concorrentes do mesmo produto
    SELECT current_stock, is_active
      INTO v_stock, v_active
      FROM products
     WHERE id = NEW.product_id
       FOR UPDATE;

    IF NOT FOUND OR NOT v_active THEN
        RAISE EXCEPTION 'ST004: produto inexistente ou inativo' USING ERRCODE = 'ST004';
    END IF;

    -- Estorno: deve inverter exatamente uma movimentação original, uma única vez
    IF NEW.reversal_of_id IS NOT NULL THEN
        SELECT * INTO v_orig FROM stock_movements WHERE id = NEW.reversal_of_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'ST002: movimentação original não encontrada' USING ERRCODE = 'ST002';
        END IF;
        IF v_orig.reversal_of_id IS NOT NULL THEN
            RAISE EXCEPTION 'ST002: um estorno não pode ser estornado' USING ERRCODE = 'ST002';
        END IF;
        IF v_orig.product_id <> NEW.product_id
           OR v_orig.quantity <> NEW.quantity
           OR v_orig.type = NEW.type THEN
            RAISE EXCEPTION 'ST002: o estorno deve ter mesmo produto, mesma quantidade e tipo oposto'
                USING ERRCODE = 'ST002';
        END IF;

        NEW.reason := 'ESTORNO';
    END IF;

    NEW.balance_before := v_stock;
    NEW.balance_after  := v_stock + CASE WHEN NEW.type = 'ENTRADA' THEN NEW.quantity ELSE -NEW.quantity END;
    -- clock_timestamp() (e não now()): lido DEPOIS do lock da linha do produto, então a ordem por
    -- data/hora acompanha exatamente a ordem em que os saldos foram calculados (Kardex coerente
    -- mesmo com movimentações simultâneas). Também impede data retroativa vinda da aplicação.
    NEW.created_at     := clock_timestamp();

    IF NEW.balance_after < 0 THEN
        RAISE EXCEPTION 'ST001: estoque insuficiente (saldo %, solicitado %)', v_stock, NEW.quantity
            USING ERRCODE = 'ST001';
    END IF;

    UPDATE products SET current_stock = NEW.balance_after WHERE id = NEW.product_id;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_stock_movements_apply
    BEFORE INSERT ON stock_movements
    FOR EACH ROW EXECUTE FUNCTION fn_apply_stock_movement();

-- Imutabilidade: sem UPDATE, DELETE ou TRUNCATE
CREATE FUNCTION fn_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ST003: a tabela % é imutável; use estorno para corrigir', TG_TABLE_NAME
        USING ERRCODE = 'ST003';
END;
$$;

CREATE TRIGGER trg_stock_movements_immutable
    BEFORE UPDATE OR DELETE ON stock_movements
    FOR EACH ROW EXECUTE FUNCTION fn_forbid_mutation();

CREATE TRIGGER trg_stock_movements_no_truncate
    BEFORE TRUNCATE ON stock_movements
    FOR EACH STATEMENT EXECUTE FUNCTION fn_forbid_mutation();

-- ---------------------------------------------------------------------
-- Auditoria de cadastros (usuários, fornecedores, produtos)
-- As movimentações já são auditáveis por si só (usuário + data/hora + tipo).
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    uuid,                                      -- quem executou (app.current_user_id)
    action     text        NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    entity     text        NOT NULL,
    entity_id  text,
    old_data   jsonb,
    new_data   jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_entity ON audit_log (entity, entity_id, created_at);
CREATE INDEX idx_audit_user   ON audit_log (user_id, created_at);

CREATE TRIGGER trg_audit_log_immutable
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION fn_forbid_mutation();

CREATE TRIGGER trg_audit_log_no_truncate
    BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION fn_forbid_mutation();

CREATE FUNCTION fn_audit_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_old  jsonb;
    v_new  jsonb;
    v_user uuid;
BEGIN
    v_user := NULLIF(current_setting('app.current_user_id', true), '')::uuid;

    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        v_old := to_jsonb(OLD) - 'password_hash';
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        v_new := to_jsonb(NEW) - 'password_hash';
    END IF;

    -- ignora ruído: mudanças que afetam só saldo/updated_at/last_login_at
    IF TG_OP = 'UPDATE'
       AND (v_old - 'current_stock' - 'updated_at' - 'last_login_at')
         = (v_new - 'current_stock' - 'updated_at' - 'last_login_at') THEN
        RETURN NEW;
    END IF;

    INSERT INTO audit_log (user_id, action, entity, entity_id, old_data, new_data)
    VALUES (v_user, TG_OP, TG_TABLE_NAME, COALESCE(v_new, v_old)->>'id', v_old, v_new);

    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_audit_users
    AFTER INSERT OR UPDATE OR DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

CREATE TRIGGER trg_audit_suppliers
    AFTER INSERT OR UPDATE OR DELETE ON suppliers
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

CREATE TRIGGER trg_audit_products
    AFTER INSERT OR UPDATE OR DELETE ON products
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

-- ---------------------------------------------------------------------
-- Views de leitura
-- ---------------------------------------------------------------------

-- Saldos (sem campos de custo — seguro para ESTOQUISTA)
CREATE VIEW v_product_balances AS
SELECT p.id,
       p.sku,
       p.barcode,
       p.name,
       p.unit,
       p.current_stock,
       p.safety_stock,
       CASE
           WHEN p.current_stock <= 0                THEN 'ZERADO'
           WHEN p.current_stock <= p.safety_stock   THEN 'BAIXO'
           ELSE 'OK'
       END AS stock_status
  FROM products p
 WHERE p.is_active;

-- Alertas de estoque mínimo (dashboard de itens críticos)
CREATE VIEW v_low_stock AS
SELECT b.id,
       b.sku,
       b.barcode,
       b.name,
       b.unit,
       b.current_stock,
       b.safety_stock,
       b.stock_status,
       GREATEST(b.safety_stock - b.current_stock, 0) AS shortfall,
       s.name AS preferred_supplier
  FROM v_product_balances b
  LEFT JOIN product_suppliers ps ON ps.product_id = b.id AND ps.is_preferred
  LEFT JOIN suppliers s          ON s.id = ps.supplier_id
 WHERE b.stock_status <> 'OK'
 ORDER BY (b.stock_status = 'ZERADO') DESC,
          (b.current_stock / NULLIF(b.safety_stock, 0)) ASC NULLS LAST,
          b.name;

-- Kardex: extrato de movimentação por produto (filtrar por product_id e período)
-- Atenção: unit_cost deve ser removido pela API para o perfil ESTOQUISTA.
CREATE VIEW v_kardex AS
SELECT m.id,
       m.created_at,
       m.product_id,
       p.sku,
       p.name              AS product_name,
       m.type,
       m.reason,
       m.quantity,
       m.signed_quantity,
       m.balance_before,
       m.balance_after,
       m.unit_cost,
       m.document_ref,
       m.notes,
       m.reversal_of_id,
       r.id                AS reversed_by_id,   -- não nulo = esta movimentação já foi estornada
       u.name              AS user_name,
       s.name              AS supplier_name
  FROM stock_movements m
  JOIN products  p ON p.id = m.product_id
  JOIN users     u ON u.id = m.user_id
  LEFT JOIN suppliers s        ON s.id = m.supplier_id
  LEFT JOIN stock_movements r  ON r.reversal_of_id = m.id;

-- ---------------------------------------------------------------------
-- (Opcional, recomendado em produção) papel de aplicação com menor privilégio.
-- Reforça a imutabilidade também no nível de permissões.
-- ---------------------------------------------------------------------
-- CREATE ROLE estoque_app LOGIN PASSWORD '***';
-- GRANT SELECT, INSERT, UPDATE ON users, suppliers, products, product_suppliers, refresh_tokens TO estoque_app;
-- GRANT SELECT, INSERT ON stock_movements, audit_log TO estoque_app;
-- GRANT SELECT ON v_product_balances, v_low_stock, v_kardex TO estoque_app;
-- GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO estoque_app;
-- REVOKE UPDATE, DELETE, TRUNCATE ON stock_movements, audit_log FROM estoque_app;

COMMIT;
