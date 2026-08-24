#!/usr/bin/env bash
set -euo pipefail

aws_profile="${AWS_PROFILE:-uplift-dev}"
aws_region="${AWS_REGION:-us-east-1}"
account_id="574521704327"
repository="uplift-production-admin-api"
instance_name="uplift-production-admin-api"
image_tag="${1:-$(git rev-parse HEAD)}"

if [[ ! "${image_tag}" =~ ^[A-Za-z0-9._-]{7,128}$ ]]; then
  echo "Invalid immutable image tag" >&2
  exit 1
fi

registry="${account_id}.dkr.ecr.${aws_region}.amazonaws.com"
image="${registry}/${repository}:${image_tag}"
aws ecr get-login-password --profile "${aws_profile}" --region "${aws_region}" \
  | docker login --username AWS --password-stdin "${registry}"
docker buildx build --platform linux/amd64 --provenance=true --sbom=true \
  --tag "${image}" --push .

instance_id="$(aws ec2 describe-instances \
  --profile "${aws_profile}" --region "${aws_region}" \
  --filters "Name=tag:Name,Values=${instance_name}" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)"
if [[ ! "${instance_id}" =~ ^i-[a-f0-9]+$ ]]; then
  echo "Running admin API instance not found" >&2
  exit 1
fi

command_id="$(aws ssm send-command \
  --profile "${aws_profile}" --region "${aws_region}" \
  --instance-ids "${instance_id}" \
  --document-name AWS-RunShellScript \
  --parameters "commands=sudo /opt/uplift-admin-api/deploy.sh ${image_tag}" \
  --comment "Deploy standalone admin API ${image_tag}" \
  --query 'Command.CommandId' --output text)"
aws ssm wait command-executed \
  --profile "${aws_profile}" --region "${aws_region}" \
  --command-id "${command_id}" --instance-id "${instance_id}"
aws ssm get-command-invocation \
  --profile "${aws_profile}" --region "${aws_region}" \
  --command-id "${command_id}" --instance-id "${instance_id}" \
  --query '{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}'
