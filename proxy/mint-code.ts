// Family-code minter. The operator generates codes and hands them out; redeeming one
// (via POST /redeem) provisions a $FAMILY_LIMIT OpenRouter sub-key + a token.
//
//   bun run mint-code.ts [MEMORABLE-PREFIX]
//
// A random, human-typeable entropy segment is always appended so codes can't be
// guessed or enumerated even without the rate limiter. The memorable prefix (if given)
// is preserved for hand-out; omit it to mint a bare random code.

import { randomBytes } from "node:crypto";
import { config } from "./config";
import { Db } from "./db";

// Crockford-ish alphabet: no 0/O/1/I to keep codes easy to read out and type. 32 chars
// divides 256 evenly, so `byte % 32` is unbiased.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SEGMENT_LEN = 6; // ~30 bits of entropy

function randomSegment(len: number): string {
	const bytes = randomBytes(len);
	let s = "";
	for (let i = 0; i < len; i++) s += ALPHABET[bytes[i]! % ALPHABET.length];
	return s;
}

const prefix = process.argv[2]?.trim().toUpperCase().replace(/\s+/g, "-");
const code = prefix ? `${prefix}-${randomSegment(SEGMENT_LEN)}` : randomSegment(SEGMENT_LEN);

const db = new Db(config.dbPath);
if (db.codeExists(code)) {
	console.error(`code already exists: ${code}`);
	process.exit(1);
}
db.insertCode(code);
console.log(`minted family code: ${code}`);
