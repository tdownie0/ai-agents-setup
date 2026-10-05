import { useCallback, useEffect, useMemo, useState } from "react";
import {
  client,
  type ApiRoundSnapshot,
  type ApiSimulation,
  type ApiSimulationRound,
  type ApiStreamSummary,
} from "@/lib/api";
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
import { AlertTriangle, ChevronRight, Layers, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency, formatPct, formatWindow, pnlClassName } from "./format";

interface StreamBoardProps {
  onSelectStream: (simulationId: string, personaKey: string, window: string) => void;
}

const WINDOW_ORDER: readonly string[] = ["daily", "weekly", "monthly"];

const LATEST_ROUND_VALUE = "latest";

interface PersonaGroup {
  personaKey: string;
  persona: string | null;
  streams: ApiStreamSummary[];
}

function formatRoundOption(round: ApiSimulationRound): string {
  const runs = `${round.runCount} ${round.runCount === 1 ? "run" : "runs"}`;
  return `Round ${round.roundSeq} — ${round.asOfTradeDate ?? "no date"} · ${runs}`;
}

function newestRoundSeq(rounds: readonly ApiSimulationRound[]): number | null {
  let newest: number | null = null;
  for (const round of rounds) {
    if (newest === null || round.roundSeq > newest) newest = round.roundSeq;
  }
  return newest;
}

function roundCaption(
  selectedRoundSeq: number | null,
  snapshot: ApiRoundSnapshot | null,
  loading: boolean,
): string | null {
  if (selectedRoundSeq === null) return null;
  if (loading) return `Loading round ${selectedRoundSeq} snapshot…`;
  if (snapshot === null || snapshot.roundSeq !== selectedRoundSeq) {
    return `Round ${selectedRoundSeq} snapshot unavailable — showing the live book`;
  }
  const decided =
    snapshot.decideTradeDate === null ? "no date" : `decided ${snapshot.decideTradeDate}`;
  return `Snapshot of round ${snapshot.roundSeq} · ${decided}`;
}

