-- =====================================================================
-- FinWare — DWM Lab reference schemas (Postgres-flavoured)
--
-- This file is documentation for the lab report, NOT executed by the
-- running app (the app uses database/schema.sqlite.sql, which already
-- combines the snowflake + galaxy shapes so the API only needs one set
-- of tables). This file spells out the three schema variants from the
-- proposal separately, exactly as they'd be presented for grading.
-- =====================================================================


-- =====================================================================
-- 1. STAR SCHEMA
-- Fact_Transactions joined directly to four denormalized dimensions.
-- Fewer joins, fastest reads, some redundant data (e.g. City and
-- Income_Bracket repeated on every row of Dim_User).
-- =====================================================================

CREATE TABLE dim_user_star (
  user_id         VARCHAR(10) PRIMARY KEY,
  user_name       VARCHAR(100) NOT NULL,
  city            VARCHAR(50)  NOT NULL,
  income_bracket  VARCHAR(20)  NOT NULL
);

CREATE TABLE dim_bank_star (
  bank_id   VARCHAR(10) PRIMARY KEY,
  bank_name VARCHAR(100) NOT NULL
);

CREATE TABLE dim_category_star (
  category_id    VARCHAR(10) PRIMARY KEY,
  category_name  VARCHAR(50) NOT NULL,
  category_group VARCHAR(20) NOT NULL
);

CREATE TABLE dim_date_star (
  date_id   VARCHAR(10) PRIMARY KEY,
  full_date DATE NOT NULL,
  month     VARCHAR(20) NOT NULL,
  quarter   VARCHAR(10) NOT NULL,
  year      INT NOT NULL
);

CREATE TABLE fact_transactions_star (
  txn_id      VARCHAR(10) PRIMARY KEY,
  date_id     VARCHAR(10) REFERENCES dim_date_star(date_id),
  user_id     VARCHAR(10) REFERENCES dim_user_star(user_id),
  bank_id     VARCHAR(10) REFERENCES dim_bank_star(bank_id),
  category_id VARCHAR(10) REFERENCES dim_category_star(category_id),
  amount      NUMERIC(12,2) NOT NULL,
  txn_type    VARCHAR(6) NOT NULL CHECK (txn_type IN ('DEBIT','CREDIT'))
);

-- Example star-schema query (single hop from fact to every dimension):
-- SELECT cat.category_name, SUM(f.amount) AS total_value
-- FROM fact_transactions_star f
-- JOIN dim_category_star cat ON cat.category_id = f.category_id
-- GROUP BY cat.category_name;


-- =====================================================================
-- 2. SNOWFLAKE SCHEMA
-- Dim_User and Dim_Bank normalized further into their own lookup
-- tables. Less redundancy, more joins, slightly slower reads.
-- =====================================================================

CREATE TABLE dim_city (
  city_id   SERIAL PRIMARY KEY,
  city_name VARCHAR(50) NOT NULL
);

CREATE TABLE dim_income_bracket (
  income_id     SERIAL PRIMARY KEY,
  bracket_label VARCHAR(20) NOT NULL
);

CREATE TABLE dim_account_type (
  account_type_id SERIAL PRIMARY KEY,
  account_type    VARCHAR(20) NOT NULL
);

CREATE TABLE dim_bank_type (
  bank_type_id SERIAL PRIMARY KEY,
  bank_type    VARCHAR(30) NOT NULL
);

CREATE TABLE dim_user_snowflake (
  user_id         VARCHAR(10) PRIMARY KEY,
  user_name       VARCHAR(100) NOT NULL,
  city_id         INT REFERENCES dim_city(city_id),
  income_id       INT REFERENCES dim_income_bracket(income_id),
  account_type_id INT REFERENCES dim_account_type(account_type_id)
);

CREATE TABLE dim_bank_snowflake (
  bank_id      VARCHAR(10) PRIMARY KEY,
  bank_name    VARCHAR(100) NOT NULL,
  bank_type_id INT REFERENCES dim_bank_type(bank_type_id)
);

-- dim_category_star / dim_date_star / fact_transactions are reused
-- unchanged — only Dim_User and Dim_Bank are snowflaked in this design.

-- Example snowflake-schema query (walks the extra hops):
-- SELECT city.city_name, income.bracket_label, SUM(f.amount) AS total_spend
-- FROM fact_transactions_star f
-- JOIN dim_user_snowflake u ON u.user_id = f.user_id
-- JOIN dim_city city ON city.city_id = u.city_id
-- JOIN dim_income_bracket income ON income.income_id = u.income_id
-- GROUP BY city.city_name, income.bracket_label;


-- =====================================================================
-- 3. GALAXY SCHEMA (FACT CONSTELLATION)
-- Fact_Transactions and Fact_CA_Sessions share the conformed Dim_User
-- and Dim_Date dimensions, which is what lets a single query compare
-- spending behaviour against CA session activity for the same user
-- and date.
-- =====================================================================

CREATE TABLE dim_ca (
  ca_id   VARCHAR(10) PRIMARY KEY,
  ca_name VARCHAR(100) NOT NULL
);

CREATE TABLE fact_ca_sessions (
  session_id VARCHAR(10) PRIMARY KEY,
  date_id    VARCHAR(10) REFERENCES dim_date_star(date_id),   -- conformed
  user_id    VARCHAR(10) REFERENCES dim_user_star(user_id),   -- conformed
  ca_id      VARCHAR(10) REFERENCES dim_ca(ca_id),
  fee_amount NUMERIC(12,2) NOT NULL,
  status     VARCHAR(12) NOT NULL CHECK (status IN ('Completed','Scheduled','Cancelled'))
);

-- Example galaxy-schema query (two facts joined only through the
-- conformed dimensions — this is the Custom Analysis / Cross-Process
-- Analysis page):
-- SELECT u.user_name, d.full_date,
--        COALESCE(t.txn_total, 0)  AS transaction_value,
--        COALESCE(c.ca_total, 0)   AS ca_fees
-- FROM dim_user_star u
-- CROSS JOIN dim_date_star d
-- LEFT JOIN (SELECT user_id, date_id, SUM(amount) AS txn_total
--            FROM fact_transactions_star GROUP BY user_id, date_id) t
--   ON t.user_id = u.user_id AND t.date_id = d.date_id
-- LEFT JOIN (SELECT user_id, date_id, SUM(fee_amount) AS ca_total
--            FROM fact_ca_sessions GROUP BY user_id, date_id) c
--   ON c.user_id = u.user_id AND c.date_id = d.date_id
-- WHERE t.txn_total IS NOT NULL OR c.ca_total IS NOT NULL
-- ORDER BY d.full_date, u.user_id;

-- The runnable app's schema (schema.sqlite.sql) is effectively this
-- Snowflake + Galaxy combination in one set of tables — see
-- src/routes/analytics.routes.js for the equivalent live queries.
