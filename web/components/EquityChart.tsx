"use client";

import { useId } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type DotItemDotProps,
  type TooltipContentProps,
} from "recharts";

// Mirrors --ease-out-expo from globals.css (recharts can't read CSS custom
// properties for animation timing, so the curve is duplicated here).
const EASE_OUT_EXPO = "cubic-bezier(0.16,1,0.3,1)";

// The benchmark leg is XRP: Kassette scores every call against "what if you had
// ignored them and held XRP", written for every call
// including XRP ones so the two totals cover the same legs (lib/marks.ts).
export type EquityPoint = {
  date: string;
  call: number;
  xrp: number;
};

/**
 * Equity curve for a caller's track record.
 *
 * Two lines and one wash: the caller's cumulative P&L in the money colour, the
 * buy-and-hold benchmark as a neutral dashed line underneath it, and a fill
 * that fades out toward the baseline so the area reads as magnitude rather than
 * as a second series. The benchmark is drawn first so the caller's line is
 * never the one obscured.
 */
export function EquityCurveChart({
  data,
  positive,
  height = 280,
}: {
  data: EquityPoint[];
  positive: boolean;
  height?: number;
}) {
  const uid = useId().replace(/[:]/g, "");
  const lineColor = positive ? "var(--gain)" : "var(--loss)";
  const fillId = `curve-fill-${uid}`;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
        <defs>
          {/* A single wash under the line, fading to nothing at the baseline —
              enough to give the curve weight, not enough to become a shape the
              eye reads on its own. */}
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity="0.16" />
            <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
          </linearGradient>
        </defs>

        <CartesianGrid stroke="var(--line)" strokeDasharray="2 3" vertical={false} />
        <XAxis
          dataKey="date"
          stroke="var(--line)"
          tick={{ fill: "var(--faint)", fontFamily: "var(--font-mono)", fontSize: 10 }}
          tickLine={false}
          axisLine={{ stroke: "var(--line)" }}
          minTickGap={32}
        />
        <YAxis
          stroke="var(--line)"
          tick={{ fill: "var(--faint)", fontFamily: "var(--font-mono)", fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={(v: number) => `$${v.toLocaleString()}`}
        />
        <Tooltip content={CurveTooltip} cursor={{ stroke: "var(--line-strong)", strokeDasharray: "2 2" }} />

        <Area
          type="monotone"
          dataKey="call"
          stroke="none"
          fill={`url(#${fillId})`}
          isAnimationActive
          animationDuration={900}
          animationEasing={EASE_OUT_EXPO}
          activeDot={false}
          dot={false}
          legendType="none"
        />

        {/* XRP benchmark — neutral, drawn first so the call line sits on top */}
        <Line
          type="monotone"
          dataKey="xrp"
          name="HODL XRP"
          stroke="var(--muted)"
          strokeWidth={1.5}
          strokeDasharray="3 3"
          dot={false}
          activeDot={{ r: 3, stroke: "var(--bg)", strokeWidth: 1, fill: "var(--muted)" }}
          isAnimationActive
          animationDuration={1200}
          animationEasing={EASE_OUT_EXPO}
        />

        {/* crisp winning line + emphasized endpoint */}
        <Line
          type="monotone"
          dataKey="call"
          name="Calls"
          stroke={lineColor}
          strokeWidth={2}
          dot={(props: DotItemDotProps) =>
            props.index === data.length - 1 ? (
              <EndpointDot key={`endpoint-${props.index}`} cx={props.cx} cy={props.cy} color={lineColor} />
            ) : (
              <g key={`dot-${props.index}`} />
            )
          }
          activeDot={{ r: 4, stroke: "var(--bg)", strokeWidth: 1.5, fill: lineColor }}
          isAnimationActive
          animationDuration={1200}
          animationEasing={EASE_OUT_EXPO}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function EndpointDot({ cx, cy, color }: { cx?: number; cy?: number; color: string }) {
  if (cx == null || cy == null) return null;
  return (
    <g>
      <circle cx={cx} cy={cy} r={7} fill={color} opacity={0.16} />
      <circle cx={cx} cy={cy} r={3} fill={color} stroke="var(--bg)" strokeWidth={1.5} />
    </g>
  );
}

function CurveTooltip({ active, payload, label }: TooltipContentProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div
      className="panel"
      style={{
        padding: "8px 10px",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
      }}
    >
      <div className="label" style={{ marginBottom: 4 }}>
        {label}
      </div>
      {payload.map((entry) => {
        const value = Number(entry.value ?? 0);
        const cls = entry.dataKey === "call" ? (value < 0 ? "loss" : "gain") : undefined;
        return (
          <div
            key={entry.dataKey as string}
            className="tnum"
            style={{
              color: entry.dataKey === "call" ? undefined : "var(--muted)",
              display: "flex",
              justifyContent: "space-between",
              gap: 16,
            }}
          >
            <span className={cls}>{entry.name}</span>
            <span className={cls}>
              {value >= 0 ? "+" : ""}
              {Math.round(value).toLocaleString()}
            </span>
          </div>
        );
      })}
    </div>
  );
}
