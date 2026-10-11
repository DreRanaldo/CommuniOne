# CommuniOne — Claude Code Development Rules

You are working on CommuniOne, a multi-tenant community infrastructure platform.

## Product

CommuniOne allows organizations and communities to create digital community hubs.

Examples:

* Residential communities
* Churches
* Schools
* Clubs
* Associations
* Organizations

The core product is:

> One Platform. Every Community.

A single user may belong to multiple communities.

Example:

* User A → Community 1 → Owner
* User A → Community 2 → Member
* User A → Community 3 → Moderator

Community membership, roles, and permissions must therefore always be scoped to the specific community.

---

# Core Architecture

## Database

Use PostgreSQL.

The database must be designed as a multi-tenant system from the beginning.

Supabase may be used for:

* PostgreSQL
* Authentication
* Row Level Security
* Storage
* Database functions
* Database migrations

Do not design the database as if there is only one community.

Every community-owned resource must be associated with a community either directly or through a trusted foreign-key relationship.

---

# Application

Mobile application:

* React Native
* Expo
* TypeScript

Admin web application:

* Next.js
* TypeScript

Backend/database:

* PostgreSQL
* Supabase where appropriate

---

# Engineering Principles

1. Security before convenience.
2. Database integrity before UI development.
3. Multi-tenancy must be enforced at the database/security layer.
4. Never trust the client application to enforce permissions.
5. Use PostgreSQL constraints wherever possible.
6. Use Row Level Security for tenant isolation.
7. Never expose service-role credentials to the client.
8. Never hard-code secrets.
9. All database changes must use migrations.
10. Do not manually modify production databases.
11. Every important feature must have tests.
12. Do not create unnecessary abstractions.
13. Prefer simple, maintainable code.
14. Do not build features before their dependencies are complete.
15. Do not silently make major architectural decisions.
16. If an architectural decision is necessary, document it.
17. Do not add features that are outside the current development stage.

---

# Development Method

CommuniOne must be developed in small, independently verifiable stages.

Each stage has:

1. Requirements
2. Implementation
3. Database migrations if required
4. Tests
5. Security review
6. Documentation
7. Verification

Do NOT automatically continue to the next stage.

When a stage is complete:

* summarize what was built
* list files changed
* list migrations created
* list tests created
* list security considerations
* identify anything unresolved
* provide commands to verify the stage

Then STOP.

Wait for the next development instruction.

---

# Database Rules

Use UUID primary keys.

Use foreign keys.

Use NOT NULL wherever the field is required.

Use UNIQUE constraints where appropriate.

Use CHECK constraints or PostgreSQL enums where appropriate.

Use indexes based on actual query patterns.

Use timestamps consistently.

Prefer:

created_at
updated_at

for mutable entities.

Use soft deletion/archive where appropriate for data that may be required for moderation, audit, or legal purposes.

Do not permanently delete important audit/security records.

---

# Multi-Tenant Rules

Every community-owned resource must have a reliable community scope.

Never allow a user from Community A to access data belonging to Community B.

Never rely only on:

* React Native logic
* UI visibility
* API parameters
* client-side role checks

Tenant isolation must be enforced server-side and preferably at the PostgreSQL RLS level.

---

# Authorization

Permissions are more important than hard-coded roles.

A user may have different roles in different communities.

Example:

User X:

Community A:

* Admin

Community B:

* Member

Community C:

* Moderator

Do not implement authorization using:

if user.role == "admin"

Instead authorization should be evaluated in the context of:

user
+
community
+
membership
+
role
+
permission

---

# Initial Permission System

Permissions should use keys similar to:

community.view
community.update

members.view
members.invite
members.approve
members.suspend
members.remove

roles.view
roles.manage

posts.view
posts.create
posts.edit_own
posts.delete_own
posts.moderate

comments.create
comments.edit_own
comments.delete_own
comments.moderate

announcements.view
announcements.create
announcements.manage

alerts.view
alerts.create
alerts.manage

events.view
events.create
events.manage

documents.view
documents.upload
documents.manage

audit.view

Additional permissions may be introduced when required by a later feature.

---

# Initial Product Scope

The initial MVP includes:

* User accounts
* User profiles
* Communities
* Community memberships
* Invitations
* Roles
* Permissions
* Posts
* Comments
* Reactions
* Announcements
* Alerts
* Notifications
* Events
* Event RSVPs
* Documents
* Audit logs

Do NOT implement the following during the core MVP unless explicitly requested:

* Courier system
* Complex marketplace transactions
* Service marketplace
* Advanced payments
* Advanced messaging
* Video
* AI features
* White-label mobile applications
* Complex analytics

These are future modules.

---

# Coding Rules

Before modifying code:

1. Inspect the repository.
2. Understand the existing architecture.
3. Do not overwrite existing work unnecessarily.
4. Reuse existing patterns where appropriate.
5. Do not introduce a new library unless it is justified.
6. Keep dependencies minimal.
7. Keep migrations reversible where practical.
8. Never delete data just to make a migration easier.

---

# Documentation

Maintain documentation for:

* architecture
* database schema
* authorization
* API contracts
* development stages
* important architectural decisions

Important decisions should be recorded in:

docs/architecture/

Database documentation should be maintained in:

docs/database/

---

# Definition of Done

A feature is NOT complete merely because the code compiles.

A stage is complete only when:

* implementation exists
* database changes are migrated
* constraints exist
* security is considered
* authorization is implemented
* tests exist
* tests pass
* documentation is updated
* no obvious cross-tenant security vulnerability exists
* no secrets are exposed
* the project remains buildable

---

# Current Priority

Start with the DATABASE.

Do not build the React Native UI yet.

Do not build the admin dashboard yet.

Do not build the marketplace yet.

Do not build unrelated features.

The immediate goal is to establish a secure, production-quality PostgreSQL foundation for CommuniOne.
