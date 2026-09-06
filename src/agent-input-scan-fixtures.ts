import { createHash } from "node:crypto";
import { basename } from "node:path";

interface ReviewedFixture {
  fixtureSha256: string;
  rawSha256?: string;
  lineSha256s?: readonly string[];
  decoders?: readonly ("PLAIN" | "HTML" | "BASE64")[];
  sources: readonly string[];
}

export type ScanSourceRole = "base" | "head" | "index" | "tree" | "worktree";

export type ReviewedAttribution = readonly [
  detectorType: 17 | 895 | 968,
  detectorName: "URI" | "MongoDB" | "Postgres",
  decoder: "PLAIN" | "ESCAPED_UNICODE",
  role: ScanSourceRole,
  rawSha256: string,
  rawV2Sha256: string,
  lineSha256: string,
  source: string,
  mode: "100644",
];

// This is host policy, never an allowlist loaded from the reviewed checkout.
const REVIEWED_FIXTURES: readonly ReviewedFixture[] = [
  {
    // Maintainer-reviewed malformed-config fixture introduced by d68b1861172120fc.
    fixtureSha256: "a728de5dbbef23b8aa5ef2d99060835f4f2fb5a0fa2abb9fe249d08aa09bd09e",
    sources: ["test/action-ledger-runtime.test.ts"],
  },
  {
    // Explicitly approved autoreview negative-test fixture, including its vendored path.
    fixtureSha256: "662a886a0fd7447dad0acda3aeccc9eb539fc90438b453de7e2f523ca7ee6c83",
    sources: [
      "skills/autoreview/tests/test_autoreview_hardening.py",
      ".agents/skills/autoreview/tests/test_autoreview_hardening.py",
    ],
  },
  {
    // OpenClaw Browser local-CDP authentication fixture introduced by 8e03b0c62e76.
    fixtureSha256: "d69d650dc6c312f3e1071f8613df780323fadd01b8c40e6edd02715cd731ae60",
    sources: ["extensions/browser/src/browser/chrome.test.ts"],
  },
  {
    // OpenClaw Browser remote-CDP redaction fixtures introduced by 58da2f5897 and 4b5987829.
    fixtureSha256: "60267342b1ab046bd8c42e2226fdfce2aa081e7f18e17c35c9c013d7b1de5720",
    sources: [
      "extensions/browser/src/browser/chrome.test.ts",
      "extensions/browser/src/browser/server-context.ensure-browser-available.waits-for-cdp-ready.test.ts",
    ],
  },
  {
    // Profile-status redaction repeats this synthetic URI in config and a mocked-call assertion.
    fixtureSha256: "d15184614e748450d49a726f84955ca7745b87d0728afbd6bb6b50d84cce4fe0",
    sources: ["extensions/browser/src/browser/server-context.list-profiles.test.ts"],
  },
  {
    // OpenClaw remote-CDP documentation example introduced by bf15c87d2b12.
    fixtureSha256: "e6907dddaccdec944b0f02e14fe9186293e2d513ff753db0a95b3460aa5dc1d9",
    sources: ["docs/tools/browser.md"],
  },
  {
    // OpenClaw credentialed-page rejection fixture introduced by d5fb4903f1b1.
    fixtureSha256: "d8996b8fdec57910e379c720611bc37f9433f1cb7027b6f6262d785f1506e9ff",
    rawSha256: "8d3331ee208c72c30fba199e4e2b8a65d69a5034e49875a2f20dbea3a4f2f976",
    sources: ["extensions/browser/src/browser-tool.test.ts"],
  },
  {
    // Decoding a neighboring Basic-auth token can label these unchanged CDP
    // literals BASE64. Each match still requires its exact original source line.
    fixtureSha256: "24bd2ee9856630ff773868d946a3b3159e1bb04b297adf4d42b916218a0195d7",
    rawSha256: "d15184614e748450d49a726f84955ca7745b87d0728afbd6bb6b50d84cce4fe0",
    lineSha256s: ["89bc2aa05769a4016fb19125143188f20b91807aa5c47918133a119b5a91d341"],
    decoders: ["PLAIN", "HTML", "BASE64"],
    sources: ["extensions/browser/src/browser/cdp.helpers.test.ts"],
  },
  {
    fixtureSha256: "973f5bd82def987cc78ac1211ce5f32debb1284687fc325aa3b9101879c19228",
    rawSha256: "886f9c4f784d3bccb1899db732a298b1d10db8ffdb2b88f76435ea346956e83f",
    lineSha256s: ["8cf15179943a1e0f6610e8bd8677c07cd69c4f9241709527c735d7a1e50ee9cf"],
    decoders: ["PLAIN", "HTML", "BASE64"],
    sources: ["extensions/browser/src/browser/cdp.helpers.test.ts"],
  },
  {
    // Bind the complete MCP redaction fixture, including its unmatched query.
    fixtureSha256: "1723ec81bae6840c6acfb126d527fa9cd7727764c93846424fc6136fa5dbb860",
    rawSha256: "a89a1a50188bbcb017bc52d1d2683ea0c06d8805919c89d4813fc3ee0050061b",
    lineSha256s: ["30136a0d64f0e22bd059dd81cc6a07cad9af26be47d7979a314dee7093011f1f"],
    sources: ["extensions/browser/src/browser/chrome-mcp.test.ts"],
  },
  {
    // Crabbox fleet audit sanitization fixture reviewed across stacked PRs 1619-1621.
    fixtureSha256: "feadf36b48cb372414d8668b56c965d97d8e34d206d323b3790e863ac233f675",
    lineSha256s: ["fe8e60928483fc681c5cd7c1fd7d9cf26dea28a4e299462b2fa17d1687889e18"],
    sources: ["worker/test/fleet.test.ts"],
  },
  {
    // Approved Mac dashboard subframe rejection witness in OpenClaw 9ba01d6c7b1c.
    fixtureSha256: "97c60d02f5114db97718cfe1c3686c0a36fb5138840611c8793c7abbd9c64f71",
    rawSha256: "43690a8c13d4028ed731bc4dfeb37f83adaa4e5849d2e0fa13f746843adec333",
    lineSha256s: ["87f28bc6a5b0037cfd2ecc94349d5c9bfff572776c25d5e713ae7d83144f5f98"],
    decoders: ["PLAIN"],
    sources: ["apps/macos/Tests/OpenClawIPCTests/DashboardWindowSmokeTests.swift"],
  },
  {
    // Mattermost slash-error sanitization fixtures introduced by 9c0975c1c20e.
    fixtureSha256: "f2c5cfd2b711577ed9048f9bd0e6c97ae88097b8eba8c1ff37deb33ed910f5a7",
    rawSha256: "7d765bfa6e81c336a916aaf71eab28f5c0c4ae47a359ec3adf2d4f175645456d",
    lineSha256s: ["38c08c0f567b2d663fb72a8b41170a233f5baeb499a2205143a873df9e21a43d"],
    sources: ["extensions/mattermost/src/mattermost/slash-http.test.ts"],
  },
  {
    fixtureSha256: "fd79d243a5d942979882ca621cfa8bd240a2fce9ca400cdd6b2b1bfab4c5cf6a",
    rawSha256: "014a5653f93da5c53f9a09313e7aa32753fbdf0de02314af39a65af9a1dde664",
    lineSha256s: ["0506dfed6fa918c830a5e0d4d1bad503960438d01d5ff9e2cc80cd6654a69033"],
    sources: ["extensions/mattermost/src/mattermost/slash-http.test.ts"],
  },
  {
    fixtureSha256: "14947662dc4356637571038e47cd3f37a8911d37d41688a2f6c6b2b54c209c41",
    rawSha256: "7d765bfa6e81c336a916aaf71eab28f5c0c4ae47a359ec3adf2d4f175645456d",
    lineSha256s: ["d94c393a7704eab6d2e6ac822bd495a27299d353260c9edc85e852b706a54de3"],
    sources: ["extensions/mattermost/src/mattermost/slash-http.test.ts"],
  },
  {
    fixtureSha256: "0c2d147cb7b70169ceb0302b40bceaa60abc15263c4dcfb7f1746cc93e3c87d3",
    rawSha256: "014a5653f93da5c53f9a09313e7aa32753fbdf0de02314af39a65af9a1dde664",
    lineSha256s: ["ae6d199d9d7983df3024f5615dc243efd1e6988e1afddb79da0b99183cab8552"],
    sources: ["extensions/mattermost/src/mattermost/slash-http.test.ts"],
  },
  {
    // OpenClaw MCP Apps sandbox-origin rejection fixture introduced by f3971bbd56e4.
    fixtureSha256: "354e44c28981412829c4cd79588c7c5385d55221eb1f5d0014e96421d35e76a4",
    lineSha256s: ["f7d672c72c5b3f9f67b09a5b0f15fdab1c565d36d534c62e3424c4cd1981bb06"],
    decoders: ["PLAIN"],
    sources: ["src/config/config-misc.test.ts"],
  },
  {
    // OpenClaw config endpoint redaction and restoration fixtures.
    fixtureSha256: "a2e43ebb989e154a5cfde0e9f67d0e7465adffdba2c8be60394f35e7797149a3",
    rawSha256: "6b167ea4a777545dcca0e4d425aafccd750a6c6fca8a5b2b370f16491f3a8a4d",
    sources: ["src/config/redact-snapshot.restore.test.ts", "src/config/redact-snapshot.test.ts"],
  },
  {
    // OpenClaw media and provider request proxy redaction fixture.
    fixtureSha256: "cee9438f4c98a2b27c3aa4bab25b071a4fa9511252ffce86ebf38f302c151e5b",
    sources: ["src/config/redact-snapshot.test.ts"],
  },
  {
    // OpenClaw browser CDP credential redaction and restoration fixture.
    fixtureSha256: "f11c92a245b2308a02f08759cdc5952b4ebe9af5225923807769267fce35f464",
    sources: ["src/config/redact-snapshot.test.ts"],
  },
  {
    // OpenClaw mocked marketplace telemetry-redaction fixture introduced by 9c5ee4676d07.
    fixtureSha256: "838f16c9fef468c069583811edaac840bd0378ff46b59008793c552bfbf1c77b",
    rawSha256: "a9bdc2ad7ded74870594f1addb8c4f86a5a075516bc840235ed7cc74ed306959",
    lineSha256s: ["6b9804d61dcc7c7c1f9220403787eb71b340645797a7a7926297db085f36c4d5"],
    decoders: ["PLAIN"],
    sources: ["src/cli/plugins-cli.marketplace-refresh.test.ts"],
  },
  {
    // OpenClaw Gateway config CDP-redaction fixture introduced by 4b5987829d0f.
    fixtureSha256: "3699f73147f6969e1a3273a5809e2dd7886b95fad51315008b75bb20c4c9832f",
    rawSha256: "3699f73147f6969e1a3273a5809e2dd7886b95fad51315008b75bb20c4c9832f",
    lineSha256s: ["fab950a882e7e3d2f50a68a07fa6adec03baeecf9f604321ebe80098dba167ec"],
    decoders: ["PLAIN"],
    sources: ["src/gateway/server.config-patch.test.ts"],
  },
];

