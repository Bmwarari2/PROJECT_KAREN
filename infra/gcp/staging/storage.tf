# Files (documents, exports, payslips): private, versioned, CMEK, in the cell's region only.
resource "google_storage_bucket" "files" {
  name                        = "${var.project_id}-${local.prefix}-files"
  location                    = upper(local.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  encryption {
    default_kms_key_name = google_kms_crypto_key.files.id
  }

  # Deleted and replaced versions are kept 30 days, then removed (erasure requests delete every
  # version straight away through the app).
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
    }
    action {
      type = "Delete"
    }
  }

  # Off: deleted files must be gone when the app deletes them (erasure requests are verified).
  soft_delete_policy {
    retention_duration_seconds = 0
  }

  # Signed download URLs are opened by the browser from the app's origin.
  cors {
    origin          = [local.app_url]
    method          = ["GET", "HEAD", "PUT"]
    response_header = ["Content-Type", "Content-Disposition"]
    max_age_seconds = 3600
  }

  depends_on = [google_kms_crypto_key_iam_member.files_gcs]
}

# Staging has no email provider: the API writes each message as an .eml object here
# (MAIL_TRANSPORT=bucket), kept 14 days. Testers read them in the Cloud Console.
resource "google_storage_bucket" "mail" {
  name                        = "${var.project_id}-${local.prefix}-mail"
  location                    = upper(local.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true

  encryption {
    default_kms_key_name = google_kms_crypto_key.files.id
  }

  lifecycle_rule {
    condition {
      age = 14
    }
    action {
      type = "Delete"
    }
  }

  soft_delete_policy {
    retention_duration_seconds = 0
  }

  depends_on = [google_kms_crypto_key_iam_member.files_gcs]
}

resource "google_storage_bucket_iam_member" "files_runtime" {
  for_each = local.runtime_accounts
  bucket   = google_storage_bucket.files.name
  role     = "roles/storage.objectAdmin"
  member   = "serviceAccount:${each.value}"
}

resource "google_storage_bucket_iam_member" "mail_runtime" {
  for_each = local.runtime_accounts
  bucket   = google_storage_bucket.mail.name
  role     = "roles/storage.objectAdmin"
  member   = "serviceAccount:${each.value}"
}

# The adapters check each bucket's location before first use (storage.buckets.get).
resource "google_storage_bucket_iam_member" "files_location" {
  for_each = local.runtime_accounts
  bucket   = google_storage_bucket.files.name
  role     = "roles/storage.legacyBucketReader"
  member   = "serviceAccount:${each.value}"
}

resource "google_storage_bucket_iam_member" "mail_location" {
  for_each = local.runtime_accounts
  bucket   = google_storage_bucket.mail.name
  role     = "roles/storage.legacyBucketReader"
  member   = "serviceAccount:${each.value}"
}
