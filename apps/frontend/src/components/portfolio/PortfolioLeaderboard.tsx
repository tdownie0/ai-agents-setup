import { useCallback, useEffect, useState } from "react";
import { client, type ApiLeaderboardRow } from "@/lib/api";
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

interface PortfolioLeaderboardProps {
  onSelectRun: (runId: number) => void;
}

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
              <TableHead>Agent</TableHead>
              <TableHead>Strategy</TableHead>
              <TableHead>Window</TableHead>
              <TableHead className="text-right">Current Value</TableHead>
              <TableHead className="text-right">Total Return</TableHead>
              <TableHead className="text-right">Sharpe</TableHead>
              <TableHead className="text-right">Max Drawdown</TableHead>
              <TableHead>As of</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => {
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
