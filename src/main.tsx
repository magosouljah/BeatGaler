import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

function GlobalStyles() {
  return (
    <style>{`
      :root {
        font-family: "SF Pro Text", "Segoe UI", "Helvetica Neue", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      button, input, select {
        font-family: inherit;
      }

      @keyframes fadeUp {
        from {
          opacity: 0;
          transform: translateY(10px) scale(0.985);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      @keyframes drawerIn {
        from {
          transform: translateX(20px);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }

      @keyframes dot {
        from { transform: translateY(0); opacity: 0.35; }
        to { transform: translateY(-4px); opacity: 1; }
      }

      @keyframes beatgaler-upload-spin {
        from { transform: rotate(0deg) scale(1); }
        to { transform: rotate(360deg) scale(1); }
      }

      @keyframes beatgaler-offline-pulse {
        0%, 100% { transform: scale(0.96); opacity: .56; }
        50% { transform: scale(1.04); opacity: .92; }
      }

      @keyframes beatgaler-upload-success {
        0% { transform: translateY(0) scale(1) rotate(0deg); opacity: 1; }
        28% { transform: translateY(-3px) scale(1.08) rotate(8deg); opacity: 1; }
        100% { transform: translateY(34px) scale(0.82) rotate(20deg); opacity: 0; }
      }

      @keyframes beatgaler-upload-glow {
        0% { opacity: 0; }
        25% { opacity: .52; }
        100% { opacity: 0; }
      }

      @keyframes beatgaler-refresh-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }

      @keyframes beatgaler-refresh-line {
        0% { transform: translateX(-120%); opacity: .25; }
        50% { opacity: .65; }
        100% { transform: translateX(430%); opacity: .25; }
      }

      @keyframes beatgaler-skeleton-pulse {
        0%, 100% { opacity: .48; }
        50% { opacity: .9; }
      }

      .beatgaler-skeleton-block {
        background: #303030;
        border-radius: 8px;
        animation: beatgaler-skeleton-pulse 1.15s ease-in-out infinite;
      }
      .beatgaler-skeleton-cover { width: 160px; height: 160px; border-radius: 10px; }
      .beatgaler-skeleton-title { width: 150px; height: 17px; margin-top: 12px; }
      .beatgaler-skeleton-tag { width: 72px; height: 17px; border-radius: 999px; }
      .beatgaler-skeleton-tag-short { width: 48px; }

      @keyframes pgb1 { from { transform: scaleY(0.25); } to { transform: scaleY(1); } }
      @keyframes pgb2 { from { transform: scaleY(0.4); } to { transform: scaleY(0.9); } }
      @keyframes pgb3 { from { transform: scaleY(0.2); } to { transform: scaleY(0.8); } }
      @keyframes pgb4 { from { transform: scaleY(0.5); } to { transform: scaleY(1); } }
    `}</style>
  );
}

class ErrorBoundary extends React.Component<{children: React.ReactNode}, {error: string | null}> {
  constructor(props: any) { super(props); this.state = { error: null }; }
  componentDidCatch(e: any) { this.setState({ error: String(e) }); }
  static getDerivedStateFromError(e: any) { return { error: String(e) }; }
  render() {
    if (this.state.error) return (
      <div style={{ padding: 40, color: "#f87171", fontFamily: "monospace", fontSize: 13, background: "#0c0c0c", height: "100vh" }}>
        <div style={{ marginBottom: 12, color: "#fff", fontSize: 16 }}>BeatVault crashed</div>
        <pre style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{this.state.error}</pre>
      </div>
    );
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <GlobalStyles />
    <App />
  </ErrorBoundary>
);
