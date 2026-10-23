# One-region staging cell on Google Cloud (ADR-0157). Fictional test data only; production hosting is
# a separate decision. Applied by .github/workflows/deploy-gcp-staging.yml through Workload Identity
# Federation (no keys); state lives in the bucket created by ../bootstrap.sh.
terraform {
  required_version = ">= 1.13.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.6"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }

  # bucket and prefix come from `tofu init -backend-config=...` (see ../README.md)
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = local.region
  default_labels = {
    app         = "thapsus-hr"
    environment = "staging"
    cell        = var.cell
    data        = "fictional"
  }
}
