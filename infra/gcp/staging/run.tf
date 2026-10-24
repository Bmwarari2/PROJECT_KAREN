locals {
  sql_socket = "/cloudsql/${google_sql_database_instance.main.connection_name}"

  # Plain settings shared by the API, worker and jobs. Secrets are injected separately below.
  common_env = {
    APP_ENV           = "staging"
    CELL_REGION       = var.cell
    SERVICE_ROLE      = "cell"
    THAPSUS_HR_DOMAIN = var.product_domain
    APP_BASE_URL      = local.app_url
    API_BASE_URL      = local.app_url
    GLOBAL_BASE_URL   = local.app_url
    DATABASE_HOST     = local.sql_socket
    GCP_KMS_KEY       = google_kms_crypto_key.fields.id
    GCS_FILES_BUCKET  = google_storage_bucket.files.name
    MAIL_TRANSPORT    = "bucket"
    MAIL_BUCKET       = google_storage_bucket.mail.name
    AI_PROVIDER       = "off"
    LOG_FORMAT        = "gcp"
    LOG_LEVEL         = "info"
    OTEL_SDK_DISABLED = "true"
    # security alert recipients for the API (dead-man's switch) and the worker (alerts and digests)
    SECURITY_ALERT_EMAILS = join(",", var.security_alert_emails)
  }

  # env name => secret key in secrets.tf
  api_secrets = {
    DATABASE_SECRET            = "db-app"
    BACKOFFICE_DATABASE_SECRET = "db-backoffice"
    REPORTING_DATABASE_SECRET  = "db-reporting"
    DIRECTORY_DATABASE_SECRET  = "db-directory"
    INTERNAL_TOKEN             = "internal-token"
    INTEGRATION_SIGNING_KEY    = "integration-signing-key"
  }

  migrate_secrets = {
    OWNER_DATABASE_SECRET      = "db-owner"
    APP_DATABASE_SECRET        = "db-app"
    BACKOFFICE_DATABASE_SECRET = "db-backoffice"
    REPORTING_DATABASE_SECRET  = "db-reporting"
  }

  seed_secrets = {
    DATABASE_SECRET           = "db-app"
    DIRECTORY_DATABASE_SECRET = "db-directory"
    STAGING_LOGINS            = "test-logins"
  }

  # The staff-invite job reaches only the back-office schema and who to invite.
  staff_invite_secrets = {
    BACKOFFICE_DATABASE_SECRET = "db-backoffice"
    STAFF_INVITEE              = "staff-invitee"
  }
}

# Web + API in one service: the web container takes the traffic and proxies API paths to the API
# sidecar on localhost, as in local development, so the API is never exposed on its own and every
# response comes from the cell's region with the app's own Cache-Control (no CDN in front).
resource "google_cloud_run_v2_service" "app" {
  name                = "${local.prefix}-app"
  location            = local.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account                  = google_service_account.app.email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    timeout                          = "300s"
    max_instance_request_concurrency = 40

    scaling {
      min_instance_count = var.app_min_instances
      max_instance_count = var.app_max_instances
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.main.connection_name]
      }
    }

    containers {
      name       = "web"
      image      = var.web_image
      depends_on = ["api"]

      ports {
        container_port = 3000
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = {
          APP_ENV           = "staging"
          CELL_REGION       = var.cell
          THAPSUS_HR_DOMAIN = var.product_domain
          API_PROXY_URL     = "http://127.0.0.1:4000"
          API_INTERNAL_URL  = "http://127.0.0.1:4000"
          CLIENT_IP_SOURCE  = "cloud-run"
        }
        content {
          name  = env.key
          value = env.value
        }
      }

      startup_probe {
        period_seconds    = 2
        failure_threshold = 30
        timeout_seconds   = 2
        http_get {
          path = "/health"
          port = 3000
        }
      }
    }

    containers {
      name  = "api"
      image = var.api_image

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        cpu_idle = true
      }

      dynamic "env" {
        for_each = merge(local.common_env, {
          API_PORT            = "4000"
          SERVICE_NAME        = "thapsus-api"
          TRUSTED_PROXY_CIDRS = "127.0.0.1/32"
          DB_POOL_MAX         = "8"
        })
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.api_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.this[env.value].secret_id
              version = "latest"
            }
          }
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      startup_probe {
        period_seconds    = 2
        failure_threshold = 45
        timeout_seconds   = 2
        http_get {
          path = "/health"
          port = 4000
        }
      }
    }
  }

  # The values too, not only the secrets: Cloud Run refuses a secret reference with no version, and
  # the deploy's targeted first step (jobs only) must therefore create them (tests/first-deploy).
  depends_on = [
    google_secret_manager_secret_version.this,
    google_secret_manager_secret_iam_member.readers,
    google_project_iam_member.sql_client,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "app_public" {
  count    = var.public_access ? 1 : 0
  name     = google_cloud_run_v2_service.app.name
  location = local.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Background jobs: Cloud Scheduler calls POST /drain every minute (WORKER_MODE=http); the service
# accepts only that caller (Cloud Run IAM), runs one drain at a time and scales to zero in between.
resource "google_cloud_run_v2_service" "worker" {
  name                = "${local.prefix}-worker"
  location            = local.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account                  = google_service_account.worker.email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    timeout                          = "120s"
    max_instance_request_concurrency = 1

    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.main.connection_name]
      }
    }

    containers {
      name  = "worker"
      image = var.worker_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        cpu_idle = true
      }

      dynamic "env" {
        for_each = merge(local.common_env, {
          WORKER_MODE            = "http"
          WORKER_DRAIN_BUDGET_MS = "50000"
          SERVICE_NAME           = "thapsus-worker"
          DB_POOL_MAX            = "4"
        })
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.api_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.this[env.value].secret_id
              version = "latest"
            }
          }
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      startup_probe {
        period_seconds    = 2
        failure_threshold = 30
        timeout_seconds   = 2
        http_get {
          path = "/health"
          port = 8080
        }
      }
    }
  }

  # The values too, not only the secrets: Cloud Run refuses a secret reference with no version, and
  # the deploy's targeted first step (jobs only) must therefore create them (tests/first-deploy).
  depends_on = [
    google_secret_manager_secret_version.this,
    google_secret_manager_secret_iam_member.readers,
    google_project_iam_member.sql_client,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "worker_scheduler" {
  name     = google_cloud_run_v2_service.worker.name
  location = local.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "drain" {
  name             = "${local.prefix}-worker-drain"
  region           = local.region
  description      = "Runs due background jobs and outbox events"
  schedule         = "* * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "120s"

  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = "${local.worker_url}/drain"
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = local.worker_url
    }
  }

  depends_on = [google_cloud_run_v2_service_iam_member.worker_scheduler]
}

