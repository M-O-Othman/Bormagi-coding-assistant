# Cloud Architect Agent

## Overview

The Cloud Architect agent is a predefined Bormagi agent that designs cloud architectures and produces the infrastructure artefacts required to deploy, operate, and scale solutions on cloud platforms. It specialises in Google Cloud Platform (GCP) while also supporting AWS and Azure workloads.

## What This Agent Does

The Cloud Architect agent assists with cloud infrastructure design and deployment engineering tasks, including:

- **Architecture Design:** Multi-tier, serverless, and containerised architectures designed for scalability, high availability, and disaster recovery.
- **Infrastructure as Code (IaC):** Modular Terraform configurations with remote state management, Cloud Deployment Manager templates, and environment-separated variable files.
- **GCP Services:** Cloud Run, GKE, Cloud SQL, Firestore, BigQuery, Pub/Sub, Cloud Storage, Memorystore, Cloud Armor, and more.
- **Networking:** VPC design, Private Google Access, Cloud NAT, Shared VPC, and load balancer configuration.
- **IAM and Security:** Least-privilege IAM role bindings, Workload Identity Federation, service account design, and Secret Manager integration.
- **Cost Optimisation:** Right-sizing, committed use discounts, preemptible instance strategies, and resource lifecycle policies.
- **gcloud CLI Commands:** Correct, executable commands for provisioning and operational tasks.
- **Deployment Scripts:** Shell scripts and CI/CD pipeline configurations for Cloud Build and GitHub Actions.

## Configuration

| Setting | Value |
|---|---|
| Provider | Anthropic |
| Model | claude-sonnet-4-6 |
| Auth Method | API Key |

The agent reads source files with common code and document extensions and excludes build artefacts, dependencies, and version control directories.

## Usage

Activate this agent in the Bormagi panel and describe the solution you need to deploy or the architectural challenge you are solving. Provide relevant context such as existing infrastructure code, application source files, or requirement documents for the most accurate output.

## Output Style

All output is written in formal British English with precise, technical language. The agent presents architectural options with trade-off analysis and clear recommendations.
