import { useId } from "react";
import { cn } from "@/lib/utils";
import { formatPct } from "./format";

interface EquityPoint {
  tradeDate: string;
  returnPct: number;
}

interface EquityChartProps {
  series: readonly EquityPoint[];
  className?: string;
}

const VIEW_W = 600;
const VIEW_H = 220;
const GUTTER = 44;

export function EquityChart({ series, className }: EquityChartProps) {
  const gradientId = useId().replace(/:/g, "");

  if (series.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
        No equity data for this run.
      </div>
    );
  }

  const returns = series.map((p) => p.returnPct);
  const rawMin = Math.min(...returns);
  const rawMax = Math.max(...returns);
  const span = rawMax - rawMin;
  const pad = span === 0 ? 1 : span * 0.15;
  const yMin = rawMin - pad;
  const yMax = rawMax + pad;

  const n = series.length;
  const plotW = VIEW_W - GUTTER;
  const xAt = (i: number) => GUTTER + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = (v: number) => VIEW_H - ((v - yMin) / (yMax - yMin)) * VIEW_H;

  const points = series
    .map((p, i) => `${xAt(i).toFixed(2)},${yAt(p.returnPct).toFixed(2)}`)
    .join(" ");
  const areaPoints = `${GUTTER},${VIEW_H} ${points} ${VIEW_W},${VIEW_H}`;

  const last = series[series.length - 1];
  const lastX = xAt(n - 1);
  const lastY = yAt(last.returnPct);
  const zeroY = yAt(0);
  const showZeroLine = zeroY >= 0 && zeroY <= VIEW_H;
  const positive = last.returnPct >= 0;

  const gridValues = [0, 1, 2, 3].map((i) => yMin + ((yMax - yMin) * i) / 3);

  return (
    <div className={className}>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className={cn("h-auto w-full", positive ? "text-emerald-500" : "text-red-500")}
        role="img"
        aria-label={`Equity curve ending at ${formatPct(last.returnPct, true)}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.25" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>

        {gridValues.map((v) => {
          const y = yAt(v);
          return (
            <g key={v}>
              <line
                x1={GUTTER}
                y1={y}
                x2={VIEW_W}
                y2={y}
                className="stroke-border"
                strokeWidth={1}
              />
              <text
                x={GUTTER - 6}
                y={y + 3}
                textAnchor="end"
                fontSize={10}
                className="fill-muted-foreground"
              >
                {v.toFixed(1)}%
              </text>
            </g>
          );
        })}

        {showZeroLine && (
          <line
            x1={GUTTER}
            y1={zeroY}
            x2={VIEW_W}
            y2={zeroY}
            className="stroke-muted-foreground/60"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
        )}

        <polygon points={areaPoints} fill={`url(#${gradientId})`} />
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={lastX} cy={lastY} r={3.5} fill="currentColor" />
      </svg>
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{series[0].tradeDate}</span>
        <span>{last.tradeDate}</span>
      </div>
    </div>
  );
}
