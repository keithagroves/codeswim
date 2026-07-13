---
name: System Overview
description: Top-level view of the example service. Click any subsystem to drill down.
tags: [overview, architecture]
---

This example shows a small e-commerce backend split into three subsystems: API
gateway, billing, and authentication. Every node links somewhere — subsystems
drill into more detailed diagrams, and the leaves land on source code. Try the
agent panel too: ask it to change something and watch it edit the diagrams
before the code.

```mermaid
flowchart TD
    Client[Web / Mobile Clients] --> API[API Gateway]
    API --> Auth[Auth Service]
    API --> Billing[Billing Service]
    Billing --> DB[(Billing DB)]
    Auth --> UserDB[(User DB)]
    Billing --> Events[[Analytics Events]]

    click Client call navigate("./api.md")
    click API call navigate("./api.md")
    click Auth call navigate("./auth.md")
    click Billing call navigate("./billing.md")
    click DB call navigate("./src/billing/db.ts")
    click UserDB call navigate("./src/auth/users.ts")
    click Events call navigate("./billing.md")
```
