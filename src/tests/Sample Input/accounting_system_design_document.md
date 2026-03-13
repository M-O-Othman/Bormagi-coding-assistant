# Accounting System Design Document

## 1. Document Control

- **Document Title:** Detailed Design Document — SMB Accounting System
- **Target Product Class:** Cloud-native accounting platform similar in scope to QuickBooks for small and medium businesses
- **Primary Audience:** Solution architects, backend engineers, frontend engineers, QA engineers, DevOps engineers, security engineers, product owners
- **Technology Assumption:** TypeScript, Node.js, PostgreSQL, Redis, React, event-driven services, REST/GraphQL APIs
- **Deployment Assumption:** Multi-tenant SaaS with optional single-tenant enterprise deployment

---

## 2. Executive Summary

This document defines a detailed design for a full-featured accounting system comparable to QuickBooks in breadth. It covers:

- Core accounting and bookkeeping functions
- Sales, purchasing, banking, tax, payroll-adjacent, reporting, inventory, projects, fixed assets, and audit capabilities
- Multi-tenant SaaS architecture
- Data model and service boundaries
- Functional modules and workflows
- API design principles
- Security, compliance, audit, and operational requirements
- Detailed implementation guidance for engineering teams

The system must support:

- General ledger and double-entry bookkeeping
- Accounts payable and receivable
- Banking feeds and reconciliation
- Invoicing and billing
- Expense capture and categorization
- Inventory and stock valuation
- VAT/GST/sales tax handling
- Financial reports and dashboards
- Period close and control framework
- Integrations with payment gateways, banks, tax services, and payroll providers

---

## 3. Product Goals

### 3.1 Business Goals

- Provide a reliable accounting platform for SMBs
- Reduce manual bookkeeping effort through automation
- Support auditability and financial correctness
- Enable integration with external business tools
- Offer extensibility for regional taxation and compliance requirements

### 3.2 Non-Goals for Phase 1

- Full enterprise ERP manufacturing planning
- Deep HR/payroll engine for all countries
- Highly specialized treasury and hedge accounting
- Consolidation for extremely large multinational groups beyond SMB/mid-market needs

---

## 4. Users and Roles

### 4.1 User Types

- Business owner
- Finance manager
- Accountant/bookkeeper
- Accounts receivable clerk
- Accounts payable clerk
- Payroll officer
- Inventory manager
- External auditor
- External accountant / accounting firm
- System administrator
- API integration user / service account

### 4.2 Role-Based Access Examples

| Role | Access Scope |
|---|---|
| Owner | Full company access, approvals, settings, reporting |
| Accountant | GL, journals, period close, reports, reconciliation |
| AR Clerk | customers, invoices, receipts, credit notes |
| AP Clerk | vendors, bills, payments, expense claims |
| Inventory Manager | items, stock movements, warehouses, valuation reports |
| Auditor | read-only access to ledgers, documents, audit logs |
| Admin | users, RBAC, integrations, security settings |

---

## 5. Functional Scope

### 5.1 Core Modules

1. Company and tenant setup
2. Chart of accounts
3. General ledger
4. Journals and posting engine
5. Customers and accounts receivable
6. Vendors and accounts payable
7. Banking and reconciliation
8. Tax management
9. Products, services, and inventory
10. Expense management
11. Fixed assets
12. Projects and job costing
13. Budgeting
14. Financial reporting
15. Period close and controls
16. Documents and attachments
17. Workflow and approvals
18. Notifications and tasks
19. Integrations and APIs
20. Audit trail and compliance

### 5.2 Optional/Advanced Modules

- Multi-entity management and consolidation
- Subscription billing
- Payroll integration
- E-commerce connectors
- OCR for invoices and receipts
- AI-assisted categorization and anomaly detection

---

## 6. Architectural Principles

### 6.1 Principles

- Double-entry bookkeeping is the source of truth
- Every financially relevant transaction must produce immutable posted ledger entries
- Operational documents can be edited until posting, but posted entries require reversal/correction flows
- Multi-tenant isolation is mandatory
- Idempotency is mandatory for posting and external callbacks
- Auditability must be first-class, not optional
- Soft deletion only for master data where legally acceptable; never delete posted accounting history
- All balances must be derived from ledger entries or trusted balance snapshots, not manually stored totals alone

### 6.2 Recommended Architecture Style

Hybrid modular monolith for MVP, with clear bounded contexts and event contracts so high-volume modules can later be extracted into services.

Recommended bounded contexts:

- Identity and access
- Tenant and company management
- Accounting core / ledger
- Sales / AR
- Purchasing / AP
- Banking
- Tax
- Inventory
- Reporting
- Documents
- Workflow
- Integration hub

### 6.3 Logical Architecture

```text
[Web App / Mobile App / Partner API Clients]
                |
        [API Gateway / BFF]
                |
 -------------------------------------------------------------
| Identity | Tenant | GL | AR | AP | Banking | Tax | Inventory |
| Reports  | Docs   | Workflow | Integrations | Notifications  |
 -------------------------------------------------------------
                |
      [PostgreSQL + Read Replicas + Redis + Object Store]
                |
     [Event Bus / Job Queue / Search Index / Data Warehouse]
```

---

## 7. Deployment Architecture

### 7.1 Deployment Model

