variable "aws_profile" {
  description = "Locally configured AWS profile used for provisioning."
  type        = string
  default     = "uplift-dev"
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "admin_api_domain" {
  type    = string
  default = "admin-api.upliftai.co"
}

variable "vpc_id" {
  description = "Existing production VPC."
  type        = string
  default     = "vpc-055087a4836ea7be1"
}

variable "subnet_id" {
  description = "Existing public production compute subnet."
  type        = string
  default     = "subnet-03c9f661c719d8a8d"
}

variable "database_security_group_id" {
  description = "Existing private RDS security group that receives one scoped PostgreSQL source rule."
  type        = string
  default     = "sg-0843da4832d30ccd2"
}

variable "cache_security_group_id" {
  description = "Existing private Valkey security group that receives one scoped TLS cache source rule."
  type        = string
  default     = "sg-0b30bf47ba49c76c3"
}

variable "instance_type" {
  type    = string
  default = "t3a.medium"
}

variable "root_volume_gib" {
  type    = number
  default = 30
}

variable "github_repository" {
  description = "Exact owner/repository allowed to assume the deployment role."
  type        = string
  default     = "CodepaperAI/uplift-admin-backend"
}

variable "github_environment" {
  type    = string
  default = "production"
}

variable "monitoring_sns_topic_arn" {
  description = "Existing production monitoring topic."
  type        = string
  default     = "arn:aws:sns:us-east-1:574521704327:uplift-production-monitoring"
}
