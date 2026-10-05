terraform {
  required_version = "= 1.12.6"

  required_providers {
    cloudflare = {
      source  = "registry.opentofu.org/cloudflare/cloudflare"
      version = "= 5.24.0"
    }
    railway = {
      source  = "registry.opentofu.org/jamesprnich/railway"
      version = "= 0.11.5"
    }
  }
}

variable "cloudflare_runtime_token" {
  type      = string
  sensitive = true
}

variable "cloudflare_dns_token" {
  type      = string
  sensitive = true
}

provider "cloudflare" {
  alias     = "runtime"
  api_token = var.cloudflare_runtime_token
}

provider "cloudflare" {
  alias     = "dns"
  api_token = var.cloudflare_dns_token
}

provider "railway" {
  strict_env_scoping = true
}
