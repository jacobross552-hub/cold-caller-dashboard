/**
 * Revenue vs cost, 12 rolling weeks, as a grouped bar chart — plus profit as
 * a signed delta per week and a full data table underneath.
 *
 * Static SVG, no client JS (matches this app's zero-client-component rule).
 * Each bar carries a native <title> for a hover tooltip, and every value is
 * also in the table below, so nothing is gated behind hover-only discovery.
 * Colors: src/app/globals.css's --series-revenue/--series-cost tokens,
 * validated against this app's actual light/dark panel surfaces with the
 * dataviz skill's palette validator before use.
 */

import { formatMoney } from "@/lib/pricing";
import type { WeekPoint } from "@/lib/finance";

const WIDTH = 880;
const HEIGHT = 260;
const PAD_LEFT = 56;
const PAD_RIGHT = 12;
const PAD_TOP = 16;
const PAD_BOTTOM = 34;
const BAR_MAX = 20;
const BAR_GAP = 2;

function niceCeil(value: number): number {
  if (value <= 0) return 100;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const steps = [1, 2, 2.5, 5, 10];
  for (const step of steps) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

export function FinanceChart({ series }: { series: WeekPoint[] }) {
  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;

  const maxRaw = Math.max(1, ...series.map((s) => Math.max(s.revenueAud, s.costAud)));
  const maxVal = niceCeil(maxRaw);

  const groupWidth = plotWidth / series.length;
  const barWidth = Math.min(BAR_MAX, (groupWidth - BAR_GAP - 8) / 2);

  const y = (v: number) => PAD_TOP + plotHeight * (1 - Math.min(v, maxVal) / maxVal);
  const barTop = (v: number) => y(v);
  const barHeight = (v: number) => PAD_TOP + plotHeight - y(v);

  const gridSteps = [0, 0.25, 0.5, 0.75, 1];
  const hasAnyData = series.some((s) => s.revenueAud > 0 || s.costAud > 0);

  return (
    <div>
      <div className="row" style={{ marginBottom: 8, gap: 16 }}>
        <span className="small">
          <span
            style={{
              display: "inline-block",
              width: 10,
              height: 10,
              borderRadius: 2,
              background: "var(--series-revenue)",
              marginRight: 6,
              verticalAlign: -1,
            }}
          />
          Revenue
        </span>
        <span className="small">
          <span
            style={{
              display: "inline-block",
              width: 10,
              height: 10,
              borderRadius: 2,
              background: "var(--series-cost)",
              marginRight: 6,
              verticalAlign: -1,
            }}
          />
          Cost
        </span>
      </div>

      {!hasAnyData && (
        <p className="small muted" style={{ marginTop: 0 }}>
          No revenue or cost recorded in this 12-week window yet — bars will fill in as calls and deals
          accumulate.
        </p>
      )}

      <div className="table-scroll">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" height={HEIGHT} role="img" aria-label="Revenue and cost by week">
          {gridSteps.map((step) => {
            const gy = PAD_TOP + plotHeight * (1 - step);
            return (
              <g key={step}>
                <line
                  x1={PAD_LEFT}
                  x2={WIDTH - PAD_RIGHT}
                  y1={gy}
                  y2={gy}
                  stroke="var(--chart-grid)"
                  strokeWidth={1}
                />
                <text x={PAD_LEFT - 8} y={gy + 4} textAnchor="end" fontSize={10} fill="var(--muted)">
                  {formatMoney(Math.round(maxVal * step))}
                </text>
              </g>
            );
          })}

          {series.map((week, i) => {
            const groupX = PAD_LEFT + i * groupWidth;
            const revX = groupX + (groupWidth - (barWidth * 2 + BAR_GAP)) / 2;
            const costX = revX + barWidth + BAR_GAP;

            return (
              <g key={i}>
                <rect
                  x={revX}
                  y={barTop(week.revenueAud)}
                  width={barWidth}
                  height={Math.max(0, barHeight(week.revenueAud))}
                  rx={4}
                  fill="var(--series-revenue)"
                >
                  <title>
                    {week.label}: revenue {formatMoney(week.revenueAud)}
                  </title>
                </rect>
                <rect
                  x={costX}
                  y={barTop(week.costAud)}
                  width={barWidth}
                  height={Math.max(0, barHeight(week.costAud))}
                  rx={4}
                  fill="var(--series-cost)"
                >
                  <title>
                    {week.label}: cost {formatMoney(week.costAud)}
                  </title>
                </rect>
                {(i === 0 || i === series.length - 1 || i % 3 === 0) && (
                  <text
                    x={groupX + groupWidth / 2}
                    y={HEIGHT - PAD_BOTTOM + 16}
                    textAnchor="middle"
                    fontSize={10}
                    fill="var(--muted)"
                  >
                    {week.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="table-scroll" style={{ marginTop: 12 }}>
        <table>
          <thead>
            <tr>
              <th>Week starting</th>
              <th>Revenue</th>
              <th>Cost</th>
              <th>Profit</th>
            </tr>
          </thead>
          <tbody>
            {[...series].reverse().map((week, i) => (
              <tr key={i}>
                <td>{week.label}</td>
                <td>{formatMoney(week.revenueAud)}</td>
                <td>{formatMoney(week.costAud)}</td>
                <td style={{ color: week.profitAud >= 0 ? "var(--good)" : "var(--bad)", fontWeight: 600 }}>
                  {week.profitAud >= 0 ? "+" : "−"}
                  {formatMoney(Math.abs(week.profitAud))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
