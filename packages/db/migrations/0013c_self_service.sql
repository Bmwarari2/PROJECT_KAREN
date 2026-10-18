-- Phase 7 (expand only): employee self-service notification preferences.
-- {"email": bool, "push": bool, "categories": {"leave": {"email": bool, "push": bool}, ...}}
-- Missing keys mean "on". In-app notifications are always recorded; security notices ignore preferences.
ALTER TABLE app.users ADD COLUMN notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX notifications_unread ON app.notifications (tenant_id, user_id) WHERE read_at IS NULL;