# Migrations: run by the deploy workflow before the services roll (expand-and-contract).
resource "google_cloud_run_v2_job" "migrate" {
  name                = "${local.prefix}-migrate"
  location            = local.region
  deletion_protection = false

  template {
    task_count = 1
    template {
      service_account = google_service_account.jobs.email
      max_retries     = 0
      timeout         = "900s"

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.main.connection_name]
        }
      }

      containers {
        image   = var.api_image
        command = ["node", "dist/migrate.mjs"]

        dynamic "env" {
          for_each = merge(local.common_env, { SERVICE_NAME = "thapsus-migrator" })
          content {
            name  = env.key
            value = env.value
          }
        }

        dynamic "env" {
          for_each = local.migrate_secrets
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.this[env.value].secret_id
                version = "latest"
              }
            }
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }
  }

  # The values too, not only the secrets: Cloud Run refuses a secret reference with no version, and
  # the deploy's targeted first step (jobs only) must therefore create them (tests/first-deploy).
  depends_on = [
    google_secret_manager_secret_version.this,
    google_secret_manager_secret_iam_member.readers,
    google_project_iam_member.sql_client,
    google_sql_user.owner,
    google_sql_database.cell,
  ]
}

# The fictional test organisation (apps/api/src/cli/seed-staging.ts). Idempotent: re-running resets
# the test logins to the passwords in the test-logins secret and changes nothing else.
resource "google_cloud_run_v2_job" "seed" {
  name                = "${local.prefix}-seed"
  location            = local.region
  deletion_protection = false

  template {
    task_count = 1
    template {
      service_account = google_service_account.jobs.email
      max_retries     = 0
      timeout         = "1800s"

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.main.connection_name]
        }
      }

      containers {
        image   = var.api_image
        command = ["node", "dist/seed-staging.mjs"]

        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }

        dynamic "env" {
          for_each = merge(local.common_env, { SERVICE_NAME = "thapsus-seed" })
          content {
            name  = env.key
            value = env.value
          }
        }

        dynamic "env" {
          for_each = local.seed_secrets
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.this[env.value].secret_id
                version = "latest"
              }
            }
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }
  }

  # The values too, not only the secrets: Cloud Run refuses a secret reference with no version, and
  # the deploy's targeted first step (jobs only) must therefore create them (tests/first-deploy).
  depends_on = [
    google_secret_manager_secret_version.this,
    google_secret_manager_secret_iam_member.readers,
    google_project_iam_member.sql_client,
    google_sql_user.directory,
    google_sql_database.global,
  ]
}

# Invites the first staff member (the product owner) to the back office (apps/api/src/cli/staff-invite.ts,
# ADR-0174): creates a passkey-only staff account and writes its one-time enrolment link to the
# staff-invite secret, never to a log. The deploy runs it once after the seed when GCP_STAFF_OWNER_EMAIL is
# set; it does nothing once the back office has staff, unless run with STAFF_INVITE_MODE=reissue.
resource "google_cloud_run_v2_job" "staff_invite" {
  name                = "${local.prefix}-staff-invite"
  location            = local.region
  deletion_protection = false

  template {
    task_count = 1
    template {
      service_account = google_service_account.jobs.email
      max_retries     = 0
      timeout         = "300s"

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.main.connection_name]
        }
      }

      containers {
        image   = var.api_image
        command = ["node", "dist/staff-invite.mjs"]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        dynamic "env" {
          for_each = merge(local.common_env, {
            SERVICE_NAME        = "thapsus-staff-invite"
            STAFF_INVITE_SECRET = google_secret_manager_secret.staff_invite.id
            STAFF_INVITE_MODE   = "first"
          })
          content {
            name  = env.key
            value = env.value
          }
        }

        dynamic "env" {
          for_each = local.staff_invite_secrets
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.this[env.value].secret_id
                version = "latest"
              }
            }
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }
  }

  # As the seed job: the secret values it reads must exist before Cloud Run creates it (PR #21).
  depends_on = [
    google_secret_manager_secret_version.this,
    google_secret_manager_secret_iam_member.readers,
    google_secret_manager_secret_iam_member.staff_invite,
    google_project_iam_member.sql_client,
    google_sql_database.cell,
  ]
}
