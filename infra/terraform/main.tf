terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket = "operon-terraform-state"
    key    = "state/terraform.tfstate"
    region = "us-east-1"
  }
}

provider "aws" {
  region = var.aws_region
}

# ---------- DynamoDB Tables ----------

resource "aws_dynamodb_table" "workflows" {
  name         = "${var.prefix}-workflows"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  attribute {
    name = "connector"
    type = "S"
  }

  global_secondary_index {
    name            = "connector-index"
    hash_key        = "connector"
    projection_type = "ALL"
  }

  tags = var.tags
}

resource "aws_dynamodb_table" "memory" {
  name         = "${var.prefix}-memory"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  attribute {
    name = "sessionId"
    type = "S"
  }

  global_secondary_index {
    name            = "session-index"
    hash_key        = "sessionId"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  tags = var.tags
}

resource "aws_dynamodb_table" "execution_events" {
  name         = "${var.prefix}-events"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  attribute {
    name = "sessionId"
    type = "S"
  }

  global_secondary_index {
    name            = "session-events-index"
    hash_key        = "sessionId"
    projection_type = "ALL"
  }

  tags = var.tags
}

# ---------- S3 Bucket (screenshots, logs) ----------

resource "aws_s3_bucket" "artifacts" {
  bucket = "${var.prefix}-artifacts"
  tags   = var.tags
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts_lifecycle" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "expire-screenshots"
    status = "Enabled"
    filter { prefix = "screenshots/" }
    expiration { days = 30 }
  }
}

# ---------- EventBridge (agent event bus) ----------

resource "aws_cloudwatch_event_bus" "operon" {
  name = "${var.prefix}-events"
  tags = var.tags
}

# ---------- ECS Cluster (for orchestrator + runners) ----------

resource "aws_ecs_cluster" "operon" {
  name = "${var.prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = var.tags
}

# ---------- Outputs ----------

output "workflows_table" {
  value = aws_dynamodb_table.workflows.name
}

output "memory_table" {
  value = aws_dynamodb_table.memory.name
}

output "events_table" {
  value = aws_dynamodb_table.execution_events.name
}

output "artifacts_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "event_bus" {
  value = aws_cloudwatch_event_bus.operon.name
}

output "ecs_cluster" {
  value = aws_ecs_cluster.operon.name
}
