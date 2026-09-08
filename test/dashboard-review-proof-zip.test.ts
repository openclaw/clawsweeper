import assert from "node:assert/strict";
import test from "node:test";
import { zip } from "./helpers/command-proof-fixtures.ts";
import { readReviewProofZip } from "../dashboard/review-proof-zip.ts";

test("Web runtime reads stored and raw-deflated proof ZIP without Node runtime APIs", async () => {
  for (const compressed of [false, true]) {
    const archive = zip([
      { name: "receipt.json", content: Buffer.from('{"ok":true}'), compressed },
    ]);
    const files = await readReviewProofZip(new Uint8Array(archive));
    assert.equal(files.size, 1);
    assert.equal(new TextDecoder().decode(files.get("receipt.json")), '{"ok":true}');
  }
});

test("Web proof ZIP rejects paths, collisions, corruption and over-inflation", async () => {
  for (const name of ["../evil", "/absolute", "foo\\bar"]) {
    await assert.rejects(readReviewProofZip(zip([{ name, content: Buffer.from("x") }])));
  }
  await assert.rejects(
    readReviewProofZip(
      zip([
        { name: "receipt.json", content: Buffer.from("x") },
        { name: "RECEIPT.JSON", content: Buffer.from("x") },
      ]),
    ),
  );
  const corrupted = zip([{ name: "receipt.json", content: Buffer.from("data") }]);
  corrupted[30 + "receipt.json".length] ^= 1;
  await assert.rejects(readReviewProofZip(corrupted), /corrupt/);
  const bomb = zip([
    { name: "receipt.json", content: Buffer.alloc(100_000, 65), compressed: true },
  ]);
  const central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(1, 22);
  bomb.writeUInt32LE(1, central + 24);
  await assert.rejects(readReviewProofZip(bomb), /inflation_limit/);
});
