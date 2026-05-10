---
name: System Overview
description: Top-level view of the example service. Click any subsystem to drill down.
tags: [overview, architecture]
---

This example shows a small e-commerce backend split into three subsystems: API
gateway, billing, and authentication. Each block on the diagram links to a more
detailed diagram or to the source code.

```mermaid
flowchart TD
    Client[Web / Mobile Clients] --> API[API Gateway]
    API --> Auth[Auth Service]
    API --> Billing[Billing Service]
    Billing --> DB[(Billing DB)]
    Auth --> UserDB[(User DB)]
    Billing --> Events[[Analytics Events]]

    click API call navigate("./api.md")
    click Auth call navigate("./auth.md")
    click Billing call navigate("./billing.md")
```