- Frontend: React SPA hosted via CDN
- Backend API: Node.js TypeScript services in containers
- Database: PostgreSQL primary + read replica(s)
- Cache: Redis
- Async jobs: queue workers (BullMQ or similar)
- Object storage: S3-compatible bucket for attachments and exports
- Search: OpenSearch or PostgreSQL full text for smaller deployments
- Observability: Prometheus, Grafana, OpenTelemetry, centralized logs

### 7.2 Environment Strategy

- Local
- Dev
- Test
- UAT
- Production

### 7.3 Multi-Tenancy Strategy

Recommended: shared database, shared schema, tenant_id on all tenant-owned tables, enforced by:

- Row-level security where feasible
- Mandatory tenant-aware repository layer
- Tenant-scoped unique constraints
- Separate encryption context per tenant for sensitive data

Alternative for regulated large customers:

- single-tenant deployment with dedicated DB and encryption keys

---

## 8. Technology Stack Recommendation

### 8.1 Backend

- **Language:** TypeScript
- **Runtime:** Node.js LTS
- **Framework:** NestJS or Fastify with strong modular structure
- **ORM/DB access:** Prisma for productivity or TypeORM/Knex for advanced SQL control
- **Validation:** Zod / class-validator
- **Async jobs:** BullMQ
- **Messaging:** Kafka, RabbitMQ, or cloud pub/sub

### 8.2 Frontend

- **Framework:** React + TypeScript
- **State:** TanStack Query + Zustand/Redux Toolkit where necessary
- **UI:** Material UI / Ant Design / custom design system
- **Forms:** React Hook Form + Zod
- **Tables:** AG Grid / TanStack Table
- **Charts:** ECharts / Recharts

### 8.3 Data and Infra

- **DB:** PostgreSQL 15+
- **Cache:** Redis
- **Storage:** S3
- **Search:** OpenSearch or DB-native search
- **CI/CD:** GitHub Actions / GitLab CI / Azure DevOps
- **Containers:** Docker + Kubernetes or managed container platform

---

## 9. Core Domain Concepts

### 9.1 Financial Objects

- Company
- Fiscal year
- Fiscal period
- Currency
- Exchange rate
- Chart of account
- Ledger account
- Journal
- Journal entry
- Journal line
- Dimension (department, class, project, location)
- Tax code
- Customer
- Vendor
- Invoice
- Bill
- Credit note
- Payment
- Bank account
- Bank transaction
- Reconciliation session
- Item / SKU
- Inventory movement
- Asset
- Depreciation schedule

### 9.2 Transaction Lifecycle

Typical lifecycle:

1. Create draft transaction
2. Validate business rules
3. Approve if workflow requires
4. Post to ledger
5. Update subledger status and balances
6. Generate downstream events and reports
7. Allow reversal/correction through controlled mechanisms only

---

## 10. Data Model Overview

### 10.1 Key Design Rules

- Use UUIDs for primary keys
- Include `tenant_id` in all tenant-owned tables
- Include `created_at`, `updated_at`, `created_by`, `updated_by`
- Include `version` for optimistic locking on mutable operational records
- Use immutable posting tables for journal entries
- Use enum tables or controlled code tables instead of free text for critical classification values

### 10.2 Example Core Tables

#### Tenant / Company

```text
tenants(id, name, status, plan, created_at)
companies(id, tenant_id, legal_name, base_currency, country_code, fiscal_year_start_month, tax_registration_no, timezone)
company_settings(id, company_id, settings_json)
```

#### Users and Security

```text
users(id, email, name, status, last_login_at)
roles(id, tenant_id, name)
permissions(id, code, description)
user_roles(user_id, role_id, company_id)
role_permissions(role_id, permission_id)
service_accounts(id, tenant_id, name, api_key_hash, scopes)
```

#### Accounting Core

```text
accounts(id, tenant_id, company_id, code, name, type, subtype, currency_mode, is_control_account, is_active)
fiscal_periods(id, company_id, year, period_no, start_date, end_date, status)
journals(id, company_id, code, name, source_module)
journal_entries(id, tenant_id, company_id, journal_id, entry_no, posting_date, status, source_type, source_id, reference, description, currency_code, total_debit, total_credit, reversal_of_entry_id)
journal_lines(id, journal_entry_id, line_no, account_id, dimension_set_id, debit_amount, credit_amount, transaction_currency, transaction_amount, exchange_rate, tax_code_id, customer_id, vendor_id, item_id, project_id, description)
```

#### AR

```text
customers(id, tenant_id, company_id, customer_no, legal_name, display_name, email, phone, billing_address_json, shipping_address_json, payment_terms_id, default_tax_code_id, credit_limit)
ar_invoices(id, tenant_id, company_id, invoice_no, customer_id, issue_date, due_date, status, currency_code, subtotal, tax_total, total, outstanding_amount, posted_entry_id)
ar_invoice_lines(id, invoice_id, line_no, item_type, item_id, description, quantity, unit_price, discount_amount, tax_code_id, line_net, line_tax, line_total, revenue_account_id)
customer_receipts(id, tenant_id, company_id, receipt_no, customer_id, receipt_date, amount, currency_code, status, bank_account_id, posted_entry_id)
customer_allocations(id, receipt_id, invoice_id, allocated_amount)
```

#### AP

