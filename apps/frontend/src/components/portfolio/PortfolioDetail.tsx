import { useEffect, useState } from "react";
import { client, type ApiAgentDetail } from "@/lib/api";
import { useTableSort, type SortDirection } from "@/lib/useTableSort";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { EquityChart } from "./EquityChart";
import { SortableTh } from "./SortableTh";
import { formatCurrency, formatPct, formatWindow } from "./format";

interface PortfolioDetailProps {
  runId: number;
  onBack: () => void;
}

type PositionRow = ApiAgentDetail["positions"][number];

type PosSortKey =
  | "symbol"
  | "name"
  | "targetWeight"
  | "shares"
  | "entryDate"
  | "entryPrice"
  | "latestPrice"
  | "value"
  | "pnl";

const posSortCompare: Record<PosSortKey, (a: PositionRow, b: PositionRow) => number> = {
  symbol: (a, b) => a.symbol.localeCompare(b.symbol),
  name: (a, b) => (a.name ?? "").localeCompare(b.name ?? ""),
  targetWeight: (a, b) => a.targetWeight - b.targetWeight,
  shares: (a, b) => a.shares - b.shares,
  entryDate: (a, b) => a.entryTradeDate.localeCompare(b.entryTradeDate),
  entryPrice: (a, b) => a.entryPrice - b.entryPrice,
  latestPrice: (a, b) => a.latestPrice - b.latestPrice,
  value: (a, b) => a.value - b.value,
  pnl: (a, b) => a.unrealizedPnlPct - b.unrealizedPnlPct,
};

// Omitted keys fall back to "asc": symbol (matches the backend's
// agentRunId-then-symbol ascending order) and name.
const posSortDefaults: Partial<Record<PosSortKey, SortDirection>> = {
  targetWeight: "desc",
  shares: "desc",
  entryDate: "desc",
  entryPrice: "desc",
  latestPrice: "desc",
  value: "desc",
  pnl: "desc",
};

interface DetailError {
  title: string;
  hint: string;
}

class PortfolioRequestError extends Error {
  readonly hint: string;

  constructor(title: string, hint: string) {
    super(title);
    this.name = "PortfolioRequestError";
    this.hint = hint;
  }
}

function Stat({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-sm font-semibold tabular-nums", valueClassName)}>{value}</div>
    </div>
  );
}