// oxfmt-ignore
const REVIEWED_ATTRIBUTIONS: readonly ReviewedAttribution[] = [
  [17, "URI", "ESCAPED_UNICODE", "base", "a460200b4a488bc178d0dac30bc5fe027ff86d9c7c94554f5c9d915580bc4239", "839b16fa1dd892daf47ab10d50f7c1957a16ace282fe9e6df67fefc40f7f06ff", "232cce5bf0c7b495e2f008fdc45cbd2bd9afc5394906576e4466411f6841d260", "src/logging/redact.test.ts", "100644"],
  [17, "URI", "ESCAPED_UNICODE", "base", "de7dcbd8612764d80691e85407d899f6e3686afd9ab40964943c3874ffe9571c", "198d323e34c2a045b86adbc72b8cd54bb8f9582175c5c25e6c68b4e374d8873f", "8ff8c788b296b7eb81abaf7f2f48bb4be717f6e8bef76200e7c842dbeea8a15c", "src/logging/redact.test.ts", "100644"],
  [17, "URI", "ESCAPED_UNICODE", "head", "31ff9f3ec446cbcc27e6fc08f3cd96b5d95d8b436b4144f3a098d7c524a863f7", "0d9e27039ed24044fe06ab5145d7b04569ced32d3ff6fe8eb9acf04a75663919", "47171b920ebd0800ac107a92ad80b7279677f0096fad5a367f82fe3b1955c790", "src/logging/redact.test.ts", "100644"],
  [17, "URI", "ESCAPED_UNICODE", "head", "de7dcbd8612764d80691e85407d899f6e3686afd9ab40964943c3874ffe9571c", "198d323e34c2a045b86adbc72b8cd54bb8f9582175c5c25e6c68b4e374d8873f", "8ff8c788b296b7eb81abaf7f2f48bb4be717f6e8bef76200e7c842dbeea8a15c", "src/logging/redact.test.ts", "100644"],
  [17, "URI", "PLAIN", "base", "31ff9f3ec446cbcc27e6fc08f3cd96b5d95d8b436b4144f3a098d7c524a863f7", "0d9e27039ed24044fe06ab5145d7b04569ced32d3ff6fe8eb9acf04a75663919", "47171b920ebd0800ac107a92ad80b7279677f0096fad5a367f82fe3b1955c790", "src/logging/redact.test.ts", "100644"],
  [17, "URI", "PLAIN", "base", "a460200b4a488bc178d0dac30bc5fe027ff86d9c7c94554f5c9d915580bc4239", "839b16fa1dd892daf47ab10d50f7c1957a16ace282fe9e6df67fefc40f7f06ff", "232cce5bf0c7b495e2f008fdc45cbd2bd9afc5394906576e4466411f6841d260", "src/logging/redact.test.ts", "100644"],
  [17, "URI", "PLAIN", "base", "de7dcbd8612764d80691e85407d899f6e3686afd9ab40964943c3874ffe9571c", "198d323e34c2a045b86adbc72b8cd54bb8f9582175c5c25e6c68b4e374d8873f", "8ff8c788b296b7eb81abaf7f2f48bb4be717f6e8bef76200e7c842dbeea8a15c", "src/logging/redact.test.ts", "100644"],
  [17, "URI", "PLAIN", "head", "31ff9f3ec446cbcc27e6fc08f3cd96b5d95d8b436b4144f3a098d7c524a863f7", "0d9e27039ed24044fe06ab5145d7b04569ced32d3ff6fe8eb9acf04a75663919", "47171b920ebd0800ac107a92ad80b7279677f0096fad5a367f82fe3b1955c790", "src/logging/redact.test.ts", "100644"],
  [17, "URI", "PLAIN", "head", "a460200b4a488bc178d0dac30bc5fe027ff86d9c7c94554f5c9d915580bc4239", "839b16fa1dd892daf47ab10d50f7c1957a16ace282fe9e6df67fefc40f7f06ff", "232cce5bf0c7b495e2f008fdc45cbd2bd9afc5394906576e4466411f6841d260", "src/logging/redact.test.ts", "100644"],
  [17, "URI", "PLAIN", "head", "de7dcbd8612764d80691e85407d899f6e3686afd9ab40964943c3874ffe9571c", "198d323e34c2a045b86adbc72b8cd54bb8f9582175c5c25e6c68b4e374d8873f", "8ff8c788b296b7eb81abaf7f2f48bb4be717f6e8bef76200e7c842dbeea8a15c", "src/logging/redact.test.ts", "100644"],
  [895, "MongoDB", "ESCAPED_UNICODE", "base", "087c10edd5d21290a4a8695083ff8c42554fc1d1a1becea9053b11c4790b859c", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "0aeba0d1b540784464c2a230b589a48d3f062d0dbbb2d9669450ff4ee2176218", "src/logging/redact.test.ts", "100644"],
  [895, "MongoDB", "ESCAPED_UNICODE", "head", "087c10edd5d21290a4a8695083ff8c42554fc1d1a1becea9053b11c4790b859c", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "0aeba0d1b540784464c2a230b589a48d3f062d0dbbb2d9669450ff4ee2176218", "src/logging/redact.test.ts", "100644"],
  [895, "MongoDB", "PLAIN", "base", "087c10edd5d21290a4a8695083ff8c42554fc1d1a1becea9053b11c4790b859c", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "0aeba0d1b540784464c2a230b589a48d3f062d0dbbb2d9669450ff4ee2176218", "src/logging/redact.test.ts", "100644"],
  [895, "MongoDB", "PLAIN", "head", "087c10edd5d21290a4a8695083ff8c42554fc1d1a1becea9053b11c4790b859c", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "0aeba0d1b540784464c2a230b589a48d3f062d0dbbb2d9669450ff4ee2176218", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "ESCAPED_UNICODE", "base", "050c1ddf61dd8b806e1a75cbe572669f8fa546e4ba36d03454377ba7a2c05d66", "050c1ddf61dd8b806e1a75cbe572669f8fa546e4ba36d03454377ba7a2c05d66", "6dc3c292a8c87dd8c203af74bf1fa03f3eb64ae12bafc23dadfff9c3f63c23e6", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "ESCAPED_UNICODE", "base", "39a0315176e45802aaa3c5c40c2a717e2fde14e99567c38b5640fe16138710fa", "39a0315176e45802aaa3c5c40c2a717e2fde14e99567c38b5640fe16138710fa", "4b03f485ba97fd1aea07f64e978e9a961179dbbb766828f20fc8a2401812a858", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "ESCAPED_UNICODE", "base", "4734d8b7c6e9bf96ae464bfc45b1482e00caaedea951cb96b9e88a92ba37a00f", "4734d8b7c6e9bf96ae464bfc45b1482e00caaedea951cb96b9e88a92ba37a00f", "252d197820142c40bc8701a8b1400f28a3224f305f37fd65cd2e6bfbe48d9fb1", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "ESCAPED_UNICODE", "base", "8be6f6c2f1e50f070e97e4b46fce7e7ad499a6bc0c145e8bdd4fc0a6ee4b5565", "8be6f6c2f1e50f070e97e4b46fce7e7ad499a6bc0c145e8bdd4fc0a6ee4b5565", "6a9d1339c87f11af0ba4e7ef89a77ea8eb8e7f7ac48fdec0abb19d9138821d18", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "ESCAPED_UNICODE", "base", "f2e76a2fe75ea0d64265b2a61462f1d8026a2286e3030077b4f3972fc0df3b70", "f2e76a2fe75ea0d64265b2a61462f1d8026a2286e3030077b4f3972fc0df3b70", "2020783f7b14c74d2d6960efca4ca82727980494ddef883f15ae9980141662ec", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "ESCAPED_UNICODE", "head", "050c1ddf61dd8b806e1a75cbe572669f8fa546e4ba36d03454377ba7a2c05d66", "050c1ddf61dd8b806e1a75cbe572669f8fa546e4ba36d03454377ba7a2c05d66", "6dc3c292a8c87dd8c203af74bf1fa03f3eb64ae12bafc23dadfff9c3f63c23e6", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "ESCAPED_UNICODE", "head", "39a0315176e45802aaa3c5c40c2a717e2fde14e99567c38b5640fe16138710fa", "39a0315176e45802aaa3c5c40c2a717e2fde14e99567c38b5640fe16138710fa", "4b03f485ba97fd1aea07f64e978e9a961179dbbb766828f20fc8a2401812a858", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "ESCAPED_UNICODE", "head", "4734d8b7c6e9bf96ae464bfc45b1482e00caaedea951cb96b9e88a92ba37a00f", "4734d8b7c6e9bf96ae464bfc45b1482e00caaedea951cb96b9e88a92ba37a00f", "252d197820142c40bc8701a8b1400f28a3224f305f37fd65cd2e6bfbe48d9fb1", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "ESCAPED_UNICODE", "head", "8be6f6c2f1e50f070e97e4b46fce7e7ad499a6bc0c145e8bdd4fc0a6ee4b5565", "8be6f6c2f1e50f070e97e4b46fce7e7ad499a6bc0c145e8bdd4fc0a6ee4b5565", "6a9d1339c87f11af0ba4e7ef89a77ea8eb8e7f7ac48fdec0abb19d9138821d18", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "ESCAPED_UNICODE", "head", "f2e76a2fe75ea0d64265b2a61462f1d8026a2286e3030077b4f3972fc0df3b70", "f2e76a2fe75ea0d64265b2a61462f1d8026a2286e3030077b4f3972fc0df3b70", "2020783f7b14c74d2d6960efca4ca82727980494ddef883f15ae9980141662ec", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "PLAIN", "base", "050c1ddf61dd8b806e1a75cbe572669f8fa546e4ba36d03454377ba7a2c05d66", "050c1ddf61dd8b806e1a75cbe572669f8fa546e4ba36d03454377ba7a2c05d66", "6dc3c292a8c87dd8c203af74bf1fa03f3eb64ae12bafc23dadfff9c3f63c23e6", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "PLAIN", "base", "39a0315176e45802aaa3c5c40c2a717e2fde14e99567c38b5640fe16138710fa", "39a0315176e45802aaa3c5c40c2a717e2fde14e99567c38b5640fe16138710fa", "4b03f485ba97fd1aea07f64e978e9a961179dbbb766828f20fc8a2401812a858", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "PLAIN", "base", "4734d8b7c6e9bf96ae464bfc45b1482e00caaedea951cb96b9e88a92ba37a00f", "4734d8b7c6e9bf96ae464bfc45b1482e00caaedea951cb96b9e88a92ba37a00f", "252d197820142c40bc8701a8b1400f28a3224f305f37fd65cd2e6bfbe48d9fb1", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "PLAIN", "base", "8be6f6c2f1e50f070e97e4b46fce7e7ad499a6bc0c145e8bdd4fc0a6ee4b5565", "8be6f6c2f1e50f070e97e4b46fce7e7ad499a6bc0c145e8bdd4fc0a6ee4b5565", "6a9d1339c87f11af0ba4e7ef89a77ea8eb8e7f7ac48fdec0abb19d9138821d18", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "PLAIN", "base", "f2e76a2fe75ea0d64265b2a61462f1d8026a2286e3030077b4f3972fc0df3b70", "f2e76a2fe75ea0d64265b2a61462f1d8026a2286e3030077b4f3972fc0df3b70", "2020783f7b14c74d2d6960efca4ca82727980494ddef883f15ae9980141662ec", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "PLAIN", "head", "050c1ddf61dd8b806e1a75cbe572669f8fa546e4ba36d03454377ba7a2c05d66", "050c1ddf61dd8b806e1a75cbe572669f8fa546e4ba36d03454377ba7a2c05d66", "6dc3c292a8c87dd8c203af74bf1fa03f3eb64ae12bafc23dadfff9c3f63c23e6", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "PLAIN", "head", "39a0315176e45802aaa3c5c40c2a717e2fde14e99567c38b5640fe16138710fa", "39a0315176e45802aaa3c5c40c2a717e2fde14e99567c38b5640fe16138710fa", "4b03f485ba97fd1aea07f64e978e9a961179dbbb766828f20fc8a2401812a858", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "PLAIN", "head", "4734d8b7c6e9bf96ae464bfc45b1482e00caaedea951cb96b9e88a92ba37a00f", "4734d8b7c6e9bf96ae464bfc45b1482e00caaedea951cb96b9e88a92ba37a00f", "252d197820142c40bc8701a8b1400f28a3224f305f37fd65cd2e6bfbe48d9fb1", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "PLAIN", "head", "8be6f6c2f1e50f070e97e4b46fce7e7ad499a6bc0c145e8bdd4fc0a6ee4b5565", "8be6f6c2f1e50f070e97e4b46fce7e7ad499a6bc0c145e8bdd4fc0a6ee4b5565", "6a9d1339c87f11af0ba4e7ef89a77ea8eb8e7f7ac48fdec0abb19d9138821d18", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "PLAIN", "head", "f2e76a2fe75ea0d64265b2a61462f1d8026a2286e3030077b4f3972fc0df3b70", "f2e76a2fe75ea0d64265b2a61462f1d8026a2286e3030077b4f3972fc0df3b70", "2020783f7b14c74d2d6960efca4ca82727980494ddef883f15ae9980141662ec", "src/logging/redact.test.ts", "100644"],
];

