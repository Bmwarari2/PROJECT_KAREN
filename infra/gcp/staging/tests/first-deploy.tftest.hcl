# Offline check of the deploy workflow's first, targeted step (no Google Cloud calls): run `tofu test` in
# infra/gcp/staging. Its own file, so it plans from an empty state like a first deploy.

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

# The deploy workflow's first step plans only the migrate and seed jobs (and what they depend on), so
# the jobs exist before migrations run. Cloud Run refuses a job whose secrets have no version yet, so
# that step must also write the secret values.
run "the_first_deploy_step_writes_the_secret_values" {
  command = plan

  plan_options {
    target = [google_cloud_run_v2_job.migrate, google_cloud_run_v2_job.seed]
  }

  assert {
    condition     = length(google_secret_manager_secret_version.this) == length(google_secret_manager_secret.this)
    error_message = "the targeted first step leaves secrets without a value, so Cloud Run cannot create the jobs"
  }
}
