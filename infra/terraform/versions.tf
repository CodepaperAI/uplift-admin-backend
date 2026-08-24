terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.80, < 7.0"
    }
  }

  backend "s3" {}
}

provider "aws" {
  profile = var.aws_profile
  region  = var.aws_region

  default_tags {
    tags = {
      Application = "uplift-ai"
      Environment = "production"
      Service     = "admin-api"
      ManagedBy   = "terraform"
    }
  }
}