```text
vendors(id, tenant_id, company_id, vendor_no, legal_name, email, address_json, payment_terms_id, default_tax_code_id)
ap_bills(id, tenant_id, company_id, bill_no, vendor_id, bill_date, due_date, status, currency_code, subtotal, tax_total, total, outstanding_amount, posted_entry_id)
ap_bill_lines(id, bill_id, line_no, expense_account_id, item_id, description, quantity, unit_cost, tax_code_id, line_net, line_tax, line_total)
vendor_payments(id, tenant_id, company_id, payment_no, vendor_id, payment_date, amount, currency_code, status, bank_account_id, posted_entry_id)
vendor_allocations(id, payment_id, bill_id, allocated_amount)
```

#### Banking

```text
bank_accounts(id, tenant_id, company_id, account_name, bank_name, masked_account_no, currency_code, gl_account_id, feed_provider, feed_status)
bank_transactions(id, tenant_id, company_id, bank_account_id, transaction_date, value_date, amount, direction, description, external_id, status, suggested_match_json)
reconciliation_sessions(id, tenant_id, company_id, bank_account_id, statement_start_date, statement_end_date, closing_balance, status)
reconciliation_lines(id, session_id, bank_transaction_id, matched_object_type, matched_object_id, difference_amount, status)
```

#### Tax

```text
tax_codes(id, tenant_id, company_id, code, tax_type, rate, recoverability, jurisdiction, effective_from, effective_to, gl_output_tax_account_id, gl_input_tax_account_id)
tax_rates(id, tax_code_id, rate, effective_from, effective_to)
tax_returns(id, tenant_id, company_id, period_start, period_end, tax_type, status, submitted_at, payload_json)
```

#### Inventory

```text
items(id, tenant_id, company_id, sku, name, item_type, inventory_method, income_account_id, expense_account_id, inventory_account_id, cogs_account_id, tax_code_id, is_active)
warehouses(id, tenant_id, company_id, code, name)
inventory_movements(id, tenant_id, company_id, item_id, warehouse_id, movement_type, quantity, unit_cost, total_cost, transaction_date, source_type, source_id, posted_entry_id)
inventory_balances(id, tenant_id, company_id, item_id, warehouse_id, quantity_on_hand, average_cost, last_updated_at)
```

#### Fixed Assets

```text
assets(id, tenant_id, company_id, asset_no, name, asset_class, acquisition_date, acquisition_cost, useful_life_months, salvage_value, depreciation_method, asset_account_id, accumulated_depr_account_id, depr_expense_account_id, status)
asset_depreciation_runs(id, tenant_id, company_id, asset_id, run_date, depreciation_amount, posted_entry_id)
```

#### Documents and Audit

```text
attachments(id, tenant_id, company_id, object_type, object_id, storage_path, filename, mime_type, checksum, uploaded_by)
audit_events(id, tenant_id, company_id, event_time, actor_id, actor_type, object_type, object_id, action, before_json, after_json, ip_address, user_agent, trace_id)
outbox_events(id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json, status, published_at)
```

---

## 11. Chart of Accounts Design

### 11.1 Account Types

- Assets
- Liabilities
- Equity
- Revenue
- Cost of Goods Sold
- Expense
- Other Income
- Other Expense
- Tax payable / receivable
- Bank and cash
- Accounts receivable
- Accounts payable

### 11.2 Rules

- Each company starts from a country-specific template COA
- Users may add custom accounts but not break system-required control accounts
- Control accounts must be flagged and protected from direct manual posting if system rules require it
- Account deactivation allowed only when balance is zero and no future dependencies exist

### 11.3 Dimensions

Support optional analytical dimensions:

- Department
- Class
- Location
- Project
- Cost center
- Custom tags

Implementation note: store dimension assignments using a `dimension_set` abstraction to reduce repeated combinations.

---

## 12. General Ledger and Posting Engine

### 12.1 Requirements

- Support manual journals
- Support system-generated journals from AR, AP, inventory, tax, banking, fixed assets
- Enforce balanced entries
- Support future-dated entries subject to open period checks
- Support reversals and recurring journals
- Prevent edits to posted journal lines

### 12.2 Posting Engine Responsibilities

- Validate source object state
- Resolve accounts and tax mappings
- Determine exchange rate when applicable
- Create journal entry and lines atomically
- Update source document status and link to entry
- Create outbox events for downstream projections and integrations

### 12.3 Example Posting Patterns

#### Sales Invoice Posting

```text
Dr Accounts Receivable
   Cr Revenue
   Cr Output Tax Payable
```

#### Customer Receipt

```text
Dr Bank
   Cr Accounts Receivable
```

#### Vendor Bill

```text
Dr Expense / Inventory / Asset
Dr Input Tax Recoverable
   Cr Accounts Payable
```

#### Vendor Payment

```text
Dr Accounts Payable
   Cr Bank
```

### 12.4 Posting API Pseudocode

```ts
async function postSalesInvoice(invoiceId: string, ctx: RequestContext): Promise<PostResult> {
  return db.transaction(async (tx) => {
    const invoice = await invoiceRepo.getDraftForUpdate(tx, invoiceId, ctx.tenantId);
    validateInvoiceForPosting(invoice);

    const lines = buildSalesInvoiceJournalLines(invoice);
    validateBalanced(lines);
    validatePeriodOpen(invoice.issueDate, invoice.companyId);

    const entry = await journalEntryRepo.create(tx, {
      tenantId: ctx.tenantId,
      companyId: invoice.companyId,
      journalCode: 'SALES',
      sourceType: 'AR_INVOICE',
      sourceId: invoice.id,
      postingDate: invoice.issueDate,
      lines,
    });

    await invoiceRepo.markPosted(tx, invoice.id, entry.id);
    await outboxRepo.add(tx, {
      aggregateType: 'AR_INVOICE',
      aggregateId: invoice.id,
      eventType: 'ar.invoice.posted',
      payload: { invoiceId: invoice.id, journalEntryId: entry.id },
    });

    return { journalEntryId: entry.id };
  });
}
```

