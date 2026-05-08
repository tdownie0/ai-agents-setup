# Multi-Agent Swarm: User Profile Dashboard (Frontend)

## Overview

This sample demonstrates the **Multi-Agent Swarm Orchestration** pattern applied to a frontend feature. A **Swarm Manager** coordinates four specialist sub-agents (Designer, CSS, HTML, JS/TS) who work in parallel with checkpoint synchronization.

**Feature**: User Profile Dashboard widget showing user info, activity stats, and preferences.

**Status**: Reference Architecture
**Applied Protocol**: `.agents/beads-enforcement.md`

---

## Agent Roles

| Role | Agent ID | Responsibility | Dependencies |
|------|----------|----------------|-------------|
| Manager | `manager/` | Decompose, create tasks, monitor, integrate | None (initiator) |
| Designer | `agent/designer` | Wireframes, design tokens, component spec, API contract | None |
| CSS Stylist | `agent/css` | Tailwind classes, animations, responsive breakpoints | Designer |
| HTML Architect | `agent/html` | Component tree, layout, ARIA attributes, data attributes | Designer |
| JS/TS Engineer | `agent/jsts` | State management, event handlers, API integration, tests | HTML Architect |

---

## Phase 1: Manager Creates the Swarm

The Swarm Manager begins by creating an epic and decomposing the feature.

### 1.1 Create Epic

```bash
bd create "Epic: User Profile Dashboard Widget" --mol-type=swarm -p 0
# ✓ Created issue: model_md-...bd-epic-profile-dashboard-a3f8
```

### 1.2 Create Sub-Tasks with Dependencies

```bash
# Wave 1: Design (no dependencies)
bd create "Design profile dashboard layout" -p 1 --parent bd-epic-profile-dashboard-a3f8 --skills=ui-design
# bd-design → model_md-...bd-design-profile

# Wave 2: CSS + HTML (depend on Design)
bd create "Implement CSS styling for dashboard" -p 2 --parent bd-epic-profile-dashboard-a3f8 --skills=css
# bd-css → model_md-...bd-css-dashboard
bd create "Write HTML structure for dashboard" -p 2 --parent bd-epic-profile-dashboard-a3f8 --skills=html
# bd-html → model_md-...bd-html-dashboard

# Wave 3: JS/TS (depends on HTML)
bd create "Add JS/TS interactivity and API calls" -p 2 --parent bd-epic-profile-dashboard-a3f8 --skills=typescript
# bd-jsts → model_md-...bd-jsts-dashboard

# Wave 4: Integration (depends on all)
bd create "Integrate and verify dashboard components" -p 1 --parent bd-epic-profile-dashboard-a3f8 --skills=integration
# bd-integrate → model_md-...bd-integrate-dashboard
```

### 1.3 Link Dependencies

```bash
bd dep add bd-css-dashboard bd-design-profile    # CSS blocked by Design
bd dep add bd-html-dashboard bd-design-profile   # HTML blocked by Design
bd dep add bd-jsts-dashboard bd-html-dashboard   # JS/TS blocked by HTML
bd dep add bd-integrate-dashboard bd-jsts-dashboard  # Integration blocked by JS/TS
bd dep add bd-integrate-dashboard bd-css-dashboard    # Integration blocked by CSS
```

### 1.4 Create Gates for Checkpointing

```bash
# Gate 1: Design contract (Designer → CSS + HTML)
bd gate create "design-contract" \
  --description "Design spec: layout, colors, typography, spacing, component structure"

# Gate 2: Component API (Designer → JS/TS)
bd gate create "component-api" \
  --description "Component props, events, data shapes for dashboard widgets"

# Gate 3: HTML structure (HTML → JS/TS)
bd gate create "html-structure" \
  --description "DOM structure, CSS classes, data attributes for JS hooks"
```

### 1.5 Validate and Launch

```bash
bd swarm validate bd-epic-profile-dashboard-a3f8
# ✓ Ready fronts: 1 (Wave 1)
#   Wave 1: 1 task (Design)
#   Wave 2: 2 tasks (CSS, HTML) — parallel
#   Wave 3: 1 task (JS/TS)
#   Wave 4: 1 task (Integration)
# ✓ Maximum parallelism: 2
# ✓ Estimated worker-sessions: 5

bd swarm create bd-epic-profile-dashboard-a3f8 --coordinator=manager/
```

---

## Phase 2: Designer Agent (Wave 1)

The Designer is unblocked and starts immediately.

### 2.1 Claim and Implement

```bash
bd ready
# ○ model_md-...bd-design-profile ● P1 Design profile dashboard layout

bd update model_md-...bd-design-profile --claim
```

### 2.2 Design Deliverables

