#!/usr/bin/env bash
# One-time setup of the Google Cloud staging project, run by the owner in Cloud Shell
# (docs/HUMAN_TODO.md "Google Cloud staging"). Safe to run again: every step checks first.
#
#   bash infra/gcp/bootstrap.sh <project-id>
#
# It creates only what the deploy workflow needs to start: the APIs, a private state bucket, the image
# repository, a deploy service account and a Workload Identity Federation trust that lets GitHub
# Actions runs on this repository's main branch act as that account. There are no keys. Everything
# else is created by OpenTofu from the workflow (infra/gcp/staging), and only after the owner approves
# the plan in GitHub.
set -euo pipefail

PROJECT_ID="${1:?usage: bash infra/gcp/bootstrap.sh <project-id>}"
REGION="europe-west2"                 # UK cell: London (packages/core/src/regions.ts)
GITHUB_REPO="Bmwarari2/PROJECT_KAREN"
GITHUB_REPO_ID="1423794937"           # immutable id: a renamed or re-created repository gets no access
POOL="github"
PROVIDER="github-actions"
DEPLOYER="thapsus-deployer"
STATE_BUCKET="${PROJECT_ID}-tofu-state"

say() { printf '\n== %s\n' "$*"; }

gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

if [[ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null)" != "True" ]]; then
  echo "Billing is not enabled on $PROJECT_ID. Link a billing account first (Console > Billing > My projects)." >&2
  exit 1
fi

say "Enabling APIs"
gcloud services enable \
  artifactregistry.googleapis.com cloudkms.googleapis.com cloudresourcemanager.googleapis.com \
  cloudscheduler.googleapis.com iam.googleapis.com iamcredentials.googleapis.com logging.googleapis.com \
  run.googleapis.com secretmanager.googleapis.com serviceusage.googleapis.com sqladmin.googleapis.com \
  storage.googleapis.com sts.googleapis.com

say "State bucket gs://$STATE_BUCKET ($REGION, private, versioned)"
if ! gcloud storage buckets describe "gs://$STATE_BUCKET" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$STATE_BUCKET" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention
fi
gcloud storage buckets update "gs://$STATE_BUCKET" --versioning >/dev/null

say "Image repository $REGION-docker.pkg.dev/$PROJECT_ID/thapsus"
if ! gcloud artifacts repositories describe thapsus --location="$REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create thapsus --location="$REGION" --repository-format=docker \
    --description="Thapsus-HR staging images (web, api, worker)"
fi
POLICY="$(mktemp)"
cat > "$POLICY" <<'JSON'
[
  {"name": "keep-recent", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 15}},
  {"name": "delete-old", "action": {"type": "Delete"}, "condition": {"olderThan": "30d"}}
]
JSON
gcloud artifacts repositories set-cleanup-policies thapsus --location="$REGION" --policy="$POLICY" \
  --no-dry-run >/dev/null
rm -f "$POLICY"

say "Deploy service account $DEPLOYER"
SA="$DEPLOYER@$PROJECT_ID.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$SA" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$DEPLOYER" --display-name="Thapsus-HR staging deploys (GitHub Actions)"
fi
# What OpenTofu manages in this project, and nothing at organisation level. Use a project that holds
# only this staging cell.
for role in \
  roles/artifactregistry.admin roles/cloudkms.admin roles/cloudscheduler.admin roles/cloudsql.admin \
  roles/logging.configWriter \
  roles/iam.serviceAccountAdmin roles/iam.serviceAccountUser roles/resourcemanager.projectIamAdmin \
  roles/run.admin roles/secretmanager.admin roles/serviceusage.serviceUsageAdmin roles/storage.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role="$role" \
    --condition=None >/dev/null
done

say "Workload Identity Federation for $GITHUB_REPO (main branch only)"
if ! gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub Actions"
fi
CONDITION="assertion.repository_id == '$GITHUB_REPO_ID' && assertion.ref == 'refs/heads/main'"
MAPPING="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref"
if ! gcloud iam workload-identity-pools providers describe "$PROVIDER" --location=global \
  --workload-identity-pool="$POOL" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --location=global \
    --workload-identity-pool="$POOL" --display-name="GitHub Actions OIDC" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="$MAPPING" --attribute-condition="$CONDITION"
else
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER" --location=global \
    --workload-identity-pool="$POOL" --attribute-mapping="$MAPPING" --attribute-condition="$CONDITION" >/dev/null
fi
gcloud iam service-accounts add-iam-policy-binding "$SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository_id/$GITHUB_REPO_ID" \
  >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$STATE_BUCKET" --member="serviceAccount:$SA" \
  --role=roles/storage.objectAdmin >/dev/null

cat <<OUT

Done. In GitHub: $GITHUB_REPO > Settings > Secrets and variables > Actions > Variables, add:

  GCP_PROJECT_ID          $PROJECT_ID
  GCP_WIF_PROVIDER        projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER
  GCP_DEPLOY_SA           $SA
  GCP_STATE_BUCKET        $STATE_BUCKET
  GCP_STAGING_ENABLED     true

These are identifiers, not secrets. Then, in Settings > Environments, create the environment
"staging-gcp" and add yourself under "Required reviewers": every deploy waits for your approval
of its plan (the workflow refuses to apply without that rule). Finally run "Deploy staging
(Google Cloud)" from the Actions tab.
OUT
