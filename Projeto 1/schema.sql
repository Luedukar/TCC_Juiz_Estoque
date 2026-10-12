-- PostgreSQL schema for a single-location retail inventory system.
-- Requires PostgreSQL 13+ and pgcrypto for UUID generation.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('manager', 'stockist');
CREATE TYPE movement_type AS ENUM ('in', 'out');

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role user_role NOT NULL DEFAULT 'stockist',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    tax_id TEXT UNIQUE,
    email TEXT,
    phone TEXT,
    notes TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id UUID REFERENCES categories(id) ON DELETE RESTRICT,
    sku TEXT NOT NULL UNIQUE,
    barcode TEXT UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    sale_price NUMERIC(12, 2) NOT NULL CHECK (sale_price >= 0),
    cost_price NUMERIC(12, 2) NOT NULL CHECK (cost_price >= 0),
    safety_stock NUMERIC(14, 3) NOT NULL DEFAULT 0 CHECK (safety_stock >= 0),
    unit TEXT NOT NULL DEFAULT 'un',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A product can be sourced from multiple suppliers, with supplier-specific
-- purchasing details.
CREATE TABLE product_suppliers (
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    supplier_sku TEXT,
    last_cost NUMERIC(12, 2) CHECK (last_cost IS NULL OR last_cost >= 0),
    PRIMARY KEY (product_id, supplier_id)
);

-- The current balance is a transactionally maintained projection of the
-- immutable stock_movements ledger.
CREATE TABLE stock_balances (
    product_id UUID PRIMARY KEY REFERENCES products(id) ON DELETE RESTRICT,
    quantity NUMERIC(14, 3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE stock_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    type movement_type NOT NULL,
    quantity NUMERIC(14, 3) NOT NULL CHECK (quantity > 0),
    reason TEXT,
    reference TEXT,
    reversal_of_id UUID UNIQUE REFERENCES stock_movements(id) ON DELETE RESTRICT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT movement_cannot_reverse_itself
        CHECK (reversal_of_id IS NULL OR reversal_of_id <> id)
);

CREATE INDEX stock_movements_product_time_idx
    ON stock_movements (product_id, occurred_at DESC, id DESC);
CREATE INDEX stock_movements_user_time_idx
    ON stock_movements (user_id, occurred_at DESC);
CREATE INDEX products_active_name_idx ON products (name) WHERE active;

CREATE FUNCTION initialize_product_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO stock_balances (product_id) VALUES (NEW.id);
    RETURN NEW;
END;
$$;

CREATE TRIGGER products_initialize_balance
AFTER INSERT ON products
FOR EACH ROW
EXECUTE FUNCTION initialize_product_balance();

CREATE FUNCTION apply_stock_movement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    original_movement stock_movements%ROWTYPE;
    balance_change NUMERIC(14, 3);
BEGIN
    IF NEW.reversal_of_id IS NOT NULL THEN
        SELECT *
          INTO original_movement
          FROM stock_movements
         WHERE id = NEW.reversal_of_id
         FOR SHARE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Movement to reverse does not exist'
                USING ERRCODE = '23503';
        END IF;

        IF original_movement.reversal_of_id IS NOT NULL
           OR original_movement.product_id <> NEW.product_id
           OR original_movement.quantity <> NEW.quantity
           OR original_movement.type = NEW.type THEN
            RAISE EXCEPTION 'Reversal must match the original movement with opposite type'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    balance_change := CASE NEW.type
        WHEN 'in' THEN NEW.quantity
        WHEN 'out' THEN -NEW.quantity
    END;

    UPDATE stock_balances
       SET quantity = quantity + balance_change,
           updated_at = NOW()
     WHERE product_id = NEW.product_id
       AND quantity + balance_change >= 0;

    IF NOT FOUND THEN
        IF NOT EXISTS (
            SELECT 1 FROM stock_balances WHERE product_id = NEW.product_id
        ) THEN
            RAISE EXCEPTION 'Stock balance is missing for product %', NEW.product_id
                USING ERRCODE = '23503';
        END IF;
        RAISE EXCEPTION 'Insufficient stock for product %', NEW.product_id
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER stock_movements_apply_balance
BEFORE INSERT ON stock_movements
FOR EACH ROW
EXECUTE FUNCTION apply_stock_movement();

CREATE FUNCTION prevent_stock_movement_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Stock movements are immutable; record a reversal instead'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER stock_movements_immutable
BEFORE UPDATE OR DELETE ON stock_movements
FOR EACH ROW
EXECUTE FUNCTION prevent_stock_movement_mutation();

-- Safe product listing for stockists. Enforce this view in the API's database
-- role/grants; managers can use products directly to access cost_price.
CREATE VIEW stockist_products AS
SELECT id, category_id, sku, barcode, name, description, sale_price,
       safety_stock, unit, active, created_at, updated_at
  FROM products;

CREATE VIEW low_stock_products AS
SELECT p.id, p.sku, p.barcode, p.name, b.quantity, p.safety_stock
  FROM products AS p
  JOIN stock_balances AS b ON b.product_id = p.id
 WHERE p.active
   AND b.quantity <= p.safety_stock;
