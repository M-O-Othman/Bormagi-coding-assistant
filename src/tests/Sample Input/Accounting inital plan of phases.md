# Detailed Multiphase Implementation Plan: SMB Accounting System

> A comprehensive, four-phase implementation roadmap for the Bormagi cloud-native accounting platform.

This document outlines the detailed delivery plan for the accounting system, structuring the build from foundational technical components and core ledger logic through to advanced enterprise and AI features. It adheres to the architectural principle that double-entry bookkeeping is the source of truth, ensuring the system is robust before layering on operational complexity.

---

## Phase 1: Foundation, Core Accounting, and Technical Components

Phase 1 establishes the architectural bedrock, deployment pipelines, multi-tenant isolation, and the immutable general ledger. This phase must be completed and thoroughly tested before any subledger modules are introduced.

### 1.1 Technical Infrastructure & CI/CD
- **Environment Setup:** Provision local, dev, test, UAT, and production environments.
- **Infrastructure as Code (IaC):** Use Terraform/Pulumi to provision PostgreSQL 15+, Redis, BullMQ (for background jobs), and S3-compatible object storage.
- **CI/CD Pipeline:** Implement GitHub Actions/GitLab CI for linting, type-checking, automated testing, and container builds.
- **Base Framework:** Initialise a NestJS/TypeScript (or Fastify) backend using a modular monolith structure. Implement Prisma or TypeORM for database access.
- **Observability:** Set up structured JSON logging, Prometheus/Grafana for metrics, and OpenTelemetry for end-to-end tracing.

### 1.2 Identity, Security, and Multi-Tenancy
- **Authentication:** Implement OIDC/OAuth2 for SSO and local authentication with JWT access tokens and refresh tokens.
- **Multi-Tenant Schema:** Implement tenant isolation at the database level. Add `tenant_id` to all tenant-owned tables and enforce row-level security (RLS) or repository-level tenant scoping.
- **Role-Based Access Control (RBAC):** Build the `users`, `roles`, and `permissions` tables. Implement basic roles (Admin, Owner, Accountant).
- **Audit Logging:** Implement the `audit_events` table to capture immutable records of all create, update, and delete operations with before/after JSON payloads.

### 1.3 Core Domain: Tenant and Company Setup
- **Company Management:** Create `tenants`, `companies`, and `company_settings` tables.
- **Fiscal Context:** Implement `fiscal_periods` logic (year, period number, open/close status).
- **Multi-Currency Foundation:** Establish company base currency and exchange rate handling.

### 1.4 The Accounting Core & General Ledger
- **Chart of Accounts (COA):** Implement the `accounts` table. Support standard account types (Assets, Liabilities, Equity, Revenue, Expense) and protect system-required control accounts.
- **General Ledger Tables:** Create immutable posting tables: `journals`, `journal_entries`, and `journal_lines`.
- **Posting Engine:** Implement the core `PostingService` and `PostingMapper` interfaces. The engine must enforce double-entry rules (debits equal credits), validate open periods, and implement an outbox pattern (`outbox_events`) for downstream async projections.
- **Manual Journals:** Build the UI and API for creating, validating, and posting manual journal entries.

---

## Phase 2: Essential Financial Operations

Phase 2 introduces the primary subledgers required for standard business operations: Accounts Receivable, Accounts Payable, Banking, Basic Tax, and Core Reporting.

### 2.1 Accounts Receivable (AR) & Sales
- **Customer Master Data:** Build the `customers` table with billing/shipping addresses and payment terms.
- **Invoicing:** Implement draft-to-posted workflows for `ar_invoices` and `ar_invoice_lines`. Connect invoices to the Posting Engine to automatically debit AR and credit Revenue/Tax.
- **Receipts & Allocations:** Implement `customer_receipts` and `customer_allocations` to apply payments against open invoices.
- **AR Reporting:** Develop AR Aging reports.

### 2.2 Accounts Payable (AP) & Purchasing
- **Vendor Master Data:** Build the `vendors` table with payment terms and default tax codes.
- **Bills:** Implement `ap_bills` and `ap_bill_lines`. Connect bills to the Posting Engine to debit Expense/Asset and credit AP.
- **Payments:** Implement `vendor_payments` and manual payment runs.