### 12.5 Idempotency

Posting endpoints must accept an idempotency key. Duplicate retries must not produce duplicate journal entries.

---

## 13. Accounts Receivable Module

### 13.1 Features

- Customer master data
- Quotes / estimates
- Sales orders (optional)
- Invoices
- Recurring invoices
- Credit notes and refunds
- Receipts and allocations
- Customer statements
- Dunning / reminders
- Aging reports
- Bad debt write-off

### 13.2 Invoice States

- Draft
- Pending approval
- Approved
- Posted / issued
- Partially paid
- Paid
- Overdue
- Voided
- Reversed

### 13.3 Functional Rules

- Invoice number sequencing by company and document type
- Support discounts at line and header levels
- Tax code per line with override control
- Due date derived from payment terms
- Posted invoice cannot be edited; must use credit note or cancellation logic

### 13.4 AR API Endpoints

```text
POST   /api/v1/customers
GET    /api/v1/customers/:id
POST   /api/v1/ar/invoices
POST   /api/v1/ar/invoices/:id/submit
POST   /api/v1/ar/invoices/:id/post
POST   /api/v1/ar/invoices/:id/credit-note
POST   /api/v1/ar/receipts
POST   /api/v1/ar/receipts/:id/post
POST   /api/v1/ar/allocations
GET    /api/v1/reports/ar-aging
```

### 13.5 UI Screens

- Customer list/detail
- Invoice editor
- Invoice details and timeline
- Receive payment screen
- Customer statement screen
- AR aging dashboard

---

## 14. Accounts Payable Module

### 14.1 Features

- Vendor master data
- Purchase orders (optional)
- Bills and bill capture
- Recurring bills
- Vendor credits
- Payment runs
- Manual and bulk payments
- Expense claims reimbursement
- AP aging reports
- 1099 / withholding support by jurisdiction extension

### 14.2 Bill Workflow

1. Draft bill entered manually or imported via OCR/email
2. Coding to expense/item/project/tax
3. Approval route
4. Posting to AP subledger and GL
5. Included in payment run based on due date, priority, discount terms
6. Reconciled to bank payment

### 14.3 Payment Run Logic

- Select open approved bills
- Group by vendor, currency, payment method
- Generate payment batch
- Export bank payment file or call payment API
- Post payments once confirmed

### 14.4 AP API Endpoints

```text
POST   /api/v1/vendors
POST   /api/v1/ap/bills
POST   /api/v1/ap/bills/:id/submit
POST   /api/v1/ap/bills/:id/post
POST   /api/v1/ap/payment-runs
POST   /api/v1/ap/payments
POST   /api/v1/ap/payments/:id/post
GET    /api/v1/reports/ap-aging
```

---

## 15. Banking and Reconciliation

### 15.1 Features

- Bank account setup
- Bank feed integration (Open Banking / aggregator)
- Import bank statements (CSV, OFX, MT940, CAMT)
- Auto-categorization rules
- Receipt/payment matching
- Transfer detection
- Reconciliation workspace
- Suspense handling

### 15.2 Reconciliation Flow

1. Fetch/import bank transactions
2. Normalize and deduplicate using external identifiers and fuzzy rules
3. Suggest matches against posted payments, receipts, invoices, bills, transfers
4. User confirms or creates adjustment transaction
5. Session reaches zero difference
6. Close reconciliation session and store evidence

### 15.3 Matching Logic

Scoring criteria:

- Exact amount
- Date proximity
- Counterparty similarity
- Reference match
- Existing unmatched ledger movement
- Historical pattern

### 15.4 Auto-Categorization Rule Model

```text
bank_rules(id, company_id, priority, conditions_json, action_type, action_payload_json, is_active)
```

### 15.5 Example Rule Conditions

- description contains `AMAZON`
- amount < 100
- counterparty equals specific IBAN or sort code/account pair
- transaction direction is debit

### 15.6 Banking API Endpoints

```text
POST   /api/v1/banking/accounts
POST   /api/v1/banking/imports/statements
GET    /api/v1/banking/transactions
POST   /api/v1/banking/transactions/:id/match
POST   /api/v1/banking/reconciliations
POST   /api/v1/banking/reconciliations/:id/close
```

---

## 16. Expense Management

### 16.1 Features

- Employee/submitted expenses
- Receipt upload and OCR
- Mileage claims
- Per diem support
- Approval workflow
- Reimbursement via AP or payroll integration

### 16.2 Functional Requirements

- Receipt attachment mandatory above configurable threshold
- Policy validation with warnings or hard stops
- Personal vs business split allowed where policy permits
- Expense claim lines map to GL accounts and tax codes

---

## 17. Tax Management

### 17.1 Supported Tax Patterns

- Sales tax
- VAT/GST
- Reverse charge
- Zero-rated / exempt
- Inclusive and exclusive tax pricing
- Compound tax for jurisdictions that require it
- Withholding tax extension

### 17.2 Tax Engine Responsibilities

- Resolve tax code by item, customer/vendor, location, and document context
- Calculate line tax and header totals
- Produce tax posting lines
- Support adjustments and partial recoverability
- Generate tax return extracts and audit details

