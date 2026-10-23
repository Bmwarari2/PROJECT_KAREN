# Logs stay in the cell's region (CLAUDE.md). A project's _Default log bucket is global, so every log
# is routed to a London log bucket and excluded from _Default. Project exclusions apply to the
# _Default sink only. Google's _Required bucket (admin-activity audit logs about the project's
# resources, not application data) is fixed by Google and cannot be moved.
resource "google_logging_project_bucket_config" "cell" {
  project        = var.project_id
  location       = local.region
  bucket_id      = "${local.prefix}-logs"
  retention_days = 30
  description    = "Thapsus-HR staging logs (the app's logger scrubs personal data)"

  depends_on = [google_project_service.this]
}

resource "google_logging_project_sink" "cell" {
  name        = "${local.prefix}-logs"
  destination = "logging.googleapis.com/projects/${var.project_id}/locations/${local.region}/buckets/${google_logging_project_bucket_config.cell.bucket_id}"
  # every log the project receives (the _Required logs are routed by Google before this)
  filter                 = ""
  unique_writer_identity = true
}

resource "google_logging_project_exclusion" "keep_out_of_global" {
  name        = "${local.prefix}-not-global"
  description = "Logs go to the regional bucket instead of the global _Default bucket"
  filter      = "logName:\"projects/${var.project_id}/logs/\""

  depends_on = [google_logging_project_sink.cell]
}
