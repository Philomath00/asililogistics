import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
const path = new URL("../.env", import.meta.url);
let content = existsSync(path) ? readFileSync(path, "utf8") : "";
const created = [];
for (const name of ["ADMIN_KEY", "WHATSAPP_VERIFY_TOKEN"]) {
  const entry = content
    .split(/\r?\n/)
    .find((line) => line.startsWith(name + "="));
  if (entry && !/^\s*(?:''|""|#.*)?\s*$/.test(entry.slice(name.length + 1)))
    continue;
  const assignment = name + "=" + randomBytes(32).toString("base64url");
  if (entry) content = content.replace(entry, assignment);
  else
    content +=
      (content.endsWith("\n") || !content ? "" : "\n") + assignment + "\n";
  created.push(name);
}
writeFileSync(path, content, { mode: 0o600 });
chmodSync(path, 0o600);
console.log(
  created.length
    ? "Generated " + created.join(", ") + " in ignored .env (values hidden)."
    : "Existing credentials preserved.",
);