### 17.3 Tax Design Rules

- Tax must be stored both as calculated transactional result and as reproducible inputs
- Effective dating mandatory for tax codes and rates
- Tax return generation must be traceable back to source entries

### 17.4 VAT Return Example Outputs

- Output tax total
- Input tax recoverable
- Net VAT payable/refundable
- Sales value ex VAT
- Purchases value ex VAT
- EU or import/export boxes depending on jurisdiction plugin

---

## 18. Inventory Module

### 18.1 Features

- Inventory items and non-stock items
- Warehouses / locations
- Goods receipt
- Stock adjustment
- Stock transfer
- Sales issue / fulfillment
- Landed cost allocation
- Cost valuation: average cost first, FIFO later if needed
- Inventory count and variance

### 18.2 Inventory Accounting

Perpetual inventory recommended:

- Purchase of stock: Dr Inventory / Cr AP
- Sale of stock: Dr COGS / Cr Inventory

### 18.3 Costing

MVP:

- weighted average cost per item per company or warehouse

Advanced:

- FIFO layers
- lot/serial tracking
- expiry tracking

### 18.4 Important Rules

- No negative stock unless explicitly allowed by company setting
- Inventory movement and accounting entry must reconcile
- Movement source must reference originating document

---

## 19. Fixed Assets

### 19.1 Features

- Asset register
- Acquisition from AP or manual capitalization
- Depreciation schedules
- Impairment and disposal
- Asset categories with default life/method/accounts

### 19.2 Depreciation Methods

- Straight line
- Declining balance
- Units of production optional extension

### 19.3 Monthly Depreciation Job

1. Select active assets
2. Calculate depreciation for open period
3. Create depreciation run records
4. Post journal entries
5. Mark asset NBV changes

---

## 20. Projects and Job Costing

### 20.1 Features

- Project master
- Project budgets
- Project tagging on invoices, bills, timesheets, expenses
- Revenue and cost reporting by project
- WIP support as extension

### 20.2 Dimension Design

Project should exist as both:

- a master object with metadata
- a ledger dimension on journal lines

---

## 21. Budgeting and Forecasting

### 21.1 Features

- Annual budgets by account and dimension
- Monthly phasing
- Reforecast versions
- Actual vs budget reports

### 21.2 Data Model

```text
budgets(id, company_id, name, fiscal_year, version, status)
budget_lines(id, budget_id, account_id, dimension_set_id, period_no, amount)
```

---

## 22. Reporting and Analytics

### 22.1 Core Reports

- Profit and Loss
- Balance Sheet
- Cash Flow Statement (indirect method first)
- Trial Balance
- General Ledger detail
- Journal report
- AR aging
- AP aging
- Tax summaries
- Inventory valuation
- Expense analysis
- Project profitability
- Budget vs actual
- Bank reconciliation summary
- Audit log reports

### 22.2 Reporting Architecture

Two-layer approach:

1. Operational reporting from PostgreSQL/materialized views
2. Analytical reporting from warehouse/read model for larger scale

### 22.3 Snapshot Strategy

For performance:

- maintain balance snapshots by account, period, and dimension set
- recompute incrementally on posted event
- retain ability to rebuild from journal lines

### 22.4 Example Reporting Views

```sql
create materialized view mv_trial_balance as
select
  tenant_id,
  company_id,
  account_id,
  date_trunc('month', posting_date) as posting_month,
  sum(debit_amount) as debits,
  sum(credit_amount) as credits,
  sum(debit_amount - credit_amount) as balance
from journal_lines jl
join journal_entries je on jl.journal_entry_id = je.id
where je.status = 'POSTED'
group by 1,2,3,4;
```

---

## 23. Period Close and Accounting Controls

### 23.1 Features

- Open/close fiscal periods
- Soft close and hard close
- Close checklist
- Manual journal approval
- Lock dates per module
- Reopen by privileged role only

### 23.2 Close Checklist Examples

- All bank accounts reconciled
- AP/AR aging reviewed
- Suspense accounts cleared
- Depreciation posted
- Inventory adjustments posted
- Tax returns prepared
- Management review completed

### 23.3 Rules

- No posting to closed periods
- Special adjustment period optional
- Closing retained earnings can be virtual or explicit year-end journal based on design preference

---

## 24. Document Management

### 24.1 Features

- Attach receipts, invoices, statements, contracts
- OCR extraction pipeline
- Virus scan and MIME validation
- Versioning for attachments where allowed
- Preview in UI

### 24.2 Object Storage Rules

- Store binary in object store, metadata in DB
- Content hash for duplicate detection
- Encryption at rest mandatory
- Signed URLs with short expiration

---

## 25. Workflow and Approvals

### 25.1 Approvals Needed For

- Bills above threshold
- Expense claims
- Manual journals above threshold
- Vendor creation/change
- Customer credit limit override
- Write-offs and refunds

### 25.2 Workflow Engine Design

Simplified rules-based engine:

```text
approval_policies(id, company_id, object_type, condition_json, steps_json, is_active)
approval_instances(id, object_type, object_id, status, current_step)
approval_actions(id, instance_id, actor_id, action, comment, acted_at)
```

### 25.3 Conditions

- amount > threshold
- department = X
- vendor risk category = high
- account belongs to sensitive list

---

## 26. Notifications and Tasks

### 26.1 Notifications

- invoice overdue reminders
- bill due reminders
- approval pending alerts
- bank feed failures
- close checklist reminders
- tax submission deadlines

