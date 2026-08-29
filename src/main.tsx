import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { browserId3Reader } from "./lib/id3BrowserParser";
import AuthExperienceGate from "./features/auth/AuthExperienceGate";
import LibraryUxBridge from "./features/library/LibraryUxBridge";
import { PlatformProvider } from "./platform/react";
import "./styles/design-foundations.css";
import "./styles/auth-ui.css";
import "./styles/library-ux.css";

// Browser metadata parsing is bundled with BeatGaler. The legacy fallback in
// tauri.ts is stripped from productive Vite output by the trust-boundary plugin,
// so no runtime JavaScript is loaded from a CDN.
(window as any).jsmediatags = browserId3Reader;

function GlobalStyles() {
  return (
    <style>{`
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
    <PlatformProvider>
      <AuthExperienceGate>
        <LibraryUxBridge />
        <App />
      </AuthExperienceGate>
    </PlatformProvider>
  </ErrorBoundary>
);
