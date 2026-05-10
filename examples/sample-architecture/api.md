---
name: API Gateway
description: Routes inbound HTTP traffic to internal services and enforces auth.
tags: [service, edge]
---

The API gateway is the only public surface. It validates JWT tokens via the
auth service, then forwards the request to the appropriate downstream
subsystem.

```mermaid
flowchart LR
    Inbound[HTTPS Request] --> Router[Router]
    Router --> Authn[Auth Middleware]
    Authn --> Billing[Billing Routes]
    Authn --> Account[Account Routes]

    click Authn call navigate("./auth.md")
    click Billing call navigate("./billing.md")
```
