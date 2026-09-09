'use strict';

const fs = require('fs');

function replaceOnce(path, before, after) {
  let text = fs.readFileSync(path, 'utf8');
  if (!text.includes(before)) {
    throw new Error(`${path} no longer matches the expected pre-10.2 regression ownership shape`);
  }
  text = text.replace(before, after);
  fs.writeFileSync(path, text);
}

replaceOnce(
  'scripts/regression-import-native.mjs',
  'const app = read("src/App.tsx");',
  'const appEntry = read("src/App.tsx");\nconst composition = read("src/app/useBeatGalerComposition.ts").replaceAll("../", "./");\nconst app = `${appEntry}\\n${composition}`;',
);

replaceOnce(
  'scripts/regression-phase9cd.mjs',
  'const app = read("src/App.tsx");',
  'const appEntry = read("src/App.tsx");\nconst composition = read("src/app/useBeatGalerComposition.ts").replaceAll("../", "./");\nconst app = `${appEntry}\\n${composition}`;',
);

replaceOnce(
  'scripts/run-regressions.mjs',
  '  const app = readFileSync(path.join(root, "src", "App.tsx"), "utf8");',
  '  const appEntry = readFileSync(path.join(root, "src", "App.tsx"), "utf8");\n  const composition = readFileSync(path.join(root, "src", "app", "useBeatGalerComposition.ts"), "utf8").replaceAll("../", "./");\n  const app = `${appEntry}\\n${composition}`;',
);

console.log('Redirected regression characterization ownership to the 10.2 root composition boundary');
fs.unlinkSync(__filename);
