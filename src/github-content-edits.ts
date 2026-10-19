import { asRecord } from "./value-coerce.js";

type JsonReader = <T>(args: string[]) => T;

/** Read attributed facts, not updated_at: a later bot edit cannot erase a human edit. */
export function githubHumanContentEditTimes(ghJson: JsonReader, ids: readonly string[]): number[] {
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error("missing or duplicate content identity");
  }
  const fields =
    "id ...on Comment{lastEditedAt userContentEdits(first:100,after:$after){totalCount nodes{id editedAt editor{__typename ...on User{id:databaseId} ...on Bot{id:databaseId}}} pageInfo{hasNextPage endCursor}}}";
  const humanTimes: number[] = [];
  for (let offset = 0; offset < ids.length; offset += 25) {
    const batch = ids.slice(offset, offset + 25);
    const data = asRecord(
      asRecord(
        ghJson<unknown>([
          "api",
          "graphql",
          "-f",
          `query=query($after:String){nodes(ids:${JSON.stringify(batch)}){${fields}}}`,
        ]),
      ).data,
    );
    if (!Array.isArray(data.nodes) || data.nodes.length !== batch.length) {
      throw new Error("missing content edit nodes");
    }
    for (const id of batch) {
      const matches = data.nodes.filter((value) => asRecord(value).id === id);
      if (matches.length !== 1) throw new Error("ambiguous content edit identity");
      let node = asRecord(matches[0]);
      const seen = new Set<string>();
      const cursors = new Set<string>();
      let latest = 0;
      let total: number | undefined;
      let expectedLastEdited: unknown;
      let complete = false;
      for (let page = 0; page < 100; page++) {
        const history = asRecord(node.userContentEdits);
        const info = asRecord(history.pageInfo);
        if (
          node.id !== id ||
          !Object.hasOwn(node, "lastEditedAt") ||
          !Array.isArray(history.nodes) ||
          !Number.isSafeInteger(history.totalCount) ||
          Number(history.totalCount) < 0 ||
          typeof info.hasNextPage !== "boolean"
        ) {
          throw new Error("incomplete content edit history");
        }
        if (page === 0) {
          total = Number(history.totalCount);
          expectedLastEdited = node.lastEditedAt;
        } else if (total !== history.totalCount || expectedLastEdited !== node.lastEditedAt) {
          throw new Error("content edit history changed while reading");
        }
        for (const value of history.nodes) {
          const edit = asRecord(value);
          const editor = asRecord(edit.editor);
          const at = typeof edit.editedAt === "string" ? Date.parse(edit.editedAt) : NaN;
          if (
            typeof edit.id !== "string" ||
            !edit.id ||
            seen.has(edit.id) ||
            !Number.isFinite(at) ||
            at <= 0 ||
            !Number.isSafeInteger(editor.id) ||
            Number(editor.id) <= 0 ||
            !["User", "Bot"].includes(String(editor.__typename))
          ) {
            throw new Error("unknown content edit attribution");
          }
          seen.add(edit.id);
          latest = Math.max(latest, at);
          if (editor.__typename === "User") humanTimes.push(at);
        }
        if (!info.hasNextPage) {
          const lastEdited =
            node.lastEditedAt === null
              ? 0
              : typeof node.lastEditedAt === "string"
                ? Date.parse(node.lastEditedAt)
                : NaN;
          if (seen.size !== total || !Number.isFinite(lastEdited) || latest !== lastEdited) {
            throw new Error("incomplete content edit history");
          }
          complete = true;
          break;
        }
        if (
          typeof info.endCursor !== "string" ||
          !info.endCursor ||
          cursors.has(info.endCursor) ||
          history.nodes.length === 0 ||
          seen.size >= Number(total)
        ) {
          throw new Error("incomplete content edit pagination");
        }
        cursors.add(info.endCursor);
        node = asRecord(
          asRecord(
            asRecord(
              ghJson<unknown>([
                "api",
                "graphql",
                "-f",
                `query=query($after:String){node(id:${JSON.stringify(id)}){${fields}}}`,
                "-f",
                `after=${info.endCursor}`,
              ]),
            ).data,
          ).node,
        );
      }
      if (!complete) throw new Error("content edit history exceeds pagination bound");
    }
  }
  return humanTimes;
}
