# Offline checks of the staging cell (no Google Cloud calls): run `tofu test` in infra/gcp/staging.
# Residency (CLAUDE.md): every regional resource of a cell is in that cell's region, backups included.

mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }
  mock_data "google_storage_project_service_account" {
    defaults = {
      email_address = "service-123456789012@gs-project-accounts.iam.gserviceaccount.com"
    }
  }
  mock_resource "google_service_account" {
    defaults = {
      email = "workload@thapsus-test.iam.gserviceaccount.com"
      name  = "projects/thapsus-test/serviceAccounts/workload@thapsus-test.iam.gserviceaccount.com"
    }
  }
  mock_resource "google_sql_database_instance" {
    defaults = {
      connection_name = "thapsus-test:europe-west2:thapsus-stg-uk-pg"
    }
  }
}

variables {
  project_id   = "thapsus-test"
  web_image    = "europe-west2-docker.pkg.dev/thapsus-test/thapsus/web:test"
  api_image    = "europe-west2-docker.pkg.dev/thapsus-test/thapsus/api:test"
  worker_image = "europe-west2-docker.pkg.dev/thapsus-test/thapsus/worker:test"
}

run "uk_cell_stays_in_london" {
  command = apply

  assert {
    condition     = local.region == "europe-west2"
    error_message = "the UK cell must run in europe-west2"
  }
  assert {
    condition = alltrue([
      google_sql_database_instance.main.region == "europe-west2",
      google_kms_key_ring.cell.location == "europe-west2",
      google_cloud_run_v2_service.app.location == "europe-west2",
      google_cloud_run_v2_service.worker.location == "europe-west2",
      google_cloud_run_v2_job.migrate.location == "europe-west2",
      google_cloud_run_v2_job.seed.location == "europe-west2",
      google_cloud_scheduler_job.drain.region == "europe-west2",
      google_storage_bucket.files.location == "EUROPE-WEST2",
      google_storage_bucket.mail.location == "EUROPE-WEST2",
      google_logging_project_bucket_config.cell.location == "europe-west2",
      strcontains(google_logging_project_sink.cell.destination, "/locations/europe-west2/"),
    ])
    error_message = "a UK resource is outside europe-west2"
  }
  assert {
    condition = alltrue([
      for s in google_secret_manager_secret.this :
      length(s.replication[0].user_managed[0].replicas) == 1 && s.replication[0].user_managed[0].replicas[0].location == "europe-west2"
    ])
    error_message = "every secret must be replicated to europe-west2 only"
  }
  assert {
    condition     = google_sql_database_instance.main.settings[0].backup_configuration[0].location == "europe-west2"
    error_message = "UK backups must stay in London (no backup region for the UK)"
  }
  assert {
    condition     = google_sql_database_instance.main.settings[0].backup_configuration[0].point_in_time_recovery_enabled
    error_message = "point-in-time recovery must be on"
  }
}

run "nothing_is_open_that_should_not_be" {
  command = apply

  assert {
    condition     = length(google_sql_database_instance.main.settings[0].ip_configuration[0].authorized_networks) == 0
    error_message = "the database must not accept direct connections"
  }
  assert {
    condition     = google_sql_database_instance.main.settings[0].ip_configuration[0].ssl_mode == "ENCRYPTED_ONLY"
    error_message = "database connections must be encrypted"
  }
  assert {
    condition     = google_sql_database_instance.main.deletion_protection
    error_message = "the database is protected from deletion by default"
  }
  assert {
    condition = alltrue([
      for b in [google_storage_bucket.files, google_storage_bucket.mail] :
      b.public_access_prevention == "enforced" && b.uniform_bucket_level_access && length(b.encryption) == 1
    ])
    error_message = "buckets must be private, uniform-access and encrypted with the cell's key"
  }
  assert {
    condition     = google_storage_bucket.files.versioning[0].enabled
    error_message = "the files bucket keeps versions"
  }
  assert {
    condition = alltrue([
      for b in [google_storage_bucket.files, google_storage_bucket.mail] :
      b.soft_delete_policy[0].retention_duration_seconds == 0
    ])
    error_message = "soft delete is off, so deleted files are really gone"
  }
  # Only the jobs account reads the test logins and the owner (migrator) credentials.
  assert {
    condition = alltrue([
      for k in keys(google_secret_manager_secret_iam_member.readers) :
      (startswith(k, "test-logins:") || startswith(k, "db-owner:")) ? endswith(k, ":jobs") : true
    ])
    error_message = "only the jobs service account may read test-logins and db-owner"
  }
  # The worker is called by the scheduler only; it has no public invoker.
  assert {
    condition     = google_cloud_run_v2_service_iam_member.worker_scheduler.member != "allUsers"
    error_message = "the worker must not be public"
  }
}

run "the_api_is_a_private_sidecar" {
  command = apply

  assert {
    condition     = length(google_cloud_run_v2_service.app.template[0].containers) == 2
    error_message = "the app service runs the web and the API"
  }
  assert {
    condition = alltrue([
      for c in google_cloud_run_v2_service.app.template[0].containers :
      c.name == "web" ? length(c.ports) == 1 : length(c.ports) == 0
    ])
    error_message = "only the web container takes traffic; the API is reached on localhost"
  }
  assert {
    condition = alltrue([
      for c in google_cloud_run_v2_service.app.template[0].containers :
      c.name != "api" || contains([for e in c.env : "${e.name}=${e.value}" if e.value != null], "TRUSTED_PROXY_CIDRS=127.0.0.1/32")
    ])
    error_message = "the API trusts only the web container as a proxy"
  }
  assert {
    condition = alltrue([
      for c in google_cloud_run_v2_service.app.template[0].containers :
      c.name != "api" || contains([for e in c.env : "${e.name}=${e.value}" if e.value != null], "APP_ENV=staging")
    ])
    error_message = "the API runs as staging"
  }
}

run "eu_cell_uses_frankfurt" {
  command = plan

  variables {
    cell = "eu"
  }

  assert {
    condition     = local.region == "europe-west3" && google_sql_database_instance.main.region == "europe-west3"
    error_message = "the EU cell must run in europe-west3"
  }
}

run "us_cell_uses_ohio" {
  command = plan

  variables {
    cell = "us"
  }

  assert {
    condition     = local.region == "us-east5" && google_cloud_run_v2_service.app.location == "us-east5"
    error_message = "the US cell must run in us-east5"
  }
}

run "unknown_cell_is_refused" {
  command = plan

  variables {
    cell = "apac"
  }

  expect_failures = [var.cell]
}
