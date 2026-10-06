import { useEffect, useMemo, useState } from "react";
import { client, type ApiLot, type ApiStreamDetail, type ApiTransaction } from "@/lib/api";
import { useTableSort, type SortDirection } from "@/lib/useTableSort";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { EquityChart } from "./EquityChart";
import { formatAgeInDays, formatCurrency, formatPct, formatWindow, pnlClassName } from "./format";

interface StreamDetailProps {
  simulationId: string;
  personaKey: string;
  window: string;
  onBack: () => void;
}

type TxnSortKey = "date" | "round" | "symbol" | "side" | "shares" | "price" | "value" | "pnl";
type LotSortKey =
  | "symbol"
  | "shares"
  | "costBasis"
  | "bookValue"
  | "weight"
  | "opened"
  | "age"
  | "pnl";

const txnSortCompare: Record<TxnSortKey, (a: ApiTransaction, b: ApiTransaction) => number> = {
  date: (a, b) => a.decideTradeDate.localeCompare(b.decideTradeDate),
  round: (a, b) => a.roundSeq - b.roundSeq,
  symbol: (a, b) => a.symbol.localeCompare(b.symbol),
  side: (a, b) => a.side.localeCompare(b.side),
  shares: (a, b) => a.shares - b.shares,
  price: (a, b) => a.price - b.price,
  value: (a, b) => a.value - b.value,
  pnl: (a, b) => a.realizedPnl - b.realizedPnl,
};

// Omitted keys fall back to "asc": symbol (must match the backend's
// symbol-ascending default lot order) and side on transactions.
const txnSortDefaults: Partial<Record<TxnSortKey, SortDirection>> = {
  date: "desc",
  round: "desc",
  shares: "desc",
  price: "desc",
  value: "desc",
  pnl: "desc",
};

const lotSortDefaults: Partial<Record<LotSortKey, SortDirection>> = {
  shares: "desc",
  costBasis: "desc",
  bookValue: "desc",
  weight: "desc",
  opened: "desc",
  age: "desc",
  pnl: "desc",
};

const DAY_MS = 86_400_000;

function lotSortCompare(asOfTradeDate: string): Record<LotSortKey, (a: ApiLot, b: ApiLot) => number> {
  const ageDays = (lot: ApiLot): number => {
    const opened = Date.parse(lot.openedTradeDate);
    const asOf = Date.parse(asOfTradeDate);
    if (Number.isNaN(opened) || Number.isNaN(asOf)) return 0;
    return Math.round((asOf - opened) / DAY_MS);
  };
  return {
    symbol: (a, b) => a.symbol.localeCompare(b.symbol),
    shares: (a, b) => a.shares - b.shares,
    costBasis: (a, b) => a.costBasis - b.costBasis,
    bookValue: (a, b) => a.shares * a.costBasis - b.shares * b.costBasis,
    weight: (a, b) => a.targetWeight - b.targetWeight,
    opened: (a, b) => a.openedTradeDate.localeCompare(b.openedTradeDate),
    age: (a, b) => ageDays(a) - ageDays(b),
    pnl: (a, b) => a.realizedPnl - b.realizedPnl,
  };
}

function SortableTh<K extends string>({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: K;
  activeKey: K | null;
  dir: SortDirection;
  onSort: (key: K) => void;
  align?: "left" | "right";
}) {
  const active = activeKey === sortKey;
  const ariaSort: "ascending" | "descending" | "none" = active
    ? dir === "asc"
      ? "ascending"
      : "descending"
    : "none";
  return (
    <TableHead aria-sort={ariaSort} className={align === "right" ? "text-right" : undefined}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn("inline-flex items-center gap-1", align === "right" && "justify-end w-full")}
      >
        {label}
        {active ? (
          dir === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5" />
          )
        ) : (
          <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground/50" />
        )}
      </button>
    </TableHead>
  );
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