### 26.2 Delivery Channels

- in-app
- email
- webhook
- SMS optional via integration

---

## 27. Integrations

### 27.1 Integration Categories

- Banks / Open Banking providers
- Payment gateways (Stripe, PayPal, Adyen, etc.)
- Payroll providers
- Tax filing providers
- E-commerce platforms
- CRM systems
- Document OCR providers
- External accountants / data export tools

### 27.2 Integration Architecture

- Outbound webhooks for business events
- Import/export jobs
- OAuth2 for third-party access
- API keys/service accounts for server-to-server usage
- Connector framework with retry and dead-letter support

### 27.3 Example Events

```text
ar.invoice.created
ar.invoice.posted
ar.invoice.paid
ap.bill.posted
bank.transaction.imported
period.closed
report.generated
```

### 27.4 Webhook Delivery Requirements

- HMAC signature
- Retry with exponential backoff
- dead-letter after max failures
- idempotent consumer guidance to partners

---

## 28. API Design Specification

### 28.1 Principles

- Resource-oriented APIs
- Pagination on list endpoints
- Filtering, sorting, and field projection
- Idempotency keys on create/post/payment endpoints
- Versioned APIs `/api/v1`
- Strong validation and consistent error payloads

### 28.2 Standard Error Format

```json
{
  "error": {
    "code": "PERIOD_CLOSED",
    "message": "The posting date belongs to a closed fiscal period.",
    "details": {
      "companyId": "...",
      "postingDate": "2026-03-31"
    },
    "traceId": "..."
  }
}
```

### 28.3 Example Invoice Create Payload

```json
{
  "customerId": "uuid",
  "issueDate": "2026-03-10",
  "currencyCode": "GBP",
  "paymentTermsCode": "NET30",
  "lines": [
    {
      "itemId": "uuid",
      "description": "Consulting services",
      "quantity": 10,
      "unitPrice": 100,
      "taxCode": "VAT20",
      "projectId": "uuid"
    }
  ],
  "notes": "Thank you for your business"
}
```

### 28.4 Example OpenAPI Structure

```yaml
paths:
  /api/v1/ar/invoices:
    post:
      summary: Create draft invoice
  /api/v1/ar/invoices/{id}/post:
    post:
      summary: Post invoice to accounts receivable and general ledger
```

---

## 29. Security Design

### 29.1 Core Security Requirements

- SSO and local auth support
- MFA for privileged roles
- RBAC and optional ABAC extensions
- Tenant isolation enforced server-side
- Encryption in transit and at rest
- Secrets in managed vault
- Tamper-evident audit trail

### 29.2 Authentication

- OIDC / OAuth2
- JWT access tokens with short TTL
- Refresh tokens with rotation
- API keys/service accounts for integrations

### 29.3 Authorization

Permission examples:

- `gl.journal.create`
- `gl.journal.post`
- `ar.invoice.manage`
- `ap.payment.approve`
- `bank.reconcile`
- `reports.financial.view`
- `admin.user.manage`

### 29.4 Sensitive Actions Requiring Step-Up Auth

- export all accounting data
- close/reopen periods
- modify bank integrations
- change tax settings
- create high-privilege users

### 29.5 Data Protection

- PII minimization
- configurable retention rules
- audit access for sensitive records
- country-specific data residency option

---

## 30. Audit and Compliance

### 30.1 Audit Requirements

- Record create/update/delete/view where required
- Record posting, reversal, approval, login, export, settings changes
- Before/after JSON snapshots for mutable operational records
- Immutable ledger history

### 30.2 Compliance Considerations

Depends on geography and market, but design should support:

- GDPR / UK GDPR
- VAT/GST digital records rules
- e-invoicing extensions
- SOC 2 operational controls
- ISO 27001-aligned security practices
- local bookkeeping retention periods

### 30.3 Tamper Resistance

- append-only audit store or hash-chain signing for critical events
- DB backups and point-in-time recovery
- ledger correction through reversal only

---

## 31. Performance and Scalability

### 31.1 Targets

- Most UI reads under 500 ms for normal tenant data volume
- Posting operations under 2 seconds in common cases
- Reconciliation workspace supports 100k+ imported transactions with pagination and search
- Financial reports under 5 seconds for SMB tenants, with async export for heavier queries

### 31.2 Scaling Strategy

- read replicas for reporting
- caching for reference data and dashboards
- asynchronous exports and OCR processing
- partition very large ledger/bank tables by tenant or date where needed
- materialized views / projections for heavy reports

---

## 32. Reliability and Recovery

### 32.1 Reliability Controls

- transactional posting
- outbox pattern for event publishing
- retries with idempotency
- dead-letter queues
- daily backups + PITR
- graceful degradation if bank feeds/OCR unavailable

### 32.2 Disaster Recovery

- documented RPO/RTO targets
- cross-region backup replication optional
- infrastructure as code for rebuild
- periodic restore tests

---

## 33. Observability

### 33.1 Logs

- structured JSON logs
- include tenantId, companyId, userId, traceId
- redact secrets and sensitive payloads

### 33.2 Metrics

- invoice creation/post counts
- posting failures by module
- reconciliation match rate
- bank import latency
- report runtime
- queue backlog
- login/MFA stats

### 33.3 Tracing

- end-to-end tracing for user request to DB and async workflows

---

## 34. UI/UX Design Requirements

### 34.1 Navigation

Primary navigation:

