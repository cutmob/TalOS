variable "aws_region" {
  description = "AWS region for OPERON infrastructure"
  type        = string
  default     = "us-east-1"
}

variable "prefix" {
  description = "Resource name prefix"
  type        = string
  default     = "operon"
}

variable "tags" {
  description = "Common tags for all resources"
  type        = map(string)
  default = {
    Project     = "OPERON"
    Environment = "dev"
    ManagedBy   = "terraform"
  }
}
