variable "project_id" {
  description = "Google Cloud project that holds this staging cell (one project per environment)."
  type        = string
}

variable "cell" {
  description = "Home region code of the cell (packages/core/src/regions.ts). Staging runs the UK cell only."
  type        = string
  default     = "uk"
  validation {
    condition     = contains(["uk", "eu", "us"], var.cell)
    error_message = "cell must be uk, eu or us."
  }
}

variable "web_image" {
  description = "Web image (Artifact Registry URL with a tag or digest), set by the deploy workflow."
  type        = string
}

variable "api_image" {
  description = "API image, set by the deploy workflow; it also runs the migrate and seed jobs."
  type        = string
}

variable "worker_image" {
  description = "Worker image, set by the deploy workflow."
  type        = string
}

variable "app_min_instances" {
  description = "0 scales to zero when idle (a few seconds' cold start); 1 keeps one warm instance (about £12 a month more)."
  type        = number
  default     = 0
}

variable "app_max_instances" {
  description = "Upper bound on app instances; keeps cost and database connections bounded."
  type        = number
  default     = 2
}

variable "sql_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-g1-small"
}

variable "public_access" {
  description = "Let anyone reach the sign-in page (the app's own sign-in, MFA and rate limits still apply). false requires Cloud Run IAM to call the app."
  type        = bool
  default     = true
}

variable "deletion_protection" {
  description = "Protects the database from `tofu destroy`. Only turn off with the owner's approval (CLAUDE.md)."
  type        = bool
  default     = true
}

variable "product_domain" {
  description = "THAPSUS_HR_DOMAIN. No product domain is chosen yet, so staging uses a reserved .example name."
  type        = string
  default     = "staging.thapsus-hr.example"
}

variable "workspace_slug" {
  description = "Workspace of the fictional test organisation created by the seed job."
  type        = string
  default     = "kestrel"
}

variable "test_login_generation" {
  description = "Bump to generate new test sign-in passwords (then deploy with the seed ticked so the users get them)."
  type        = number
  default     = 1
}

variable "security_alert_emails" {
  description = "Thapsus staff addresses that receive security alerts (critical and high at once, digests, the daily test and the dead-man's switch; ADR-0178). Configuration, never code: set it from a GitHub variable. Empty means alerts are recorded with no recipients and the back office says so."
  type        = list(string)
  default     = []
  # staff addresses: plans in the (public) workflow logs never show them
  sensitive = true
  validation {
    condition     = length(var.security_alert_emails) <= 20 && alltrue([for e in var.security_alert_emails : can(regex("^[^\\s@,<>]+@[^\\s@,<>]+\\.[A-Za-z]{2,24}$", e))])
    error_message = "security_alert_emails must be at most 20 email addresses."
  }
}
# The first Thapsus staff member (the product owner) invited to this cell's back office by the
# staff-invite job (ADR-0174), from the GitHub repository variables GCP_STAFF_OWNER_EMAIL and
# GCP_STAFF_OWNER_NAME. Empty: nobody is invited. Sensitive, so plans in the (public) workflow logs
# never show them; never commit a real address here.
variable "staff_owner_email" {
  description = "Work email of the first staff member to invite to the back office (empty: none)."
  type        = string
  default     = ""
  sensitive   = true
  validation {
    condition     = var.staff_owner_email == "" || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.staff_owner_email))
    error_message = "staff_owner_email must be an email address or empty."
  }
}

variable "staff_owner_name" {
  description = "Display name of that staff member."
  type        = string
  default     = ""
  sensitive   = true
}
