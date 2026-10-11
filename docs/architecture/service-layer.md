# Service Layer Architecture (Stage 12)

## The final relationship

```
 React Native app            Admin web app
        │                          │
        └────────────┬─────────────┘
                     ▼
   Service / API layer  (services/, TypeScript, runs in the app)
   business operations · input validation · error translation ·
   pagination · safe logging          [convenience + defence in depth]
                     │  supabase-js, anon key + the user's session
                     ▼
   Authentication     Supabase Auth (GoTrue): JWT + live auth.sessions row,
                      active account (private.current_active_user_id)
                     │
                     ▼
   Authorization      has_community_permission(community, key): user +
                      community + active membership + permission
                     │
                     ▼
   PostgreSQL / Supabase
     SECURITY DEFINER RPCs for sensitive, multi-step operations
     PostgREST tables for simple authorized reads/writes
                     │
                     ▼
   RLS + column grants + constraints + triggers + rate limits
                                           [the security boundary]
```

The **database is the source of truth and the trust boundary**. Anyone can
call the Data API directly with a valid session and skip the TypeScript code,
so every rule that protects data (authentication, permissions, tenant
isolation, lifecycle, immutability, rate limits) is enforced in Postgres. The
service layer gives the apps one consistent, typed, validated way to perform
business operations, and makes errors and pagination uniform. It never holds
privileges of its own.

## Why this architecture

| Option | Decision |
|---|---|
| Separate backend (Express, Nest, …) between apps and Supabase | **Not now.** It would duplicate the authorization the database already enforces, add a second place for it to be wrong, and need its own hosting, secrets and scaling. There is no operation today that needs a secret the app must not have. |
| Supabase Edge Functions | **Reserved** for operations that need server-only secrets or third parties: push notifications, email/SMS delivery, malware scanning, scheduled purges. None exist yet. |
| SECURITY DEFINER RPCs | **Used** wherever an operation must be atomic or needs to read/write rows the caller cannot touch directly: community creation, invitations, RSVP, uploads, account deletion, listings with aggregates. |
| Direct PostgREST table access under RLS | **Used** for simple single-row operations whose rules RLS, column grants and triggers fully express (e.g. editing your own post, publishing an announcement). |
| Service layer in TypeScript, shared by both apps | **Built** (`services/`). Wraps both of the above as business operations. |

## Code layout

```
services/
  index.ts              createServices(client, { logger }) → all domain services
  database.types.ts     generated from the schema (npm run db:types; CI checks drift)
  core/
    context.ts          run(): error translation + logging; requireUserId(); mutateOne()
    errors.ts           ServiceError, 7 codes, Postgres/PostgREST → code mapping
    validate.ts         uuid, text, oneOf, int, dateTime, httpsUrl, only (mass assignment) …
    pagination.ts       Page<T>, opaque validated cursors, page size ≤ 50
    logger.ts           Logger interface, redact(), safeLogger()
  auth/ communities/ memberships/ roles/ invitations/ posts/ comments/
  announcements/ alerts/ events/ notifications/ documents/ audit/
tests/unit/             core logic, no database
tests/services/         every domain end to end against local Supabase + security suite
```

Contracts for every operation: [`../api/README.md`](../api/README.md).

## Rules every operation follows

1. **Identity from the session only.** `requireUserId()` reads the Supabase
   session; no input field carries a user id, role or permission. The database
   independently re-validates the session (Stage 2) on every request.
2. **Validate first, then let the database decide.** Ids, lengths, enums,
   dates, URLs, file metadata, page sizes and cursors are checked before any
   request. Then RLS / grants / triggers / RPC checks make the actual decision.
3. **Whitelisted inputs.** `only()` rejects unknown keys and every write maps
   explicit fields to columns, so there is no mass assignment. Column grants in
   the database are the second line (clients cannot write `author_user_id`,
   `status` of communities, `community_id` of memberships, etc.).
4. **No existence leaks.** Reading or changing a row you cannot see returns
   `NOT_FOUND`, exactly like a missing row. `mutateOne()` only reports
   `FORBIDDEN` when the row is visible to you but not changeable.
