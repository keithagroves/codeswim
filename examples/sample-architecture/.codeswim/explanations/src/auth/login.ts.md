---
name: Login handler
description: Validates credentials and establishes an authenticated session.
tags: [auth, source, explanation]
---

## Purpose

The login handler is the authentication boundary for username and password
requests. It converts untrusted request data into either a signed session or a
stable authentication error.

## Flow

1. Validate the submitted credentials.
2. Load the matching user record.
3. Compare the supplied password with the stored credential.
4. Issue the session token returned to the caller.

## Boundaries

The handler owns request orchestration, not password storage or token policy.
Those decisions belong to the surrounding authentication subsystem.

## Related documents

- [Authentication](../../../../auth.md)
- [System overview](../../../../overview.md)
