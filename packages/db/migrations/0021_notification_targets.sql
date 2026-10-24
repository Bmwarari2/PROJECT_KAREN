-- Notifications name what they are about (ADR-0160): a target type and the target's id, from which the
-- API builds the page to open (packages/core/src/links.ts). Expand only: both columns are nullable, and
-- older notifications keep working through their stored link or the list page for their kind.
ALTER TABLE app.notifications
  ADD COLUMN IF NOT EXISTS target_type text CHECK (target_type IS NULL OR target_type ~ '^[a-z_]{1,40}$'),
  ADD COLUMN IF NOT EXISTS target_id uuid;