5. **Safe errors.** Postgres / PostgREST errors become one of seven codes.
   Messages written by our database functions are passed through; any message
   that mentions relations, constraints, policies, columns or SQL is replaced
   with a generic one. The original error is kept only for the logger.
6. **Bounded results.** Every list is keyset-paginated (≤ 50 per page) or has a
   hard cap (≤ 200 roles, ≤ 200 invitations, ≤ 500 folders, ≤ 50 banner
   alerts).

## Transactions (atomic operations)

Each of these runs as **one database transaction** inside one RPC or one
statement, so it either fully happens or not at all:

| Operation | What is atomic | Where |
|---|---|---|
| `communities.create` | community + Owner membership + default roles and their permissions + audit | `create_community()` |
| `invitations.redeem` | lock invitation → validate → create/activate membership → default role → redemption row → `use_count` → audit | `redeem_invitation()` (row lock) |
| `invitations.create` | permission check + token + hash + audit | `create_invitation()` |
| `events.rsvp` / `cancelRsvp` | event lock → capacity check → RSVP → waitlist position / promotion → notifications | `rsvp_to_event()`, `cancel_rsvp()` + capacity trigger |
| `memberships.approve` | status change + default role + notification + audit | one UPDATE + triggers |
| `memberships.remove` | delete + role assignments + audit | one DELETE + cascades |
| `documents.upload` | phase 1: validate + reserve path; phase 3: verify stored object + activate + audit | `create_document_upload()`, `complete_document_upload()` |
| `auth.deleteMyAccount` | guard + audit + erase personal data + keep history | `delete_my_account()` |
| any publish (announcement, alert, event) | status + stamps + outbox event + notifications + audit | one UPDATE + triggers |

The document upload has three steps (reserve, Storage upload, complete). If
the upload or completion fails, the reserved row stays `pending_upload`,
invisible to members, and the purge job removes it; nothing half-finished is
ever visible.

## Rate limiting

**Decision: per-user fixed-window counters inside Postgres** (migration 21).
The apps talk to Supabase directly, so the database is the only point every
request passes and a client cannot skip. No Redis or gateway is needed, the
counter update is transactional with the operation, and a refused attempt is
rolled back so it does not count.

| Action | Default limit | Counted at |
|---|---|---|
| `post.create` | 60 / 10 min | BEFORE INSERT on posts |
| `comment.create` | 120 / 10 min | BEFORE INSERT on comments |
| `alert.create` | 20 / hour | BEFORE INSERT on alerts |
| `invitation.create` | 50 / hour | BEFORE INSERT on invitations |
| `invitation.redeem` | 30 / hour | BEFORE INSERT on invitation_redemptions |
| `document.upload` | 60 / hour | BEFORE INSERT on documents |
| community creation | 10 / 24 hours | `create_community()` (Stage 3) |
| sign-in, sign-up, emails, token refresh, OTP | Supabase Auth limits | `config.toml [auth.rate_limit]` / dashboard |

- Exceeding a limit raises SQLSTATE `53400` with HINT `retry_after_seconds=N`;
  the service returns `RATE_LIMITED` with `details.retryAfterSeconds`.
- Limits are per user and apply to client requests only (the service role,
  migrations and jobs are not limited).
- Operators tune limits without a migration:
  `update private.rate_limit_rules set max_count = 100 where action = 'post.create';`
- `public.purge_rate_limit_counters()` (service role, e.g. hourly) drops old windows.
- Invitation guessing: invalid tokens are refused before anything is written,
  so they are not counted by the redemption limit. Tokens carry 244 random
  bits, so guessing is infeasible; IP-level throttling of the Data API, if
  wanted, belongs at the edge (Supabase network restrictions / a CDN WAF).
- Fixed windows allow a burst of up to 2× the limit across a window boundary.
  Acceptable for abuse prevention; a sliding window can replace it later
  without changing callers.

## Logging

- Services log through an injected `Logger`; the default logs nothing.
- Every field passes through `redact()`: keys like password, token, secret,
  authorization, cookie, session, jwt, api key, phone, email, card, pin, otp
  are replaced, and values that look like JWTs, invitation tokens
  (`ci_…`), Supabase keys, bearer tokens, card numbers or email addresses are
  masked, at any depth. A failing log sink never breaks a request.
