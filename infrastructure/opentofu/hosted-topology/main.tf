resource "cloudflare_workers_script" "managed" {
  provider           = cloudflare.runtime
  for_each           = var.cloudflare_workers
  account_id         = each.value.account_id
  script_name        = each.value.script_name
  content_file       = each.value.content_file
  content_sha256     = each.value.content_sha256
  compatibility_date = each.value.compatibility_date

  annotations = {
    workers_message = "TreeSeed ${each.value.desired_digest}"
  }

  lifecycle { prevent_destroy = true }
}

resource "cloudflare_dns_record" "managed" {
  provider = cloudflare.dns
  for_each = var.cloudflare_dns_records
  zone_id  = each.value.zone_id
  name     = each.value.name
  type     = each.value.type
  content  = each.value.content
  ttl      = each.value.ttl
  proxied  = each.value.proxied
  comment  = "treeseed:${each.value.desired_digest}"

  lifecycle { prevent_destroy = true }
}

resource "cloudflare_zone_setting" "managed" {
  provider   = cloudflare.dns
  for_each   = var.cloudflare_tls_policies
  zone_id    = each.value.zone_id
  setting_id = "ssl"
  value      = each.value.mode

  lifecycle { prevent_destroy = true }
}

resource "railway_service" "managed" {
  for_each       = var.railway_services
  project_id     = each.value.project_id
  environment_id = each.value.environment_id
  name           = each.value.name
  volume = each.value.volume_name == null || each.value.volume_mount_path == null ? null : {
    name       = each.value.volume_name
    mount_path = each.value.volume_mount_path
  }

  lifecycle { prevent_destroy = true }
}

resource "railway_service_instance" "managed" {
  for_each         = var.railway_services
  service_id       = railway_service.managed[each.key].id
  environment_id   = each.value.environment_id
  source_image     = each.value.source_image
  healthcheck_path = each.value.healthcheck_path
  start_command    = each.value.start_command
  num_replicas     = each.value.num_replicas
  vcpus             = each.value.vcpus
  memory_gb         = each.value.memory_gb

  lifecycle { prevent_destroy = true }
}

locals {
  railway_variables = merge([for service_key, service in var.railway_services : {
    for name, value in service.variables : "${service_key}:${name}" => {
      service_key   = service_key
      environment_id = service.environment_id
      name          = name
      value         = value
    }
  }]...)
}

resource "railway_variable" "managed" {
  for_each       = local.railway_variables
  service_id     = railway_service.managed[each.value.service_key].id
  environment_id = each.value.environment_id
  name           = each.value.name
  value          = each.value.value

  lifecycle { prevent_destroy = true }
}
