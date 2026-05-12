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
