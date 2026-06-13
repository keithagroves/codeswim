---
name: Refund handler
description: Validates and records refunds against existing charges.
tags: [billing, source, explanation]
---

## Purpose

The refund handler reverses all or part of a previously recorded charge while
preserving an auditable relationship to the original transaction.

## Responsibilities

- Confirm the charge exists and remains refundable.
- Validate that the requested amount does not exceed the refundable balance.
- Submit the reversal to the payment provider.
- Record the refund and updated charge balance.

## Related documents

- [Billing subsystem](../../../../billing.md)
- [System overview](../../../../overview.md)
