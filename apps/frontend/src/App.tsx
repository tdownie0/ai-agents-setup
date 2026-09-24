import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { UserTable } from "./components/UserTable";
import { NotificationBell } from "./components/NotificationBell";
import { Auth } from "./components/Auth";
import { Button } from "./components/ui/button";
import { PortfolioLeaderboard } from "./components/portfolio/PortfolioLeaderboard";
import { PortfolioDetail } from "./components/portfolio/PortfolioDetail";
import { cn } from "@/lib/utils";

type View = "users" | "portfolio";

function App() {
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("portfolio");
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center">Loading...</div>;
  }

  const switchView = (next: View) => {
    setView(next);
    setSelectedRunId(null);
  };

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-5xl">
        {!session ? (
          <div className="flex flex-col items-center justify-center pt-20">
            <Auth />
          </div>
        ) : (
          <>
            <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h1 className="text-3xl font-bold tracking-tight">
                  {view === "portfolio" ? "Portfolio Simulation" : "Users"}
                </h1>
                <p className="text-sm text-muted-foreground">{session.user.email}</p>
              </div>

              <div className="flex items-center gap-4">
                <nav
                  className="flex items-center gap-1 rounded-lg border bg-card p-1"
                  aria-label="App sections"
                >
                  <button
                    type="button"
                    onClick={() => switchView("portfolio")}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      view === "portfolio"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Portfolio
                  </button>
                  <button
                    type="button"
                    onClick={() => switchView("users")}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      view === "users"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Users
                  </button>
                </nav>
                <NotificationBell userId={session.user.id} />
                <Button variant="ghost" onClick={() => supabase.auth.signOut()}>
                  Sign Out
                </Button>
              </div>
            </div>

            {view === "portfolio" ? (
              selectedRunId === null ? (
                <PortfolioLeaderboard onSelectRun={setSelectedRunId} />
              ) : (
                <PortfolioDetail runId={selectedRunId} onBack={() => setSelectedRunId(null)} />
              )
            ) : (
              <div className="rounded-lg border bg-card">
                <UserTable />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default App;