export function serializeReviewContext(context: object): string {
  return JSON.stringify(
    context,
    (_key, value) => (typeof value === "string" ? omitReviewedFixtureReferences(value) : value),
    2,
  );
}

export function omitReviewedFixtureReferences(text: string): string {
  // Match whole scheme tokens once; retrying at every character is quadratic.
  // Strip only terminal punctuation; internal punctuation may belong to a URI.
  return text.replace(/(?<![A-Za-z0-9+.-])[A-Za-z0-9+.-]+:\/\/[^\s<>"\x60]+/g, (uri) => {
    let end = uri.length;
    while (end > 0 && ")]}.,;!'".includes(uri.charAt(end - 1))) {
      end -= 1;
    }
    for (const candidate of [uri, uri.slice(0, end)]) {
      const digest = createHash("sha256").update(candidate).digest("hex");
      const fixture = REVIEWED_FIXTURES.find((entry) => entry.fixtureSha256 === digest);
      if (fixture) {
        return (
          "[reviewed synthetic URI omitted; inspect " +
          fixture.sources.join(", ") +
          "]" +
          uri.slice(candidate.length)
        );
      }
    }
    return uri;
  });
}

export interface ScanSourceReference {
  source: string;
  mode: string;
  revision: string;
  role: ScanSourceRole;
}

