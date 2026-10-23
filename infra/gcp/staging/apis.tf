# APIs the cell uses (the bootstrap enables the ones the deploy itself needs). Never disabled on
# destroy, so a teardown cannot break unrelated resources in the project.
locals {
  services = [
    "cloudkms.googleapis.com",
    "cloudscheduler.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
  ]
}

resource "google_project_service" "this" {
  for_each           = toset(local.services)
  service            = each.value
  disable_on_destroy = false
}
