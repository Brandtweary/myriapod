// Family-code minter. The operator generates codes and hands them out; redeeming one
// (via POST /redeem) provisions a $FAMILY_LIMIT OpenRouter sub-key + a token.
//
//   bun run mint-code.ts <code>

import { config } from "./config";
import { Db } from "./db";

const code = process.argv[2]?.trim();
if (!code) {
	console.error("usage: bun run mint-code.ts <code>");
	process.exit(1);
}

const db = new Db(config.dbPath);
if (db.codeExists(code)) {
	console.error(`code already exists: ${code}`);
	process.exit(1);
}
db.insertCode(code);
console.log(`minted family code: ${code}`);