export function StreamBoard({ onSelectStream }: StreamBoardProps) {
  const [simulations, setSimulations] = useState<ApiSimulation[]>([]);
  const [selectedSimId, setSelectedSimId] = useState<string | null>(null);
  const [streams, setStreams] = useState<ApiStreamSummary[]>([]);
  const [rounds, setRounds] = useState<ApiSimulationRound[]>([]);
  const [selectedRoundSeq, setSelectedRoundSeq] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<ApiRoundSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [streamsLoading, setStreamsLoading] = useState(false);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotFailed, setSnapshotFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSimulations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.api.portfolio.simulations.$get({});
      if (!res.ok) throw new Error(`Failed to load simulations: ${res.status} ${res.statusText}`);
      const rows = await res.json();
      setSimulations(rows);
      setSelectedSimId((current) => current ?? rows[0]?.simId ?? null);
    } catch (err) {
      console.error("Failed to fetch simulations:", err);
      setError(err instanceof Error ? err.message : "An unknown error occurred");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchStreams = useCallback(async (simId: string) => {
    setStreamsLoading(true);
    try {
      const res = await client.api.portfolio.simulations[":simId"].streams.$get({
        param: { simId },
      });
      if (!res.ok) throw new Error(`Failed to load streams: ${res.status} ${res.statusText}`);
      setStreams(await res.json());
    } catch (err) {
      console.error("Failed to fetch streams:", err);
      setStreams([]);
      setError(err instanceof Error ? err.message : "An unknown error occurred");
    } finally {
      setStreamsLoading(false);
    }
  }, []);

  const fetchRounds = useCallback(async (simId: string) => {
    setRounds([]);
    setSnapshot(null);
    setSnapshotFailed(false);
    setSelectedRoundSeq(null);
    try {
      const res = await client.api.portfolio.simulations[":simId"].rounds.$get({
        param: { simId },
      });
      if (!res.ok) throw new Error(`Failed to load rounds: ${res.status} ${res.statusText}`);
      const rows = await res.json();
      setRounds(rows);
      setSelectedRoundSeq(newestRoundSeq(rows));
    } catch (err) {
      console.error("Failed to fetch rounds:", err);
      setError(err instanceof Error ? err.message : "An unknown error occurred");
    }
  }, []);

  const fetchSnapshot = useCallback(async (simId: string, roundSeq: number) => {
    setSnapshotLoading(true);
    setSnapshotFailed(false);
    try {
      const res = await client.api.portfolio.simulations[":simId"].rounds[":roundSeq"].$get({
        param: { simId, roundSeq: String(roundSeq) },
      });
      if (!res.ok) {
        throw new Error(`Failed to load round ${roundSeq}: ${res.status} ${res.statusText}`);
      }
      setSnapshot(await res.json());
    } catch (err) {
      console.error("Failed to fetch round snapshot:", err);
      setError(err instanceof Error ? err.message : "An unknown error occurred");
      setSnapshotFailed(true);
    } finally {
      setSnapshotLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSimulations();
  }, [fetchSimulations]);

  useEffect(() => {
    if (selectedSimId === null) return;
    fetchStreams(selectedSimId);
    fetchRounds(selectedSimId);
  }, [selectedSimId, fetchStreams, fetchRounds]);

  useEffect(() => {
    if (selectedSimId === null || selectedRoundSeq === null) return;
    fetchSnapshot(selectedSimId, selectedRoundSeq);
  }, [selectedSimId, selectedRoundSeq, fetchSnapshot]);

  const snapshotInView = snapshot !== null && snapshot.roundSeq === selectedRoundSeq;
  const visibleStreams: ApiStreamSummary[] = snapshotInView ? snapshot.streams : streams;

  const groups = useMemo<readonly PersonaGroup[]>(() => {
    const byPersona = new Map<string, ApiStreamSummary[]>();
    for (const stream of visibleStreams) {
      const bucket = byPersona.get(stream.personaKey);
      if (bucket === undefined) byPersona.set(stream.personaKey, [stream]);
      else bucket.push(stream);
    }
    return [...byPersona.entries()]
      .map(([personaKey, bucket]) => ({
        personaKey,
        persona: bucket[0]?.persona ?? null,
        streams: [...bucket].sort(
          (a, b) => WINDOW_ORDER.indexOf(a.window) - WINDOW_ORDER.indexOf(b.window),
        ),
      }))
      .sort((a, b) => a.personaKey.localeCompare(b.personaKey));
  }, [visibleStreams]);

  const selectedSim = simulations.find((sim) => sim.simId === selectedSimId) ?? null;
  const caption = roundCaption(selectedRoundSeq, snapshot, snapshotLoading);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <div className="text-muted-foreground">Loading simulations...</div>
      </div>
    );
  }

  if (error && simulations.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
        <div className="font-medium text-destructive">Error loading simulations</div>
        <div className="mt-1 text-sm text-destructive/80">{error}</div>
        <Button variant="outline" size="sm" className="mt-3" onClick={fetchSimulations}>
          Try again
        </Button>
      </div>
    );
  }

  if (simulations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border bg-card p-12 text-center">
        <Layers className="h-10 w-10 text-muted-foreground/50" />
        <p className="font-medium">No simulations yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          A simulation holds all 18 analyst streams (6 personas × 3 rebalance windows) and carries
          their books forward between rounds. Launch one to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Simulation Streams</h2>
          <p className="text-sm text-muted-foreground">
            {streams.length} streams · every stream decides each round
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void fetchSimulations()}
          disabled={loading || streamsLoading}
        >
          <RefreshCw className={cn("h-4 w-4", streamsLoading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {simulations.map((sim) => (
          <button
            key={sim.simId}
            type="button"
            onClick={() => setSelectedSimId(sim.simId)}
            aria-pressed={sim.simId === selectedSimId}
            className={cn(
              "rounded-lg border px-3 py-2 text-left transition-colors",
              sim.simId === selectedSimId ? "border-primary bg-primary/5" : "hover:bg-muted/50",
            )}
          >
            <div className="text-sm font-medium">{sim.label ?? sim.simId}</div>
            <div className="text-xs text-muted-foreground">
              {sim.streamCount} streams
              {sim.lastRoundSeq === null
                ? " · not yet decided"
                : ` · through round ${sim.lastRoundSeq}`}
            </div>
          </button>
        ))}
      </div>

      {rounds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="stream-board-round" className="text-sm font-medium">
            Round
          </label>
          <select
            id="stream-board-round"
            value={selectedRoundSeq === null ? LATEST_ROUND_VALUE : String(selectedRoundSeq)}
            onChange={(e) => {
              const next = e.target.value;
              setSelectedRoundSeq(next === LATEST_ROUND_VALUE ? null : Number(next));
            }}
            className="border-input bg-background h-9 rounded-md border px-3 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          >
            <option value={LATEST_ROUND_VALUE}>Latest (live book)</option>
            {rounds.map((round) => (
              <option key={round.roundId} value={String(round.roundSeq)}>
                {formatRoundOption(round)}
              </option>
            ))}
          </select>
          {caption !== null && <span className="text-xs text-muted-foreground">{caption}</span>}
        </div>
      )}

      {error && (streams.length === 0 || snapshotFailed) && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" />
          {error}
        </div>
      )}

      {selectedSim !== null && visibleStreams.length === 0 && !streamsLoading && (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-12 text-center">
          <p className="font-medium">No streams materialized</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            A stream appears once a round folds its book forward. Decide a round for{" "}
            {selectedSim.label ?? selectedSim.simId} to populate the board.
          </p>
        </div>
      )}

      {groups.map((group) => (
        <Card key={group.personaKey}>
          <CardHeader>
            <CardTitle className="text-base">{group.persona ?? group.personaKey}</CardTitle>
            <CardDescription>{group.personaKey}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Window</TableHead>
                    <TableHead className="text-right">Cash</TableHead>
                    <TableHead className="text-right">Holdings</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead className="text-right">Return</TableHead>
                    <TableHead className="text-right">Sharpe</TableHead>
                    <TableHead className="text-right">Drawdown</TableHead>
                    <TableHead className="text-right">Lots</TableHead>
                    <TableHead>Marked</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.streams.map((stream) => {
                    const behind = stream.lastTradeDate !== stream.asOfTradeDate;
                    return (
                      <TableRow
                        key={`${stream.personaKey}:${stream.window}`}
                        className="cursor-pointer"
                        onClick={() =>
                          onSelectStream(stream.simulationId, stream.personaKey, stream.window)
                        }
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSelectStream(stream.simulationId, stream.personaKey, stream.window);
                          }
                        }}
                        aria-label={`View ${stream.persona ?? stream.personaKey} ${stream.window} stream`}
                      >
                        <TableCell className="font-medium">{formatWindow(stream.window)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(stream.cash, 0)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(stream.holdingsValue, 0)}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatCurrency(stream.totalValue, 0)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right font-medium tabular-nums",
                            pnlClassName(stream.returnPct),
                          )}
                        >
                          {formatPct(stream.returnPct, true)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {stream.sharpe.toFixed(2)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right tabular-nums",
                            stream.maxDrawdownPct < 0 && "text-red-600",
                          )}
                        >
                          {formatPct(stream.maxDrawdownPct)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{stream.openLots}</TableCell>
                        <TableCell className="tabular-nums">
                          <span className={cn(behind && "font-medium text-amber-600")}>
                            {stream.lastTradeDate}
                          </span>
                          {behind && (
                            <div className="text-xs text-amber-600">
                              behind {stream.asOfTradeDate}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
