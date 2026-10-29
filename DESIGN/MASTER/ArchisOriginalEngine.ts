// @ts-nocheck
/*
 * Verbatim optical engine from https://github.com/archisvaze/liquid-glass
 * Upstream revision: fbeb99ef5e8dad2cbbc991ffc23e186a28dc01c4, index.html, functions from
 * SURFACE_FNS through rebuildFilter. MIT license: SHAPE_GLASS_LICENSE.txt.
 *
 * IMPORTANT: All code between BEGIN/END is copied unchanged (including
 * upstream filter and its original parameter lookup). Only the containing
 * function and returned rebuild callback are integration glue.
 */
export function mountOriginalArchisEngine() {
  /* BEGIN VERBATIM UPSTREAM */
const SURFACE_FNS = {
            convex_squircle: (x) => Math.pow(1 - Math.pow(1 - x, 4), 0.25),
            convex_circle: (x) => Math.sqrt(1 - (1 - x) * (1 - x)),
            concave: (x) => 1 - Math.sqrt(1 - (1 - x) * (1 - x)),
            lip: (x) => {
                const convex = Math.pow(1 - Math.pow(1 - Math.min(x * 2, 1), 4), 0.25);
                const concave = 1 - Math.sqrt(1 - (1 - x) * (1 - x)) + 0.1;
                const t = 6 * x ** 5 - 15 * x ** 4 + 10 * x ** 3;
                return convex * (1 - t) + concave * t;
            },
        };

        function calculateRefractionProfile(glassThickness, bezelWidth, heightFn, ior, samples) {
            samples = samples || 128;
            const eta = 1 / ior;
            function refract(nx, ny) {
                const dot = ny;
                const k = 1 - eta * eta * (1 - dot * dot);
                if (k < 0) return null;
                const sq = Math.sqrt(k);
                return [-(eta * dot + sq) * nx, eta - (eta * dot + sq) * ny];
            }
            const profile = new Float64Array(samples);
            for (let i = 0; i < samples; i++) {
                const x = i / samples;
                const y = heightFn(x);
                const dx = x < 1 ? 0.0001 : -0.0001;
                const y2 = heightFn(x + dx);
                const deriv = (y2 - y) / dx;
                const mag = Math.sqrt(deriv * deriv + 1);
                const ref = refract(-deriv / mag, -1 / mag);
                if (!ref) {
                    profile[i] = 0;
                    continue;
                }
                profile[i] = ref[0] * ((y * bezelWidth + glassThickness) / ref[1]);
            }
            return profile;
        }

        function generateDisplacementMap(w, h, radius, bezelWidth, profile, maxDisp) {
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            const ctx = c.getContext('2d');
            const img = ctx.createImageData(w, h);
            const d = img.data;
            for (let i = 0; i < d.length; i += 4) {
                d[i] = 128;
                d[i + 1] = 128;
                d[i + 2] = 0;
                d[i + 3] = 255;
            }

            const r = radius,
                rSq = r * r,
                r1Sq = (r + 1) ** 2;
            const rBSq = Math.max(r - bezelWidth, 0) ** 2;
            const wB = w - r * 2,
                hB = h - r * 2,
                S = profile.length;

            for (let y1 = 0; y1 < h; y1++) {
                for (let x1 = 0; x1 < w; x1++) {
                    const x = x1 < r ? x1 - r : x1 >= w - r ? x1 - r - wB : 0;
                    const y = y1 < r ? y1 - r : y1 >= h - r ? y1 - r - hB : 0;
                    const dSq = x * x + y * y;
                    if (dSq > r1Sq || dSq < rBSq) continue;
                    const dist = Math.sqrt(dSq);
                    const fromSide = r - dist;
                    const op = dSq < rSq ? 1 : 1 - (dist - Math.sqrt(rSq)) / (Math.sqrt(r1Sq) - Math.sqrt(rSq));
                    if (op <= 0 || dist === 0) continue;
                    const cos = x / dist,
                        sin = y / dist;
                    const bi = Math.min(((fromSide / bezelWidth) * S) | 0, S - 1);
                    const disp = profile[bi] || 0;
                    const dX = (-cos * disp) / maxDisp,
                        dY = (-sin * disp) / maxDisp;
                    const idx = (y1 * w + x1) * 4;
                    d[idx] = (128 + dX * 127 * op + 0.5) | 0;
                    d[idx + 1] = (128 + dY * 127 * op + 0.5) | 0;
                }
            }
            ctx.putImageData(img, 0, 0);
            return c.toDataURL();
        }

        function generateSpecularMap(w, h, radius, bezelWidth, angle) {
            angle = angle != null ? angle : Math.PI / 3;
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            const ctx = c.getContext('2d');
            const img = ctx.createImageData(w, h);
            const d = img.data;
            d.fill(0);

            const r = radius,
                rSq = r * r,
                r1Sq = (r + 1) ** 2;
            const rBSq = Math.max(r - bezelWidth, 0) ** 2;
            const wB = w - r * 2,
                hB = h - r * 2;
            const sv = [Math.cos(angle), Math.sin(angle)];

            for (let y1 = 0; y1 < h; y1++) {
                for (let x1 = 0; x1 < w; x1++) {
                    const x = x1 < r ? x1 - r : x1 >= w - r ? x1 - r - wB : 0;
                    const y = y1 < r ? y1 - r : y1 >= h - r ? y1 - r - hB : 0;
                    const dSq = x * x + y * y;
                    if (dSq > r1Sq || dSq < rBSq) continue;
                    const dist = Math.sqrt(dSq);
                    const fromSide = r - dist;
                    const op = dSq < rSq ? 1 : 1 - (dist - Math.sqrt(rSq)) / (Math.sqrt(r1Sq) - Math.sqrt(rSq));
                    if (op <= 0 || dist === 0) continue;
                    const cos = x / dist,
                        sin = -y / dist;
                    const dot = Math.abs(cos * sv[0] + sin * sv[1]);
                    const edge = Math.sqrt(Math.max(0, 1 - (1 - fromSide) ** 2));
                    const coeff = dot * edge;
                    const col = (255 * coeff) | 0;
                    const alpha = (col * coeff * op) | 0;
                    const idx = (y1 * w + x1) * 4;
                    d[idx] = col;
                    d[idx + 1] = col;
                    d[idx + 2] = col;
                    d[idx + 3] = alpha;
                }
            }
            ctx.putImageData(img, 0, 0);
            return c.toDataURL();
        }

        const glass = document.getElementById('glass');

        let lastFilter = null;

        function rebuildFilter() {
            const w = glass.offsetWidth,
                h = glass.offsetHeight;
            if (w < 2 || h < 2) return;

            const surfaceKey = document.getElementById('surface-fn').value;
            const glassThick = +document.getElementById('glass-thickness').value;
            const bezelW = +document.getElementById('bezel-width').value;
            const ior = +document.getElementById('refractive-index').value;
            const scaleRatio = +document.getElementById('scale-ratio').value;
            const blurAmt = +document.getElementById('blur-amount').value;
            const specOpacity = +document.getElementById('specular-opacity').value;
            const specSat = +document.getElementById('specular-saturation').value;
            const radius = Math.floor(Math.min(+document.getElementById('border-radius').value, w / 2, h / 2));

            const heightFn = SURFACE_FNS[surfaceKey];
            const clampedBezel = Math.max(1, Math.min(bezelW, radius - 1, Math.min(w, h) / 2 - 1));

            const profile = calculateRefractionProfile(glassThick, clampedBezel, heightFn, ior, 128);
            const maxDisp = Math.max(...Array.from(profile).map(Math.abs)) || 1;
            const dispUrl = generateDisplacementMap(w, h, radius, clampedBezel, profile, maxDisp);
            const specUrl = generateSpecularMap(w, h, radius, clampedBezel * 2.5);
            const scale = maxDisp * scaleRatio;

            const markup = `<filter id="liquid-glass-filter" x="0%" y="0%" width="100%" height="100%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="${blurAmt}" result="blurred_source" />
      <feImage href="${dispUrl}" x="0" y="0" width="${w}" height="${h}" result="disp_map" />
      <feDisplacementMap in="blurred_source" in2="disp_map"
        scale="${scale}" xChannelSelector="R" yChannelSelector="G"
        result="displaced" />
      <feColorMatrix in="displaced" type="saturate" values="${specSat}" result="displaced_sat" />
      <feImage href="${specUrl}" x="0" y="0" width="${w}" height="${h}" result="spec_layer" />
      <feComposite in="displaced_sat" in2="spec_layer" operator="in" result="spec_masked" />
      <feComponentTransfer in="spec_layer" result="spec_faded">
        <feFuncA type="linear" slope="${specOpacity}" />
      </feComponentTransfer>
      <feBlend in="spec_masked" in2="displaced" mode="normal" result="with_sat" />
      <feBlend in="spec_faded" in2="with_sat" mode="normal" />
    </filter>`;

            document.getElementById('svg-defs').innerHTML = markup;
            lastFilter = { markup, w, h, radius };
        }
  /* END VERBATIM UPSTREAM */
  rebuildFilter();
  return rebuildFilter;
}