- Dashboard
- Sales
- Expenses
- Banking
- Accounting
- Reports
- Inventory
- Projects
- Taxes
- Settings

### 34.2 UX Principles

- accounting users need dense but readable screens
- draft/edit screens optimized for keyboard efficiency
- timeline/history visible on financial objects
- clear posted vs draft distinction
- irreversible actions require strong confirmation language
- error messages must be precise and actionable

### 34.3 Key Screens

- dashboard with KPI cards
- invoice editor with line grid
- bill capture/coding screen
- bank reconciliation workspace
- general ledger journal entry screen
- report runner with filters and export
- period close checklist dashboard

---

## 35. Business Rules Catalogue

### 35.1 Universal Rules

- Debits must equal credits for every journal entry
- Posting date must fall in open period
- Document currency must be valid for company configuration
- Exchange rate must exist for foreign currency posting unless manual override allowed
- Posted documents are immutable except through permitted correction flows

### 35.2 AR Rules

- receipt allocation cannot exceed outstanding invoice balance
- credit note cannot exceed original invoice without privileged override
- customer status block can prevent new invoice posting

### 35.3 AP Rules

- vendor payment cannot exceed total selected open bills unless prepayment supported
- duplicate vendor bill detection by vendor + invoice number + amount + date tolerance

### 35.4 Banking Rules

- imported external bank transaction IDs must be deduplicated
- reconciliation cannot be closed with non-zero unexplained difference above tolerance

### 35.5 Tax Rules

- effective tax code must exist on transaction date
- non-recoverable tax portion must flow to expense/asset where configured

### 35.6 Inventory Rules

- inventory issue requires sufficient stock unless negative stock enabled
- cost adjustment must preserve inventory valuation integrity

---

## 36. Accounting Engine Implementation Detail

### 36.1 Source-to-Posting Mapping Pattern

Each source module implements a posting mapper interface:

```ts
export interface PostingMapper<TSource> {
  validateForPosting(source: TSource): Promise<void>;
  buildEntry(source: TSource): Promise<DraftJournalEntry>;
  afterPost(source: TSource, entryId: string): Promise<void>;
}
```

Module implementations:

- `SalesInvoicePostingMapper`
- `CustomerReceiptPostingMapper`
- `VendorBillPostingMapper`
- `VendorPaymentPostingMapper`
- `InventoryAdjustmentPostingMapper`
- `AssetDepreciationPostingMapper`

### 36.2 Posting Service Pattern

```ts
export class PostingService {
  async post(sourceType: SourceType, sourceId: string, ctx: RequestContext): Promise<PostResult> {
    const mapper = this.mapperRegistry.get(sourceType);
    return this.unitOfWork.transaction(async () => {
      const source = await this.sourceLoader.loadForUpdate(sourceType, sourceId, ctx);
      await mapper.validateForPosting(source);
      const draft = await mapper.buildEntry(source);
      this.balanceValidator.ensureBalanced(draft.lines);
      this.periodValidator.ensureOpen(draft.postingDate, source.companyId);
      const entry = await this.journalRepo.insertPostedEntry(draft, ctx);
      await mapper.afterPost(source, entry.id);
      await this.outbox.publishDeferred({
        type: `${sourceType}.posted`,
        aggregateId: sourceId,
        payload: { sourceId, entryId: entry.id }
      });
      return { entryId: entry.id };
    });
  }
}
```

---

## 37. Asynchronous Processing

### 37.1 Jobs

- OCR extraction
- bank feed synchronization
- recurring invoice generation
- payment reminder dispatch
- depreciation runs
- tax return compilation
- report exports
- search indexing
- data warehouse sync

### 37.2 Job Requirements

- retry policy
- idempotent execution
- progress tracking
- dead-letter handling
- tenant-aware resource controls

---

## 38. Search and Filtering

### 38.1 Search Use Cases

- find invoice by number, customer, amount, date
- find bank transactions by memo or amount
- search vendors, customers, items
- global command palette style search

### 38.2 Implementation

- PostgreSQL full-text for MVP
- OpenSearch for large scale and advanced relevance
- index only needed fields with tenant segregation

---

## 39. Import/Export Framework

### 39.1 Imports

- chart of accounts
- customers/vendors
- invoices/bills
- bank statements
- items/inventory balances
- journal entries

### 39.2 Export Formats

- CSV
- Excel
- PDF reports
- SAF-T / MTD / local tax schemas via plugins where required
- API bulk export

### 39.3 Import Pipeline Stages

1. Upload file
2. Parse
3. Validate schema
4. Preview mapping
5. Dry-run validation
6. Commit import
7. Produce import audit report

---

## 40. Localization and Internationalization

### 40.1 Requirements

- multilingual UI labels
- locale-aware dates/numbers
- country-specific tax plugins
- multi-currency support
- localized document templates

### 40.2 Multi-Currency Rules

- company base currency mandatory
- transactional currency supported for invoices, bills, bank accounts
- store source amount, source currency, exchange rate, base currency amount
- realized and unrealized FX gains/losses supported

---

## 41. Multi-Entity and Consolidation Extension

### 41.1 Extension Scope

- multiple companies under one tenant
- intercompany transactions
- elimination entries
- consolidated financial reports

### 41.2 Phase Guidance

Build the core with `company_id` everywhere so consolidation can be added later without redesign.

---

## 42. Testing Strategy

### 42.1 Test Types

- unit tests
- integration tests
- DB repository tests
- API contract tests
- E2E UI tests
- accounting correctness tests
- performance tests
- security tests