export type ScanInputOrigin =
  | { kind: "prompt" | "schema" | "additional" }
  | { kind: "raw_diff" | "patch"; from: string; to: string }
  | { kind: "worktree" | "blob"; references: readonly ScanSourceReference[] };

export type StagedScanInput = ScanInputOrigin & { id: string; bytes?: Buffer };

interface ScanMaterialDiagnostic {
  kind: ScanInputOrigin["kind"];
  id: string;
  from?: string;
  to?: string;
  referenceCount?: number;
  references?: { revision: string; pathSha256: string; mode: string; role: ScanSourceRole }[];
}

export type ScanRefusalDiagnostic =
  | {
      kind: "native_contract";
      reason:
        | "invalid_stdout"
        | "invalid_stderr"
        | "scan_error"
        | "incomplete_scan"
        | "completion_mismatch"
        | "unexpected_exit";
    }
  | {
      kind: "unclassified_finding";
      reason:
        | "finding_not_reviewed"
        | "literal_not_reviewed"
        | "material_not_reviewed"
        | "source_not_reviewed"
        | "metadata_mismatch"
        | "literal_mismatch"
        | "duplicate_finding";
      findingCount: number;
      findingIndex: number;
      detectorType: number | null;
      decoder: "PLAIN" | "HTML" | "OTHER";
      verified: boolean | null;
      scannerLine: number | null;
      material?: ScanMaterialDiagnostic;
    };

