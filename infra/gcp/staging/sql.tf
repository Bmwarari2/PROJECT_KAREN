# PostgreSQL 17 (same major as local dev and CI). RLS, roles and policies come from the migrations,
# unchanged. Reached only through the Cloud Run Cloud SQL connector (IAM-authorised, encrypted): the
# instance has a public address for the connector but no authorised networks, so nothing else can
# connect.
resource "google_sql_database_instance" "main" {
  name                = "${local.prefix}-pg"
  region              = local.region
  database_version    = "POSTGRES_17"
  deletion_protection = var.deletion_protection

  settings {
    tier                        = var.sql_tier
    edition                     = "ENTERPRISE"
    availability_type           = "ZONAL"
    disk_type                   = "PD_SSD"
    disk_size                   = 10
    disk_autoresize             = true
    deletion_protection_enabled = var.deletion_protection

    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "02:00"
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      # Backups stay in the cell's region (the default would be the nearest multi-region).
      location = local.region
      backup_retention_settings {
        retained_backups = 7
      }
    }

    maintenance_window {
      day  = 7
      hour = 3
    }

    # No statement logging: queries can carry personal data (CLAUDE.md observability rule).
    database_flags {
      name  = "log_min_duration_statement"
      value = "-1"
    }

    insights_config {
      query_insights_enabled  = false
      record_application_tags = false
      record_client_address   = false
    }
  }

  depends_on = [google_project_service.this]
}

resource "google_sql_database" "cell" {
  name     = "thapsus"
  instance = google_sql_database_instance.main.name
}

# The global tenant directory (tenant id, slug, home region; no employee personal data).
resource "google_sql_database" "global" {
  name     = "thapsus_global"
  instance = google_sql_database_instance.main.name
}

# Built-in users: the migrator (owner of the tables) and the directory. The application roles
# (thapsus_app, thapsus_backoffice, thapsus_reporting) are created by the migrations without
# BYPASSRLS and get their passwords from the migrate job.
resource "google_sql_user" "owner" {
  name     = local.db_roles.owner.user
  instance = google_sql_database_instance.main.name
  password = random_password.db["owner"].result
}

resource "google_sql_user" "directory" {
  name     = local.db_roles.directory.user
  instance = google_sql_database_instance.main.name
  password = random_password.db["directory"].result
}
