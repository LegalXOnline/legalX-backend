-- Migration: 20240101000006_consultations
-- Description: Consultation bookings, sessions, and availability scheduling
-- Depends on: 20240101000003, 20240101000004

CREATE TABLE IF NOT EXISTS bookings (
  id              UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID     NOT NULL REFERENCES accounts(id),
  lawyer_id       UUID     NOT NULL REFERENCES lawyer_profiles(account_id),
  consult_type    consult_type NOT NULL,
  status          booking_status NOT NULL DEFAULT 'requested',
  scheduled_at    TIMESTAMPTZ,
  duration_mins   SMALLINT NOT NULL DEFAULT 30,
  amount          NUMERIC(10,2) NOT NULL,
  notes           TEXT,
  cancel_reason   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id          UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  UUID     NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  status      session_status NOT NULL DEFAULT 'not_started',
  room_id     TEXT,
  started_at  TIMESTAMPTZ,
  ended_at    TIMESTAMPTZ,
  duration_actual_mins SMALLINT,
  recording_url TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bookings_client   ON bookings(client_id);
CREATE INDEX IF NOT EXISTS idx_bookings_lawyer   ON bookings(lawyer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status   ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_schedule ON bookings(scheduled_at);

CREATE OR REPLACE TRIGGER trg_bookings_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

CREATE OR REPLACE TRIGGER trg_sessions_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

-- RLS
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bookings_client_read  ON bookings;
DROP POLICY IF EXISTS bookings_lawyer_read  ON bookings;
DROP POLICY IF EXISTS bookings_admin_all    ON bookings;

CREATE POLICY bookings_client_read ON bookings FOR SELECT USING (auth.uid() = client_id);
CREATE POLICY bookings_lawyer_read ON bookings FOR SELECT USING (auth.uid() = lawyer_id);
CREATE POLICY bookings_admin_all   ON bookings USING (
  EXISTS (SELECT 1 FROM accounts WHERE id = auth.uid() AND role = 'admin')
);
