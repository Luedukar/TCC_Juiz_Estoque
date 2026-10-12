-- Dados de demonstração. Requer schema.sql aplicado e ao menos um usuário GERENTE (npm run user:create).
-- Idempotente: pode ser executado mais de uma vez (produtos existentes são ignorados; movimentações só entram se o produto for novo).
DO $$
DECLARE mgr uuid; pid uuid;
BEGIN
  SELECT id INTO mgr FROM users WHERE role = 'GERENTE' AND is_active ORDER BY created_at LIMIT 1;
  IF mgr IS NULL THEN RAISE EXCEPTION 'Crie antes um usuário GERENTE (npm run user:create).'; END IF;
  PERFORM set_config('app.current_user_id', mgr::text, true);
  INSERT INTO products (sku,barcode,name,unit,cost_price,sale_price,safety_stock) VALUES ('CAFE-500','7891000100103','Café Torrado 500g','UN',12.5,18.9,20)
    ON CONFLICT (sku) DO NOTHING RETURNING id INTO pid;
  IF pid IS NOT NULL THEN
    INSERT INTO stock_movements (product_id,type,reason,quantity,unit_cost,notes,user_id) VALUES (pid,'ENTRADA','COMPRA',100,12.5,'Carga inicial (demo)',mgr);
    INSERT INTO stock_movements (product_id,type,reason,quantity,notes,user_id) VALUES (pid,'SAIDA','VENDA',30,'Vendas (demo)',mgr);
  END IF;
  pid := NULL;
  INSERT INTO products (sku,barcode,name,unit,cost_price,sale_price,safety_stock) VALUES ('ARROZ-5','7891000200209','Arroz Branco 5kg','UN',21.0,29.9,15)
    ON CONFLICT (sku) DO NOTHING RETURNING id INTO pid;
  IF pid IS NOT NULL THEN
    INSERT INTO stock_movements (product_id,type,reason,quantity,unit_cost,notes,user_id) VALUES (pid,'ENTRADA','COMPRA',40,21.0,'Carga inicial (demo)',mgr);
    INSERT INTO stock_movements (product_id,type,reason,quantity,notes,user_id) VALUES (pid,'SAIDA','VENDA',32,'Vendas (demo)',mgr);
  END IF;
  pid := NULL;
  INSERT INTO products (sku,barcode,name,unit,cost_price,sale_price,safety_stock) VALUES ('FEIJAO-1','7891000300305','Feijão Carioca 1kg','UN',6.8,9.5,30)
    ON CONFLICT (sku) DO NOTHING RETURNING id INTO pid;
  IF pid IS NOT NULL THEN
    INSERT INTO stock_movements (product_id,type,reason,quantity,unit_cost,notes,user_id) VALUES (pid,'ENTRADA','COMPRA',80,6.8,'Carga inicial (demo)',mgr);
    INSERT INTO stock_movements (product_id,type,reason,quantity,notes,user_id) VALUES (pid,'SAIDA','VENDA',60,'Vendas (demo)',mgr);
  END IF;
  pid := NULL;
  INSERT INTO products (sku,barcode,name,unit,cost_price,sale_price,safety_stock) VALUES ('ACUCAR-1','7891000400401','Açúcar Refinado 1kg','UN',3.2,4.99,25)
    ON CONFLICT (sku) DO NOTHING RETURNING id INTO pid;
  IF pid IS NOT NULL THEN
    INSERT INTO stock_movements (product_id,type,reason,quantity,unit_cost,notes,user_id) VALUES (pid,'ENTRADA','COMPRA',50,3.2,'Carga inicial (demo)',mgr);
    INSERT INTO stock_movements (product_id,type,reason,quantity,notes,user_id) VALUES (pid,'SAIDA','VENDA',50,'Vendas (demo)',mgr);
  END IF;
  pid := NULL;
  INSERT INTO products (sku,barcode,name,unit,cost_price,sale_price,safety_stock) VALUES ('OLEO-900','7891000500507','Óleo de Soja 900ml','UN',5.9,8.79,20)
    ON CONFLICT (sku) DO NOTHING RETURNING id INTO pid;
  IF pid IS NOT NULL THEN
    INSERT INTO stock_movements (product_id,type,reason,quantity,unit_cost,notes,user_id) VALUES (pid,'ENTRADA','COMPRA',60,5.9,'Carga inicial (demo)',mgr);
    INSERT INTO stock_movements (product_id,type,reason,quantity,notes,user_id) VALUES (pid,'SAIDA','VENDA',35,'Vendas (demo)',mgr);
  END IF;
  pid := NULL;
  INSERT INTO products (sku,barcode,name,unit,cost_price,sale_price,safety_stock) VALUES ('LEITE-1','7891000600603','Leite Integral 1L','UN',3.9,5.49,40)
    ON CONFLICT (sku) DO NOTHING RETURNING id INTO pid;
  IF pid IS NOT NULL THEN
    INSERT INTO stock_movements (product_id,type,reason,quantity,unit_cost,notes,user_id) VALUES (pid,'ENTRADA','COMPRA',120,3.9,'Carga inicial (demo)',mgr);
    INSERT INTO stock_movements (product_id,type,reason,quantity,notes,user_id) VALUES (pid,'SAIDA','VENDA',70,'Vendas (demo)',mgr);
  END IF;
  pid := NULL;
END $$;
