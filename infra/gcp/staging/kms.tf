# Per-region keys (CLAUDE.md): `fields` wraps the data keys of the sensitive-data store (field-level
# envelope encryption, apps/api/src/lib/kms.ts); `files` is the files and mail buckets' default key.
resource "google_kms_key_ring" "cell" {
  name     = "${local.prefix}-keys"
  location = local.region

  depends_on = [google_project_service.this]
}

resource "google_kms_crypto_key" "fields" {
  name            = "fields"
  key_ring        = google_kms_key_ring.cell.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "7776000s" # 90 days
  # A destroyed key's versions stay restorable for 30 days before Google deletes them.
  destroy_scheduled_duration = "2592000s"
}

resource "google_kms_crypto_key" "files" {
  name                       = "files"
  key_ring                   = google_kms_key_ring.cell.id
  purpose                    = "ENCRYPT_DECRYPT"
  rotation_period            = "7776000s"
  destroy_scheduled_duration = "2592000s"
}

# Cloud Storage encrypts objects with the files key on the project's behalf.
data "google_storage_project_service_account" "gcs" {}

resource "google_kms_crypto_key_iam_member" "files_gcs" {
  crypto_key_id = google_kms_crypto_key.files.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
}

# Only the services that read or write sensitive fields can use the fields key.
resource "google_kms_crypto_key_iam_member" "fields_runtime" {
  for_each      = local.runtime_accounts
  crypto_key_id = google_kms_crypto_key.fields.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${each.value}"
}
