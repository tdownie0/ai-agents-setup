import { useEffect, useState } from "react";
import { client, type ApiStreamDetail } from "@/lib/api";
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
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { EquityChart } from "./EquityChart";
import { formatAgeInDays, formatCurrency, formatPct, formatWindow, pnlClassName } from "./format";

interface StreamDetailProps {
  simulationId: string;
  personaKey: string;
  window: string;
  onBack: () => void;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
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
    return () => {
      cancelled = true;
    };
  }, [simulationId, personaKey, window]);

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
                    <TableHead>Symbol</TableHead>
                    <TableHead className="text-right">Shares</TableHead>
                    <TableHead className="text-right">Cost Basis</TableHead>
                    <TableHead className="text-right">Book Value</TableHead>
                    <TableHead className="text-right">Weight</TableHead>
                    <TableHead>Opened</TableHead>
                    <TableHead className="text-right">Age</TableHead>
                    <TableHead className="text-right">Realized P&amp;L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lots.map((lot) => {
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
