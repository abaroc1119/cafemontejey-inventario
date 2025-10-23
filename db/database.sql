-- Crear la base de datos si no existe
CREATE DATABASE IF NOT EXISTS gestioneexus_db;
USE gestioneexus_db;

-- Tabla de Roles
CREATE TABLE roles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);

-- Insertar roles iniciales
INSERT INTO roles (name) VALUES ('admin'), ('normal');

-- Tabla de Usuarios
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role_id INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP NULL,
    is_active BOOLEAN DEFAULT TRUE,
    FOREIGN KEY (role_id) REFERENCES roles(id)
);

-- Tabla de Productos
CREATE TABLE products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    reference VARCHAR(50) UNIQUE,
    category VARCHAR(100),
    sizes VARCHAR(100),
    brand VARCHAR(100),
    quantity INT NOT NULL DEFAULT 0,
    price DECIMAL(10, 2) NOT NULL
);

-- Tabla de Ventas
CREATE TABLE sales (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    total_amount DECIMAL(10, 2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Tabla de Detalles de Venta (relación muchos a muchos entre ventas y productos)
CREATE TABLE sale_details (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sale_id INT,
    product_id INT,
    quantity INT NOT NULL,
    unit_price DECIMAL(10, 2) NOT NULL,
    FOREIGN KEY (sale_id) REFERENCES sales(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
);

-- Tabla de Planes Separe (Apartados)
CREATE TABLE layaway_plans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_name VARCHAR(100) NOT NULL,
    customer_id_doc VARCHAR(50),
    customer_contact VARCHAR(50),
    total_value DECIMAL(10, 2) NOT NULL,
    down_payment DECIMAL(10, 2) NOT NULL,
    balance_due DECIMAL(10, 2) NOT NULL,
    deadline DATE NOT NULL,
    status ENUM('active', 'completed', 'overdue') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabla de Detalles de Planes Separe
CREATE TABLE layaway_plan_details (
    id INT AUTO_INCREMENT PRIMARY KEY,
    layaway_plan_id INT,
    product_id INT,
    quantity INT NOT NULL,
    FOREIGN KEY (layaway_plan_id) REFERENCES layaway_plans(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
);

-- Tabla de Proveedores
CREATE TABLE suppliers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_name VARCHAR(100) NOT NULL,
    contact_person VARCHAR(100),
    contact_number VARCHAR(50),
    email VARCHAR(100),
    address VARCHAR(255),
    nit VARCHAR(50) UNIQUE
);

-- Tabla de Auditoría (Logs)
CREATE TABLE audit_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    action VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Trigger para descontar stock al crear una venta
DELIMITER $$
CREATE TRIGGER after_saledetail_insert
AFTER INSERT ON sale_details
FOR EACH ROW
BEGIN
    UPDATE products
    SET quantity = quantity - NEW.quantity
    WHERE id = NEW.product_id;
END$$
DELIMITER ;

-- Trigger para descontar stock al crear un plan separe
DELIMITER $$
CREATE TRIGGER after_layawaydetail_insert
AFTER INSERT ON layaway_plan_details
FOR EACH ROW
BEGIN
    UPDATE products
    SET quantity = quantity - NEW.quantity
    WHERE id = NEW.product_id;
END$$
DELIMITER ;

-- Insertar usuario administrador de prueba
-- Contraseña: "admin123" (será hasheada por el sistema al registrar)
INSERT INTO users (full_name, username, email, password, role_id) VALUES
('Yeison Molina', 'admin', 'admin@gestioneexus.com', '$2a$10$wG/N4j5j5Y.l8J5c7Q9p7eRz2q4O/2Yq6E6s.1Q2b6Xz9X7r4Y5yC', 1);

-- Insertar usuario normal de prueba
-- Contraseña: "user123"
INSERT INTO users (full_name, username, email, password, role_id) VALUES
('Karol Zea Cano', 'karolzea', 'karol@gestioneexus.com', '$2a$10$fW/g8a7H9c.E6k7v/3x8R.sY9d8e7F6g5H4i3J2k1l0O9p8q7r6tU', 2);