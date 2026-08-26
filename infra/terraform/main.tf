data "aws_caller_identity" "current" {}

data "aws_ssm_parameter" "amazon_linux_2023_x86_64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_ecr_registry_scanning_configuration" "production" {
  scan_type = "ENHANCED"

  rule {
    scan_frequency = "CONTINUOUS_SCAN"

    repository_filter {
      filter      = "uplift-production-*"
      filter_type = "WILDCARD"
    }
  }
}

resource "aws_ecr_repository" "admin_api" {
  name                 = "uplift-production-admin-api"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "admin_api" {
  repository = aws_ecr_repository.admin_api.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Retain the newest 30 immutable admin API images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 30
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_secretsmanager_secret" "runtime" {
  name                    = "uplift-ai/production/admin-api-runtime"
  description             = "Least-privilege runtime environment for the standalone admin API. Populated outside Terraform to keep values out of state."
  recovery_window_in_days = 30
}

resource "aws_cloudwatch_log_group" "admin_api" {
  name              = "/uplift/production/admin-api"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "caddy" {
  name              = "/uplift/production/admin-api-caddy"
  retention_in_days = 14
}

resource "aws_security_group" "admin_api" {
  name        = "uplift-production-admin-api"
  description = "Standalone admin API HTTPS ingress; no public SSH"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTP for ACME issuance and HTTPS redirect"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "Admin API HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "AWS services, existing private data plane, and provider APIs"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_vpc_security_group_ingress_rule" "database_from_admin_api" {
  security_group_id            = var.database_security_group_id
  referenced_security_group_id = aws_security_group.admin_api.id
  description                  = "PostgreSQL from standalone admin API only"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_ingress_rule" "cache_from_admin_api" {
  security_group_id            = var.cache_security_group_id
  referenced_security_group_id = aws_security_group.admin_api.id
  description                  = "TLS Valkey from standalone admin API only"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

resource "aws_iam_role" "instance" {
  name = "uplift-production-admin-api"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "instance_ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "instance" {
  name = "uplift-production-admin-api-runtime"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer"
        ]
        Resource = aws_ecr_repository.admin_api.arn
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.runtime.arn
      },
      {
        Effect = "Allow"
        Action = ["logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"]
        Resource = [
          "${aws_cloudwatch_log_group.admin_api.arn}:*",
          "${aws_cloudwatch_log_group.caddy.arn}:*"
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = "*"
        Condition = {
          StringEquals = { "cloudwatch:namespace" = "Uplift/Production/AdminApi" }
        }
      }
    ]
  })
}

resource "aws_iam_instance_profile" "instance" {
  name = "uplift-production-admin-api"
  role = aws_iam_role.instance.name
}

resource "aws_instance" "admin_api" {
  ami                         = data.aws_ssm_parameter.amazon_linux_2023_x86_64.value
  instance_type               = var.instance_type
  subnet_id                   = var.subnet_id
  associate_public_ip_address = true
  vpc_security_group_ids      = [aws_security_group.admin_api.id]
  iam_instance_profile        = aws_iam_instance_profile.instance.name

  user_data = templatefile("${path.module}/templates/user-data.sh.tftpl", {
    aws_region         = var.aws_region
    admin_api_domain   = var.admin_api_domain
    ecr_repository_url = aws_ecr_repository.admin_api.repository_url
    runtime_secret_arn = aws_secretsmanager_secret.runtime.arn
    admin_log_group    = aws_cloudwatch_log_group.admin_api.name
    caddy_log_group    = aws_cloudwatch_log_group.caddy.name
  })
  user_data_replace_on_change = false

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gib
    encrypted             = true
    delete_on_termination = true
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  disable_api_termination = true
  monitoring              = true

  lifecycle {
    ignore_changes = [ami]
  }

  tags = {
    Name = "uplift-production-admin-api"
  }

  depends_on = [aws_iam_role_policy.instance]
}

resource "aws_eip" "admin_api" {
  domain   = "vpc"
  instance = aws_instance.admin_api.id
  tags = {
    Name = "uplift-production-admin-api"
  }
}

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

resource "aws_iam_role" "github_deploy" {
  name = "uplift-production-admin-api-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = var.github_oidc_subject
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_deploy" {
  name = "uplift-production-admin-api-deploy"
  role = aws_iam_role.github_deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart"
        ]
        Resource = aws_ecr_repository.admin_api.arn
      },
      {
        Effect = "Allow"
        Action = ["ssm:SendCommand"]
        Resource = [
          "arn:aws:ssm:${var.aws_region}::document/AWS-RunShellScript",
          aws_instance.admin_api.arn
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetCommandInvocation", "ssm:ListCommands"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ec2:DescribeInstances", "ecr:DescribeImageScanFindings"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "inspector2:BatchGetFindingDetails",
          "inspector2:ListAccountPermissions",
          "inspector2:ListCoverage",
          "inspector2:ListFindings"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_cloudwatch_log_metric_filter" "http_5xx" {
  name           = "uplift-production-admin-api-http-5xx"
  log_group_name = aws_cloudwatch_log_group.caddy.name
  pattern        = "{ $.status >= 500 }"

  metric_transformation {
    name          = "Http5xx"
    namespace     = "Uplift/Production/AdminApi"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "instance_status" {
  alarm_name          = "uplift-production-admin-api-instance-status"
  alarm_description   = "Standalone admin API EC2 status checks are failing."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  dimensions          = { InstanceId = aws_instance.admin_api.id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [var.monitoring_sns_topic_arn]
  ok_actions          = [var.monitoring_sns_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "high_cpu" {
  alarm_name          = "uplift-production-admin-api-high-cpu"
  alarm_description   = "Standalone admin API CPU is above 85% for 15 minutes."
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  dimensions          = { InstanceId = aws_instance.admin_api.id }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 85
  treat_missing_data  = "missing"
  alarm_actions       = [var.monitoring_sns_topic_arn]
  ok_actions          = [var.monitoring_sns_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "http_5xx" {
  alarm_name          = "uplift-production-admin-api-http-5xx"
  alarm_description   = "Standalone admin API returned repeated 5xx responses."
  namespace           = "Uplift/Production/AdminApi"
  metric_name         = "Http5xx"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 5
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.monitoring_sns_topic_arn]
  ok_actions          = [var.monitoring_sns_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "high_memory" {
  alarm_name          = "uplift-production-admin-api-high-memory"
  alarm_description   = "Standalone admin API memory is above 85% for 15 minutes."
  namespace           = "Uplift/Production/AdminApi"
  metric_name         = "MemoryUsedPercent"
  dimensions          = { InstanceId = aws_instance.admin_api.id }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 85
  treat_missing_data  = "breaching"
  alarm_actions       = [var.monitoring_sns_topic_arn]
  ok_actions          = [var.monitoring_sns_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "high_disk" {
  alarm_name          = "uplift-production-admin-api-high-disk"
  alarm_description   = "Standalone admin API root disk usage is above 85% for 15 minutes."
  namespace           = "Uplift/Production/AdminApi"
  metric_name         = "DiskUsedPercent"
  dimensions          = { InstanceId = aws_instance.admin_api.id }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 85
  treat_missing_data  = "breaching"
  alarm_actions       = [var.monitoring_sns_topic_arn]
  ok_actions          = [var.monitoring_sns_topic_arn]
}
