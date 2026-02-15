# Mission: User Management UI with shadcn Table

## Overview
Create a type-safe User interface, add shadcn Table component, and build a UserTable component that fetches data via Hono RPC.

## M1: Create User Type Interface
### T1.1: Setup types directory | agent:Worker | size:S
- [ ] Create `client/src/types/` directory
- [ ] Create `client/src/types/user.ts`
- [ ] Define User interface matching Drizzle schema:
  - id: number
  - fullName: string
  - email: string
  - createdAt: string (JSON serialized Date)
- [ ] Export User type
- [ ] Create branch `feat/user-types`
- [ ] Commit with atomic commit message

## M2: Add shadcn Table Component
### T2.1: Initialize shadcn/ui | agent:Worker | size:M
- [ ] Check if shadcn/ui is already initialized in client
- [ ] If not initialized, run shadcn init (npx shadcn@latest init)
- [ ] Configure for React + Vite + TypeScript
- [ ] Create branch `feat/shadcn-table`

### T2.2: Install Table component | agent:Worker | size:S | depends:T2.1
- [ ] Add shadcn Table component: `npx shadcn add table`
- [ ] Verify component installs to `client/src/components/ui/`
- [ ] Commit changes

## M3: Create UserTable Component
### T3.1: Create components structure | agent:Worker | size:S
- [ ] Create `client/src/components/` directory
- [ ] Create `client/src/components/UserTable.tsx`
- [ ] Create branch `feat/user-table`

### T3.2: Implement UserTable with RPC | agent:Worker | size:L | depends:T1.1,T2.2,T3.1
- [ ] Import User type from `../types/user`
- [ ] Import shadcn Table components from `../components/ui/table`
- [ ] Import `hc` from `hono/client`
- [ ] Import `AppType` from server
- [ ] Create RPC client with `hc<AppType>('http://localhost:3000/')`
- [ ] Implement useEffect to fetch users from `/api/users`
- [ ] Display users in shadcn Table with columns:
  - ID
  - Full Name
  - Email
  - Created At
- [ ] Handle loading state
- [ ] Handle error state
- [ ] Add basic styling
- [ ] Commit changes

## M4: Integration & PRs
### T4.1: Update App.tsx to use UserTable | agent:Worker | size:S | depends:T3.2
- [ ] Import UserTable component
- [ ] Replace existing user list with UserTable
- [ ] Remove direct fetch logic from App.tsx (move to UserTable)
- [ ] Test integration
- [ ] Commit changes

### T4.2: Open PRs | agent:Worker | size:M
- [ ] Push branch `feat/user-types` and create PR
- [ ] Push branch `feat/shadcn-table` and create PR  
- [ ] Push branch `feat/user-table` and create PR
- [ ] Ensure each PR has clear description
- [ ] Link related PRs in descriptions

## Dependencies
- T1.1 (User types) → T3.2 (UserTable implementation)
- T2.1 (shadcn init) → T2.2 (Table component)
- T2.2 + T1.1 + T3.1 → T3.2 (Full UserTable)
- T3.2 → T4.1 (Integration)

## Notes
- Use RPC pattern from AGENTS.md
- CORS already enabled on server
- Server endpoint: GET /api/users
- Client already has hono dependency
- Follow existing TypeScript patterns
