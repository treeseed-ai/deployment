variable "cloudflare_pages" {
  type = map(object({
    account_id        = string
    name              = string
    production_branch = string
    destination_dir   = string
    artifact_sha256   = string
    desired_digest    = string
  }))
  default = {}
}

variable "cloudflare_workers" {
  type = map(object({
    account_id         = string
    script_name        = string
    content_file       = string
    content_sha256     = string
    compatibility_date = string
    desired_digest     = string
  }))
  default = {}
}

variable "cloudflare_dns_records" {
  type = map(object({
    zone_id       = string
    name          = string
    type          = string
    content       = string
    ttl           = number
    proxied       = bool
    desired_digest = string
  }))
  default = {}
}

variable "cloudflare_tls_policies" {
  type = map(object({
    zone_id       = string
    mode          = string
    desired_digest = string
  }))
  default = {}
}

variable "railway_services" {
  type = map(object({
    project_id       = string
    environment_id   = string
    environment_name = string
    name             = string
    source_image     = string
    healthcheck_path = optional(string)
    start_command    = optional(string)
    num_replicas     = number
    vcpus             = number
    memory_gb         = number
    volume_name       = optional(string)
    volume_mount_path = optional(string)
    variables         = map(string)
    desired_digest    = string
  }))
  default = {}
}
