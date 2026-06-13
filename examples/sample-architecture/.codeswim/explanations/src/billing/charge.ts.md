---
name: Charge workflow
description: Coordinates validation, payment authorization, and charge persistence.
tags: [billing, source, explanation]
---

## Purpose

This file owns the successful charge workflow. It keeps payment-provider work
and local persistence in a single ordered operation so callers receive a
stable result.

## Flow

1. Validate the requested amount and account.
2. Ask the payment provider to authorize the charge.
3. Persist the accepted transaction.
4. Return the recorded charge identifier.

## Failure modes

Validation failures stop before external work. Provider failures do not create
a local charge. Persistence failures require reconciliation because external
authorization may already have succeeded.

## Related documents

- [Charge flow](../../../../charge-flow.md)
- [Billing subsystem](../../../../billing.md)
