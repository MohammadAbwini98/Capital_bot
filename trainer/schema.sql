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

-- ── Quotes (live bid/ask ticks, flushed every ~60 s) ──────────
-- Useful for spread analysis, slippage studies, and offline replay.
-- Batched inserts keep DB write pressure negligible.
CREATE TABLE IF NOT EXISTS quotes (
  epic   TEXT             NOT NULL,
  ts     BIGINT           NOT NULL,   -- epoch ms
  bid    DOUBLE PRECISION NOT NULL,
  ask    DOUBLE PRECISION NOT NULL,
  spread DOUBLE PRECISION NOT NULL,
  status TEXT,
  PRIMARY KEY (epic, ts)
);
CREATE INDEX IF NOT EXISTS quotes_epic_ts ON quotes (epic, ts DESC);

-- ── Model registry ────────────────────────────────────────────
-- status: 'champion' (active), 'challenger' (shadow), 'archived'
CREATE TABLE IF NOT EXISTS model_registry (
  id            BIGSERIAL    PRIMARY KEY,
  model_version TEXT         NOT NULL UNIQUE,
  trained_at    TIMESTAMPTZ  DEFAULT NOW(),
  n_train       INT,
  accuracy      DOUBLE PRECISION,
  roc_auc       DOUBLE PRECISION,
  notes         TEXT,
  status        TEXT         NOT NULL DEFAULT 'challenger',
  promoted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS model_registry_status ON model_registry (status);

-- ── Training runs ──────────────────────────────────────────────
-- One row per execution of train.py — audit trail for every fit.
CREATE TABLE IF NOT EXISTS training_runs (
  id             BIGSERIAL        PRIMARY KEY,
  model_version  TEXT             NOT NULL,
  started_at     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ,
  n_train        INT,
  n_val          INT,
  train_start_ts BIGINT,
  train_end_ts   BIGINT,
  cv_roc_auc     DOUBLE PRECISION,
  val_hit_rate   DOUBLE PRECISION,
  promoted       BOOLEAN          NOT NULL DEFAULT FALSE,
  notes          TEXT
);

-- ── Predictions ────────────────────────────────────────────────
-- One row per model scoring event (champion + challenger shadow).
-- Enables offline comparison of champion vs challenger before promotion.
CREATE TABLE IF NOT EXISTS predictions (
  id        BIGSERIAL        PRIMARY KEY,
  signal_id BIGINT           REFERENCES signals(id) ON DELETE CASCADE,
  model_id  TEXT             NOT NULL,    -- model_version string
  p_win     DOUBLE PRECISION NOT NULL,    -- model output probability
  acted     BOOLEAN          NOT NULL DEFAULT FALSE,  -- trade placed on this score?
  shadow    BOOLEAN          NOT NULL DEFAULT FALSE,  -- TRUE = challenger shadow score
  ts        BIGINT           NOT NULL
);
CREATE INDEX IF NOT EXISTS predictions_signal_id ON predictions (signal_id);
CREATE INDEX IF NOT EXISTS predictions_model_ts  ON predictions (model_id, ts DESC);
