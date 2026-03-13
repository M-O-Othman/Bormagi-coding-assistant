# Accounting System Design Document

**Document Type:** Detailed Design / Implementation Specification  
**Target Product:** Cloud-native accounting platform similar in scope to QuickBooks  
**Primary Audience:** Product managers, solution architects, backend engineers, frontend engineers, QA engineers, DevOps, security engineers, data engineers  
**Version:** 1.0  
**Date:** 2026-03-13

---

## 1. Purpose

This document defines a production-grade design for a multi-tenant accounting system similar to QuickBooks, covering:

- core accounting and bookkeeping
- invoicing and receivables
- bills and payables
- bank feeds and reconciliation
- chart of accounts and journal engine
- taxes and compliance hooks
- inventory and item accounting
- payroll integration boundaries
- fixed assets and depreciation
- budgeting, projects, and cost tracking
- reporting, dashboards, and analytics
- approval workflows and audit controls
- public/internal APIs, data model, security, and deployment architecture

The design is implementation-oriented and intended to be detailed enough to hand to an engineering team.

---

## 2. Product Vision

Build a secure, extensible, cloud-native accounting platform for SMBs and mid-market businesses that provides:

- double-entry accounting as the financial source of truth
- operational finance workflows for sales, purchasing, banking, tax, and reporting
- automation for categorisation, bank matching, reminders, reconciliation, recurring documents, and anomaly detection
- role-based collaboration for business owners, finance teams, accountants, bookkeepers, and auditors
- integration with banks, payment providers, e-commerce systems, payroll, tax engines, CRM, and document storage
- multi-entity, multi-currency, and multi-tax-jurisdiction readiness

---

## 3. Design Principles

1. **Ledger-first architecture**  
   All financial workflows must resolve into immutable journal entries or controlled journal adjustments.

2. **Operational simplicity with accounting rigor**  
   The UI should simplify bookkeeping, but backend accounting rules must remain strict.

3. **Multi-tenant by design**  
   Strict tenant isolation, configurable company-level settings, and scalable tenancy.

4. **API-first and event-driven**  
   Core modules must expose versioned APIs and publish domain events.

5. **Auditability over convenience**  
   Every critical financial mutation must be traceable, attributable, and reversible via proper accounting flows.

6. **Configurable localization**  
   Tax, invoice numbering, reporting standards, currencies, date formats, and statutory exports should be pluggable.

7. **Progressive automation**  
   Automation should propose, not silently corrupt, accounting outcomes unless explicitly trusted and governed.

---

## 4. Representative Market Scope

Modern accounting products similar to QuickBooks commonly include invoicing, expense tracking, bank feeds, cash flow visibility, payments, payroll support, reporting, inventory support, mobile access, integrations, and automation features. Official QuickBooks pages describe capabilities such as invoicing, income/expense tracking, bank feeds, reconciliation, inventory support, payments, payroll, project management, cloud/mobile access, and large integration ecosystems. These references are used only to anchor feature scope; the design below is an independent implementation specification.  

**Reference pages:**
- QuickBooks UK homepage
- QuickBooks Online
- QuickBooks bank feeds
- QuickBooks invoicing
- QuickBooks expense tracking
- QuickBooks inventory
- QuickBooks Online Advanced

