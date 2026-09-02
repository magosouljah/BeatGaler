import { readFileSync, writeFileSync } from 'node:fs';

function replaceExact(path, before, after) {
  const source = readFileSync(path, 'utf8');
  if (!source.includes(before)) throw new Error(`Pattern not found in ${path}: ${before.slice(0, 120)}`);
  const next = source.replace(before, after);
  if (next === source) throw new Error(`No change in ${path}`);
  writeFileSync(path, next);
}

// Web already has AuthExperienceGate in main.tsx. Keep the legacy AccountGate
// only for Desktop so Web performs one session restore and shows one startup surface.
replaceExact(
  'src/App.tsx',
  `export default function App() {\n  return <AccountGate><BeatGalerApp /></AccountGate>;\n}`,
  `export default function App() {\n  return platform.kind === "web"\n    ? <BeatGalerApp />\n    : <AccountGate><BeatGalerApp /></AccountGate>;\n}`,
);

// Cached cards may play/warm before authoritative mutation rights are verified.
replaceExact(
  'src/App.tsx',
  `                    visible={revealedBeatIds.has(beat.id)}\n                    interactive={cloudSessionVerified || connectionState === "offline" || connectionState === "poor"}\n                    openableProject=`,
  `                    visible={revealedBeatIds.has(beat.id)}\n                    interactive={cloudSessionVerified || connectionState === "offline" || connectionState === "poor"}\n                    playbackInteractive={connectionState === "online" || Boolean(beat.offline_available)}\n                    openableProject=`,
);

// Online reveal is monotonic. A refresh may add newly-authoritative ids, but it
// must never hide already-visible slots while another transport event settles.
replaceExact(
  'src/App.tsx',
  `            setRevealedBeatIds(new Set(visible.map(beat => beat.id)));`,
  `            setRevealedBeatIds(current => {\n              const next = new Set(current);\n              for (const beat of visible) next.add(beat.id);\n              return next;\n            });`,
);

replaceExact(
  'src/components/BeatCard.tsx',
  `  interactive?: boolean;\n  cloudUploadErrorDetail?: string;`,
  `  interactive?: boolean;\n  playbackInteractive?: boolean;\n  cloudUploadErrorDetail?: string;`,
);
replaceExact(
  'src/components/BeatCard.tsx',
  `  beat, visible = true, interactive = true, cloudUploadErrorDetail, tagFrequency, showIncompleteWarnings, openableProject = false, playing, selected, selectedCount, selectMode,`,
  `  beat, visible = true, interactive = true, playbackInteractive = interactive, cloudUploadErrorDetail, tagFrequency, showIncompleteWarnings, openableProject = false, playing, selected, selectedCount, selectMode,`,
);
replaceExact(
  'src/components/BeatCard.tsx',
  `    if (!visible || !interactive || !node || hasEnteredViewport) return;`,
  `    if (!visible || !playbackInteractive || !node || hasEnteredViewport) return;`,
);
replaceExact(
  'src/components/BeatCard.tsx',
  `  }, [visible, interactive, hasEnteredViewport]);`,
  `  }, [visible, playbackInteractive, hasEnteredViewport]);`,
);
replaceExact(
  'src/components/BeatCard.tsx',
  `    if (!visible || !interactive || !hasEnteredViewport || !beat.telegram_file_id) return;`,
  `    if (!visible || !playbackInteractive || !hasEnteredViewport || !beat.telegram_file_id) return;`,
);
replaceExact(
  'src/components/BeatCard.tsx',
  `  }, [visible, interactive, hasEnteredViewport, beat.id, beat.telegram_file_id, onWarm]);`,
  `  }, [visible, playbackInteractive, hasEnteredViewport, beat.id, beat.telegram_file_id, onWarm]);`,
);
replaceExact(
  'src/components/BeatCard.tsx',
  `  const handleContextMenu = (e: React.MouseEvent) => {\n    if (selectMode) {`,
  `  const handleContextMenu = (e: React.MouseEvent) => {\n    if (!interactive) return;\n    if (selectMode) {`,
);
replaceExact(
  'src/components/BeatCard.tsx',
  `      onClick={e => { if (selectMode) onToggleSelect(beat, e); }}`,
  `      onClick={e => { if (interactive && selectMode) onToggleSelect(beat, e); }}`,
);
replaceExact(
  'src/components/BeatCard.tsx',
  `        pointerEvents: visible && interactive ? "auto" : "none",`,
  `        pointerEvents: visible ? "auto" : "none",`,
);
replaceExact(
  'src/components/BeatCard.tsx',
  `        {...(dragEnabled ? attributes : {})}\n        {...(dragEnabled ? listeners : {})}\n        aria-disabled={playbackBlocked}\n        style={{\n          position: "relative", cursor: playbackBlocked ? "default" : (dragEnabled ? "grab" : "pointer"),`,
  `        {...(dragEnabled && interactive ? attributes : {})}\n        {...(dragEnabled && interactive ? listeners : {})}\n        aria-disabled={playbackBlocked || !playbackInteractive}\n        style={{\n          position: "relative", cursor: playbackBlocked || !playbackInteractive ? "default" : (dragEnabled && interactive ? "grab" : "pointer"),`,
);
replaceExact(
  'src/components/BeatCard.tsx',
  `          if (selectMode) { e.stopPropagation(); onToggleSelect(beat, e); return; }\n          e.stopPropagation();\n          if (playbackBlocked) return;\n          onPlay(beat);`,
  `          if (selectMode) {\n            if (!interactive) return;\n            e.stopPropagation(); onToggleSelect(beat, e); return;\n          }\n          e.stopPropagation();\n          if (!playbackInteractive || playbackBlocked) return;\n          onPlay(beat);`,
);

