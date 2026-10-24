# Generated credentials, stored in Secret Manager in the cell's region only. Nothing secret is in the
# repository; the values exist in Secret Manager and in the (private) state bucket.
locals {
  db_roles = {
    owner      = { user = "thapsus_owner", db = "thapsus" }
    app        = { user = "thapsus_app", db = "thapsus" }
    backoffice = { user = "thapsus_backoffice", db = "thapsus" }
    reporting  = { user = "thapsus_reporting", db = "thapsus" }
    directory  = { user = "thapsus_directory", db = "thapsus_global" }
  }
}

resource "random_password" "db" {
  for_each = local.db_roles
  length   = 40
  special  = false
}

resource "random_password" "internal_token" {
  length  = 48
  special = false
}

resource "random_password" "integration_signing_key" {
  length  = 64
  special = false
}

resource "random_password" "login" {
  for_each         = local.test_logins
  keepers          = { generation = var.test_login_generation }
  length           = 20
  special          = true
  override_special = "-_.!#%+="
  min_lower        = 2
  min_upper        = 2
  min_numeric      = 2
  min_special      = 2
}

locals {
  secret_values = merge(
    {
      for k, r in local.db_roles : "db-${k}" => jsonencode({
        username = r.user
        password = random_password.db[k].result
        dbname   = r.db
        port     = 5432
      })
    },
    {
      "internal-token"          = random_password.internal_token.result
      "integration-signing-key" = random_password.integration_signing_key.result
      # Read by the staff-invite job only (STAFF_INVITEE): who to invite to the back office (ADR-0174).
      "staff-invitee" = jsonencode({
        email = var.staff_owner_email
        name  = var.staff_owner_name
        role  = "super_admin"
      })
      # Read by the seed job (STAGING_LOGINS) and by the owner to sign in: see ../README.md.
      "test-logins" = jsonencode({
        url       = local.app_url
        workspace = var.workspace_slug
        logins = [
          for role, email in local.test_logins : {
            role     = role
            email    = email
            password = random_password.login[role].result
          }
        ]
      })
    },
  )

  # Which workload may read which secret.
  secret_readers = {
    "db-owner"                = ["jobs"]
    "db-app"                  = ["app", "worker", "jobs"]
    "db-backoffice"           = ["app", "worker", "jobs"]
    "db-reporting"            = ["app", "worker", "jobs"]
    "db-directory"            = ["app", "worker", "jobs"]
    "internal-token"          = ["app", "worker"]
    "integration-signing-key" = ["app", "worker"]
    "test-logins"             = ["jobs"]
    "staff-invitee"           = ["jobs"]
  }
}

resource "google_secret_manager_secret" "this" {
  for_each  = local.secret_values
  secret_id = "${local.prefix}-${each.key}"

  replication {
    user_managed {
      replicas {
        location = local.region
      }
    }
  }

  depends_on = [google_project_service.this]
}

resource "google_secret_manager_secret_version" "this" {
  for_each    = local.secret_values
  secret      = google_secret_manager_secret.this[each.key].id
  secret_data = each.value
}

resource "google_secret_manager_secret_iam_member" "readers" {
  for_each = merge([
    for secret, readers in local.secret_readers : {
      for r in readers : "${secret}:${r}" => { secret = secret, member = local.runtime_accounts[r] }
    }
  ]...)
  secret_id = google_secret_manager_secret.this[each.value.secret].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value.member}"
}

# The one-time back-office enrolment link for the invited staff member, written by the staff-invite job
# (never by OpenTofu, so it has no version until the job runs; no workload reads it as an environment
# value). London only like every other secret. The owner reads it with gcloud: ../README.md.
resource "google_secret_manager_secret" "staff_invite" {
  secret_id = "${local.prefix}-staff-invite"

  replication {
    user_managed {
      replicas {
        location = local.region
      }
    }
  }

  depends_on = [google_project_service.this]
}

resource "google_secret_manager_secret_iam_member" "staff_invite" {
  for_each  = toset(["roles/secretmanager.secretVersionAdder", "roles/secretmanager.secretAccessor"])
  secret_id = google_secret_manager_secret.staff_invite.id
  role      = each.value
  member    = "serviceAccount:${google_service_account.jobs.email}"
}
