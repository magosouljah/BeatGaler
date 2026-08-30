import React, { useEffect, useMemo, useState } from "react";
import privacyMarkdown from "../../../docs/legal/PRIVACY.md?raw";
import termsMarkdown from "../../../docs/legal/TERMS.md?raw";
import { platform } from "../../platform";

type LegalKind = "privacy" | "terms";

type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] };

function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    if (text) blocks.push({ type: "paragraph", text });
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push({ type: "list", items: list });
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: heading[1].length as 1 | 2 | 3, text: heading[2] });
      continue;
    }
    if (line.startsWith("- ")) {
      flushParagraph();
      list.push(line.slice(2));
      continue;
    }
    flushList();
    paragraph.push(line.replace(/\s{2}$/g, ""));
  }
  flushParagraph();
  flushList();
  return blocks;
}

function inline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi);
  return parts.filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(part)) return <a key={index} href={`mailto:${part}`}>{part}</a>;
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

export function PublicLegalLinks() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (platform.kind !== "web") return;
    const update = () => setShow(Boolean(document.querySelector(".bg-auth-shell")));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  if (!show) return null;
  return (
    <nav aria-label="Legal" style={{ position: "fixed", left: 0, right: 0, bottom: 16, zIndex: 1000, display: "flex", justifyContent: "center", gap: 16, fontFamily: "'DM Sans', sans-serif", fontSize: 11 }}>
      <a href="/privacy" style={{ color: "#777", textDecoration: "none" }}>Privacy Policy</a>
      <a href="/terms" style={{ color: "#777", textDecoration: "none" }}>Terms of Service</a>
    </nav>
  );
}

export function PublicLegalPage({ kind }: { kind: LegalKind }) {
  const markdown = kind === "privacy" ? privacyMarkdown : termsMarkdown;
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  const title = kind === "privacy" ? "Privacy Policy" : "Terms of Service";

  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · BeatGaler`;
    return () => { document.title = previous; };
  }, [title]);

  return (
    <main style={{ minHeight: "100vh", background: "#0c0c0c", color: "#d8d8d8", fontFamily: "'DM Sans', system-ui, sans-serif", padding: "48px 20px 80px" }}>
      <article style={{ width: "min(820px, 100%)", margin: "0 auto" }}>
        <header style={{ marginBottom: 34 }}>
          <a href="/" style={{ color: "#8a8a8a", textDecoration: "none", fontSize: 12 }}>← BeatGaler</a>
        </header>
        {blocks.map((block, index) => {
          if (block.type === "heading") {
            const Tag = block.level === 1 ? "h1" : block.level === 2 ? "h2" : "h3";
            const style: React.CSSProperties = block.level === 1
              ? { color: "#fff", fontSize: 34, lineHeight: 1.12, letterSpacing: "-.03em", margin: "0 0 24px" }
              : block.level === 2
                ? { color: "#f2f2f2", fontSize: 20, lineHeight: 1.25, margin: "34px 0 12px" }
                : { color: "#e8e8e8", fontSize: 15, lineHeight: 1.3, margin: "24px 0 9px" };
            return <Tag key={index} style={style}>{inline(block.text)}</Tag>;
          }
          if (block.type === "list") {
            return <ul key={index} style={{ margin: "8px 0 18px", paddingLeft: 22, color: "#b9b9b9", lineHeight: 1.7, fontSize: 13 }}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}</ul>;
          }
          return <p key={index} style={{ margin: "0 0 14px", color: "#b9b9b9", lineHeight: 1.7, fontSize: 13 }}>{inline(block.text)}</p>;
        })}
        <footer style={{ borderTop: "1px solid #242424", marginTop: 42, paddingTop: 18, display: "flex", gap: 16, fontSize: 11 }}>
          <a href="/privacy" style={{ color: "#777", textDecoration: "none" }}>Privacy Policy</a>
          <a href="/terms" style={{ color: "#777", textDecoration: "none" }}>Terms of Service</a>
        </footer>
      </article>
    </main>
  );
}
