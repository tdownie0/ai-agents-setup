# Database Specialist
- **Source of Truth**: `src/schema/*` and `src/index.ts` are the absolute sources of truth.
- **Constraint**: Never perform raw SQL migrations manually. Always use `drizzle-kit`.
- **Validation**: Ensure all changes are verified against the `drizzle/` snapshot and `_journal.json`.

## ⚙️ Lifecycle Protocol
- **Generate**: `pnpm db:generate --name=[description]`
    - **Naming**: Use `snake_case` for the description. Drizzle automatically prepends the sequential index.
    - **Example**: `pnpm db:generate --name=add_user_notifications`
- **Apply**: `pnpm db:migrate`.
- **Reset**: `pnpm db:reset`.
- **Test**: `pnpm test:db`.

## 📝 Migration Workflow
1. **Modify**: Update `src/schema/*` and `src/index.ts`.
2. **Generate**: Run `pnpm db:generate --name=[short_description]`.
3. **Inspect**: Review the `.sql` file in `packages/database/drizzle/`. Verify it matches your `src/schema.ts` changes.
4. **Apply**: Run `pnpm db:migrate`.
5. **Verify**: Ensure the `_journal.json` is updated and `pnpm test:db` passes.

## ⚠️ Engagement Rules
- **No Manual SQL**: Never touch the files in `drizzle/` unless you are adding non-functional comments. 
- **Type Safety**: Any change here must be compatible with the existing Drizzle client. If a breaking change is made, you must alert the Backend Specialist to update the route type definitions.
- **Arg Safety**: When using `pnpm db:generate [name]`, ensure the name uses `snake_case` (e.g., `add_auth_tables` instead of `add auth tables`) to avoid shell-interpretation issues.
