/**
 * Dialled → answered → booked → won, as a horizontal ordinal bar funnel.
 *
 * Single hue (blue), monotone light→dark per stage — the dataviz skill's
 * ordinal-ramp rule for discrete ordered magnitude. Every bar carries its
 * raw N as a direct label (never a bare percentage — see src/lib/funnel.ts's
 * own rule) plus a native <title> tooltip.
 */

import type { ConversionFunnel } from "@/lib/funnel";

const WIDTH = 520;
const BAR_HEIGHT = 28;
const BAR_GAP = 10;
const LABEL_WIDTH = 90;

const STAGE_COLORS = ["var(--funnel-1)", "var(--funnel-2)", "var(--funnel-3)", "var(--funnel-4)"];

export function FunnelChart({ funnel }: { funnel: ConversionFunnel }) {
  const stages = [
    { label: "Dialled", n: funnel.dialled },
    { label: "Answered", n: funnel.answered },
    { label: "Booked", n: funnel.booked },
    { label: "Won", n: funnel.deals.won },
  ];

  const max = Math.max(1, stages[0].n);
  const trackWidth = WIDTH - LABEL_WIDTH;
  const height = stages.length * (BAR_HEIGHT + BAR_GAP);

  if (funnel.dialled === 0) {
    return (
      <p className="small muted" style={{ marginTop: 0 }}>
        No calls yet — the funnel fills in once dialling starts.
      </p>
    );
  }

  return (
    <div className="table-scroll">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} width="100%" height={height} role="img" aria-label="Conversion funnel">
        {stages.map((stage, i) => {
          const barWidth = Math.max(2, (stage.n / max) * trackWidth);
          const y = i * (BAR_HEIGHT + BAR_GAP);
          return (
            <g key={stage.label}>
              <text x={0} y={y + BAR_HEIGHT / 2 + 4} fontSize={12} fill="var(--muted)">
                {stage.label}
              </text>
              <rect x={LABEL_WIDTH} y={y} width={trackWidth} height={BAR_HEIGHT} rx={4} fill="var(--line)" />
              <rect x={LABEL_WIDTH} y={y} width={barWidth} height={BAR_HEIGHT} rx={4} fill={STAGE_COLORS[i]}>
                <title>
                  {stage.label}: {stage.n}
                </title>
              </rect>
              <text
                x={LABEL_WIDTH + barWidth + 8}
                y={y + BAR_HEIGHT / 2 + 4}
                fontSize={12}
                fontWeight={600}
                fill="var(--ink)"
              >
                {stage.n.toLocaleString()}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
