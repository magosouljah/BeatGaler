import React from "react";

interface Props {
  current?: number;
  total?: number | null;
  onCancel?: () => void;
}

const shimmer = (width: string, height: number, radius = 7): React.CSSProperties => ({
  width,
  height,
  borderRadius: radius,
  background: "linear-gradient(90deg,#151515 20%,#202020 45%,#151515 70%)",
  backgroundSize: "220% 100%",
  animation: "beatgaler-review-skeleton 1.05s ease-in-out infinite",
});

/**
 * Skeleton deliberately mirrors the existing Review Drawer geometry exactly.
 * Keep it isolated so it can be removed later without touching import state.
 */
export default function ReviewBeatSkeleton({ current = 1, total = null, onCancel }: Props) {
  const title = total && total > 0 ? `Review beat ${current} of ${total}` : `Review beat ${current}`;
  return (
    <>
      <style>{`@keyframes beatgaler-review-skeleton {0%{background-position:100% 0}100%{background-position:-120% 0}}`}</style>
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 300, backdropFilter: "blur(4px)" }} />
      <div style={{
        position: "fixed", right: 0, top: 0, bottom: 0, width: 340,
        background: "#0f0f0f", borderLeft: "1px solid #1a1a1a", zIndex: 310,
        display: "flex", flexDirection: "column", animation: "drawerIn 0.22s ease",
      }}>
        <div style={{ padding: "18px 22px", borderBottom: "1px solid #1a1a1a", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 500, fontSize: 14, color: "#e0e0e0" }}>{title}</span>
          {onCancel && (
            <button onClick={onCancel} style={{ background: "none", border: "none", color: "#777", fontSize: 12, cursor: "pointer" }}>
              Cancel import
            </button>
          )}
        </div>

        <div style={{ flex: 1, overflow: "hidden", padding: 22 }}>
          <div style={shimmer("296px", 296, 10)} />

          <div style={{ marginTop: 16, ...shimmer("68%", 34, 8) }} />

          <div style={{ marginTop: 14 }}>
            <div style={shimmer("52px", 10, 4)} />
            <div style={{ display: "flex", gap: 6, marginTop: 9 }}>
              {[0, 1, 2, 3, 4].map(i => <div key={i} style={shimmer("18px", 18, 9)} />)}
            </div>
          </div>

          <div style={{ marginTop: 14, background: "#161616", borderRadius: 8, padding: 14, border: "1px solid #1e1e1e" }}>
            <div style={shimmer("42px", 10, 4)} />
            <div style={{ display: "flex", gap: 7, marginTop: 10 }}>
              <div style={shimmer("70px", 24, 12)} />
              <div style={shimmer("92px", 24, 12)} />
              <div style={shimmer("54px", 24, 12)} />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 }}>
            <div style={shimmer("100%", 40, 8)} />
            <div style={shimmer("100%", 40, 8)} />
          </div>
        </div>

        <div style={{ padding: "14px 22px 18px", borderTop: "1px solid #1a1a1a", display: "flex", gap: 8 }}>
          <div style={{ flex: 1, ...shimmer("100%", 38, 8) }} />
          <div style={{ width: 104, ...shimmer("104px", 38, 8) }} />
        </div>
      </div>
    </>
  );
}
