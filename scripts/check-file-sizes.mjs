import { readdirSync, readFileSync } from "node:fs";

// Physical line ceilings after formatting, tracked debt for SB-3/SB-5/SB-6.
// Production/scripts get 500 lines, tests 1,000. Shrinking debt must lower its ceiling.
const debtLimits = {
  "src/ThreadCard.tsx": 574,
};
const files = [
  "app.tsx",
  ...readdirSync("src", { recursive: true })
    .filter((name) => /\.(ts|tsx)$/.test(name))
    .map((name) => `src/${name}`),
  ...readdirSync("scripts", { recursive: true })
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => `scripts/${name}`),
];
let failures = 0;
for (const file of Object.keys(debtLimits)) {
  if (!files.includes(file)) {
    console.error(`${file}: debt file no longer exists. Remove the debt entry.`);
    failures++;
  }
}
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const lines = source.length === 0 ? 0 : source.split(/\r?\n/).length - Number(source.endsWith("\n"));
  const defaultLimit = /\.test\.(ts|tsx)$/.test(file) ? 1000 : 500;
  const ceiling = debtLimits[file];
  const limit = ceiling ?? defaultLimit;
  if (lines > limit) {
    console.error(`${file}: ${lines} lines exceeds the ${limit}-line budget. Split the file before adding more.`);
    failures++;
  } else if (ceiling !== undefined && lines <= defaultLimit) {
    console.error(`${file}: ${lines} lines is within the ${defaultLimit}-line budget. Remove the debt entry.`);
    failures++;
  } else if (ceiling !== undefined && lines < ceiling) {
    console.error(
      `${file}: ${lines} lines is below the recorded ${ceiling}-line ceiling. Lower the number to ${lines}.`,
    );
    failures++;
  }
}
if (failures > 0) process.exitCode = 1;
else console.log("File-size budgets passed.");
