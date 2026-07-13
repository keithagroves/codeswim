---
name: Authentication
description: Handles user login, session tokens, and password resets.
tags: [service, auth, security]
---

Auth issues short-lived JWTs after verifying credentials against the user
database. Login orchestration lives in `src/auth/login.ts`; credential lookup
and token signing are split into their own modules.

```mermaid
flowchart TD
    Login[Login Endpoint] --> Verify[Credential Verification]
    Verify --> UserDB[(User DB)]
    Verify --> Token[JWT Issuer]
    Token --> Client[Authenticated Client]

    click Login call navigate("./src/auth/login.ts")
    click Verify call navigate("./src/auth/users.ts")
    click UserDB call navigate("./src/auth/users.ts")
    click Token call navigate("./src/auth/jwt.ts")
    click Client call navigate("./overview.md")
```

## Source

- [src/auth/login.ts](./src/auth/login.ts) — the login flow: lookup, verify, issue.
- [src/auth/users.ts](./src/auth/users.ts) — user lookup and password verification.
- [src/auth/jwt.ts](./src/auth/jwt.ts) — session token issuing.