The Designer produces:

```
apps/frontend/src/designs/profile-dashboard/
├── layout.md                   # Wireframe description
├── DESIGN_TOKENS.md            # Colors, spacing, typography
├── component-spec.json         # Component API contract
└── mockup.png                  # Visual mockup
```

### 2.3 Open Gates for Sub-Agents

```bash
# Gate 1: Design contract
bd gate open "design-contract" "
Layout: Two-column grid. Left: user avatar + name + bio. Right: stats cards + recent activity.
Colors: --primary: #6366f1, --surface: #ffffff, --bg: #f8fafc
Spacing: 4px base unit, 24px card padding, 16px gap
Typography: Inter 400/600/700, 14px body, 18px heading
"

# Gate 2: Component API
bd gate open "component-api" "
<UserProfileCard
  user={{ id: string, name: string, email: string, avatarUrl: string, bio: string }}
  variant={'compact' | 'full'}
  onEdit={(userId: string) => void}
/>
<StatsCard
  title: string
  value: string | number
  icon: ReactNode
  trend: 'up' | 'down' | 'neutral'
  trendValue?: string
/>
<ActivityList
  activities: Array<{ id: string, type: string, description: string, timestamp: string }>
/>
"
```

### 2.4 Close Task

```bash
bd close model_md-...bd-design-profile "Design complete: layout mockup, design tokens, component API spec"
```

---

## Phase 3: CSS + HTML Agents (Wave 2 - Parallel)

Wave 2 has two agents working in parallel, both blocked by the Designer's gates.

### 3.1 CSS Stylist

The CSS agent waits for the design contract gate, then starts work:

```bash
bd gate wait "design-contract"
# Contract received: colors, spacing, typography, layout

bd ready
# ○ model_md-...bd-css-dashboard ● P2 Implement CSS styling for dashboard

bd update model_md-...bd-css-dashboard --claim
```

The CSS agent implements:

```css
/* apps/frontend/src/components/ProfileDashboard/dashboard.css */
.user-profile-dashboard {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 24px;
  padding: 24px;
  background: var(--bg, #f8fafc);
  font-family: 'Inter', sans-serif;
}
```

```bash
# Verify no type/lint errors
# lsp_diagnostics clean on all changed CSS files

bd close model_md-...bd-css-dashboard "CSS: implemented dashboard layout grid, responsive breakpoints, card styles, animations"
```

### 3.2 HTML Architect

The HTML agent also waits for the design contract, then builds the component tree:

```bash
bd gate wait "design-contract"
# Contract received

bd ready
# ○ model_md-...bd-html-dashboard ● P2 Write HTML structure for dashboard

bd update model_md-...bd-html-dashboard --claim
```

The HTML agent implements:

```tsx
// apps/frontend/src/components/ProfileDashboard/Dashboard.tsx
interface DashboardProps {
  user: UserProfile;
  activities: Activity[];
  stats: StatsData;
  onEditUser: (id: string) => void;
}

export function Dashboard({ user, activities, stats, onEditUser }: DashboardProps) {
  return (
    <div className="user-profile-dashboard" data-testid="profile-dashboard">
      <aside className="dashboard-sidebar">
        <UserProfileCard
          user={user}
          variant="full"
          onEdit={onEditUser}
        />
      </aside>
      <main className="dashboard-main">
        <div className="stats-grid">
          <StatsCard title="Posts" value={stats.postCount} icon={PostsIcon} trend="up" />
          <StatsCard title="Followers" value={stats.followerCount} icon={FollowersIcon} trend="up" />
          <StatsCard title="Engagement" value={stats.engagementRate} icon={EngagementIcon} trend="neutral" />
        </div>
        <ActivityList activities={activities} />
      </main>
    </div>
  );
}
```

The HTML agent opens the gate for JS/TS:

```bash
bd gate open "html-structure" "
Component tree:
  Dashboard (container)
    ├── UserProfileCard (sidebar)
    │   ├── Avatar (img)
    │   ├── UserName (h2)
    │   ├── UserBio (p)
    │   └── EditButton (button[data-action='edit'])
    ├── StatsCard x3 (grid)
    │   ├── Icon (slot)
    │   ├── Title (span)
    │   ├── Value (strong)
    │   └── Trend (span)
    └── ActivityList
        └── ActivityItem x N
            ├── ActivityIcon (div)
            ├── Description (p)
            └── Timestamp (time)

CSS class naming: BEM-style, .component__element--modifier
Data attributes: data-testid, data-action, data-user-id
"

bd close model_md-...bd-html-dashboard "HTML: implemented Dashboard, UserProfileCard, StatsCard, ActivityList components"
```

---

