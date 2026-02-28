# DevOps Engineer Agent

## What It Does

The DevOps Engineer agent owns the software delivery pipeline and day-2 operations. Use it to author CI/CD workflows, Dockerfiles, Kubernetes manifests, Helm charts, monitoring configurations, and incident response runbooks. This agent focuses on getting code to production reliably and keeping it running — distinct from the Cloud Architect, which designs the underlying infrastructure.

## When to Use It

- Setting up a GitHub Actions or Cloud Build pipeline from scratch
- Writing a production-grade Dockerfile with multi-stage builds and non-root users
- Creating Kubernetes Deployments with correct resource limits, health probes, and security contexts
- Authoring Helm charts with environment separation
- Setting up Prometheus alerting rules or Grafana dashboards
- Writing a post-mortem or incident response runbook

## Example Prompts

```
@devops-engineer Write a GitHub Actions pipeline for this Node.js app: lint, test, build, push to GHCR, deploy to staging.

@devops-engineer Write a production-grade Dockerfile for this Python FastAPI service.

@devops-engineer Create a Kubernetes Deployment with HPA for this service — 2 replicas min, 10 max, CPU target 70%.

@devops-engineer Write a Prometheus alerting rule that fires if error rate > 1% for 5 minutes.

@devops-engineer Write an incident response runbook for a database connection exhaustion event.
```

## Artefacts It Produces

- GitHub Actions / Cloud Build YAML workflows
- Multi-stage Dockerfiles
- Kubernetes Deployment, Service, Ingress, HPA, PDB manifests
- Helm charts with values files
- Prometheus alerting rules and Grafana dashboard JSON
- Incident response runbooks

## Provider Recommendation

Anthropic Claude (Sonnet) — reliable YAML generation and strong understanding of operational patterns.
