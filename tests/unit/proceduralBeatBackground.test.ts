import { assert, equal, runSuite } from "../helpers/testHarness.js";
import { __testProceduralBeatBackground as bg } from "../../src/lib/proceduralBeatBackground.js";

function colorCount(seed: string): number {
  const spec = bg.makeSpec(seed) as { blobs: Array<{ idx: number }> };
  return new Set(spec.blobs.map((blob) => blob.idx)).size;
}

runSuite("Procedural beat background", [
  ["same beat id produces the same specification", () => {
    const a = JSON.stringify(bg.makeSpec("bg-v1:beat-123"));
    const b = JSON.stringify(bg.makeSpec("bg-v1:beat-123"));
    equal(a, b, "Procedural spec must be deterministic for a stable beat id");
  }],
  ["different beat ids normally produce different specifications", () => {
    const a = JSON.stringify(bg.makeSpec("bg-v1:beat-123"));
    const b = JSON.stringify(bg.makeSpec("bg-v1:beat-124"));
    assert(a !== b, "Different ids should not collapse to the same procedural spec");
  }],
  ["generated specs always use 2 to 4 colors", () => {
    for (let i = 0; i < 1000; i += 1) {
      const count = colorCount(`bg-v1:range-${i}`);
      assert(count >= 2 && count <= 4, `Unexpected color count ${count}`);
    }
  }],
  ["color-count distribution stays near 45/35/20", () => {
    const total = 10000;
    const counts = new Map<number, number>([[2, 0], [3, 0], [4, 0]]);
    for (let i = 0; i < total; i += 1) {
      const count = colorCount(`bg-v1:dist-${i}`);
      counts.set(count, (counts.get(count) || 0) + 1);
    }
    const share = (n: number) => (counts.get(n) || 0) / total;
    assert(Math.abs(share(2) - 0.45) < 0.035, `2-color share drifted to ${share(2)}`);
    assert(Math.abs(share(3) - 0.35) < 0.035, `3-color share drifted to ${share(3)}`);
    assert(Math.abs(share(4) - 0.20) < 0.03, `4-color share drifted to ${share(4)}`);
  }],
  ["coverage target remains inside designed bounds", () => {
    for (let i = 0; i < 1000; i += 1) {
      const spec = bg.makeSpec(`bg-v1:coverage-${i}`) as { targetCoverage: number };
      assert(spec.targetCoverage >= 0.42 && spec.targetCoverage <= 0.68, `coverage=${spec.targetCoverage}`);
    }
  }],
  ["blob geometry and intensity stay inside generator bounds", () => {
    for (let i = 0; i < 500; i += 1) {
      const spec = bg.makeSpec(`bg-v1:blob-${i}`) as { blobs: Array<{ cx:number; cy:number; rx:number; ry:number; rot:number; intensity:number }> };
      assert(spec.blobs.length >= 5 && spec.blobs.length <= 9, `blob count=${spec.blobs.length}`);
      for (const blob of spec.blobs) {
        assert(blob.cx >= 0.04 && blob.cx <= 0.96, `cx=${blob.cx}`);
        assert(blob.cy >= 0.04 && blob.cy <= 0.96, `cy=${blob.cy}`);
        assert(blob.rx > 0 && blob.rx <= 0.54, `rx=${blob.rx}`);
        assert(blob.ry > 0 && blob.ry <= 0.54, `ry=${blob.ry}`);
        assert(blob.rot >= 0 && blob.rot <= Math.PI * 2, `rot=${blob.rot}`);
        assert(blob.intensity > 0 && blob.intensity <= 1.2, `intensity=${blob.intensity}`);
      }
    }
  }],
  ["HSL conversion always returns normalized RGB", () => {
    for (let h = -720; h <= 720; h += 17) {
      const [r, g, b] = bg.hslToRgb(h, 100, 50);
      for (const channel of [r, g, b]) assert(channel >= 0 && channel <= 1, `channel=${channel}`);
    }
  }],
]);
