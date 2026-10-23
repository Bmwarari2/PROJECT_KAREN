locals {
  # Mirrors gcpRegion in packages/core/src/regions.ts; infra/test/gcp-staging.residency.test.ts keeps
  # the two in step. Every resource below is created in local.region and nowhere else.
  gcp_regions = {
    uk = "europe-west2"
    eu = "europe-west3"
    us = "us-east5"
  }
  region = local.gcp_regions[var.cell]

  prefix = "thapsus-stg-${var.cell}"

  # Cloud Run's deterministic service URL, known before the service exists (no dependency cycle).
  app_url    = "https://${local.prefix}-app-${data.google_project.this.number}.${local.region}.run.app"
  worker_url = "https://${local.prefix}-worker-${data.google_project.this.number}.${local.region}.run.app"

  # The test organisation's sign-in users (passwords are generated in secrets.tf).
  test_logins = {
    owner         = "owner@${var.workspace_slug}.example.test"
    hr_admin      = "hr.admin@${var.workspace_slug}.example.test"
    payroll_admin = "payroll@${var.workspace_slug}.example.test"
    manager       = "manager@${var.workspace_slug}.example.test"
    employee      = "employee@${var.workspace_slug}.example.test"
  }
}

data "google_project" "this" {
  project_id = var.project_id
}
