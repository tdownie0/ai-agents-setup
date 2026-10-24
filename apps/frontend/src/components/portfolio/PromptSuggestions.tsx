import { useCallback, useEffect, useMemo, useState } from "react";
import {
  client,
  getAuthHeaders,
  type ApiPromptProposal,
  type ApiPromptSuggestion,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, MessageSquareText, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatWindow } from "./format";

const WINDOW_ORDER: readonly string[] = ["daily", "weekly", "monthly"];

const COMPONENT_LABELS: Record<string, string> = {
  persona_mandate: "Persona mandate",
  complete_book_rule: "Complete-book rule",
  envelope_schema: "Envelope schema",
  example_envelope: "Example envelope",
  scaffolding: "Scaffolding",
};

const SEVERITY_STYLES: Record<string, string> = {
  high: "bg-red-100 text-red-700",
  medium: "bg-amber-100 text-amber-700",
  low: "bg-muted text-muted-foreground",
};

function Badge({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        className,
      )}
    >
      {children}
    </span>
  );
}

function ProposalCard({ proposal }: { proposal: ApiPromptProposal }) {
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={SEVERITY_STYLES[proposal.severity] ?? "bg-muted"}>
          {proposal.severity}
        </Badge>
        <Badge className="bg-muted text-muted-foreground">
          {COMPONENT_LABELS[proposal.component] ?? proposal.component}
        </Badge>
        <Badge className="bg-muted text-muted-foreground">{proposal.kind}</Badge>
      </div>
      <p className="text-sm">
        <span className="font-medium">Problem: </span>
        {proposal.problem}
      </p>
      {proposal.currentText.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground">Current text</div>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
            {proposal.currentText}
          </pre>
        </div>
      )}
      <div>
        <div className="text-xs font-medium text-muted-foreground">Proposed text</div>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
          {proposal.proposedText}
        </pre>
      </div>
      <p className="text-sm text-muted-foreground">
        <span className="font-medium">Why: </span>
        {proposal.rationale}
      </p>
    </div>
  );
}

function SuggestionCard({ suggestion }: { suggestion: ApiPromptSuggestion }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>
            {suggestion.personaKey} · {formatWindow(suggestion.window)}
          </CardTitle>
          <Badge
            className={cn(
              suggestion.isCurrent
                ? "bg-emerald-100 text-emerald-700"
                : "bg-muted text-muted-foreground",
            )}
          >
            {suggestion.isCurrent ? "Current" : "Historical"}
          </Badge>
          <Badge className="bg-muted text-muted-foreground">{suggestion.promptSetVersion}</Badge>
        </div>
        <CardDescription>
          {suggestion.judgeKey} v{suggestion.judgeVersion} · {suggestion.judgeModel} ·{" "}
          {new Date(suggestion.createdAt).toLocaleString()}
          <br />
          source {suggestion.sourcePromptHash.slice(0, 12)}… · {suggestion.proposals.length}{" "}
          proposal
          {suggestion.proposals.length === 1 ? "" : "s"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Critique</h3>
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
            {suggestion.critiques}
          </p>
        </div>
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Proposals ({suggestion.proposals.length})</h3>
          {suggestion.proposals.map((proposal, index) => (
            <ProposalCard key={`${suggestion.id}-${index}`} proposal={proposal} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function PromptSuggestions() {
  const [suggestions, setSuggestions] = useState<ApiPromptSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [personaFilter, setPersonaFilter] = useState("all");
  const [windowFilter, setWindowFilter] = useState("all");
  const [currentOnly, setCurrentOnly] = useState(false);

  const fetchSuggestions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.api.portfolio["prompt-suggestions"].$get(
        {},
        { headers: await getAuthHeaders() },
      );
      if (res.status === 401) {
        throw new Error("Your session has expired. Sign in again and retry.");
      }
      if (!res.ok) {
        throw new Error(`Failed to fetch prompt suggestions: ${res.status} ${res.statusText}`);
      }
      setSuggestions((await res.json()).suggestions);
    } catch (err) {
      console.error("Failed to fetch prompt suggestions:", err);
      setError(err instanceof Error ? err.message : "An unknown error occurred");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSuggestions();
  }, [fetchSuggestions]);

  const personas = useMemo(() => {
    const keys = new Set(suggestions.map((suggestion) => suggestion.personaKey));
    return [...keys].sort();
  }, [suggestions]);

  const visible = useMemo(() => {
    return suggestions
      .filter((suggestion) => personaFilter === "all" || suggestion.personaKey === personaFilter)
      .filter((suggestion) => windowFilter === "all" || suggestion.window === windowFilter)
      .filter((suggestion) => !currentOnly || suggestion.isCurrent)
      .sort((a, b) => {
        const persona = a.personaKey.localeCompare(b.personaKey);
        if (persona !== 0) return persona;
        const window = WINDOW_ORDER.indexOf(a.window) - WINDOW_ORDER.indexOf(b.window);
        if (window !== 0) return window;
        return b.createdAt.localeCompare(a.createdAt);
      });
  }, [suggestions, personaFilter, windowFilter, currentOnly]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <div className="text-muted-foreground">Loading prompt suggestions...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
        <div className="font-medium text-destructive">Error loading prompt suggestions</div>
        <div className="mt-1 text-sm text-destructive/80">{error}</div>
        <Button variant="outline" size="sm" className="mt-3" onClick={fetchSuggestions}>
          Try again
        </Button>
      </div>
    );
  }

  if (suggestions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border bg-card p-12 text-center">
        <MessageSquareText className="h-10 w-10 text-muted-foreground/50" />
        <p className="font-medium">No prompt suggestions yet</p>
        <p className="max-w-md text-sm text-muted-foreground">
          Run the prompt critic for a persona to generate suggestions. Each run stores one row per
          persona and window, with a prose critique and up to 15 structured proposals.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Prompt Suggestions</h2>
          <p className="text-sm text-muted-foreground">
            Non-blind prompt-critic output. Proposals are advisory — a human edits the prompt set.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchSuggestions} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={personaFilter}
          onChange={(event) => setPersonaFilter(event.target.value)}
          aria-label="Filter by persona"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="all">All personas</option>
          {personas.map((persona) => (
            <option key={persona} value={persona}>
              {persona}
            </option>
          ))}
        </select>
        <select
          value={windowFilter}
          onChange={(event) => setWindowFilter(event.target.value)}
          aria-label="Filter by window"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="all">All windows</option>
          {WINDOW_ORDER.map((window) => (
            <option key={window} value={window}>
              {formatWindow(window)}
            </option>
          ))}
        </select>
        <Button
          variant={currentOnly ? "default" : "outline"}
          size="sm"
          onClick={() => setCurrentOnly((value) => !value)}
          aria-pressed={currentOnly}
        >
          Current only
        </Button>
        <span className="text-sm text-muted-foreground">
          {visible.length} of {suggestions.length}
        </span>
      </div>

      {visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border bg-card p-12 text-center">
          <AlertTriangle className="h-10 w-10 text-muted-foreground/50" />
          <p className="font-medium">No suggestions match these filters</p>
          <p className="text-sm text-muted-foreground">Clear a filter to see more.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {visible.map((suggestion) => (
            <SuggestionCard key={suggestion.id} suggestion={suggestion} />
          ))}
        </div>
      )}
    </div>
  );
}