See [Appendix A](#appendix-a-reference-scope-benchmark) for reference links.

---

## 5. Target Users and Roles

### 5.1 Primary personas

- **Business Owner**: views cash flow, sends invoices, approves payments, checks KPIs
- **Bookkeeper**: categorises transactions, reconciles bank accounts, posts journals, manages AP/AR
- **Accountant**: period close, adjustments, tax review, financial statements, compliance support
- **Finance Manager / Controller**: approvals, budgeting, reporting, audit trails, access control
- **AP Clerk**: bills, suppliers, payments, approvals, attachments
- **AR Clerk**: quotes, invoices, reminders, receipts, customer statements
- **Payroll Admin**: syncs payroll journals and liabilities
- **Auditor**: read-only access to reports, journals, attachments, audit log
- **System Administrator**: tenant setup, roles, integrations, security settings

### 5.2 Access roles

Minimum RBAC roles:

- Super Admin (platform level)
- Company Admin
- Accountant
- Bookkeeper
- AP User
- AR User
- Payroll User
- Read Only / Auditor
- External Accountant
- Custom Role

Permissions must support object-level and action-level control such as:

- view/create/edit/delete draft invoices
- approve bills
- post manual journals
- lock closed periods
- manage tax settings
- manage integrations
- export reports
- manage user access

---

## 6. Functional Scope

### 6.1 Core accounting

- chart of accounts
- journals and journal lines
- fiscal periods and year-end close
- account types and subtypes
- dimensions/tags/classes/locations/departments/projects
- trial balance
- retained earnings roll-forward
- accrual and cash basis reporting views
- opening balances and migration tools
- period locking and re-open workflow
- reclassification and reversing journals

### 6.2 Accounts receivable (AR)

- customer master
- estimates / quotations
- sales orders (optional module)
- invoices
- credit notes / credit memos
- receipts / customer payments
- refunds
- recurring invoices
- dunning / reminders / statements
- online payment links
- customer aging
- write-offs and bad debt provisioning

### 6.3 Accounts payable (AP)

- supplier/vendor master
- purchase orders (optional module)
- bills / vendor invoices
- bill credits
- expenses / spend money
- approvals and coding
- batch payments
- payment runs
- supplier aging
- recurring bills
- document attachments and OCR ingestion

### 6.4 Banking

- bank and card accounts
- open banking / bank feed ingestion
- statement import (CSV, OFX, QIF, CAMT)
- transaction matching
- bank rules and auto-categorisation
- reconciliation workspace
- transfer handling
- unreconciled exception tracking
- cash flow view

### 6.5 Tax

- tax codes / VAT / GST / sales tax
- inclusive vs exclusive tax pricing
- purchase tax vs sales tax handling
- filing periods and return summary
- tax adjustments
- tax reports by jurisdiction
- tax rate effective dating
- tax exemption handling
- reverse charge / withholding / zero-rated / exempt

### 6.6 Inventory and items

- inventory items
- non-inventory items
- service items
- bundles/kits (optional)
- warehouses/locations (phase 2)
- quantity on hand
- average cost or FIFO policy (configurable by edition)
- COGS postings
- stock adjustments
- stock count support
- reorder points

### 6.7 Fixed assets

- asset register
- capitalization rules
- depreciation books
- depreciation methods (SL, DB, units-based optional)
- disposal, impairment, transfer
- monthly depreciation journal generation

### 6.8 Payroll integration boundary

The core system should not require native payroll in v1, but must support:

- payroll journal import/API sync
- employee payable and tax liability accounts
- payslip attachment references
- payroll cost allocation by department/project
- employer taxes and pension liability accounts

### 6.9 Projects and job costing

- project master
- revenue/cost tagging
- timesheet imports
- profitability by project/customer/job
- WIP and deferred revenue hooks
- billable expense workflows

### 6.10 Budgets and planning

- annual and monthly budgets
- scenario versions (base, optimistic, conservative)
- budget vs actual
- budget by department, class, project, location

### 6.11 Reporting and analytics

- dashboard KPIs
- profit & loss
- balance sheet
- cash flow statement
- general ledger
- trial balance
- AR aging
- AP aging
- tax reports
- inventory valuation
- customer profitability
- project profitability
- expense by supplier/category
- custom report builder
- scheduled reports

### 6.12 Platform and collaboration

- notifications
- approval workflows
- comments and mentions
- file attachments
- activity feed
- audit log
- import/export
- API keys / webhooks
- mobile support
- accountant portal / external access

---

## 7. Out of Scope for V1

- full ERP manufacturing/MRP
- advanced treasury and cash pooling
- native payroll engine across all countries
- advanced consolidation with minority interest and eliminations (phase 2)
- revenue recognition engine for complex contracts (phase 2)
- lease accounting (phase 2)
- full procurement sourcing suite
- POS/retail store operations

---

## 8. High-Level Architecture

### 8.1 Architecture style

Recommended architecture: **modular monolith first, event-driven internally, with clean boundaries that allow extraction into services later**.

Reasoning:

- accounting systems require strong transactional consistency
- most early teams move faster with a modular monolith than with premature microservices
- modules can publish domain events via an internal event bus and later externalise them to Kafka/PubSub

### 8.2 Logical modules

1. Identity & Access
2. Tenant & Company Settings
3. Customer Management
4. Supplier Management
5. Item & Inventory Management
6. Tax Engine
7. Invoicing & AR
8. Bills & AP
9. Banking & Reconciliation
10. Ledger / Accounting Engine
11. Fixed Assets
12. Projects & Dimensions
13. Reporting & Analytics
14. Notifications & Workflow
15. Attachments & OCR
16. Integrations & Webhooks
17. Audit & Compliance
18. Import / Migration

### 8.3 Recommended deployment stack

**Frontend**
- React + TypeScript
- Next.js or Vite + React Router
- TanStack Query
- Zustand or Redux Toolkit
- component library: MUI or shadcn-based enterprise design system
- charting: ECharts / Recharts / Highcharts

**Backend**
- TypeScript + Node.js
- NestJS preferred for modularity, DI, validation, guards, CQRS compatibility
- REST API for external consumption
- GraphQL optional for internal UI aggregation only
- background jobs via BullMQ / Temporal

**Database and storage**
- PostgreSQL as system of record
- Redis for caching, locks, queues
- object storage: S3/GCS/Azure Blob for attachments and exports
- Elasticsearch/OpenSearch optional for document/report search

**Messaging**
- internal domain events abstraction
- external broker optional: Kafka / Google PubSub / RabbitMQ

**Reporting / BI**
- OLTP reporting for standard financial reports
- optional replicated warehouse for advanced analytics

**Auth / Security**
- OpenID Connect / OAuth2
- SSO for enterprise edition
- TOTP/MFA
- secrets in Vault / cloud secret manager

---

## 9. Multi-Tenancy Model

### 9.1 Tenancy approach

Recommended: **shared application, shared database, tenant_id on all business tables**, with optional premium isolated database deployment for enterprise customers.

### 9.2 Isolation rules

- every query filtered by `tenant_id`
- row-level enforcement in repository layer and optionally PostgreSQL RLS
- object storage paths namespaced by tenant/company
- all cache keys include tenant/company context
- audit log must include tenant and actor metadata

### 9.3 Company hierarchy

A tenant may contain one or more legal entities/companies.

Suggested hierarchy:

- platform tenant
- company
- branch/location (optional)
- departments/classes/projects as accounting dimensions

---

## 10. Domain Model Overview

### 10.1 Core master entities

- Tenant
- Company
- User
- Role
- Permission
- Currency
- ExchangeRate
- FiscalYear
- FiscalPeriod
- Sequence
- Attachment
- AuditLog

### 10.2 Accounting entities

- Account
- AccountType
- JournalEntry
- JournalLine
- LedgerPostingBatch
- AccountingPeriodLock
- DimensionValue
- ManualJournalTemplate

### 10.3 AR entities

- Customer
- CustomerContact
- Estimate
- Invoice
- InvoiceLine
- CreditNote
- Receipt
- CustomerStatement
- RecurringInvoiceTemplate

### 10.4 AP entities

- Supplier
- SupplierContact
- Bill
- BillLine
- BillCredit
- SupplierPayment
- ExpenseClaim (optional)
- RecurringBillTemplate

### 10.5 Banking entities

- BankAccount
- BankFeedConnection
- BankTransaction
- BankRule
- BankMatchCandidate
- BankReconciliationSession
- BankStatementImport

### 10.6 Inventory entities

- Item
- ItemCategory
- InventoryLot (if FIFO/lot tracking enabled)
- InventoryMovement
- InventoryValuationLayer
- Warehouse
- StockAdjustment

### 10.7 Tax entities

- TaxJurisdiction
- TaxCode
- TaxRate
- TaxReturnPeriod
- TaxFiling
- TaxAdjustment

### 10.8 Fixed asset entities

- FixedAsset
- AssetClass
- DepreciationBook
- DepreciationRun
- AssetDisposal

### 10.9 Workflow entities

- ApprovalPolicy
- ApprovalRequest
- ApprovalStep
- Notification
- Comment
- ActivityEvent

---

## 11. Accounting Engine Design

This is the most critical part of the system.

### 11.1 Core rules

- every posted financial event produces balanced journal entries
- a journal entry must have at least two lines
- total debits must equal total credits in base currency
- source documents are mutable only in draft; once posted, changes must occur through reversal/amendment flows
- accounting periods can be soft-closed or hard-closed
- the ledger is append-only after posting except via authorized adjusting entries

### 11.2 Journal structure

**JournalEntry**
- id
- tenant_id
- company_id
- journal_number
- source_type
- source_id
- journal_date
- posting_date
- currency_code
- exchange_rate
- base_currency_code
- total_debit
- total_credit
- status: draft | posted | reversed
- reversal_of_journal_id
- memo
- created_by / posted_by
- timestamps

**JournalLine**
- id
- journal_entry_id
- line_no
- account_id
- debit_amount_txn
- credit_amount_txn
- debit_amount_base
- credit_amount_base
- tax_code_id nullable
- dimension fields
- customer_id nullable
- supplier_id nullable
- item_id nullable
- project_id nullable
- description

### 11.3 Posting patterns

Examples:

**Sales invoice**
- Dr Accounts Receivable
- Cr Revenue
- Cr Output Tax Payable

**Customer payment**
- Dr Bank
- Cr Accounts Receivable

**Vendor bill**
- Dr Expense or Inventory/Asset
- Dr Input Tax Recoverable
- Cr Accounts Payable

**Supplier payment**
- Dr Accounts Payable
- Cr Bank

**Inventory sale (if perpetual inventory enabled)**
- Dr COGS
- Cr Inventory

**Depreciation**
- Dr Depreciation Expense
- Cr Accumulated Depreciation

### 11.4 Posting service responsibilities

`AccountingPostingService` should:

- validate source document status and invariants
- derive posting template/policy
- resolve accounts from configuration/item/customer/supplier/tax settings
- perform exchange rate conversion
- generate journal header and lines
- enforce balanced entry
- persist journal in single DB transaction with source state update
- publish `JournalPosted` domain event

### 11.5 Idempotency

Posting endpoints and event consumers must be idempotent.

Implementation:

- unique key on `(source_type, source_id, posting_version)`
- idempotency token on API mutation requests
- outbox pattern for domain event publication

### 11.6 Reversal strategy

- direct delete of posted entries is forbidden
- reversal creates equal and opposite journal with link to original
- corrected re-posting may create a new source version and posting version

---

## 12. Chart of Accounts Design

### 12.1 Account types

- Asset
- Liability
- Equity
- Revenue
- Cost of Sales
- Expense
- Other Income
- Other Expense

### 12.2 Account attributes

- account code
- name
- type / subtype
- parent account
- currency restriction optional
- allow manual posting flag
- reconciliation required flag
- tax default
- active flag
- system account flag
- normal balance side

### 12.3 System accounts

Tenant/company setup must bind mandatory system accounts such as:

- Accounts Receivable
- Accounts Payable
- Suspense / Uncategorized
- Bank clearing
- Sales tax payable
- Sales tax receivable/input VAT
- Retained earnings
- Current year earnings
- Inventory asset
- COGS
- Undeposited funds
- FX gain/loss
- Payroll liabilities

---

## 13. Customer, Supplier, and Item Master Design

### 13.1 Customer master

Fields:

- code
- legal/trading name
- billing/shipping addresses
- contacts
- tax/VAT number
- payment terms
- default currency
- default receivable account
- default revenue account override optional
- default tax code
- credit limit
- risk status
- statement delivery preferences

### 13.2 Supplier master

Fields:

- code
- legal name
- remittance details
- addresses
- contacts
- tax registration number
- payment terms
- default expense account/category
- default AP account
- default tax code
- withholding tax settings optional

### 13.3 Item master

Fields:

- type: service | non_inventory | inventory | bundle
- SKU/code
- name
- description
- sales price
- purchase cost
- revenue account
- expense/COGS account
- inventory asset account
- tax codes (sale/purchase)
- unit of measure
- track quantity flag
- reorder point
- active flag

---

## 14. Accounts Receivable Module Design

### 14.1 Document lifecycle

**Estimate**
- draft -> sent -> accepted/rejected -> converted

**Invoice**
- draft -> approved optional -> sent -> partially_paid -> paid -> void/credited

**Credit note**
- draft -> approved -> posted -> applied/refunded

### 14.2 Invoice numbering

Support sequences per company and optionally per document type, branch, or channel.

Format examples:
- INV-2026-000123
- CRN-2026-000077

### 14.3 Invoice capabilities

- line items, free text, taxes, discounts
- subtotal, tax, total, balance due
- due dates from terms
- attachments
- branding templates
- email sending and tracking
- partial payments
- payment links
- recurring scheduling
- credit application
- write-off flows

### 14.4 Accounting behavior

- posting on invoice issue or approval depending on config
- cash basis reporting derived from settlement events, not separate source docs
- overpayments stored as customer credits or unapplied cash

### 14.5 Dunning

Configurable reminder workflow:

- reminder before due date
- reminder on due date
- reminder after 7/14/30 days
- escalate to statement or collections status

---

## 15. Accounts Payable Module Design

### 15.1 Bill ingestion

Input channels:

- manual entry
- OCR/email capture
- supplier portal upload optional
- API import
- PO to bill conversion

### 15.2 Bill lifecycle

- draft -> submitted -> approved -> posted -> scheduled -> paid -> closed

### 15.3 Approval workflow

Approval policy can be based on:

- amount threshold
- supplier risk
- account category
- department/project
- spend type

### 15.4 Payment run

Features:

- select due bills
- respect terms, holds, and cash constraints
- choose payment method
- generate payment batch
- export bank payment file / API payment request
- reconcile settlement

### 15.5 Duplicate bill prevention

Enforce near-duplicate detection using:

- supplier + invoice number unique constraint
- fuzzy match on amount/date/reference

---

## 16. Banking and Reconciliation Module Design

### 16.1 Bank feeds

Sources:

- Open Banking APIs
- direct bank integrations
- aggregator integration providers
- file imports: CSV, OFX, QIF, CAMT.053

### 16.2 Bank transaction model

Fields:

- external_txn_id
- bank_account_id
- booking_date
- value_date
- amount
- currency
- description
- counterparty
- reference
- status
- imported_hash
- reconciliation_state

### 16.3 Matching engine

Match bank transactions against:

- customer receipts
- supplier payments
- invoices/bills
- transfers
- existing ledger entries
- rule-based categorisation

Matching strategies:

1. exact reference + amount
2. exact amount + near date
3. counterparty + rule
4. ML suggestion score
5. manual review queue

### 16.4 Reconciliation workflow

- load statement/bank feed lines
- display opening/closing balances
- auto-match candidates
- user confirms or creates adjustment
- system marks reconciled items
- store reconciliation snapshot and sign-off

### 16.5 Special flows

- deposits in transit
- undeposited funds
- bank fees
- foreign bank charges
- merchant processor clearing
- inter-account transfers

---

## 17. Tax Engine Design

### 17.1 Requirements

- tax code per line and defaults from account/item/contact
- effective-dated tax rates
- tax inclusive or exclusive calculations
- compound tax optional in some jurisdictions
- filing period summarisation
- manual override with audit trail

### 17.2 Tax model

**TaxCode**
- code
- name
- direction: sales | purchase | both
- rate type: percentage | fixed | exempt | reverse_charge
- jurisdiction
- recoverability rules
- effective_start / effective_end

### 17.3 Calculation rules

At document line level:

- determine line net amount
- apply discount precedence
- derive tax base
- calculate tax amount with required precision and rounding mode
- aggregate by tax code and return bucket

### 17.4 Filing support

Support export interfaces rather than hard-coding every country initially.

Approach:

- common tax abstraction in core
- country packs for forms, boxes, exports, and validations

---

## 18. Inventory Accounting Design

### 18.1 Valuation choices

V1 recommendation:

- average cost as default for simplicity
- FIFO optional in higher edition if team capacity allows

### 18.2 Inventory movements

Every stock-affecting event creates `InventoryMovement` records:

- purchase receipt / bill
- sales invoice / shipment
- return
- stock adjustment
- opening balance load
- transfer

### 18.3 Accounting entries

- purchase of stock: Dr Inventory, Cr AP/Bank
- sale of stock: Dr AR/Bank, Cr Revenue/Tax; and Dr COGS, Cr Inventory
- stock adjustment gain/loss to adjustment account

### 18.4 Negative inventory policy

Configurable:

- block transaction
- warn only
- allow temporary negative with valuation adjustment later

---

## 19. Fixed Asset Module Design

### 19.1 Asset lifecycle

- acquisition
- capitalization
- depreciation
- transfer
- impairment
- disposal

### 19.2 Required fields

- asset code
- description
- acquisition date
- in-service date
- cost
- salvage value
- useful life
- depreciation method
- asset account
- accumulated depreciation account
- depreciation expense account
- location/department/project

### 19.3 Depreciation run

Background job monthly:

- select active assets
- compute periodic depreciation
- create depreciation run batch
- generate and post journal
- lock run after approval

---

## 20. Projects, Dimensions, and Cost Allocation

### 20.1 Dimensions

Support flexible dimensions:

- department
- class
- location
- project
- custom tags

### 20.2 Design approach

For flexibility, use a generic dimension model:

- `dimension_type`
- `dimension_value`
- bridge table for line allocations or store a limited number of typed FK columns for performance-critical reports

Recommended hybrid:

- typed columns for main dimensions (department_id, project_id, location_id, class_id)
- generic tag mapping for extensibility

### 20.3 Allocations

Support cost allocation rules:

- percentage split across dimensions
- recurring allocation templates
- headcount or revenue driver imports in later phase

---

## 21. Reporting Design

### 21.1 Reporting principles

- accounting reports should run from posted ledger and dimension tables only
- operational reports may join source documents and status tables
- all financial statements must support date ranges, comparison periods, dimensions, and currency display modes

### 21.2 Standard report catalog

**Financial statements**
- Profit & Loss
- Balance Sheet
- Cash Flow Statement (indirect method initially)
- Trial Balance
- General Ledger
- Journal Report

**AR/AP**
- Customer Aging
- Supplier Aging
- Invoice List
- Bill List
- Collections Dashboard

**Tax**
- Tax Summary
- Tax Detail
- Filing Period Summary

**Inventory/Projects**
- Inventory Valuation
- Stock Movement
- COGS Analysis
- Project Profitability
- Budget vs Actual

### 21.3 Report engine

Recommended implementation:

- metadata-driven report definitions
- SQL views or query builders for core datasets
- saved filters and column sets
- export to CSV/XLSX/PDF
- scheduled email delivery

### 21.4 Performance strategy

- indexed ledger tables
- monthly summary/materialized tables for common reports
- asynchronous generation for large reports
- cache by parameter signature with short TTL where allowed

---

## 22. Workflow, Approvals, and Notifications

### 22.1 Approval scenarios

- bill approval
- manual journal approval
- expense approval
- supplier onboarding approval
- payment batch approval
- bank rule changes approval

### 22.2 Notification channels

- in-app
- email
- webhook
- mobile push optional

### 22.3 Rules engine

Simple rules engine first:

- trigger on event type
- condition expression over document fields
- action: assign approver, send notification, block posting, require review

---

## 23. Attachments, OCR, and Document Management

### 23.1 Attachment support

- invoices
- bills
- receipts
- bank statements
- contracts/supporting evidence
- payroll files

### 23.2 OCR pipeline

Suggested flow:

1. upload receipt or bill
2. virus scan
3. store object
4. OCR extraction job
5. parse fields: supplier, invoice number, date, due date, tax, totals, line candidates
6. confidence scoring
7. human review UI
8. create draft bill/expense

### 23.3 Controls

- file type and size restrictions
- malware scanning
- retention policies
- immutable evidence storage option for compliance editions

---

## 24. API Design

### 24.1 API style

Primary external API: REST JSON, versioned under `/api/v1`.

Examples:

- `POST /api/v1/customers`
- `GET /api/v1/invoices/{id}`
- `POST /api/v1/invoices/{id}/send`
- `POST /api/v1/bills/{id}/approve`
- `POST /api/v1/bank-transactions/{id}/match`
- `POST /api/v1/journals/manual`
- `GET /api/v1/reports/profit-and-loss`

### 24.2 API standards

- OpenAPI 3.1 specification
- idempotency key on mutation endpoints
- cursor pagination
- sparse field selection optional
- filtering/sorting conventions
- standardized error envelope

### 24.3 Example response envelope

```json
{
  "data": {
    "id": "inv_01J...",
    "type": "invoice",
    "attributes": {
      "number": "INV-2026-000123",
      "status": "sent",
      "currency": "GBP",
      "total": 1250.00,
      "balance_due": 1250.00
    }
  },
  "meta": {
    "request_id": "req_..."
  }
}
```

### 24.4 Webhooks

Emit events such as:

- customer.created
- invoice.created
- invoice.sent
- invoice.paid
- bill.approved
- payment.batch.completed
- journal.posted
- bank_transaction.imported
- reconciliation.completed

Webhook requirements:

- signed payloads (HMAC)
- retries with backoff
- dead-letter queue
- replay tooling

---

## 25. Example Backend Module Structure (NestJS)

```text
src/
  modules/
    auth/
    tenancy/
    companies/
    accounts/
    ledger/
    customers/
    suppliers/
    items/
    invoices/
    bills/
    banking/
    tax/
    inventory/
    fixed-assets/
    projects/
    reports/
    workflows/
    attachments/
    integrations/
    audit/
  common/
    db/
    events/
    guards/
    interceptors/
    utils/
  jobs/
  main.ts
```

### 25.1 Module layering

Each module should contain:

- controller/API layer
- application services/use cases
- domain models and policies
- repository interfaces
- infrastructure adapters
- DTOs/validators
- event handlers

---

## 26. Example Posting Policy Code Sketch (TypeScript)

```ts
export interface PostingLine {
  accountId: string;
  debitBase: number;
  creditBase: number;
  memo?: string;
  dimensions?: {
    projectId?: string;
    departmentId?: string;
    locationId?: string;
    classId?: string;
  };
}

export interface PostingResult {
  sourceType: string;
  sourceId: string;
  journalDate: string;
  currency: string;
  exchangeRate: number;
  lines: PostingLine[];
}

export interface PostingPolicy<TSource> {
  supports(sourceType: string): boolean;
  build(source: TSource): Promise<PostingResult>;
}

export class SalesInvoicePostingPolicy implements PostingPolicy<SalesInvoice> {
  supports(sourceType: string): boolean {
    return sourceType === 'sales_invoice';
  }

  async build(source: SalesInvoice): Promise<PostingResult> {
    const lines: PostingLine[] = [];

    lines.push({
      accountId: source.receivableAccountId,
      debitBase: source.totalBase,
      creditBase: 0,
      memo: `AR for ${source.number}`,
      dimensions: { projectId: source.projectId }
    });

    for (const item of source.lines) {
      lines.push({
        accountId: item.revenueAccountId,
        debitBase: 0,
        creditBase: item.netAmountBase,
        memo: item.description,
        dimensions: { projectId: item.projectId ?? source.projectId }
      });

      if (item.taxAmountBase > 0) {
        lines.push({
          accountId: item.outputTaxAccountId,
          debitBase: 0,
          creditBase: item.taxAmountBase,
          memo: `Tax ${item.taxCode}`
        });
      }
    }

    return {
      sourceType: 'sales_invoice',
      sourceId: source.id,
      journalDate: source.invoiceDate,
      currency: source.currencyCode,
      exchangeRate: source.exchangeRate,
      lines
    };
  }
}
```

---

## 27. Database Design Notes

### 27.1 Relational database

Use PostgreSQL.

Reasons:

- transactional integrity
- strong indexing and query capability
- JSONB for flexible fields
- partitioning options for large ledger tables
- mature tooling

### 27.2 Table design standards

- UUID or ULID primary keys
- `tenant_id`, `company_id` on all business tables
- `created_at`, `updated_at`, `created_by`, `updated_by`
- soft-delete only for non-financial masters where appropriate
- posted financial tables never hard deleted from app logic

### 27.3 Important indexes

- `(tenant_id, company_id, status)` on document tables
- `(tenant_id, company_id, posting_date, account_id)` on journal lines
- `(tenant_id, company_id, customer_id, due_date)` on invoices
- `(tenant_id, company_id, supplier_id, due_date)` on bills
- `(tenant_id, company_id, bank_account_id, booking_date)` on bank transactions
- unique `(tenant_id, company_id, supplier_id, supplier_invoice_number)`
- unique `(tenant_id, company_id, source_type, source_id, posting_version)` on journals

### 27.4 Partitioning

For scale, partition:

- journal_entry / journal_line by company or by posting month for large tenants
- audit_log by month
- activity_event by month

---

## 28. Example Core Tables (Condensed)

```sql
create table accounts (
  id uuid primary key,
  tenant_id uuid not null,
  company_id uuid not null,
  code varchar(30) not null,
  name varchar(200) not null,
  type varchar(30) not null,
  subtype varchar(50),
  parent_account_id uuid,
  is_system boolean not null default false,
  allow_manual_posting boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, company_id, code)
);

create table journal_entries (
  id uuid primary key,
  tenant_id uuid not null,
  company_id uuid not null,
  source_type varchar(50) not null,
  source_id uuid not null,
  posting_version int not null default 1,
  journal_number varchar(50) not null,
  journal_date date not null,
  posting_date date not null,
  status varchar(20) not null,
  currency_code char(3) not null,
  exchange_rate numeric(18,8) not null,
  total_debit_base numeric(18,2) not null,
  total_credit_base numeric(18,2) not null,
  reversal_of_journal_id uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, company_id, source_type, source_id, posting_version)
);

create table journal_lines (
  id uuid primary key,
  tenant_id uuid not null,
  company_id uuid not null,
  journal_entry_id uuid not null references journal_entries(id),
  line_no int not null,
  account_id uuid not null references accounts(id),
  debit_base numeric(18,2) not null default 0,
  credit_base numeric(18,2) not null default 0,
  customer_id uuid,
  supplier_id uuid,
  project_id uuid,
  department_id uuid,
  description text,
  created_at timestamptz not null default now()
);
```

---

## 29. Frontend Design

### 29.1 UX goals

- clean finance-first interface
- fast data entry
- minimal clicks for common tasks
- strong visibility of draft vs posted vs paid/reconciled states
- role-appropriate dashboards
- spreadsheet-like editing where useful

### 29.2 Major screens

1. Dashboard
2. Customers
3. Invoices
4. Suppliers
5. Bills
6. Banking feed/reconciliation
7. Chart of accounts
8. Manual journals
9. Reports center
10. Inventory/items
11. Fixed assets
12. Projects/budgets
13. Settings
14. Audit log
15. Import center

### 29.3 UI patterns

- list + filter + detail drawer
- document header + lines grid + totals sidebar
- wizard for import/reconciliation
- timeline/activity panel on record pages
- approval banner / lock banner

### 29.4 Accessibility

- WCAG 2.2 AA target
- keyboard support for line entry and reconciliation
- screen-reader labels
- high-contrast mode support

---

## 30. Security Design

### 30.1 Authentication

- OIDC/OAuth2
- email/password for SMB edition with MFA option
- SSO SAML/OIDC for enterprise edition
- session rotation and device management

### 30.2 Authorization

- RBAC plus policy conditions
- company-scoped permissions
- maker-checker separation for sensitive actions

### 30.3 Data protection

- TLS everywhere
- encryption at rest
- field-level encryption for bank credentials/tokens and sensitive identifiers
- KMS-managed keys
- secure audit logs

### 30.4 Security controls

- immutable audit trail for posting and approvals
- anomaly detection for suspicious changes
- period lock enforcement
- IP allowlisting optional
- SCIM provisioning for enterprise
- secret rotation
- dependency and container scanning

### 30.5 Fraud and abuse controls

- duplicate payment detection
- account takeover monitoring
- unusual bank rule change alerts
- high-value transaction approvals
- payment detail change confirmation workflow

---

## 31. Compliance and Auditability

### 31.1 Audit requirements

Track:

- who created/edited/sent/approved/posted documents
- before/after snapshots for mutable records
- login and permission changes
- report exports
- attachment uploads/downloads
- reconciliation sign-offs

### 31.2 Data retention

Configurable by jurisdiction and plan.

Suggested defaults:
- financial records: 7–10 years
- audit logs: 7 years minimum
- attachments: aligned with record retention

### 31.3 Period close controls

- soft close: warn or restrict edits
- hard close: block posting before close date without privileged override
- close checklist and sign-off record

---

## 32. Performance and Scalability Targets

### 32.1 Baseline targets

- page list load: < 2 seconds for typical tenant workloads
- invoice create/save draft: < 1 second median
- post document: < 2 seconds median
- bank reconciliation screen load: < 3 seconds for 1,000 pending transactions with pagination/virtualization
- standard report: < 5 seconds for SMB tenants

### 32.2 Scale assumptions

Support in initial architecture:

- 10,000+ tenants
- up to 100 companies per enterprise tenant
- up to 50M journal lines per large company with partitioning strategy

### 32.3 Scalability techniques

- read replicas
- partitioned ledger tables
- async report generation
- cache reference/master data
- batch imports and streaming job workers
- outbox pattern and event consumers for integrations

---

## 33. Background Jobs and Scheduling

### 33.1 Job types

- recurring invoice generation
- recurring bill generation
- depreciation runs
- report schedules
- dunning reminders
- bank feed sync
- exchange rate sync
- webhook retries
- OCR extraction
- tax return snapshot generation

### 33.2 Reliability

- job idempotency
- retries with backoff
- dead-letter queue
- job observability and replay tooling

---

## 34. Integrations

### 34.1 Core integrations

- banks / open banking
- payment gateways
- payroll providers
- tax filing services
- CRM/e-commerce platforms
- document storage
- email providers

### 34.2 Integration architecture

Use adapter pattern with canonical internal events.

Example:

- `InvoicePaid` internal event
- payment adapter listens and updates processor/refunds if needed
- CRM adapter syncs customer balance status

### 34.3 Import/export

Support CSV/XLSX templates for:

- chart of accounts
- customers
- suppliers
- items
- invoices
- bills
- opening balances
- bank transactions

---

## 35. Observability and Operations

### 35.1 Logging

- structured JSON logs
- correlation/request IDs
- actor and tenant context
- redaction of sensitive data

### 35.2 Metrics

- API latency/error rate
- posting throughput
- report generation duration
- reconciliation auto-match rate
- OCR confidence and correction rate
- webhook success rate
- queue backlog

### 35.3 Tracing

Distributed tracing for API -> DB -> job -> integration flows.

### 35.4 Operational dashboards

- platform health
- financial posting failures
- reconciliation backlog
- integration sync failures
- tenant usage and limits

---

## 36. Testing Strategy

### 36.1 Test layers

- unit tests for domain rules and calculations
- integration tests for DB repositories and posting flows
- contract tests for public APIs and webhooks
- end-to-end tests for main finance journeys
- performance/load tests on ledger and reporting
- security tests and penetration testing

### 36.2 Critical test areas

1. journal balancing invariants
2. multi-currency conversions
3. tax calculations and rounding
4. invoice/bill lifecycle transitions
5. reconciliation matching correctness
6. period lock enforcement
7. role/permission enforcement
8. duplicate bill/invoice prevention
9. reversal and adjustment flows
10. audit log completeness

### 36.3 Example invariant tests

- posted journals cannot be edited directly
- every source posting produces balanced ledger
- reversing journal negates original amounts exactly
- invoice total equals net + tax - discounts + charges
- bank reconciliation cannot reconcile same bank line twice

---

## 37. Migration and Onboarding

### 37.1 Initial setup wizard

- company profile
- base currency
- fiscal year start
- tax registration and scheme
- chart of accounts template
- invoice branding
- bank account connection
- import opening balances
- invite accountant/users

### 37.2 Legacy migration

Import from spreadsheets or other systems:

- customers/suppliers/items
- unpaid invoices/bills
- chart of accounts
- trial balance/opening balances
- historical transactions optional by migration tier

### 37.3 Validation

- file schema validation
- account code resolution
- total balancing checks
- migration preview with errors/warnings

---

## 38. Release Plan / Phased Delivery

### Phase 1: Foundational SMB accounting

- tenant/company/auth/RBAC
- chart of accounts
- customers/suppliers/items
- invoices, bills, expenses
- ledger posting engine
- bank imports + basic reconciliation
- tax engine baseline
- standard reports
- audit log
- CSV import/export

### Phase 2: Automation and scale

- open banking sync
- approval workflows
- recurring transactions
- OCR bill capture
- projects/dimensions
- budgets
- inventory accounting
- payment integrations
- scheduled reports/webhooks

### Phase 3: Advanced finance

- fixed assets
- multi-entity/consolidation basics
- advanced cash flow forecasting
- stronger analytics/data warehouse sync
- country packs and filing connectors
- enterprise SSO/SCIM/compliance enhancements

---

## 39. Key Risks and Mitigations

### 39.1 Accounting correctness risk

**Risk:** incorrect postings or silent data corruption  
**Mitigation:** posting policy tests, append-only ledger, maker-checker, invariants, reconciliation controls

### 39.2 Tax complexity risk

**Risk:** jurisdiction-specific edge cases  
**Mitigation:** tax abstraction + country packs + configurable rates + specialist review

### 39.3 Multi-currency complexity

**Risk:** FX gains/losses and unrealized revaluation errors  
**Mitigation:** base+transaction currency model, formal revaluation routines, strong test coverage

### 39.4 Premature microservices complexity

**Risk:** delivery slowdown and inconsistent data  
**Mitigation:** modular monolith first, outbox/events, extract only when needed

### 39.5 Reconciliation usability risk

**Risk:** users abandon automation if match quality is poor  
**Mitigation:** rule engine first, explainable suggestions, human override, precision-first matching

---

## 40. Recommended Implementation Decisions

1. Use **TypeScript + NestJS + PostgreSQL + Redis + React**.
2. Start with **modular monolith**.
3. Use **append-only posted ledger**.
4. Implement **document drafts + explicit posting**.
5. Use **average cost inventory** first unless FIFO is a hard requirement.
6. Build **tax engine abstraction** with country-specific plugins.
7. Design for **multi-currency and dimensions from day one**.
8. Use **outbox pattern** for integrations and webhook reliability.
9. Build **strong auditability** before advanced AI automation.
10. Keep AI/OCR/categorisation suggestions **human-reviewable**.

---

## 41. Suggested Repository Structure

```text
/apps
  /web
  /api
/packages
  /ui
  /types
  /config
  /eslint-config
  /report-definitions
  /sdk
/infrastructure
  /terraform
  /k8s
/docs
  /architecture
  /api
  /runbooks
```

Monorepo tooling:
- pnpm workspaces
- Turborepo or Nx

---

## 42. Example Non-Functional Requirements

- availability target: 99.9% for standard edition, higher for enterprise
- RPO: <= 15 minutes
- RTO: <= 4 hours
- all critical actions logged
- MFA available for all users; mandatory for admins
- support at least 2 decimal currencies and configurable precision for quantities/rates
- APIs backward compatible within major version
- time zone aware, but accounting dates controlled per company rules

---

## 43. Open Technical Decisions for the Team

1. Will v1 support one company per tenant only, or multiple companies under one tenant?
2. Is inventory valuation required in v1, and if yes, average cost only or FIFO?
3. Must tax filing exports target specific jurisdictions on day one?
4. Is native online payment acceptance required in v1 or only integration hooks?
5. Is project accounting mandatory in the first release?
6. Do we require hard real-time open banking sync, or periodic sync is acceptable?
7. Will manual journals require approval in all editions, or only enterprise?
8. Are cash-basis reports a hard requirement in v1?
9. Is there a requirement for document e-signature/quote acceptance?
10. Should consolidation and intercompany be reserved entirely for phase 3?

---

## 44. Conclusion

A QuickBooks-like accounting platform should be built around a strict accounting engine rather than around UI workflows alone. In practice, invoices, bills, bank feeds, taxes, inventory, and reports are all source workflows that ultimately depend on a reliable, balanced, auditable ledger.

For implementation, the highest-value path is:

- modular monolith
- PostgreSQL source of truth
- strong posting engine
- practical SMB workflows first
- automation layered on top of governed accounting controls

This design is intentionally broad enough to support a commercial product while remaining concrete enough for implementation planning.

---

## Appendix A: Reference Scope Benchmark

The following public product pages were reviewed to benchmark common feature scope for a modern QuickBooks-like product:

1. QuickBooks UK: https://quickbooks.intuit.com/uk/
2. QuickBooks Online: https://quickbooks.intuit.com/online/
3. QuickBooks Bank Feeds: https://quickbooks.intuit.com/global/bank-feeds/
4. QuickBooks Features: https://quickbooks.intuit.com/global/features/
5. QuickBooks Invoicing: https://quickbooks.intuit.com/accounting/invoicing/
6. QuickBooks Expense Tracking: https://quickbooks.intuit.com/global/expense-tracker/
7. QuickBooks Inventory: https://quickbooks.intuit.com/accounting/inventory/
8. QuickBooks Online Advanced: https://quickbooks.intuit.com/online/advanced/

These were used only to confirm the rough scope that users expect from this class of product, not as a line-by-line implementation source.