### 42.2 Critical Test Scenarios

- double-entry balance on all posting flows
- period closed rejection
- tax calculation correctness
- foreign currency gain/loss handling
- duplicate bank import deduplication
- duplicate bill detection
- reversal entries correctness
- reconciliation difference tolerance logic
- concurrent edits with optimistic locking
- tenant isolation penetration tests

### 42.3 Accounting Golden Tests

Maintain golden datasets with expected journal results for typical scenarios:

- taxable invoice
- partial payment
- bill with mixed tax recoverability
- inventory sale with average cost
- depreciation month-end
- FX revaluation

### 42.4 Example Test Structure

```text
/tests/unit/posting/*.spec.ts
/tests/integration/api/*.spec.ts
/tests/integration/accounting-golden/*.spec.ts
/tests/e2e/playwright/*.spec.ts
```

---

## 43. DevOps and Release Management

### 43.1 CI Pipeline

- lint
- typecheck
- unit tests
- integration tests
- security scan
- build container image
- deploy to dev/test
- smoke tests

### 43.2 Release Controls

- feature flags for incomplete modules
- migration gating and rollback strategy
- blue/green or canary deployment
- post-deploy health checks

### 43.3 Infrastructure as Code

Use Terraform or Pulumi for:

- databases
- storage
- queues
- secrets
- container orchestration
- networking
- monitoring

---

## 44. Data Migration Strategy

### 44.1 Migration Sources

- legacy accounting software CSV exports
- bank statement history
- opening balances
- open AR/AP documents
- inventory opening balances
- fixed asset opening register

### 44.2 Migration Phases

1. master data load
2. opening balances
3. open transaction load
4. historical optional detail import
5. reconciliation and sign-off

### 44.3 Controls

- migration checksum reports
- trial balance tie-out to legacy
- customer/vendor subledger tie-out
- inventory valuation tie-out

---

## 45. AI and Automation Extensions

### 45.1 Useful AI Features

- OCR extraction from bills/receipts
- suggested account/tax coding
- anomaly detection for unusual transactions
- cash flow forecast assistance
- reconciliation suggestions
- natural-language report exploration

### 45.2 AI Guardrails

- AI may recommend but not auto-post without explicit rules/approval
- deterministic accounting rules override AI outputs
- confidence score and explanation required for suggestions
- full audit trail for AI-assisted actions

---

## 46. Suggested Phased Delivery

### Phase 1

- tenant/company setup
- users/RBAC
- chart of accounts
- manual journals
- customers/vendors
- invoices/bills
- receipts/payments
- banking import and reconciliation MVP
- basic tax
- core financial reports
- audit logs

### Phase 2

- inventory
- expense claims
- approvals
- recurring transactions
- OCR capture
- budgets
- project costing

### Phase 3

- fixed assets
- advanced tax/localization
- payroll integration
- e-commerce integrations
- multi-entity/consolidation
- AI assistant features

---

## 47. Open Risks and Design Decisions

### 47.1 Major Decisions Needed Early

- modular monolith vs microservices from day one
- Prisma vs SQL-first repository design
- average cost vs FIFO in initial inventory release
- local tax jurisdictions to support in first release
- report engine choice and export standards
- bank connectivity partner choice

### 47.2 Risks

- tax complexity by country can expand scope rapidly
- accounting correctness bugs have severe business impact
- reconciliation UX can become overly complex
- performance of reports on raw transactional tables may degrade quickly without projections
- localization requirements may cause hidden redesign unless plugin model is introduced early

---

## 48. Recommended Folder Structure (TypeScript/NestJS Example)

```text
src/
  modules/
    identity/
    tenant/
    accounting/
      domain/
      application/
      infrastructure/
      api/
    ar/
    ap/
    banking/
    tax/
    inventory/
    reporting/
    workflow/
    documents/
    integrations/
  shared/
    db/
    events/
    auth/
    utils/
  jobs/
  config/
  main.ts
```

---

## 49. Example Domain Events

```ts
export type DomainEvent =
  | { type: 'ar.invoice.posted'; invoiceId: string; journalEntryId: string; tenantId: string; companyId: string }
  | { type: 'ap.bill.posted'; billId: string; journalEntryId: string; tenantId: string; companyId: string }
  | { type: 'bank.transaction.imported'; bankTransactionId: string; tenantId: string; companyId: string }
  | { type: 'period.closed'; fiscalPeriodId: string; tenantId: string; companyId: string };
```

---

## 50. Definition of Done for MVP Core Accounting

A module is done only when all of the following are satisfied:

- Functional UI is complete
- API contract documented
- Unit and integration tests pass
- Posting output verified with accounting golden tests
- Audit events recorded
- Role-based permissions applied
- Error handling and validation implemented
- Metrics/logging/tracing added
- Documentation completed
- Migration scripts available

---

## 51. Final Recommendation

The most robust path is to build this product as a **modular, accounting-first SaaS platform** with the **ledger and posting engine as the core**, while keeping all operational modules subordinate to accounting truth.

Key implementation priorities:

1. Get the domain model and posting engine correct first
2. Make period control, audit trail, and reconciliation first-class capabilities
3. Build extensibility for tax, localization, and integrations early
4. Favor deterministic business rules over automation when financial correctness is at stake
5. Use phased delivery to control scope

This design is detailed enough to start solution architecture, backlog decomposition, API design, schema design, and implementation planning.
