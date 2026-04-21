-- =====================================================================
-- MIGRACIÓN: Módulo de comisiones + reimportación histórica
-- Fecha: 2026-04
-- =====================================================================
-- Aplica las tablas y columnas necesarias para:
--   1. Gestionar vendedores (sellers)
--   2. Reglas de comisión por vendedor y producto
--   3. Comisiones generadas por venta / lote histórico
--   4. Trazabilidad de comisiones en la tabla de ventas
-- =====================================================================

USE gestioneexus_db;

-- ---------------------------------------------------------------------
-- 1. Tabla de vendedores
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sellers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(150) NOT NULL,
    document VARCHAR(50) UNIQUE,
    contact VARCHAR(100),
    email VARCHAR(120),
    commission_rate_default DECIMAL(6,3) NOT NULL DEFAULT 0,
    notes TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Vendedor genérico para las filas históricas importadas desde el Excel
INSERT INTO sellers (full_name, document, notes, commission_rate_default)
SELECT 'Histórico Montejey', 'HIST-MONTEJEY', 'Vendedor genérico creado automáticamente para la reimportación histórica', 0
WHERE NOT EXISTS (SELECT 1 FROM sellers WHERE document = 'HIST-MONTEJEY');

-- ---------------------------------------------------------------------
-- 2. Reglas de comisión (opcional - permite tasas distintas por producto)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commission_rules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    seller_id INT NOT NULL,
    product_id INT NULL,                 -- NULL = aplica a todos los productos
    rate_percent DECIMAL(6,3) NOT NULL DEFAULT 0,
    rate_fixed DECIMAL(12,2) NOT NULL DEFAULT 0,
    valid_from DATE NOT NULL,
    valid_to DATE NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
    INDEX idx_commission_rules_seller (seller_id),
    INDEX idx_commission_rules_product (product_id)
);

-- ---------------------------------------------------------------------
-- 3. Comisiones generadas
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    seller_id INT NOT NULL,
    sale_id INT NULL,
    batch_id INT NULL,                   -- utilizado por la carga histórica
    entry_date DATE NOT NULL,            -- fecha contable
    base_amount DECIMAL(14,2) NOT NULL,  -- monto sobre el que se calcula (ventas)
    rate_percent DECIMAL(6,3) NOT NULL DEFAULT 0,
    amount DECIMAL(14,2) NOT NULL,       -- monto de la comisión (puede ser negativo = ajuste)
    status ENUM('pending','paid','cancelled') NOT NULL DEFAULT 'pending',
    payment_date DATE NULL,
    payment_method VARCHAR(40) NULL,
    source ENUM('sale','historical_import','manual_adjustment') NOT NULL DEFAULT 'sale',
    notes VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (seller_id) REFERENCES sellers(id),
    FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL,
    FOREIGN KEY (batch_id) REFERENCES product_batches(id) ON DELETE SET NULL,
    INDEX idx_commissions_seller (seller_id),
    INDEX idx_commissions_status (status),
    INDEX idx_commissions_date (entry_date)
);

-- ---------------------------------------------------------------------
-- 4. Añadir trazabilidad de vendedor y comisión a las ventas
-- ---------------------------------------------------------------------
-- NOTA: MySQL < 8.0.29 no soporta IF NOT EXISTS en ADD COLUMN. Uso un
-- bloque preparado que revisa information_schema y añade si falta.

SET @dbname = DATABASE();

-- sales.seller_id
SET @col_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'sales' AND COLUMN_NAME = 'seller_id'
);
SET @sql = IF(@col_exists = 0,
    'ALTER TABLE sales ADD COLUMN seller_id INT NULL, ADD CONSTRAINT fk_sales_seller FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE SET NULL',
    'SELECT "Columna sales.seller_id ya existe" AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- sales.commission_amount
SET @col_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'sales' AND COLUMN_NAME = 'commission_amount'
);
SET @sql = IF(@col_exists = 0,
    'ALTER TABLE sales ADD COLUMN commission_amount DECIMAL(14,2) NOT NULL DEFAULT 0',
    'SELECT "Columna sales.commission_amount ya existe" AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- sales.commission_rate (tasa aplicada en el momento)
SET @col_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'sales' AND COLUMN_NAME = 'commission_rate'
);
SET @sql = IF(@col_exists = 0,
    'ALTER TABLE sales ADD COLUMN commission_rate DECIMAL(6,3) NOT NULL DEFAULT 0',
    'SELECT "Columna sales.commission_rate ya existe" AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- sales.is_historical (marca las ventas importadas)
SET @col_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'sales' AND COLUMN_NAME = 'is_historical'
);
SET @sql = IF(@col_exists = 0,
    'ALTER TABLE sales ADD COLUMN is_historical BOOLEAN NOT NULL DEFAULT FALSE',
    'SELECT "Columna sales.is_historical ya existe" AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- product_batches.is_historical
SET @col_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'product_batches' AND COLUMN_NAME = 'is_historical'
);
SET @sql = IF(@col_exists = 0,
    'ALTER TABLE product_batches ADD COLUMN is_historical BOOLEAN NOT NULL DEFAULT FALSE',
    'SELECT "Columna product_batches.is_historical ya existe" AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- product_batches.historical_reference (lote original del Excel)
SET @col_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'product_batches' AND COLUMN_NAME = 'historical_reference'
);
SET @sql = IF(@col_exists = 0,
    'ALTER TABLE product_batches ADD COLUMN historical_reference VARCHAR(100) NULL',
    'SELECT "Columna product_batches.historical_reference ya existe" AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- =====================================================================
-- FIN DE LA MIGRACIÓN
-- =====================================================================
-- Para revertir manualmente (en orden):
--   ALTER TABLE product_batches DROP COLUMN historical_reference;
--   ALTER TABLE product_batches DROP COLUMN is_historical;
--   ALTER TABLE sales DROP COLUMN is_historical;
--   ALTER TABLE sales DROP COLUMN commission_rate;
--   ALTER TABLE sales DROP COLUMN commission_amount;
--   ALTER TABLE sales DROP FOREIGN KEY fk_sales_seller;
--   ALTER TABLE sales DROP COLUMN seller_id;
--   DROP TABLE commissions;
--   DROP TABLE commission_rules;
--   DROP TABLE sellers;
-- =====================================================================
