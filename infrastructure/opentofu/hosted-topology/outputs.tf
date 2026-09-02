output "cloudflare_workers" {
  value = { for key, resource in cloudflare_workers_script.managed : key => resource.id }
}

output "cloudflare_dns_records" {
  value = { for key, resource in cloudflare_dns_record.managed : key => resource.id }
}

output "cloudflare_tls_policies" {
  value = { for key, resource in cloudflare_zone_setting.managed : key => resource.id }
}

output "railway_services" {
  value = { for key, resource in railway_service.managed : key => resource.id }
}
