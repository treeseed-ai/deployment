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

provider "cloudflare" {}

provider "railway" {
  strict_env_scoping = true
}