### 2.3 Banking and Basic Reconciliation
- **Bank Account Setup:** Implement the `bank_accounts` table linked to GL control accounts.
- **Statement Import:** Build parsing pipelines for manual imports of CSV, OFX, MT940, and CAMT formats.
- **Reconciliation Workspace (MVP):** Build the `reconciliation_sessions` and `reconciliation_lines` tables. Implement a UI to manually match bank statement lines against posted receipts and payments.

### 2.4 Basic Tax Management
- **Tax Engine:** Implement `tax_codes` and `tax_rates` with effective dating.
- **Transactional Tax:** Automatically calculate line-item tax and header totals on invoices and bills. Route output and input tax to the correct GL accounts during posting.

### 2.5 Core Financial Reporting
- **Report Engine:** Implement materialized views or read models for high-performance querying.
- **Primary Reports:** Deliver the Profit and Loss (P&L), Balance Sheet, Trial Balance, and General Ledger Detail reports.

---

## Phase 3: Operational Expansion & Advanced Workflows

Phase 3 layers on operational modules that add value for medium-sized businesses, including inventory management, asset depreciation, and structured workflows.

### 3.1 Inventory Management
- **Items & Warehouses:** Implement `items`, `warehouses`, and `inventory_balances` tables.
- **Movements:** Support goods receipt, sales issue, and stock adjustments via the `inventory_movements` table.
- **Costing:** Implement weighted average cost valuation and ensure inventory movements trigger the Posting Engine (e.g., Debit COGS, Credit Inventory on sale).

### 3.2 Fixed Assets
- **Asset Register:** Implement the `assets` table to track acquisition cost, useful life, and salvage value.
- **Depreciation Engine:** Build async jobs (`asset_depreciation_runs`) to calculate straight-line depreciation at month-end and automatically post journal entries (Debit Depreciation Expense, Credit Accumulated Depreciation).

### 3.3 Expense Management & Approvals
- **Employee Expenses:** Build the UI/API for capturing expense claims, attaching receipts (via S3), and mileage claims.
- **Workflow Engine:** Implement `approval_policies` and `approval_instances` for rules-based approvals (e.g., bills over a certain threshold require Finance Manager approval before posting).

### 3.4 Projects & Job Costing
- **Analytical Dimensions:** Implement a `dimension_set_id` on journal lines to support tagging revenue and expenses to specific projects, departments, or cost centres.
- **Project Reporting:** Develop P&L reports filtered by project dimensions.

### 3.5 Period Close Controls & Budgeting
- **Period Close:** Implement a soft-close/hard-close checklist dashboard and lock dates by module (e.g., lock AP but leave manual journals open).
- **Budgeting:** Implement `budgets` and `budget_lines` tables for annual budgeting with monthly phasing, alongside Budget vs Actual reporting.

---

## Phase 4: Advanced Integrations, Automation, and Enterprise Features

Phase 4 targets the least priority features, focusing on ecosystem connectivity, AI-driven automation, and complex enterprise requirements that are not strictly necessary for the MVP.

### 4.1 Ecosystem Integrations
- **Open Banking Direct Feeds:** Integrate with third-party aggregators for automated daily bank transaction fetching.
- **Payment Gateways:** Integrate with Stripe, PayPal, or Adyen for inbound customer payments and outbound vendor payment file generation.
- **Payroll & E-Commerce:** Provide connectors for major payroll systems and e-commerce platforms to automatically generate summary journal entries.
- **Webhooks:** Implement outbound webhooks with HMAC signatures, exponential backoff, and dead-letter queues for external API consumers.

### 4.2 Automation & AI Features
- **OCR Capture:** Implement an asynchronous pipeline to extract vendor, date, and amount from uploaded bill and receipt PDFs/images.
- **Banking Auto-Categorisation:** Build a rules engine (`bank_rules`) to automatically suggest ledger matches for imported bank transactions based on historical patterns or text matching.
- **Recurring Transactions:** Implement background jobs to automatically generate recurring draft invoices and bills.
- **AI Assistant:** Introduce AI-assisted anomaly detection for unusual account coding and natural-language querying for reports (with strict guardrails preventing auto-posting).

### 4.3 Enterprise & Localisation Extensions
- **Multi-Entity & Consolidation:** Introduce multi-company tenant management, intercompany transaction flows, and consolidated reporting.
- **Advanced Tax Plugins:** Implement complex jurisdictional tax requirements, including US Sales Tax APIs (e.g., Avalara/TaxJar), UK Making Tax Digital (MTD) submissions, and e-invoicing compliance.
- **Advanced Inventory:** Introduce FIFO costing, lot tracking, and serial number management.