export interface ReviewedFixtureNotice {
  fixtureSha256: string;
  source: string;
  detector: string;
  findings: ClassifiedFinding[];
}

interface RefusedScan {
  kind: "refused";
  reason: "scanner_failed" | "findings";
  diagnostic: ScanRefusalDiagnostic;
}

interface ClassifiedFinding {
  blob: string;
  scannerLine: number;
  literalLine: number;
  decoder: string;
  occurrences: number;
  role?: ScanSourceRole;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function records(bytes: Buffer): Record<string, unknown>[] | undefined {
  try {
    if (!bytes.length) return [];
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.endsWith("\n")) return undefined;
    return text
      .slice(0, -1)
      .split("\n")
      .map((line) => {
        const value = object(JSON.parse(line));
        if (!value) throw new Error("invalid scanner object");
        return value;
      });
  } catch {
    // Parser errors can contain credential-shaped input; retain only a closed reason.
    return undefined;
  }
}

function exactStringRecord(value: unknown, keys: readonly string[]): boolean {
  const record = object(value);
  return (
    record !== undefined &&
    Object.keys(record).sort().join("\0") === [...keys].sort().join("\0") &&
    keys.every((key) => typeof record[key] === "string" && record[key].length > 0)
  );
}

function materialDiagnostic(input: StagedScanInput): ScanMaterialDiagnostic {
  // Only host-staged identities leave the scanner boundary. Bound reference
  // fanout and hash paths; raw finding values and provider strings never leave.
  return {
    kind: input.kind,
    id: input.id,
    ...("from" in input ? { from: input.from, to: input.to } : {}),
    ...("references" in input
      ? {
          referenceCount: input.references.length,
          references: input.references.slice(0, 4).map(({ source, mode, revision, role }) => ({
            revision,
            pathSha256: createHash("sha256").update(source).digest("hex"),
            mode,
            role,
          })),
        }
      : {}),
  };
}

