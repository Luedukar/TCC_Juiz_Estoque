-- Controle de estoque - PostgreSQL 14+
-- Execute em um banco vazio. O saldo é derivado do ledger, nunca editado diretamente.

BEGIN;

CREATE TYPE user_role AS ENUM ('MANAGER', 'STOCK_CLERK');
CREATE TYPE movement_type AS ENUM (
  'IN', 'OUT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'REVERSAL_IN', 'REVERSAL_OUT'
);
CREATE TYPE movement_status AS ENUM ('POSTED');

CREATE TABLE app_users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          user_role NOT NULL DEFAULT 'STOCK_CLERK',
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_users_email_not_blank CHECK (length(trim(email)) > 0)
);

CREATE TABLE suppliers (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         TEXT NOT NULL,
  tax_id       TEXT UNIQUE,
  email        TEXT,
  phone        TEXT,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT suppliers_name_not_blank CHECK (length(trim(name)) > 0)
);

CREATE TABLE categories (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT categories_name_not_blank CHECK (length(trim(name)) > 0)
);

CREATE TABLE products (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku              TEXT NOT NULL UNIQUE,
  barcode          TEXT UNIQUE,
  name             TEXT NOT NULL,
  description      TEXT,
  category_id      BIGINT REFERENCES categories(id) ON DELETE SET NULL,
  supplier_id      BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
  unit             TEXT NOT NULL DEFAULT 'UN',
  sale_price       NUMERIC(12,2) NOT NULL DEFAULT 0,
  unit_cost        NUMERIC(12,2),
  safety_stock     NUMERIC(14,3) NOT NULL DEFAULT 0,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT products_sku_not_blank CHECK (length(trim(sku)) > 0),
  CONSTRAINT products_name_not_blank CHECK (length(trim(name)) > 0),
  CONSTRAINT products_unit_not_blank CHECK (length(trim(unit)) > 0),
  CONSTRAINT products_prices_nonnegative CHECK (sale_price >= 0 AND (unit_cost IS NULL OR unit_cost >= 0)),
  CONSTRAINT products_safety_stock_nonnegative CHECK (safety_stock >= 0)
);

-- Cabeçalho de evento imutável: estornos são eventos novos vinculados ao original.
CREATE TABLE stock_movements (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  movement_type       movement_type NOT NULL,
  status              movement_status NOT NULL DEFAULT 'POSTED',
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id             BIGINT NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  supplier_id         BIGINT REFERENCES suppliers(id) ON DELETE RESTRICT,
  reference           TEXT,
  notes               TEXT,
  reverses_movement_id BIGINT UNIQUE REFERENCES stock_movements(id) ON DELETE RESTRICT,
  idempotency_key     UUID UNIQUE,
  CONSTRAINT movement_reversal_type CHECK (
    (movement_type IN ('REVERSAL_IN', 'REVERSAL_OUT')) = (reverses_movement_id IS NOT NULL)
  ),
  CONSTRAINT movement_reference_not_blank CHECK (reference IS NULL OR length(trim(reference)) > 0)
);

CREATE TABLE stock_movement_items (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  movement_id    BIGINT NOT NULL REFERENCES stock_movements(id) ON DELETE RESTRICT,
  product_id     BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity       NUMERIC(14,3) NOT NULL,
  unit_cost      NUMERIC(12,2),
  -- Em um estorno, aponta para a linha original; quantidade e produto serão verificados pela aplicação.
  reverses_item_id BIGINT UNIQUE REFERENCES stock_movement_items(id) ON DELETE RESTRICT,
  CONSTRAINT movement_item_quantity_positive CHECK (quantity > 0),
  CONSTRAINT movement_item_cost_nonnegative CHECK (unit_cost IS NULL OR unit_cost >= 0)
);

CREATE INDEX idx_products_name ON products (name);
CREATE INDEX idx_products_category ON products (category_id);
CREATE INDEX idx_movements_occurred_at ON stock_movements (occurred_at DESC);
CREATE INDEX idx_movements_user ON stock_movements (user_id);
CREATE INDEX idx_movement_items_product ON stock_movement_items (product_id, movement_id);

-- Nenhuma movimentação ou linha pode ser alterada/removida; correções são novos eventos de estorno.
CREATE FUNCTION reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Ledger is append-only; record a reversal instead' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER stock_movements_immutable
BEFORE UPDATE OR DELETE ON stock_movements
FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE TRIGGER stock_movement_items_immutable
BEFORE UPDATE OR DELETE ON stock_movement_items
FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- Emissão inicial das linhas é permitida somente enquanto o cabeçalho está sendo criado.
-- Aplicação deve inserir cabeçalho e linhas na mesma transação antes de confirmar.
CREATE FUNCTION validate_movement_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  head_type movement_type;
  original_product BIGINT;
  original_quantity NUMERIC(14,3);
BEGIN
  SELECT movement_type INTO head_type FROM stock_movements WHERE id = NEW.movement_id;
  IF head_type IS NULL THEN
    RAISE EXCEPTION 'Movement % does not exist', NEW.movement_id;
  END IF;
  IF head_type IN ('REVERSAL_IN', 'REVERSAL_OUT') THEN
    IF NEW.reverses_item_id IS NULL THEN
      RAISE EXCEPTION 'Reversal item must reference its original item';
    END IF;
    SELECT product_id, quantity INTO original_product, original_quantity
      FROM stock_movement_items WHERE id = NEW.reverses_item_id;
    IF original_product IS DISTINCT FROM NEW.product_id OR original_quantity IS DISTINCT FROM NEW.quantity THEN
      RAISE EXCEPTION 'Reversal item must match original product and quantity';
    END IF;
  ELSIF NEW.reverses_item_id IS NOT NULL THEN
    RAISE EXCEPTION 'Only reversal items may reference an original item';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER movement_item_validate
BEFORE INSERT ON stock_movement_items
FOR EACH ROW EXECUTE FUNCTION validate_movement_item();

-- Saldo atual e alertas. Movimentos OUT reduzem; IN aumentam. Ajustes/estornos são explícitos.
CREATE VIEW inventory_balances AS
SELECT
  p.id AS product_id,
  p.sku,
  p.barcode,
  p.name,
  p.safety_stock,
  COALESCE(SUM(CASE sm.movement_type
    WHEN 'IN' THEN smi.quantity
    WHEN 'ADJUSTMENT_IN' THEN smi.quantity
    WHEN 'REVERSAL_IN' THEN smi.quantity
    WHEN 'OUT' THEN -smi.quantity
    WHEN 'ADJUSTMENT_OUT' THEN -smi.quantity
    WHEN 'REVERSAL_OUT' THEN -smi.quantity
  END), 0)::NUMERIC(14,3) AS quantity_on_hand,
  COALESCE(SUM(CASE sm.movement_type
    WHEN 'IN' THEN smi.quantity
    WHEN 'ADJUSTMENT_IN' THEN smi.quantity
    WHEN 'REVERSAL_IN' THEN smi.quantity
    WHEN 'OUT' THEN -smi.quantity
    WHEN 'ADJUSTMENT_OUT' THEN -smi.quantity
    WHEN 'REVERSAL_OUT' THEN -smi.quantity
  END), 0) <= p.safety_stock AS is_below_safety_stock
FROM products p
LEFT JOIN stock_movement_items smi ON smi.product_id = p.id
LEFT JOIN stock_movements sm ON sm.id = smi.movement_id
GROUP BY p.id, p.sku, p.barcode, p.name, p.safety_stock;

COMMIT;
