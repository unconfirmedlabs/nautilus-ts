#!/usr/bin/env bash
# CI smoke test: launch a spot EC2 instance with Nitro Enclave support,
# deploy the EIF, run the smoke test, and terminate the instance.
#
# Required environment variables:
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION
#   EC2_SSH_PRIVATE_KEY  — SSH private key for the EC2 key pair
#   EC2_KEY_NAME         — Name of the EC2 key pair
#   EC2_SECURITY_GROUP   — Security group ID (must allow SSH from CI runner)
#   EC2_SUBNET           — Subnet ID (must support public IP assignment)
#
# Optional:
#   EC2_INSTANCE_TYPE    — Instance type (default: c5.xlarge)
#
# Expects out/nitro.eif and out/traffic-proxy to exist.
set -euo pipefail

INSTANCE_TYPE="${EC2_INSTANCE_TYPE:-c5.xlarge}"
INSTANCE_ID=""
SSH_KEY_FILE=""

for var in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION \
           EC2_SSH_PRIVATE_KEY EC2_KEY_NAME EC2_SECURITY_GROUP EC2_SUBNET; do
  if [[ -z "${!var:-}" ]]; then
    echo "[ci] ERROR: $var is not set"
    exit 1
  fi
done

for file in out/nitro.eif out/traffic-proxy; do
  [[ -f "$file" ]] || { echo "[ci] ERROR: $file not found"; exit 1; }
done

cleanup() {
  if [[ -n "$INSTANCE_ID" ]]; then
    echo "[ci] terminating instance $INSTANCE_ID"
    aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" 2>/dev/null || true
  fi
  [[ -n "$SSH_KEY_FILE" ]] && rm -f "$SSH_KEY_FILE" 2>/dev/null || true
}
trap cleanup EXIT

# Write SSH key to temp file
SSH_KEY_FILE=$(mktemp)
echo "$EC2_SSH_PRIVATE_KEY" > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
SSH="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -i $SSH_KEY_FILE"
SCP="scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i $SSH_KEY_FILE"

# Resolve latest Amazon Linux 2023 AMI
AMI_ID=$(aws ssm get-parameters \
  --names /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64 \
  --query 'Parameters[0].Value' --output text)
echo "[ci] AMI: $AMI_ID"

# User-data: install nitro-cli, configure allocator, signal readiness
USER_DATA_FILE=$(mktemp)
cat > "$USER_DATA_FILE" <<'USERDATA'
#!/bin/bash
set -eux
dnf install -y aws-nitro-enclaves-cli jq curl
usermod -aG ne ec2-user
sed -i 's/^memory_mib:.*/memory_mib: 4096/' /etc/nitro_enclaves/allocator.yaml
sed -i 's/^cpu_count:.*/cpu_count: 2/' /etc/nitro_enclaves/allocator.yaml
systemctl enable --now nitro-enclaves-allocator
touch /tmp/enclave-ready
USERDATA

# Launch spot instance
echo "[ci] launching $INSTANCE_TYPE spot instance"
INSTANCE_ID=$(aws ec2 run-instances \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$EC2_KEY_NAME" \
  --security-group-ids "$EC2_SECURITY_GROUP" \
  --subnet-id "$EC2_SUBNET" \
  --associate-public-ip-address \
  --enclave-options 'Enabled=true' \
  --instance-market-options 'MarketType=spot,SpotOptions={SpotInstanceType=one-time}' \
  --user-data "file://$USER_DATA_FILE" \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=nautilus-ci-smoke}]' \
  --query 'Instances[0].InstanceId' --output text)
rm -f "$USER_DATA_FILE"
echo "[ci] instance: $INSTANCE_ID"

# Wait for running
echo "[ci] waiting for instance to start..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "[ci] public IP: $PUBLIC_IP"

# Wait for SSH
echo "[ci] waiting for SSH..."
for i in $(seq 1 30); do
  if $SSH "ec2-user@$PUBLIC_IP" "echo ready" 2>/dev/null; then
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo "[ci] ERROR: SSH timeout"
    exit 1
  fi
  sleep 10
done

# Wait for user-data setup to complete
echo "[ci] waiting for nitro-cli setup..."
for i in $(seq 1 30); do
  if $SSH "ec2-user@$PUBLIC_IP" "test -f /tmp/enclave-ready" 2>/dev/null; then
    echo "[ci] nitro-cli setup complete"
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo "[ci] ERROR: nitro-cli setup timeout"
    # Print cloud-init log for debugging
    $SSH "ec2-user@$PUBLIC_IP" "sudo cat /var/log/cloud-init-output.log" 2>/dev/null || true
    exit 1
  fi
  sleep 10
done

# Copy files to instance
echo "[ci] copying EIF and traffic-proxy to instance"
$SCP out/nitro.eif out/traffic-proxy scripts/enclave-smoke-test.sh "ec2-user@$PUBLIC_IP":~/

# Run smoke test
echo "[ci] running smoke test"
$SSH "ec2-user@$PUBLIC_IP" "chmod +x ~/traffic-proxy && sudo bash ~/enclave-smoke-test.sh ~/nitro.eif ~/traffic-proxy"

echo "[ci] smoke test passed"
