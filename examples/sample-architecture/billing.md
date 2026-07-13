---
name: Billing
description: Handles charges, refunds, and subscription lifecycle.
tags: [service, payments]
---

The billing subsystem owns all money-moving operations. It depends on auth
for user identity and emits events to the analytics pipeline. Both charge and
refund go through the shared payment-provider client and persist via the
billing repository.

```mermaid
flowchart TD
    API[API Gateway] --> Charge[Charge Service]
    API --> Refund[Refund Service]
    Charge --> Provider[Payment Provider Client]
    Refund --> Provider
    Charge --> DB[(Billing DB)]
    Refund --> DB

    click API call navigate("./api.md")
    click Charge call navigate("./charge-flow.md")
    click Refund call navigate("./src/billing/refund.ts")
    click Provider call navigate("./src/billing/provider.ts")
    click DB call navigate("./src/billing/db.ts")
```

## Source

- [src/billing/charge.ts](./src/billing/charge.ts) — charge workflow (see [charge flow](./charge-flow.md)).
- [src/billing/refund.ts](./src/billing/refund.ts) — refund workflow.
- [src/billing/provider.ts](./src/billing/provider.ts) — external payment-provider client.
- [src/billing/db.ts](./src/billing/db.ts) — charge/refund persistence.
