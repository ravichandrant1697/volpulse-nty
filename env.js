// Minimal .env loader (KEY=value lines, # comments, optional quotes). Values already in the environment win,
// so GitHub repository secrets override the file. Kept in-house to stay dependency-free.
const fs = require("fs");
const path = require("path");
for (const file of [path.join(process.cwd(), ".env"), path.join(__dirname, ".env")]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !m[0].trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  break;
}
