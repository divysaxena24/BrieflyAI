# Database Layer — BrieflyAI

This directory contains all database-related logic for the BrieflyAI application.

## Structure

```
lib/db/
├── index.ts       # Drizzle ORM client initialization (to be implemented)
├── schema/        # Drizzle table definitions (to be implemented)
├── migrations/    # Generated SQL migration files (to be generated)
└── README.md      # This file
```

## Setup (Phase 2)

1. Define database schema tables in `schema/`
2. Run `npm run db:generate` to generate migration files
3. Run `npm run db:push` to apply migrations to the database
4. Import the `db` client from `@/lib/db` in route handlers and services

## Conventions

- All database queries go through the Drizzle ORM client
- Raw SQL should be avoided unless necessary for performance
- Every table gets a corresponding TypeScript type exported from its schema file
