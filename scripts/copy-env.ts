import { existsSync, mkdirSync, copyFileSync } from "fs";
import { join } from "path";

const root = process.cwd();
const source = join(root, ".env");
const binDir = join(root, "bin");
const target = join(binDir, ".env");

if (existsSync(source)) {
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });
  copyFileSync(source, target);
  console.log("Copied .env to bin/.env");
} else {
  console.log("No .env found; skipping copy.");
}