/** Classify only complete native scans whose every finding matches host fixture policy. */
export function classifyReviewedFixtureScan(
  status: number,
  stdout: Buffer,
  stderr: Buffer,
  inputs: ReadonlyMap<string, StagedScanInput>,
  reviewedAttributions: readonly ReviewedAttribution[] = REVIEWED_ATTRIBUTIONS,
): { kind: "classified"; notices: ReviewedFixtureNotice[] } | RefusedScan {
  const nativeFailure = (
    reason: Extract<ScanRefusalDiagnostic, { kind: "native_contract" }>["reason"],
  ): RefusedScan => ({
    kind: "refused",
    reason: "scanner_failed",
    diagnostic: { kind: "native_contract", reason },
  });
  if (status !== 183) return nativeFailure("unexpected_exit");
  const findings = records(stdout);
  if (!findings?.length) return nativeFailure("invalid_stdout");
  const logs = records(stderr);
  if (!logs) return nativeFailure("invalid_stderr");
  // TruffleHog can log detector failures and still exit 183. Its exit status
  // alone therefore cannot establish that all detectors finished successfully.
  if (
    logs.some(
      (entry) =>
        entry.level !== "info-0" ||
        typeof entry.logger !== "string" ||
        typeof entry.msg !== "string" ||
        entry.error !== undefined ||
        entry.errors !== undefined,
    )
  )
    return nativeFailure("scan_error");
  const completion = logs.at(-1)!;
  if (
    logs.filter((entry) => entry.msg === "finished scanning").length !== 1 ||
    completion?.logger !== "trufflehog" ||
    completion.msg !== "finished scanning"
  )
    return nativeFailure("incomplete_scan");
  const verifiedCount = findings.filter((finding) => finding.Verified === true).length;
  if (
    completion.trufflehog_version !== "3.97.1" ||
    typeof completion.chunks !== "number" ||
    !Number.isSafeInteger(completion.chunks) ||
    completion.chunks <= 0 ||
    typeof completion.bytes !== "number" ||
    !Number.isSafeInteger(completion.bytes) ||
    completion.bytes <= 0 ||
    completion.verified_secrets !== verifiedCount ||
    completion.unverified_secrets !== findings.length - verifiedCount
  )
    return nativeFailure("completion_mismatch");

  const literalLines = new Map<string, number>();
  const classified = new Map<
    string,
    {
      fixtureSha256: string;
      source: string;
      detector: string;
      findings: Map<string, ClassifiedFinding>;
    }
  >();
  const exactFindings = new Set<string>();
  for (const [findingIndex, finding] of findings.entries()) {
    const source = object(object(object(finding.SourceMetadata)?.Data)?.Filesystem);
    const file = source?.file;
    const staged = typeof file === "string" ? inputs.get(file) : undefined;
    const scannerLine =
      typeof source?.line === "number" && Number.isSafeInteger(source.line) && source.line > 0
        ? source.line
        : null;
    const refuse = (
      reason: Extract<ScanRefusalDiagnostic, { kind: "unclassified_finding" }>["reason"],
    ): RefusedScan => ({
      kind: "refused",
      reason: "findings",
      diagnostic: {
        kind: "unclassified_finding",
        reason,
        findingCount: findings.length,
        findingIndex,
        detectorType:
          typeof finding.DetectorType === "number" &&
          Number.isInteger(finding.DetectorType) &&
          finding.DetectorType >= 0 &&
          finding.DetectorType <= 2_147_483_647
            ? finding.DetectorType
            : null,
        decoder:
          finding.DecoderName === "PLAIN" || finding.DecoderName === "HTML"
            ? finding.DecoderName
            : "OTHER",
        verified: typeof finding.Verified === "boolean" ? finding.Verified : null,
        scannerLine,
        ...(staged ? { material: materialDiagnostic(staged) } : {}),
      },
    });
    const raw = typeof finding.Raw === "string" ? finding.Raw : undefined;
    const rawV2 = typeof finding.RawV2 === "string" ? finding.RawV2 : undefined;
    const rawDigest =
      raw === undefined ? undefined : createHash("sha256").update(raw).digest("hex");
    const rawV2Digest =
      rawV2 === undefined ? undefined : createHash("sha256").update(rawV2).digest("hex");
    const exactCandidates =
      rawDigest === undefined || rawV2Digest === undefined
        ? []
        : reviewedAttributions.filter(
            ([, , , , expectedRaw, expectedRawV2]) =>
              expectedRaw === rawDigest && expectedRawV2 === rawV2Digest,
          );
    if (exactCandidates.length > 0) {
      if (
        raw === undefined ||
        rawV2 === undefined ||
        rawDigest === undefined ||
        rawV2Digest === undefined
      )
        return refuse("finding_not_reviewed");
      if (
        finding.SourceType !== 15 ||
        finding.Verified !== false ||
        typeof finding.VerificationError !== "string" ||
        !finding.VerificationError ||
        finding.StructuredData !== null
      )
        return refuse("finding_not_reviewed");
      const matchingMetadata = exactCandidates.filter(
        ([detectorType, detectorName, decoder]) =>
          detectorType === finding.DetectorType &&
          detectorName === finding.DetectorName &&
          decoder === finding.DecoderName,
      );
      if (matchingMetadata.length === 0) return refuse("finding_not_reviewed");
      const [detectorType, detectorName, decoder] = matchingMetadata[0]!;
      if (typeof file !== "string" || scannerLine === null) return refuse("metadata_mismatch");
      if (staged?.kind !== "blob" || !staged.bytes) return refuse("material_not_reviewed");
      const parts = object(finding.SecretParts);
      if (detectorType === 17) {
        let uri: URL;
        try {
          uri = new URL(rawV2);
        } catch {
          return refuse("metadata_mismatch");
        }
        if (
          finding.ExtraData !== null ||
          !parts ||
          Object.keys(parts).sort().join("\0") !== "host\0password\0username" ||
          parts.host !== uri.host ||
          parts.username !== uri.username ||
          parts.password !== uri.password
        )
          return refuse("metadata_mismatch");
      } else if (detectorType === 895) {
        if (
          rawV2 !== "" ||
          !parts ||
          Object.keys(parts).join("\0") !== "key" ||
          parts.key !== raw ||
          !exactStringRecord(finding.ExtraData, ["database", "host", "rotation_guide", "username"])
        )
          return refuse("metadata_mismatch");
      } else if (
        raw !== rawV2 ||
        !parts ||
        Object.keys(parts).join("\0") !== "connection_string" ||
        parts.connection_string !== raw ||
        !exactStringRecord(finding.ExtraData, ["database", "host", "sslmode", "username"])
      ) {
        return refuse("metadata_mismatch");
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(staged.bytes);
      } catch {
        return refuse("literal_mismatch");
      }
      let lineStart = 0;
      let lineNumber = 1;
      let witnessLine: string | undefined;
      let witnessLineNumber: number | undefined;
      let literalOccurrences = 0;
      while (lineStart <= text.length) {
        const newline = text.indexOf("\n", lineStart);
        const lineEnd = newline === -1 ? text.length : newline;
        const line = text.slice(lineStart, lineEnd);
        if (detectorType === 17 && line.includes(rawV2)) {
          let occurrence = line.indexOf(rawV2);
          while (occurrence !== -1) {
            literalOccurrences++;
            occurrence = line.indexOf(rawV2, occurrence + rawV2.length);
          }
          witnessLine ??= line;
          witnessLineNumber ??= lineNumber;
        } else if (detectorType !== 17 && lineNumber === scannerLine) {
          witnessLine = line;
          witnessLineNumber = lineNumber;
        }
        if (newline === -1) break;
        lineStart = newline + 1;
        lineNumber++;
      }
      if (
        witnessLine === undefined ||
        witnessLineNumber === undefined ||
        (detectorType === 17 && literalOccurrences !== 1)
      )
        return refuse("literal_mismatch");
      const lineDigest = createHash("sha256").update(witnessLine).digest("hex");
      if (!matchingMetadata.some(([, , , , , , expectedLine]) => expectedLine === lineDigest))
        return refuse("literal_mismatch");
      if (
        !staged.references.length ||
        staged.references.some(({ source, mode, role }) =>
          matchingMetadata.every(
            ([, , , expectedRole, , , expectedLine, expectedSource, expectedMode]) =>
              expectedRole !== role ||
              expectedLine !== lineDigest ||
              expectedSource !== source ||
              expectedMode !== mode,
          ),
        )
      )
        return refuse("source_not_reviewed");
      const duplicateKey = [
        file,
        scannerLine,
        detectorType,
        detectorName,
        decoder,
        rawDigest,
        rawV2Digest,
      ].join("\0");
      if (exactFindings.has(duplicateKey)) return refuse("duplicate_finding");
      exactFindings.add(duplicateKey);
      const fixtureSha256 = detectorType === 17 ? rawV2Digest : rawDigest;
      const blob = basename(file);
      for (const { source, role } of staged.references) {
        const groupKey = `exact:${detectorType}:${fixtureSha256}:${source}`;
        const group = classified.get(groupKey) ?? {
          fixtureSha256,
          source,
          detector: detectorName,
          findings: new Map<string, ClassifiedFinding>(),
        };
        const key = `${blob}:${scannerLine}:${decoder}:${role}`;
        const previous = group.findings.get(key);
        group.findings.set(key, {
          blob,
          scannerLine,
          literalLine: witnessLineNumber,
          decoder,
          role,
          occurrences: (previous?.occurrences ?? 0) + 1,
        });
        classified.set(groupKey, group);
      }
      continue;
    }
    if (
      finding.DetectorType !== 17 ||
      finding.DetectorName !== "URI" ||
      finding.SourceType !== 15 ||
      finding.Verified !== false ||
      typeof finding.DecoderName !== "string" ||
      typeof finding.VerificationError !== "string" ||
      !finding.VerificationError ||
      typeof finding.Raw !== "string" ||
      typeof finding.RawV2 !== "string" ||
      finding.ExtraData !== null ||
      finding.StructuredData !== null
    )
      return refuse("finding_not_reviewed");
    // URI Raw omits the path; bind both native outputs to the reviewed match.
    const digest = createHash("sha256").update(finding.RawV2).digest("hex");
    const legacyRawDigest = createHash("sha256").update(finding.Raw).digest("hex");
    const fixture = REVIEWED_FIXTURES.find(
      (entry) =>
        entry.fixtureSha256 === digest &&
        (entry.rawSha256 ?? entry.fixtureSha256) === legacyRawDigest,
    );
    if (!fixture) return refuse("literal_not_reviewed");
    if (!(fixture.decoders ?? ["PLAIN", "HTML"]).some((decoder) => decoder === finding.DecoderName))
      return refuse("finding_not_reviewed");
    if (typeof file !== "string" || scannerLine === null) return refuse("metadata_mismatch");
    if (staged?.kind !== "blob" || !staged.bytes) return refuse("material_not_reviewed");
    if (
      !staged.references.length ||
      staged.references.some(
        ({ source, mode }) => mode !== "100644" || !fixture.sources.some((path) => path === source),
      )
    )
      return refuse("source_not_reviewed");
    const uri = new URL(finding.RawV2);
    const parts = object(finding.SecretParts);
    if (
      !parts ||
      Object.keys(parts).length !== 3 ||
      parts.host !== uri.host ||
      parts.username !== uri.username ||
      parts.password !== uri.password
    )
      return refuse("metadata_mismatch");
    const valueKey = `${file}:${digest}`;
    let literalLine = literalLines.get(valueKey);
    if (literalLine === undefined) {
      // Decoding can shift coordinates, and deduplication can drop the plain
      // finding. Bind to staged bytes and record one literal witness separately
      // from the scanner's location, without allocating unbounded line lists.
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(staged.bytes);
      } catch {
        return refuse("literal_mismatch");
      }
      let lineStart = 0;
      let lineNumber = 1;
      let literalOccurrences = 0;
      while (lineStart <= text.length) {
        const newline = text.indexOf("\n", lineStart);
        const lineEnd = newline === -1 ? text.length : newline;
        const line = text.slice(lineStart, lineEnd);
        if (line.includes(finding.RawV2)) {
          let occurrence = line.indexOf(finding.RawV2);
          while (occurrence !== -1) {
            literalOccurrences++;
            occurrence = line.indexOf(finding.RawV2, occurrence + finding.RawV2.length);
          }
          if (
            fixture.lineSha256s &&
            !fixture.lineSha256s.includes(createHash("sha256").update(line).digest("hex"))
          )
            return refuse("literal_mismatch");
          literalLine ??= lineNumber;
        }
        if (newline === -1) break;
        lineStart = newline + 1;
        lineNumber++;
      }
      if (
        literalLine === undefined ||
        (fixture.lineSha256s !== undefined && literalOccurrences !== 1)
      )
        return refuse("literal_mismatch");
      literalLines.set(valueKey, literalLine);
    }
    const blob = basename(file);
    const key = `${blob}:${scannerLine}:${finding.DecoderName}`;
    const sources = new Set(staged.references.map(({ source }) => source));
    for (const path of sources) {
      const groupKey = `${digest}:${path}`;
      const group = classified.get(groupKey) ?? {
        fixtureSha256: digest,
        source: path,
        detector: "URI",
        findings: new Map<string, ClassifiedFinding>(),
      };
      const previous = group.findings.get(key);
      group.findings.set(key, {
        blob,
        scannerLine,
        literalLine,
        decoder: finding.DecoderName,
        occurrences: (previous?.occurrences ?? 0) + 1,
      });
      classified.set(groupKey, group);
    }
  }
  return {
    kind: "classified",
    notices: [...classified.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, group]) => ({
        fixtureSha256: group.fixtureSha256,
        source: group.source,
        detector: group.detector,
        findings: [...group.findings.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, value]) => value),
      })),
  };
}
