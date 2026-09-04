BEGIN;

CREATE TABLE IF NOT EXISTS billing_subscription_state (
  user_id text PRIMARY KEY,
  provider_customer_id text,
  provider_subscription_id text,
  plan_id text NOT NULL DEFAULT 'free' CHECK (plan_id IN ('free','paid_entry','highest_paid')),
  status text NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive','trialing','active','past_due','canceled','unpaid','incomplete','incomplete_expired','paused')),
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  current_period_end timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entitlement_reservations (
  reservation_id text PRIMARY KEY,
  user_id text NOT NULL,
  resource text NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  state text NOT NULL DEFAULT 'RESERVED' CHECK (state IN ('RESERVED','COMMITTED','RELEASED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entitlement_reservations_user_resource_idx
  ON entitlement_reservations(user_id, resource, state);

COMMIT;