## Phase 4: JS/TS Engineer (Wave 3)

The JS/TS agent is blocked by the HTML structure gate.

### 4.1 Wait and Claim

```bash
bd gate wait "html-structure"
# Structure received: component tree, data attributes, CSS classes

bd gate wait "component-api"
# API received: component props, events, data shapes

bd ready
# ○ model_md-...bd-jsts-dashboard ● P2 Add JS/TS interactivity and API calls

bd update model_md-...bd-jsts-dashboard --claim
```

### 4.2 Implement State Logic

```tsx
// apps/frontend/src/components/ProfileDashboard/useDashboard.ts
import { useState, useEffect } from 'react';
import { hc } from 'hono/client';
import type { AppType } from '@model_md/backend';

const client = hc<AppType>('/');

interface DashboardState {
  user: UserProfile | null;
  activities: Activity[];
  stats: StatsData;
  loading: boolean;
  error: string | null;
}

export function useDashboard(userId: string): DashboardState & { refresh: () => void } {
  const [state, setState] = useState<DashboardState>({
    user: null, activities: [], stats: { postCount: 0, followerCount: 0, engagementRate: '0%' },
    loading: true, error: null,
  });

  const fetchData = async () => {
    try {
      setState(prev => ({ ...prev, loading: true, error: null }));
      const [userRes, activityRes, statsRes] = await Promise.all([
        client.api.users[':id'].$get({ param: { id: userId } }),
        client.api.users[':id'].activities.$get({ param: { id: userId } }),
        client.api.users[':id'].stats.$get({ param: { id: userId } }),
      ]);
      const [user, activities, stats] = await Promise.all([
        userRes.json(), activityRes.json(), statsRes.json(),
      ]);
      setState({ user, activities, stats, loading: false, error: null });
    } catch (err) {
      setState(prev => ({ ...prev, loading: false, error: err.message }));
    }
  };

  useEffect(() => { fetchData(); }, [userId]);

  return { ...state, refresh: fetchData };
}
```

### 4.3 Verify and Close

```bash
# lsp_diagnostics clean
# Tests pass
bd close model_md-...bd-jsts-dashboard "JS/TS: implemented useDashboard hook, API integration, error handling, loading states"
```

---

## Phase 5: Integration (Wave 4)

The Integration agent waits for all Wave 2 and 3 tasks to close.

### 5.1 Verify Full Integration

```bash
# All sub-tasks should be closed
bd epic status bd-epic-profile-dashboard-a3f8
# ✓ All 5 tasks closed

# Run smoke tests
lsp_diagnostics apps/frontend/src/components/ProfileDashboard/
# ✓ Clean
```

### 5.2 Merge and Verify

```bash
# If using separate branches:
git merge feat-dashboard-design
git merge feat-dashboard-css
git merge feat-dashboard-html
git merge feat-dashboard-jsts

# Or if in same worktree: verify everything together
execute_lifecycle action="build"
execute_lifecycle action="verify"
```

### 5.3 Close Epic

```bash
bd epic close-eligible bd-epic-profile-dashboard-a3f8
# ✓ All children complete. Epic ready to close.

bd close bd-epic-profile-dashboard-a3f8 "User Profile Dashboard widget complete: design, CSS, HTML, JS/TS integrated and verified"
```

---

## Phase 6: Post-Completion Documentation

```bash
# Record architectural decisions
cat > FEATURE_README.md << 'EOF'
# User Profile Dashboard Widget

## Architecture
- Component tree defined by HTML Architect
- State management via custom hooks (JS/TS Engineer)
- Styling with Tailwind utility classes (CSS Stylist)
- All components follow the component-spec.json API contract

## Files Created
- apps/frontend/src/components/ProfileDashboard/Dashboard.tsx
- apps/frontend/src/components/ProfileDashboard/UserProfileCard.tsx
- apps/frontend/src/components/ProfileDashboard/StatsCard.tsx
- apps/frontend/src/components/ProfileDashboard/ActivityList.tsx
- apps/frontend/src/components/ProfileDashboard/useDashboard.ts
- apps/frontend/src/components/ProfileDashboard/dashboard.css
EOF
```

---

## Key Takeaways

1. **Manager sets the DAG** - Dependency graph ensures no agent starts before its inputs are ready
2. **Gates synchronize checkpoints** - Sub-agents don't poll, they wait on gates
3. **Contracts are explicit** - Design spec and component API are published as gate notes
4. **Parallel when possible** - CSS and HTML agents run simultaneously in Wave 2
5. **Integration is a task** - A dedicated integration task catches issues before epic close
6. **Everything is tracked in beads** - Every task, dependency, gate, and checkpoint is recorded
