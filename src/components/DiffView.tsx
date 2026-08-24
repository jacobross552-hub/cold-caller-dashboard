/**
 * Line-level diff display. The diff itself is computed by plain code
 * (learning.ts's computeDiff) from the exact before/after prompt text, never
 * by the model — what's shown here can never drift from what Accept applies.
 */

import type { DiffLine } from "@/lib/learning";

export function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <div
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12.5,
        lineHeight: 1.6,
        background: "var(--bg)",
        border: "1px solid var(--line)",
        borderRadius: 6,
        padding: 10,
        maxHeight: 420,
        overflowY: "auto",
        whiteSpace: "pre-wrap",
      }}
    >
      {lines.map((line, i) => {
        const style: React.CSSProperties = {
          display: "block",
          padding: "1px 6px",
          borderRadius: 3,
        };
        if (line.type === "added") {
          style.background = "var(--accent-soft)";
          style.color = "var(--good)";
        } else if (line.type === "removed") {
          style.background = "var(--bad-soft)";
          style.color = "var(--bad)";
          style.textDecoration = "line-through";
        } else {
          style.color = "var(--muted)";
        }
        const prefix = line.type === "added" ? "+ " : line.type === "removed" ? "− " : "  ";
        return (
          <span key={i} style={style}>
            {prefix}
            {line.text || " "}
          </span>
        );
      })}
    </div>
  );
}
