import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { UserTable } from "./components/UserTable";
import { NotificationBell } from "./components/NotificationBell";
import { Auth } from "./components/Auth";
import { Button } from "./components/ui/button";
import { PortfolioLeaderboard } from "./components/portfolio/PortfolioLeaderboard";
import { PortfolioDetail } from "./components/portfolio/PortfolioDetail";
import { StreamBoard } from "./components/portfolio/StreamBoard";
import { StreamDetail } from "./components/portfolio/StreamDetail";
import { PromptSuggestions } from "./components/portfolio/PromptSuggestions";
import { cn } from "./lib/utils";

type View = "users" | "streams" | "runs" | "suggestions";

interface SelectedStream {
  simulationId: string;
  personaKey: string;
  window: string;
}

function App() {
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("streams");
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [selectedStream, setSelectedStream] = useState<SelectedStream | null>(null);

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
    setSelectedStream(null);
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
                  {view === "users"
                    ? "Users"
                    : view === "suggestions"
                      ? "Prompt Suggestions"
                      : "Portfolio Simulation"}
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
                    onClick={() => switchView("streams")}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      view === "streams"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Streams
                  </button>
                  <button
                    type="button"
                    onClick={() => switchView("runs")}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      view === "runs"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Runs
                  </button>
                  <button
                    type="button"
                    onClick={() => switchView("suggestions")}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      view === "suggestions"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Suggestions
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

            {view === "users" ? (
              <div className="rounded-lg border bg-card">
                <UserTable />
              </div>
            ) : view === "suggestions" ? (
              <PromptSuggestions />
            ) : view === "streams" ? (
              selectedStream === null ? (
                <StreamBoard
                  onSelectStream={(simulationId, personaKey, streamWindow) =>
                    setSelectedStream({ simulationId, personaKey, window: streamWindow })
                  }
                />
              ) : (
                <StreamDetail
                  simulationId={selectedStream.simulationId}
                  personaKey={selectedStream.personaKey}
                  window={selectedStream.window}
                  onBack={() => setSelectedStream(null)}
                />
              )
            ) : selectedRunId === null ? (
              <PortfolioLeaderboard onSelectRun={setSelectedRunId} />
            ) : (
              <PortfolioDetail runId={selectedRunId} onBack={() => setSelectedRunId(null)} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default App;
