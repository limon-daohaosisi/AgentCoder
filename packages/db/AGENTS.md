# Database Migration Agent Notes

This package is the source of truth for database schema and migrations.

## Rules

1. Do not edit any migration file that has already been applied, committed, or shared.
2. Treat every applied migration under `packages/db/migrations/` as historical record.
3. Make schema changes in `packages/db/schema/*.lt.hcl` first.
4. Generate a new migration with Atlas instead of modifying old SQL.
5. Review generated SQL before running tests, especially SQLite table rebuilds.
6. If generated SQL is manually adjusted, run `atlas migrate hash` afterward.
7. Keep ORM schema and database HCL schema aligned.

## Correct Workflow

1. Edit HCL schema files under `packages/db/schema/`.
2. From `packages/db`, generate a migration:

```bash
atlas migrate diff <migration_name> --env local
```

3. Review the new file under `packages/db/migrations/`.
4. For SQLite table rebuild migrations, check every `INSERT INTO new_* SELECT ...` statement:
   - New `NOT NULL` columns must receive values.
   - Default values may not be applied during `INSERT ... SELECT` if the column is omitted incorrectly.
   - Foreign key dependencies must be created in a valid order.
5. If the generated migration SQL is edited manually, update checksums:

```bash
atlas migrate hash --dir "file://migrations"
```

6. If schema changes affect TypeScript ORM usage, sync or update ORM definitions:

```bash
pnpm db:sync
```

7. Verify from repository root:

```bash
pnpm --filter @opencode/server typecheck
pnpm --filter @opencode/agent typecheck
pnpm --filter @opencode/server test
```

## Test Environment

Server tests should apply all SQL migrations in `packages/db/migrations/` in sorted order.

Do not make tests depend only on the initial migration file. If tests fail with missing columns after a schema change, first check whether the test helper is applying every migration.

## Common Mistakes To Avoid

1. Editing any already-applied migration directly.
2. Forgetting to add a new HCL table file when adding a table.
3. Updating ORM schema but not HCL schema.
4. Updating HCL schema but not generating a migration.
5. Manually editing generated SQL without refreshing `atlas.sum`.
6. Adding `NOT NULL` columns without a safe backfill in SQLite rebuild SQL.
7. Letting `tool_calls` and `message_parts` drift from the runtime TypeScript schema.
