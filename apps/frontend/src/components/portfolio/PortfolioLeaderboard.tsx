import { useCallback, useEffect, useState } from "react";
import { client, type ApiLeaderboardRow } from "@/lib/api";
import { useTableSort, type SortDirection } from "@/lib/useTableSort";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronRight, LineChart, RefreshCw, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency, formatPct, formatWindow } from "./format";
import { SortableTh } from "./SortableTh";

interface PortfolioLeaderboardProps {
  onSelectRun: (runId: number) => void;
}

type RunSortKey =
  | "agent"
  | "strategy"
  | "window"
  | "currentValue"
  | "totalReturn"
  | "sharpe"
  | "drawdown"
  | "asOf";

const WINDOW_ORDER: readonly string[] = ["daily", "weekly", "monthly"];

const runSortCompare: Record<RunSortKey, (a: ApiLeaderboardRow, b: ApiLeaderboardRow) => number> = {
  agent: (a, b) => a.persona.localeCompare(b.persona),
  strategy: (a, b) => a.strategy.localeCompare(b.strategy),
  window: (a, b) => WINDOW_ORDER.indexOf(a.window) - WINDOW_ORDER.indexOf(b.window),
  currentValue: (a, b) => a.currentValue - b.currentValue,
  totalReturn: (a, b) => a.totalReturnPct - b.totalReturnPct,
  sharpe: (a, b) => a.sharpe - b.sharpe,
  drawdown: (a, b) => a.maxDrawdownPct - b.maxDrawdownPct,
  asOf: (a, b) => a.asOfTradeDate.localeCompare(b.asOfTradeDate),
};

// Omitted keys fall back to "asc": agent, strategy, window.
const runSortDefaults: Partial<Record<RunSortKey, SortDirection>> = {
  currentValue: "desc",
  totalReturn: "desc",
  sharpe: "desc",
  drawdown: "desc",
  asOf: "desc",
};

export function PortfolioLeaderboard({ onSelectRun }: PortfolioLeaderboardProps) {
  const [rows, setRows] = useState<ApiLeaderboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLeaderboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.api.portfolio.leaderboard.$get({});
      if (!res.ok) {
        throw new Error(`Failed to fetch leaderboard: ${res.status} ${res.statusText}`);
      }
      setRows(await res.json());
    } catch (err) {
      console.error("Failed to fetch leaderboard:", err);
      setError(err instanceof Error ? err.message : "An unknown error occurred");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLeaderboard();
  }, [fetchLeaderboard]);

  const sort = useTableSort<ApiLeaderboardRow, RunSortKey>(
    rows,
    "totalReturn",
    runSortCompare,
    runSortDefaults,
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <div className="text-muted-foreground">Loading leaderboard...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
        <div className="font-medium text-destructive">Error loading leaderboard</div>
        <div className="mt-1 text-sm text-destructive/80">{error}</div>
        <Button variant="outline" size="sm" className="mt-3" onClick={fetchLeaderboard}>
          Try again
        </Button>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border bg-card p-12 text-center">
        <LineChart className="h-10 w-10 text-muted-foreground/50" />
        <p className="font-medium">No portfolio runs yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          The analyst agents haven&apos;t completed any simulation runs. Check back after the next
          round finishes.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Analyst Leaderboard</h2>
          <p className="text-sm text-muted-foreground">
            Completed agent runs ranked by total return
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchLeaderboard} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-14">Rank</TableHead>
              <SortableTh
                label="Agent"
                sortKey="agent"
                activeKey={sort.sortKey}
                dir={sort.sortDir}
                onSort={sort.onSort}
              />
              <SortableTh
                label="Strategy"
                sortKey="strategy"
                activeKey={sort.sortKey}
                dir={sort.sortDir}
                onSort={sort.onSort}
              />
              <SortableTh
                label="Window"
                sortKey="window"
                activeKey={sort.sortKey}
                dir={sort.sortDir}
                onSort={sort.onSort}
              />
              <SortableTh
                label="Current Value"
                sortKey="currentValue"
                activeKey={sort.sortKey}
                dir={sort.sortDir}
                onSort={sort.onSort}
                align="right"
              />
              <SortableTh
                label="Total Return"
                sortKey="totalReturn"
                activeKey={sort.sortKey}
                dir={sort.sortDir}
                onSort={sort.onSort}
                align="right"
              />
              <SortableTh
                label="Sharpe"
                sortKey="sharpe"
                activeKey={sort.sortKey}
                dir={sort.sortDir}
                onSort={sort.onSort}
                align="right"
              />
              <SortableTh
                label="Max Drawdown"
                sortKey="drawdown"
                activeKey={sort.sortKey}
                dir={sort.sortDir}
                onSort={sort.onSort}
                align="right"
              />
              <SortableTh
                label="As of"
                sortKey="asOf"
                activeKey={sort.sortKey}
                dir={sort.sortDir}
                onSort={sort.onSort}
              />
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sort.sortedRows.map((row, index) => {
              const rank = index + 1;
              const returnPositive = row.totalReturnPct >= 0;
              return (
                <TableRow
                  key={row.runId}
                  className="cursor-pointer"
                  onClick={() => onSelectRun(row.runId)}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectRun(row.runId);
                    }
                  }}
                  aria-label={`View ${row.persona} run details`}
                >
                  <TableCell>
                    <span className="flex items-center gap-1.5 font-medium tabular-nums">
                      {rank === 1 && <Trophy className="h-4 w-4 text-amber-500" />}
                      {rank}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{row.persona}</span>
                      {row.replicateOf !== null && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          replica
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">{row.agentKey}</div>
                  </TableCell>
                  <TableCell>{row.strategy}</TableCell>
                  <TableCell>{formatWindow(row.window)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(row.currentValue, 0)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-medium tabular-nums",
                      returnPositive ? "text-emerald-600" : "text-red-600",
                    )}
                  >
                    {formatPct(row.totalReturnPct, true)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.sharpe.toFixed(2)}</TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      row.maxDrawdownPct < 0 && "text-red-600",
                    )}
                  >
                    {formatPct(row.maxDrawdownPct)}
                  </TableCell>
                  <TableCell className="tabular-nums">{row.asOfTradeDate}</TableCell>
                  <TableCell>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