export function PortfolioDetail({ runId, onBack }: PortfolioDetailProps) {
  const [detail, setDetail] = useState<ApiAgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<DetailError | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchDetail = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await client.api.portfolio.agents[":id"].$get({
          param: { id: String(runId) },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          if (body !== null && typeof body === "object" && "error" in body) {
            throw new PortfolioRequestError(
              body.error,
              body.hint ?? "Please go back and select another run.",
            );
          }
          throw new PortfolioRequestError(
            `Failed to load agent run (${res.status} ${res.statusText})`,
            "Please go back and try again.",
          );
        }
        const data = await res.json();
        if (!cancelled) setDetail(data);
      } catch (err) {
        if (!cancelled) {
          if (err instanceof PortfolioRequestError) {
            setError({ title: err.message, hint: err.hint });
          } else {
            console.error("Failed to fetch agent detail:", err);
            setError({
              title: "Something went wrong",
              hint: err instanceof Error ? err.message : "An unknown error occurred",
            });
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchDetail();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const positionRows: readonly PositionRow[] = detail?.positions ?? [];
  const posSort = useTableSort<PositionRow, PosSortKey>(
    positionRows,
    "symbol",
    posSortCompare,
    posSortDefaults,
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <div className="text-muted-foreground">Loading agent run...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={onBack} className="-ml-2">
          <ArrowLeft className="h-4 w-4" />
          Back to leaderboard
        </Button>
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6">
          <div className="flex items-center gap-2 font-medium text-destructive">
            <AlertTriangle className="h-5 w-5" />
            {error.title}
          </div>
          <div className="mt-1 text-sm text-destructive/80">{error.hint}</div>
        </div>
      </div>
    );
  }

  if (detail === null) return null;

  const returnPositive = detail.totalReturnPct >= 0;

  return (
    <div className="space-y-6">
      <Button variant="ghost" onClick={onBack} className="-ml-2">
        <ArrowLeft className="h-4 w-4" />
        Back to leaderboard
      </Button>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2 text-xl">
                {detail.persona}
                {detail.replicateOf !== null && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    replica
                  </span>
                )}
              </CardTitle>
              <CardDescription className="mt-1">
                {detail.agentKey} · {detail.strategy} · {formatWindow(detail.window)} rebalance ·
                round {detail.roundId}
              </CardDescription>
            </div>
            <div className="text-right">
              <div
                className={cn(
                  "text-2xl font-bold tabular-nums",
                  returnPositive ? "text-emerald-600" : "text-red-600",
                )}
              >
                {formatPct(detail.totalReturnPct, true)}
              </div>
              <div className="text-xs text-muted-foreground">as of {detail.asOfTradeDate}</div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Initial Capital" value={formatCurrency(detail.initialCapital)} />
            <Stat label="Current Value" value={formatCurrency(detail.currentValue)} />
            <Stat
              label="Total Return"
              value={formatPct(detail.totalReturnPct, true)}
              valueClassName={returnPositive ? "text-emerald-600" : "text-red-600"}
            />
            <Stat label="Sharpe" value={detail.sharpe.toFixed(2)} />
            <Stat
              label="Max Drawdown"
              value={formatPct(detail.maxDrawdownPct)}
              valueClassName={detail.maxDrawdownPct < 0 ? "text-red-600" : undefined}
            />
            <Stat label="Status" value={formatWindow(detail.status)} />
          </div>
        </CardContent>
      </Card>

      {detail.rationale !== null && detail.rationale.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Rationale</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
              {detail.rationale}
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Equity Curve</CardTitle>
          <CardDescription>Portfolio return over the simulation window</CardDescription>
        </CardHeader>
        <CardContent>
          <EquityChart series={detail.equitySeries} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Positions</CardTitle>
          <CardDescription>{detail.positions.length} holdings</CardDescription>
        </CardHeader>
        <CardContent>
          {detail.positions.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No positions recorded for this run.
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTh
                      label="Symbol"
                      sortKey="symbol"
                      activeKey={posSort.sortKey}
                      dir={posSort.sortDir}
                      onSort={posSort.onSort}
                    />
                    <SortableTh
                      label="Name"
                      sortKey="name"
                      activeKey={posSort.sortKey}
                      dir={posSort.sortDir}
                      onSort={posSort.onSort}
                    />
                    <SortableTh
                      label="Target Weight"
                      sortKey="targetWeight"
                      activeKey={posSort.sortKey}
                      dir={posSort.sortDir}
                      onSort={posSort.onSort}
                      align="right"
                    />
                    <SortableTh
                      label="Shares"
                      sortKey="shares"
                      activeKey={posSort.sortKey}
                      dir={posSort.sortDir}
                      onSort={posSort.onSort}
                      align="right"
                    />
                    <SortableTh
                      label="Entry Date"
                      sortKey="entryDate"
                      activeKey={posSort.sortKey}
                      dir={posSort.sortDir}
                      onSort={posSort.onSort}
                    />
                    <SortableTh
                      label="Entry Price"
                      sortKey="entryPrice"
                      activeKey={posSort.sortKey}
                      dir={posSort.sortDir}
                      onSort={posSort.onSort}
                      align="right"
                    />
                    <SortableTh
                      label="Latest Price"
                      sortKey="latestPrice"
                      activeKey={posSort.sortKey}
                      dir={posSort.sortDir}
                      onSort={posSort.onSort}
                      align="right"
                    />
                    <SortableTh
                      label="Value"
                      sortKey="value"
                      activeKey={posSort.sortKey}
                      dir={posSort.sortDir}
                      onSort={posSort.onSort}
                      align="right"
                    />
                    <SortableTh
                      label="Unrealized P&L"
                      sortKey="pnl"
                      activeKey={posSort.sortKey}
                      dir={posSort.sortDir}
                      onSort={posSort.onSort}
                      align="right"
                    />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {posSort.sortedRows.map((pos) => (
                    <TableRow key={pos.symbol}>
                      <TableCell className="font-medium">{pos.symbol}</TableCell>
                      <TableCell className="text-muted-foreground">{pos.name ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatPct(pos.targetWeight * 100)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {pos.shares.toLocaleString()}
                      </TableCell>
                      <TableCell className="tabular-nums">{pos.entryTradeDate}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(pos.entryPrice)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(pos.latestPrice)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(pos.value)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          pos.unrealizedPnlPct >= 0 ? "text-emerald-600" : "text-red-600",
                        )}
                      >
                        {formatPct(pos.unrealizedPnlPct, true)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