export function StreamDetail({ simulationId, personaKey, window, onBack }: StreamDetailProps) {
  const [detail, setDetail] = useState<ApiStreamDetail | null>(null);
  const [txns, setTxns] = useState<ApiTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchTransactions = async () => {
      try {
        const res = await client.api.portfolio.simulations[":simId"].streams[":personaKey"][
          ":window"
        ].transactions.$get({
          param: { simId: simulationId, personaKey, window },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setTxns(data.transactions);
      } catch (err) {
        console.error("Failed to fetch transactions:", err);
      }
    };

    const fetchDetail = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await client.api.portfolio.simulations[":simId"].streams[":personaKey"][
          ":window"
        ].$get({
          param: { simId: simulationId, personaKey, window },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          if (body !== null && typeof body === "object" && "error" in body) {
            throw new Error(String(body.error));
          }
          throw new Error(`Failed to load stream (${res.status} ${res.statusText})`);
        }
        const data = await res.json();
        if (!cancelled) setDetail(data);
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to fetch stream detail:", err);
          setError(err instanceof Error ? err.message : "An unknown error occurred");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchDetail();
    void fetchTransactions();
    return () => {
      cancelled = true;
    };
  }, [simulationId, personaKey, window]);

  const [dateFilter, setDateFilter] = useState<string | null>(null);

  const dateOptions = useMemo(() => {
    const roundByDate = new Map<string, number>();
    for (const txn of txns) {
      if (!roundByDate.has(txn.decideTradeDate)) {
        roundByDate.set(txn.decideTradeDate, txn.roundSeq);
      }
    }
    return [...roundByDate.entries()]
      .map(([date, roundSeq]) => ({ date, roundSeq }))
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [txns]);

  const activeFilter =
    dateFilter !== null && dateOptions.some((option) => option.date === dateFilter)
      ? dateFilter
      : null;

  const filteredTxns = useMemo(
    () =>
      activeFilter === null ? txns : txns.filter((txn) => txn.decideTradeDate === activeFilter),
    [txns, activeFilter],
  );

  const txnSort = useTableSort<ApiTransaction, TxnSortKey>(
    filteredTxns,
    "date",
    txnSortCompare,
    txnSortDefaults,
  );

  const detailLots = detail?.lots ?? [];
  const lastTradeDate = detail?.stream.lastTradeDate ?? "";
  const lotCompare = useMemo(() => lotSortCompare(lastTradeDate), [lastTradeDate]);
  const lotSort = useTableSort<ApiLot, LotSortKey>(
    detailLots,
    "symbol",
    lotCompare,
    lotSortDefaults,
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <div className="text-muted-foreground">Loading stream...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={onBack} className="-ml-2">
          <ArrowLeft className="h-4 w-4" />
          Back to streams
        </Button>
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6">
          <div className="flex items-center gap-2 font-medium text-destructive">
            <AlertTriangle className="h-5 w-5" />
            Could not load this stream
          </div>
          <div className="mt-1 text-sm text-destructive/80">{error}</div>
        </div>
      </div>
    );
  }

  if (detail === null) return null;

  const { stream, lots, equitySeries } = detail;

  return (
    <div className="space-y-6">
      <Button variant="ghost" onClick={onBack} className="-ml-2">
        <ArrowLeft className="h-4 w-4" />
        Back to streams
      </Button>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2 text-xl">
                {stream.persona ?? stream.personaKey}
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {formatWindow(stream.window)}
                </span>
              </CardTitle>
              <CardDescription className="mt-1">
                {stream.agentKey}
                {stream.strategy !== null && ` · ${stream.strategy}`} · chain position {stream.seq}
              </CardDescription>
            </div>
            <div className="text-right">
              <div
                className={cn("text-2xl font-bold tabular-nums", pnlClassName(stream.returnPct))}
              >
                {formatPct(stream.returnPct, true)}
              </div>
              <div className="text-xs text-muted-foreground">
                as of {stream.asOfTradeDate} · last marked {stream.lastTradeDate}
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Cash" value={formatCurrency(stream.cash)} />
            <Stat label="Holdings Value" value={formatCurrency(stream.holdingsValue)} />
            <Stat label="Portfolio Value" value={formatCurrency(stream.totalValue)} />
            <Stat
              label="Total Return"
              value={formatPct(stream.returnPct, true)}
              valueClassName={pnlClassName(stream.returnPct)}
            />
            <Stat label="Sharpe" value={stream.sharpe.toFixed(2)} />
            <Stat
              label="Max Drawdown"
              value={formatPct(stream.maxDrawdownPct)}
              valueClassName={stream.maxDrawdownPct < 0 ? "text-red-600" : undefined}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Equity Curve</CardTitle>
          <CardDescription>
            Carried forward across decisions — return measured against{" "}
            {formatCurrency(stream.basisCapital)} basis capital
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EquityChart series={equitySeries} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Open Lots</CardTitle>
          <CardDescription>
            {lots.length === 0
              ? "Fully in cash"
              : `${lots.length} carried ${lots.length === 1 ? "position" : "positions"}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {lots.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              This stream holds no open positions.
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTh
                      label="Symbol"
                      sortKey="symbol"
                      activeKey={lotSort.sortKey}
                      dir={lotSort.sortDir}
                      onSort={lotSort.onSort}
                    />
                    <SortableTh
                      label="Shares"
                      sortKey="shares"
                      activeKey={lotSort.sortKey}
                      dir={lotSort.sortDir}
                      onSort={lotSort.onSort}
                      align="right"
                    />
                    <SortableTh
                      label="Cost Basis"
                      sortKey="costBasis"
                      activeKey={lotSort.sortKey}
                      dir={lotSort.sortDir}
                      onSort={lotSort.onSort}
                      align="right"
                    />
                    <SortableTh
                      label="Book Value"
                      sortKey="bookValue"
                      activeKey={lotSort.sortKey}
                      dir={lotSort.sortDir}
                      onSort={lotSort.onSort}
                      align="right"
                    />
                    <SortableTh
                      label="Weight"
                      sortKey="weight"
                      activeKey={lotSort.sortKey}
                      dir={lotSort.sortDir}
                      onSort={lotSort.onSort}
                      align="right"
                    />
                    <SortableTh
                      label="Opened"
                      sortKey="opened"
                      activeKey={lotSort.sortKey}
                      dir={lotSort.sortDir}
                      onSort={lotSort.onSort}
                    />
                    <SortableTh
                      label="Age"
                      sortKey="age"
                      activeKey={lotSort.sortKey}
                      dir={lotSort.sortDir}
                      onSort={lotSort.onSort}
                      align="right"
                    />
                    <SortableTh
                      label={"Realized P&L"}
                      sortKey="pnl"
                      activeKey={lotSort.sortKey}
                      dir={lotSort.sortDir}
                      onSort={lotSort.onSort}
                      align="right"
                    />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lotSort.sortedRows.map((lot) => {
                    const bookValue = lot.shares * lot.costBasis;
                    return (
                      <TableRow key={`${lot.openedFromRoundId}:${lot.symbol}`}>
                        <TableCell className="font-medium">{lot.symbol}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {lot.shares.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(lot.costBasis)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(bookValue)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatPct(lot.targetWeight * 100)}
                        </TableCell>
                        <TableCell className="tabular-nums">{lot.openedTradeDate}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatAgeInDays(lot.openedTradeDate, stream.lastTradeDate)}
                        </TableCell>
                        <TableCell
                          className={cn("text-right tabular-nums", pnlClassName(lot.realizedPnl))}
                        >
                          {formatCurrency(lot.realizedPnl)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Lots carry cost basis and realized P&amp;L. Unrealized P&amp;L needs a last price per
            symbol, which this endpoint does not return yet — book value above is shares × cost
            basis, not market value.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-2">
              <CardTitle>Transaction History</CardTitle>
              <CardDescription>
                {txns.length === 0
                  ? "No buys or sells recorded yet"
                  : activeFilter === null
                    ? `${txns.length} fills · newest decision first — holds are not trades`
                    : `${filteredTxns.length} of ${txns.length} fills · holds are not trades`}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="tx-history-date" className="text-sm font-medium">
                Date
              </label>
              <select
                id="tx-history-date"
                value={activeFilter ?? "all"}
                onChange={(e) => setDateFilter(e.target.value === "all" ? null : e.target.value)}
                className="border-input bg-background h-9 rounded-md border px-3 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
              >
                <option value="all">All dates</option>
                {dateOptions.map((option) => (
                  <option key={option.date} value={option.date}>
                    {option.date} · Round {option.roundSeq}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {txns.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              This stream has no buy or sell activity yet.
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTh
                      label="Date"
                      sortKey="date"
                      activeKey={txnSort.sortKey}
                      dir={txnSort.sortDir}
                      onSort={txnSort.onSort}
                    />
                    <SortableTh
                      label="Round"
                      sortKey="round"
                      activeKey={txnSort.sortKey}
                      dir={txnSort.sortDir}
                      onSort={txnSort.onSort}
                      align="right"
                    />
                    <SortableTh
                      label="Symbol"
                      sortKey="symbol"
                      activeKey={txnSort.sortKey}
                      dir={txnSort.sortDir}
                      onSort={txnSort.onSort}
                    />
                    <SortableTh
                      label="Side"
                      sortKey="side"
                      activeKey={txnSort.sortKey}
                      dir={txnSort.sortDir}
                      onSort={txnSort.onSort}
                    />
                    <SortableTh
                      label="Shares"
                      sortKey="shares"
                      activeKey={txnSort.sortKey}
                      dir={txnSort.sortDir}
                      onSort={txnSort.onSort}
                      align="right"
                    />
                    <SortableTh
                      label="Price"
                      sortKey="price"
                      activeKey={txnSort.sortKey}
                      dir={txnSort.sortDir}
                      onSort={txnSort.onSort}
                      align="right"
                    />
                    <SortableTh
                      label="Value"
                      sortKey="value"
                      activeKey={txnSort.sortKey}
                      dir={txnSort.sortDir}
                      onSort={txnSort.onSort}
                      align="right"
                    />
                    <SortableTh
                      label={"Realized P&L"}
                      sortKey="pnl"
                      activeKey={txnSort.sortKey}
                      dir={txnSort.sortDir}
                      onSort={txnSort.onSort}
                      align="right"
                    />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {txnSort.sortedRows.map((txn) => (
                    <TableRow key={`${txn.roundId}:${txn.symbol}:${txn.side}`}>
                      <TableCell className="tabular-nums">{txn.decideTradeDate}</TableCell>
                      <TableCell className="text-right">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {txn.roundSeq}
                        </span>
                      </TableCell>
                      <TableCell className="font-medium">{txn.symbol}</TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[10px] font-medium",
                            txn.side === "buy"
                              ? "bg-emerald-600/10 text-emerald-600"
                              : "bg-red-600/10 text-red-600",
                          )}
                        >
                          {txn.side === "buy" ? "Buy" : "Sell"}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {txn.shares.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(txn.price)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(txn.value)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          txn.side === "sell" && pnlClassName(txn.realizedPnl),
                        )}
                      >
                        {txn.side === "sell" ? formatCurrency(txn.realizedPnl) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {lots.some((lot) => lot.thesis !== null) && (
        <Card>
          <CardHeader>
            <CardTitle>Carried Theses</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {lots
              .filter((lot) => lot.thesis !== null)
              .map((lot) => (
                <div key={`thesis:${lot.openedFromRoundId}:${lot.symbol}`}>
                  <div className="text-sm font-medium">{lot.symbol}</div>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                    {lot.thesis}
                  </p>
                </div>
              ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
