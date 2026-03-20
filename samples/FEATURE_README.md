# User Registration Feature

## Overview

The User Registration Feature provides a complete registration flow that integrates Supabase Auth (for authentication) with a local PostgreSQL database (for user profile storage). This dual-storage approach ensures both secure authentication and persistent user data.

**Status**: COMPLETED ✅  
**Date**: 2026-03-19  
**Feature Branch**: `feat-user-registration`

---

## Architecture Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          REGISTRATION FLOW                                    │
└─────────────────────────────────────────────────────────────────────────────┘

  Frontend (RegistrationForm.tsx)
           │
           │  1. User submits form (fullName, email, password)
           │     ↓
           │  2. supabase.auth.signUp({ email, password })
           │     ↓
           ├─────────────────────────────────────────────┐
           │                                             │
           ↓                                             ↓
   ┌──────────────────┐                      ┌──────────────────┐
   │  Supabase Auth   │                      │  Backend API     │
   │  (Authentication)│                      │  POST /api/auth/ │
   │                  │                      │  register        │
   │  - Creates user  │                      │                  │
   │  - Sends email   │                      │  - Receives data │
   │    confirmation  │                      │  - Validates     │
   │                  │                      │  - Inserts to DB │
   └──────────────────┘                      └──────────────────┘
           │                                             │
           │  Returns user ID                            │
           │  and session token                         │
           │                                             │
           └──────────────────────┬──────────────────────┘
                                  │
                                  ↓
                         ┌──────────────────┐
                         │  Local Database  │
                         │  (users table)   │
                         │                  │
                         │  - Stores profile│
                         │  - Links to      │
                         │    Supabase ID   │
                         └──────────────────┘
```

---

## Files Changed

### Frontend Changes

| File | Action | Description |
|------|--------|-------------|
| `apps/frontend/src/components/Auth.tsx` | MODIFY | Updated with login/registration toggle, success states |
| `apps/frontend/src/components/RegistrationForm.tsx` | CREATE | New standalone registration component with form validation |

### Backend Changes

| File | Action | Description |
|------|--------|-------------|
| `apps/backend/src/routes/auth.ts` | CREATE | POST /register endpoint for local user profile creation |
| `apps/backend/src/index.ts` | MODIFY | Mounted auth routes under /api/auth |

---

## Components

### Frontend Components

#### RegistrationForm.tsx
**Location**: `apps/frontend/src/components/RegistrationForm.tsx`  
**Lines**: 222  
**Purpose**: Standalone registration form with Supabase + backend sync

**Features**:
- Form fields: fullName, email, password, confirmPassword
- Client-side validation:
  - Email format validation (regex)
  - Password minimum length (8 characters)
  - Password confirmation match
- Supabase Auth signUp integration
- Backend API sync via Hono RPC
- Loading states and error handling
- Success state with confirmation message

**Props**:
```typescript
interface RegistrationFormProps {
  onSuccess?: () => void      // Callback when registration succeeds
  onToggleMode?: () => void  // Callback to switch to login mode
}
```

#### Auth.tsx
**Location**: `apps/frontend/src/components/Auth.tsx`  
**Lines**: 126  
**Purpose**: Main authentication container with login/registration toggle

**Features**:
- Login form with email/password
- Toggle between login and registration modes
- Success state display
- Error handling and display
- Integration with RegistrationForm component

### Backend Routes

#### auth.ts
**Location**: `apps/backend/src/routes/auth.ts`  
**Lines**: 56  
**Purpose**: Handle user registration endpoint

**Endpoint**: `POST /api/auth/register`

**Request Body**:
```typescript
{
  fullName: string       // User's full name
  supabaseUserId: string // Supabase Auth user ID (UUID)
  email: string          // User's email address
}
```

**Response (Success - 201)**:
```typescript
{
  success: true,
  user: {
    id: string,
    fullName: string,
    email: string,
    createdAt: Date
  }
}
```

**Response (Error - 400)**:
```typescript
{
  error: "Missing required fields: fullName, supabaseUserId, email"
}
```

**Response (Error - 409)**:
```typescript
{
  error: "User profile already exists"
}
```

---

## API Endpoint

### POST /api/auth/register

**Description**: Creates a user profile in the local database after successful Supabase Auth signup.

**Authentication**: Bearer token (Supabase access token) in Authorization header

**Request Example**:
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <supabase_access_token>" \
  -d '{
    "fullName": "John Doe",
    "supabaseUserId": "uuid-from-supabase",
    "email": "john@example.com"
  }'
```

**Response Example**:
```json
{
  "success": true,
  "user": {
    "id": "uuid-from-supabase",
    "fullName": "John Doe",
    "email": "john@example.com",
    "createdAt": "2026-03-19T14:30:00.000Z"
  }
}
```

---

## Environment Variables Required

### Frontend (.env.local)
```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

### Backend (.env)
```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
DATABASE_URL=postgresql://user:password@localhost:5432/model_md
PORT=3000
```

---

## Registration Flow (Step-by-Step)

1. **User submits registration form** with fullName, email, password
2. **Client-side validation** ensures all fields are valid
3. **Supabase signUp** creates the user in Supabase Auth
   - Sends confirmation email to user
   - Returns `authData.user.id` (Supabase UUID)
4. **Backend API call** to `/api/auth/register`:
   - Passes: fullName, supabaseUserId, email
   - Includes Authorization header with Supabase token
5. **Backend validation**:
   - Checks for missing required fields (400 error)
   - Checks for duplicate user (409 error)
6. **Database insertion** creates user profile in local users table
7. **Success response** returns created user object
8. **UI displays success message** with confirmation prompt

---

## Error Handling

| Error Code | Condition | User Message |
|------------|-----------|--------------|
| 400 | Missing required fields | "Missing required fields: fullName, supabaseUserId, email" |
| 409 | User already exists | "User profile already exists" |
| - | Supabase auth error | Error message from Supabase |
| - | Network error | "Registration failed" |

---

## Security Considerations

1. **Password Requirements**: Minimum 8 characters enforced client-side
2. **Email Validation**: Regex format validation before submission
3. **Password Confirmation**: User must type password twice
4. **Bearer Token**: Backend validates Supabase access token
5. **CORS**: Server configured with permissive CORS for development

---

## Testing

### Manual Testing Checklist

- [ ] Registration form renders correctly
- [ ] All form fields are present and labeled
- [ ] Validation errors show for invalid email
- [ ] Validation errors show for short password
- [ ] Validation errors show for mismatched passwords
- [ ] Successful registration shows success message
- [ ] Confirmation email is sent (check inbox)
- [ ] Toggle between login/registration works
- [ ] Login works after email confirmation

### Integration Testing

```bash
# Start the development servers
pnpm dev

# Test the registration flow
# 1. Open http://localhost:5173
# 2. Click "Register"
# 3. Fill in the form
# 4. Submit and verify success message
# 5. Check Supabase dashboard for new user
# 6. Check local database for new user record
```

---

## Dependencies

- **Frontend**: React 18, Vite, Tailwind CSS, shadcn/ui, @supabase/supabase-js, hono/client
- **Backend**: Hono, Drizzle ORM, @supabase/supabase-js
- **Database**: PostgreSQL with users table

---

## Related Documentation

- [Supabase Auth Documentation](https://supabase.com/docs/guides/auth)
- [Hono RPC Documentation](https://hono.dev/docs/api/rpc)
- [Drizzle ORM Documentation](https://orm.drizzle.team/docs/overview)
- [shadcn/ui Components](https://ui.shadcn.com/)
