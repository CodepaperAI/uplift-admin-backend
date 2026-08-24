output "admin_api_elastic_ip" {
  description = "Create an A record for admin-api.upliftai.co pointing here."
  value       = aws_eip.admin_api.public_ip
}

output "admin_api_instance_id" {
  value = aws_instance.admin_api.id
}

output "admin_api_ecr_repository_url" {
  value = aws_ecr_repository.admin_api.repository_url
}

output "admin_api_runtime_secret_arn" {
  value = aws_secretsmanager_secret.runtime.arn
}

output "github_deploy_role_arn" {
  value = aws_iam_role.github_deploy.arn
}

output "dns_record" {
  value = {
    type  = "A"
    name  = "admin-api"
    value = aws_eip.admin_api.public_ip
    ttl   = 300
  }
}
