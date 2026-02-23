-- ==============================================================
-- GoldBot — trainer/schema.sql
-- Run once against your PostgreSQL database:
--   psql $DB_URL -f trainer/schema.sql
-- ==============================================================

-- ── Candles (algorithm section B: REQUIRED DATA) ───────────────
-- One row per closed OHLC bar.  Primary key prevents duplicates.
CREATE TABLE IF NOT EXISTS candles (
  epic  TEXT             NOT NULL,
  tf    TEXT             NOT NULL,  -- M1 / M5 / M15 / H1 / H4
  ts    BIGINT           NOT NULL,  -- bar open-time, epoch ms
  open  DOUBLE PRECISION NOT NULL,
  high  DOUBLE PRECISION NOT NULL,
  low   DOUBLE PRECISION NOT NULL,
  close DOUBLE PRECISION NOT NULL,
  vol   DOUBLE PRECISION,
  PRIMARY KEY (epic, tf, ts)
);
CREATE INDEX IF NOT EXISTS candles_epic_tf_ts ON candles (epic, tf, ts DESC);

-- ── Signals (algorithm section M: MAIN LOOP decision points) ──
-- One row per M5/H1 candle close.  features + reasons are JSONB
-- so the schema survives indicator additions without migrations.
CREATE TABLE IF NOT EXISTS signals (
  id            BIGSERIAL    PRIMARY KEY,
  epic          TEXT         NOT NULL,
  ts            BIGINT       NOT NULL,  -- decision timestamp, epoch ms
  mode          TEXT         NOT NULL,  -- SCALP | SWING
  action        TEXT         NOT NULL,  -- HOLD / SKIP_RISK / BUY_EXEC / ...
  reasons       JSONB        NOT NULL,  -- gate outputs
  features      JSONB        NOT NULL,  -- indicator snapshot
  model_version TEXT,
  model_score   DOUBLE PRECISION,
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS signals_epic_ts ON signals (epic, ts DESC);

-- ── Trades (algorithm sections K/L: order placement + management) ─
CREATE TABLE IF NOT EXISTS trades (
  deal_id      TEXT             PRIMARY KEY,
  epic         TEXT             NOT NULL,
  opened_ts    BIGINT           NOT NULL,
  closed_ts    BIGINT,
  direction    TEXT             NOT NULL,  -- BUY / SELL
  size         DOUBLE PRECISION NOT NULL,
  entry        DOUBLE PRECISION NOT NULL,
  exit         DOUBLE PRECISION,
  sl           DOUBLE PRECISION,
  tp2          DOUBLE PRECISION,
  realized_pnl DOUBLE PRECISION,
  mode         TEXT,                       -- SCALP / SWING / UNKNOWN
  close_reason TEXT,                       -- SL_HIT / TP2_HIT / BROKER_CLOSE / ...
  status       TEXT             NOT NULL DEFAULT 'OPEN'
);
CREATE INDEX IF NOT EXISTS trades_epic_opened ON trades (epic, opened_ts DESC);

-- ── Labels (training labels, computed offline by label_signals.py) ──
CREATE TABLE IF NOT EXISTS labels (
  signal_id     BIGINT           PRIMARY KEY REFERENCES signals(id) ON DELETE CASCADE,
  horizon_bars  INT              NOT NULL,  -- e.g. 6 (6 × M5 = 30 min)
  horizon_tf    TEXT             NOT NULL,  -- e.g. 'M5'
  label         SMALLINT         NOT NULL,  -- +1 up, -1 down, 0 neutral
  future_return DOUBLE PRECISION,           -- raw close[t+H] - close[t]
  ret_norm      DOUBLE PRECISION,           -- future_return / ATR14_M5[t]
  computed_at   TIMESTAMPTZ      DEFAULT NOW()
);

-- ── Model registry ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS model_registry (
  id            BIGSERIAL    PRIMARY KEY,
  model_version TEXT         NOT NULL UNIQUE,
  trained_at    TIMESTAMPTZ  DEFAULT NOW(),
  n_train       INT,
  accuracy      DOUBLE PRECISION,
  roc_auc       DOUBLE PRECISION,
  notes         TEXT
);