- What is logged: `service.error` (operation, code, redacted cause) for
  unexpected failures; `service.rate_limited` (operation, retry-after);
  `service.refused` at debug level (operation, code).
- Tests assert that tokens, JWTs, emails and passwords never appear in logs.
- Security-relevant events are recorded by the database audit log (Stage 11),
  not by application logs.

## API security review (Stage 12)

| Area | Finding / control | Evidence |
|---|---|---|
| Authentication | Every protected operation needs a session; the database re-validates the session row and account status on every request; forged or session-less tokens resolve to nobody | `tests/unit` (fast path), `security.test.ts` (forged token, tampered token → 401), pgTAP 009 |
| Authorization | Permission keys via `has_community_permission`; no role names; anti-escalation "covers" rule | `security.test.ts` (member → admin ops), communities-and-memberships suite, pgTAP 004–006 |
| RLS | Enabled on every table; services use the anon key so RLS always applies | pgTAP 001, `security.test.ts` raw Data API section |
| Tenant isolation | A member of A gets nothing from B through any service or raw table | `security.test.ts` (every read and write into B), pgTAP 003 and 022 |
| IDOR | Swapping in another community's ids gives `NOT_FOUND` / empty; **fixed:** RSVP to a foreign vs. missing event used to fail differently (an existence oracle) and locked the foreign event row; now one uniform refusal before any lock (migration 22) | `security.test.ts` IDOR section, pgTAP 015 oracle test |
| Privilege escalation | Members cannot assign roles, approve, suspend, publish, moderate; admins cannot take Owner | suites above |
| Mass assignment | `only()` rejects unknown keys; column grants block protected columns (`author_user_id`, `user_id`, `status` of communities…) | unit tests, `security.test.ts` impersonation |
| Injection | No SQL is built from input; RPC arguments are typed parameters; the one PostgREST filter built from input (member-list cursor) uses only values matching strict ISO-timestamp / UUID patterns | unit tests (cursor filter injection), `security.test.ts` |
| Input validation | Every operation validates ids, text, enums, dates, URLs, files, page sizes | unit tests, every suite's VALIDATION cases |
| File upload abuse | MIME allow-list and size limit checked twice (reservation and real stored object); server-generated paths only; names without slashes; short-lived signed links (≤ 300 s); restricted documents invisible | content suite, pgTAP 017 |
| Rate limiting | Database-level per-user limits; Auth limits for sign-in | pgTAP 023, `security.test.ts` rate-limit test |
| Sensitive data exposure | Errors never contain SQL / schema names; invitation hashes not selectable; phone numbers owner-only; logs redacted | unit tests, `security.test.ts`, pgTAP 020/021 |
| Service-role key | Not used by the service layer; documented as server-only | `.env.example`, `docs/deployment/supabase-auth.md` |

## Performance review

- **Indexes:** every list operation is served by a keyset index created with
  its feature (posts/comments by community and time, announcements, alerts by
  severity and time, events by start time, notifications by user and time,
  documents by folder/community and time, audit by community and time). The
  member list was the only one that sorted after filtering; migration 22 adds
  `memberships (community_id, status, created_at, id)` (verified with
  `EXPLAIN`: an index-only scan in sort order, no sort step).
- **N+1:** the feed returns author, comment count, reaction count and my
  reaction in one RPC; `reactionSummary` batches up to 200 targets; the member
  list embeds profiles and roles in the same request; attendance is one RPC.
- **Repeated authorization:** RLS evaluates `has_community_permission()` per
  row. Lists are bounded at 50 rows and the function is two indexed lookups,
  so this is cheap at current scale. If it shows up in profiles, list RPCs can
  check permission once up front and filter by community.
- **Unbounded queries:** none; every list is paginated or capped (see above).
- **Rate-limit cost:** one upsert on a primary key per limited write.

## Known limitations

- The service layer runs in the client. It is not a security boundary by
  itself (the database is). This is by design for a Supabase architecture.
- No IP-based throttling of the Data API; per-user limits only (see above).
- Fixed-window rate limiting (burst at window edges).
- Realtime subscriptions are not wrapped yet (Realtime is not enabled).
