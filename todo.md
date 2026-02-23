# Mission: Notification System Implementation

## Project Context
- **Monorepo**: `/server` (Hono/Drizzle) | `/client` (React/Vite)
- **Technology**: TypeScript, PostgreSQL with Drizzle ORM, React 19
- **Worktrees**: 
  - Backend: `/app/notification-backend` (branch: feat/notification-backend)
  - Frontend: `/app/notification-frontend` (branch: feat/notification-frontend)

## M1: Worktree Setup | status: completed
### T1.1: Initialize Git Repository
- [x] S1.1.1: Check git status in model_md | size:S
- [x] S1.1.2: Create initial commit on main branch | size:S

### T1.2: Create Worktree 1 - Backend
- [x] S1.2.1: Create branch feat/notification-backend | size:S
- [x] S1.2.2: Create worktree at ../notification-backend | size:S
- [x] S1.2.3: Symlink node_modules | size:S

### T1.3: Create Worktree 2 - Frontend
- [x] S1.3.1: Create branch feat/notification-frontend | size:S
- [x] S1.3.2: Create worktree at ../notification-frontend | size:S
- [x] S1.3.3: Symlink node_modules | size:S

## M2: Backend Implementation (Worktree 1) | status: completed
### T2.1: Database Schema for Notifications
- [x] S2.1.1: Add notifications table to schema.ts | size:M
- [x] S2.1.2: Add notification_types enum | size:S
- [x] S2.1.3: Create TypeScript types for notification | size:S

### T2.2: Notification API Endpoints
- [x] S2.2.1: POST /api/notifications - Create notification | size:M
- [x] S2.2.2: GET /api/notifications - List user notifications | size:M
- [x] S2.2.3: PATCH /api/notifications/:id/read - Mark as read | size:S
- [x] S2.2.4: DELETE /api/notifications/:id - Delete notification | size:S

### T2.3: Notification Queue Logic
- [x] S2.3.1: Create notification service module | size:L
- [x] S2.3.2: Implement queue processing utilities | size:M

## M3: Frontend Implementation (Worktree 2) | status": completed
### T3.1: Notification Types
- [x] S3.1.1: Create shared notification types | size:S

### T3.2: Notification Bell Component
- [x] S3.2.1: Create NotificationBell.tsx component | size:L
- [x] S3.2.2: Add notification dropdown panel | size:M
- [x] S3.2.3: Implement unread count badge | size:S

### T3.3: Notification API Client
- [x] S3.3.1: Create notification API hooks | size:M
- [x] S3.3.2: Connect to backend RPC | size:S

## M4: Type Integration & Verification | status": completed
### T4.1: AST-Based Type Verification
- [x] S4.1.1: Use AST MCP to verify notification type mapping | size:M
- [x] S4.1.2: Check frontend correctly uses backend types | size:S

### T4.2: Final Merge & Verification
- [x] S4.2.1: Merge backend worktree to main | size:S
- [x] S4.2.2: Merge frontend worktree to main | size:S
- [x] S4.2.3: Run full system verification | size:L
