output "app_url" {
  description = "Staging sign-in: <app_url>/signin"
  value       = local.app_url
}

output "region" {
  value = local.region
}

output "image_repository" {
  description = "Artifact Registry repository (created by ../bootstrap.sh) the deploy workflow pushes to"
  value       = "${local.region}-docker.pkg.dev/${var.project_id}/thapsus"
}

output "test_logins_secret" {
  description = "gcloud secrets versions access latest --secret=<this> prints the test organisation's sign-ins"
  value       = google_secret_manager_secret.this["test-logins"].secret_id
}

output "migrate_job" {
  value = google_cloud_run_v2_job.migrate.name
}

output "seed_job" {
  value = google_cloud_run_v2_job.seed.name
}

output "mail_bucket" {
  description = "Where staging email lands (.eml files, kept 14 days)"
  value       = google_storage_bucket.mail.name
}
