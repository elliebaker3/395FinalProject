-- CallWizard minimal schema (Neon / Postgres)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  phone_e164 TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device_tokens (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expo_push_token TEXT,
  fcm_token TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id)
);

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,
  frequency_days INT NOT NULL DEFAULT 7 CHECK (frequency_days > 0),
  last_nudged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contacts_owner_idx ON contacts (owner_user_id);

-- Calling availability windows per user (day_of_week: 0=Sun … 6=Sat)
CREATE TABLE IF NOT EXISTS user_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS availability_user_idx ON user_availability (user_id);

-- Explicit recurring call schedules per contact
CREATE TABLE IF NOT EXISTS contact_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  recurrence TEXT NOT NULL CHECK (recurrence IN ('weekly', 'biweekly', 'monthly')),
  day_of_week SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),   -- weekly/biweekly only
  day_of_month SMALLINT CHECK (day_of_month BETWEEN 1 AND 31), -- monthly only
  scheduled_time TIME NOT NULL,
  last_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (recurrence IN ('weekly', 'biweekly') AND day_of_week IS NOT NULL AND day_of_month IS NULL)
    OR
    (recurrence = 'monthly' AND day_of_month IS NOT NULL AND day_of_week IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS schedules_user_idx ON contact_schedules (user_id);
