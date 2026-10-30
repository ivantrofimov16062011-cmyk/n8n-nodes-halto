// n8n loads icons relative to the compiled files: dist/icons next to dist/nodes and dist/credentials.
import { cpSync } from "node:fs";
cpSync("icons", "dist/icons", { recursive: true });
