# One service account per workload, each with only what it uses (least privilege, ASVS V1.4).
resource "google_service_account" "app" {
  account_id   = "${local.prefix}-app"
  display_name = "Thapsus-HR staging app (web + API)"
}

resource "google_service_account" "worker" {
  account_id   = "${local.prefix}-worker"
  display_name = "Thapsus-HR staging worker"
}

resource "google_service_account" "jobs" {
  account_id   = "${local.prefix}-jobs"
  display_name = "Thapsus-HR staging migrate and seed jobs"
}

resource "google_service_account" "scheduler" {
  account_id   = "${local.prefix}-sched"
  display_name = "Calls the worker's drain endpoint every minute"
}

locals {
  runtime_accounts = {
    app    = google_service_account.app.email
    worker = google_service_account.worker.email
    jobs   = google_service_account.jobs.email
  }
}

# Cloud SQL connections go through the Cloud Run connector, which needs this project-level role
# (Cloud SQL has no per-instance IAM).
resource "google_project_iam_member" "sql_client" {
  for_each = local.runtime_accounts
  project  = var.project_id
  role     = "roles/cloudsql.client"
  member   = "serviceAccount:${each.value}"
}

# Signed download URLs: without a key file the storage library signs through the IAM signBlob API,
# which needs the token creator role on the account itself (and nothing wider).
resource "google_service_account_iam_member" "self_sign" {
  for_each           = { app = google_service_account.app, worker = google_service_account.worker }
  service_account_id = each.value.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${each.value.email}"
}