// Keep one visible startup surface. Signed-in Web stays behind the static loader
// until the library can paint; signed-out Web dismisses it only when the real auth UI is ready.
replaceExact(
  'index.html',
  `        const dismissWhenSignedOutGateRenders = () => {\n          if (!root.querySelector(".bg-account-gate")) return false;\n          document.getElementById("beatgaler-startup-loader")?.remove();\n          return true;\n        };`,
  `        const dismissWhenSignedOutGateRenders = () => {\n          const readyAuth = root.querySelector('.bg-auth-shell:not([aria-busy="true"])');\n          const legacyDesktopAuth = root.querySelector(".bg-account-gate");\n          if (!readyAuth && !legacyDesktopAuth) return false;\n          document.getElementById("beatgaler-startup-loader")?.remove();\n          return true;\n        };`,
);

// Force the exact MIME mapping; default_type alone does not override an inherited
// extension mapping and production proved that .wasm was still octet-stream.
replaceExact(
  'deploy/web/beatgaler.com.conf',
  `    location ~* ^/assets/.*\\.wasm$ {\n        default_type application/wasm;`,
  `    location ~* ^/assets/.*\\.wasm$ {\n        types { application/wasm wasm; }\n        default_type application/wasm;`,
);

// Update permanent architecture tests for the new split between playback and mutations.
replaceExact(
  'tests/component-dom/startupRevealArchitecture.test.ts',
  `    expect(app).toContain('interactive={cloudSessionVerified || connectionState === "offline" || connectionState === "poor"}');\n    expect(beatCard).toContain('visibility: visible ? "visible" : "hidden"');\n    expect(beatCard).toContain('pointerEvents: visible && interactive ? "auto" : "none"');\n    expect(beatCard).toContain("if (!visible || !interactive || !hasEnteredViewport || !beat.telegram_file_id) return;");`,
  `    expect(app).toContain('interactive={cloudSessionVerified || connectionState === "offline" || connectionState === "poor"}');\n    expect(app).toContain('playbackInteractive={connectionState === "online" || Boolean(beat.offline_available)}');\n    expect(beatCard).toContain('visibility: visible ? "visible" : "hidden"');\n    expect(beatCard).toContain('pointerEvents: visible ? "auto" : "none"');\n    expect(beatCard).toContain("if (!visible || !playbackInteractive || !hasEnteredViewport || !beat.telegram_file_id) return;");`,
);
replaceExact(
  'tests/component-dom/startupRevealArchitecture.test.ts',
  `  it("serves WebAssembly with the streaming MIME type", () => {\n    expect(nginx).toContain("default_type application/wasm;");\n  });`,
  `  it("keeps Web auth to one gate while preserving Desktop AccountGate", () => {\n    expect(app).toContain('return platform.kind === "web"');\n    expect(app).toContain('? <BeatGalerApp />');\n    expect(app).toContain(': <AccountGate><BeatGalerApp /></AccountGate>');\n  });\n\n  it("keeps online reveal monotonic across transport refreshes", () => {\n    expect(app).toContain("for (const beat of visible) next.add(beat.id)");\n  });\n\n  it("serves WebAssembly with the streaming MIME type", () => {\n    expect(nginx).toContain("types { application/wasm wasm; }");\n    expect(nginx).toContain("default_type application/wasm;");\n  });`,
);

console.log('Issue #97 startup interaction follow-up patch applied.');
