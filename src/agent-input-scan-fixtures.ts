import { createHash } from "node:crypto";
import { basename } from "node:path";
import { TRUFFLEHOG_VERSION } from "./review-tool-bootstrap.js";
import { resolvePatchWitnesses } from "./agent-input-scan-patch.js";
import { resolveGitObjectMetadata } from "./agent-input-scan-git-metadata.js";

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
  decoder: "PLAIN" | "HTML" | "ESCAPED_UNICODE",
  rawSha256: string,
  rawV2Sha256: string,
  lineSha256: string | readonly string[],
  source: string,
  mode: "100644",
];

// This is host policy, never an allowlist loaded from the reviewed checkout.
const REVIEWED_FIXTURES: readonly ReviewedFixture[] = [
  {
    // Approved Signal URL-rejection fixture; retain the complete source-line witness.
    fixtureSha256: "c9c820a05b2d035eb65422d1a50e58c5fa52e4d7a087ad3791de23bdd4efeabd",
    rawSha256: "c9c820a05b2d035eb65422d1a50e58c5fa52e4d7a087ad3791de23bdd4efeabd",
    lineSha256s: ["f4646625b141392982b168ff4591bf66dd208316f1f21ad712efb4ee30a8a339"],
    decoders: ["PLAIN", "HTML"],
    sources: ["extensions/signal/src/client.test.ts"],
  },
  {
    fixtureSha256: "7849c0ac39a4f42a5cd5cb1b029c7132193f270454865f2f4a49a83da3444665",
    rawSha256: "7849c0ac39a4f42a5cd5cb1b029c7132193f270454865f2f4a49a83da3444665",
    lineSha256s: ["281f664b2e7f36e82ef38d0a36bb791ec8a70b4a4afca470847d4699573b338d"],
    decoders: ["PLAIN", "HTML"],
    sources: ["extensions/signal/src/client-container.test.ts"],
  },
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
    // OpenClaw loopback CDP proxy-bypass fixture introduced by a37ebb2d496c.
    fixtureSha256: "c10384849acffcfd5e4a8c5c7e368a9822425fbd631b1b51e74e48fd974b76d0",
    rawSha256: "6eff40b9b295cc8f78a2a7762888d6884610d3399a676b6c648fd1f8a71c1d58",
    lineSha256s: ["389cd151272bf0c7005e544b01a6c173a008af9bec42fb9d5c4de577b6113c32"],
    decoders: ["PLAIN", "HTML"],
    sources: ["extensions/browser/src/browser/cdp.helpers.internal.test.ts"],
  },
  {
    // OpenClaw credential-bearing CDP target fixture moved by 9a7ceceffaa8.
    fixtureSha256: "996b19a5512866475ab05efe0308921cadf916d8a506b76ea1a4204ad1e1193c",
    rawSha256: "996b19a5512866475ab05efe0308921cadf916d8a506b76ea1a4204ad1e1193c",
    lineSha256s: ["f0fa784540b0d2421ae27c655b5648cf5c94a1d24e29d8058fdcf26c0ba2375a"],
    decoders: ["PLAIN", "HTML"],
    sources: ["extensions/browser/src/browser/cdp.test.ts"],
  },
  {
    // Profile-status redaction repeats this synthetic URI in config and a mocked-call assertion.
    fixtureSha256: "d15184614e748450d49a726f84955ca7745b87d0728afbd6bb6b50d84cce4fe0",
    sources: ["extensions/browser/src/browser/server-context.list-profiles.test.ts"],
  },
  {
    // Introduced by bf15c87d2b12; moved unchanged to browser/remote.md by 26b84d3f38d.
    fixtureSha256: "e6907dddaccdec944b0f02e14fe9186293e2d513ff753db0a95b3460aa5dc1d9",
    sources: ["docs/tools/browser.md", "docs/tools/browser/remote.md"],
  },
  {
    // OpenClaw credentialed-page rejection fixture introduced by d5fb4903f1b1.
    fixtureSha256: "d8996b8fdec57910e379c720611bc37f9433f1cb7027b6f6262d785f1506e9ff",
    rawSha256: "8d3331ee208c72c30fba199e4e2b8a65d69a5034e49875a2f20dbea3a4f2f976",
    sources: ["extensions/browser/src/browser-tool.test.ts"],
  },
  {
    // OpenClaw Firecrawl blocked-host credential fixture introduced by d1b80794b651.
    fixtureSha256: "fe30fb721f4e8b1d50f281ae338da254a0e34dba6804776c231b8666d5856055",
    sources: ["extensions/firecrawl/src/firecrawl-client.test.ts"],
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
    // Reviewed WebVNC writer-redaction fixtures (Crabbox #544).
    fixtureSha256: "18cd62c666a4b48f9968cacc2acc34a27c1f15682219d4f45bfb903cfb3d60fc",
    rawSha256: "d72aa985328cd8b6b8d13182b028f5e5c06e574b9acfddc31dc5ab0655896050",
    lineSha256s: ["83b93f401c1c6526ce80cca9860fdbf59825c92e70644a6f087e6a1b46b295e8"],
    decoders: ["PLAIN"],
    sources: ["internal/cli/webvnc_test.go"],
  },
  {
    fixtureSha256: "5f63e971f3b95e10c500e2c40cfaf423b47c60e1bbb3c1dad9633cef0aa1a10f",
    rawSha256: "6a160b5adb896b7ae8e5347258bce211ebcb35f422aa9fc0931d2406403e72ae",
    lineSha256s: ["83b93f401c1c6526ce80cca9860fdbf59825c92e70644a6f087e6a1b46b295e8"],
    decoders: ["PLAIN"],
    sources: ["internal/cli/webvnc_test.go"],
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

const CRABBOX_POSTGRES_DOC_ATTRIBUTIONS: readonly ReviewedAttribution[] = [
  [
    968,
    "Postgres",
    "HTML",
    "b296b6d2d18690f50a8088d03ce813c6147aaf1642e9f774a88b7c10b4c1948b",
    "b296b6d2d18690f50a8088d03ce813c6147aaf1642e9f774a88b7c10b4c1948b",
    "222f928b39fd053a8a3b088b53f703bccbb7d3cd58ede6ae974e985cae4d6406",
    "docs/operations.md",
    "100644",
  ],
  [
    968,
    "Postgres",
    "PLAIN",
    "b296b6d2d18690f50a8088d03ce813c6147aaf1642e9f774a88b7c10b4c1948b",
    "b296b6d2d18690f50a8088d03ce813c6147aaf1642e9f774a88b7c10b4c1948b",
    "222f928b39fd053a8a3b088b53f703bccbb7d3cd58ede6ae974e985cae4d6406",
    "docs/operations.md",
    "100644",
  ],
];

// oxfmt-ignore
const REVIEWED_ATTRIBUTIONS: readonly ReviewedAttribution[] = [
  // Approved TypeSafe loopback URL-rejection fixture: OpenClaw #154059.
  [17, "URI", "HTML", "923d03ede473d23a81840727f6af65897692c61133596ca2a59d52d88fd6775f", "923d03ede473d23a81840727f6af65897692c61133596ca2a59d52d88fd6775f", "e6a2587ba99aab4b1437d4382b043f2253065508d5ab038841fd4262ce0b0a6f", "extensions/typesafe/src/local.transport.test.ts", "100644"],
  [17, "URI", "PLAIN", "923d03ede473d23a81840727f6af65897692c61133596ca2a59d52d88fd6775f", "923d03ede473d23a81840727f6af65897692c61133596ca2a59d52d88fd6775f", "e6a2587ba99aab4b1437d4382b043f2253065508d5ab038841fd4262ce0b0a6f", "extensions/typesafe/src/local.transport.test.ts", "100644"],
  // Approved browser CDP discovery fixture: https://github.com/openclaw/openclaw/pull/153597.
  [17, "URI", "HTML", "58e5399334d925e239b1b4777a226340f84778101809699897154e2a3c750a42", "a2b7cdba4afae496b99e64423837887e56340606268f28b7edef5a33e22cdc0f", "285d12ccfcf9b9547713f38140953dde8763b2ddccd234f8deed19b04c4b6f42", "extensions/browser/src/browser/pw-session.connections.test.ts", "100644"],
  [17, "URI", "PLAIN", "58e5399334d925e239b1b4777a226340f84778101809699897154e2a3c750a42", "a2b7cdba4afae496b99e64423837887e56340606268f28b7edef5a33e22cdc0f", "285d12ccfcf9b9547713f38140953dde8763b2ddccd234f8deed19b04c4b6f42", "extensions/browser/src/browser/pw-session.connections.test.ts", "100644"],
  // Approved synthetic unsafe-link fixture: https://github.com/openclaw/openclaw/pull/153274.
  [17, "URI", "PLAIN", "148db1b794aa55e895c253fc95230148dd8cf58b8f97bac16c3db0147df7f457", "e10c3a5ca351377dab596260b30d87d26337a91bb3bb7b8f8d1fecda7285a125", "9b986f89b4bc448cd97566a1512992e765197fe5be1333cbb79681b1c25d95e4", "extensions/github/src/detail-checks.test.ts", "100644"],
  [17, "URI", "HTML", "148db1b794aa55e895c253fc95230148dd8cf58b8f97bac16c3db0147df7f457", "e10c3a5ca351377dab596260b30d87d26337a91bb3bb7b8f8d1fecda7285a125", "9b986f89b4bc448cd97566a1512992e765197fe5be1333cbb79681b1c25d95e4", "extensions/github/src/detail-checks.test.ts", "100644"],
  // Maintainer-qualified Gateway readiness error privacy fixture from OpenClaw #152309.
  [17,"URI","PLAIN","630affa5ad9abd80845b370cfee593f079ea56cf2907e2e0135d154bb7d30fcb","630affa5ad9abd80845b370cfee593f079ea56cf2907e2e0135d154bb7d30fcb","135365663033f668caf9d6e3fc27b905e8ffaef8ad43bc587e43fceb055bad59","test/helpers/openclaw-test-instance.test.ts","100644"],
  [17,"URI","HTML","630affa5ad9abd80845b370cfee593f079ea56cf2907e2e0135d154bb7d30fcb","630affa5ad9abd80845b370cfee593f079ea56cf2907e2e0135d154bb7d30fcb","135365663033f668caf9d6e3fc27b905e8ffaef8ad43bc587e43fceb055bad59","test/helpers/openclaw-test-instance.test.ts","100644"],
  // Gateway sibling of the reviewed question URL-rejection fixture; exact source bytes differ.
  [17, "URI", "PLAIN", "2c45f25f2626ac90554ac699f6b285846faf497f796f3d1c05acb7fef231d0a9", "c914cd0ca5fb29af5f36f2e92ac43bf9fa59e1a729049dcbdd5b09cee50d4b28", "61b6dd9a49e1ba2bbbb38735e6227c34642f606603cf41999cd99be24a1fa011", "src/gateway/server-methods/question.test.ts", "100644"],
  [17, "URI", "HTML", "2c45f25f2626ac90554ac699f6b285846faf497f796f3d1c05acb7fef231d0a9", "c914cd0ca5fb29af5f36f2e92ac43bf9fa59e1a729049dcbdd5b09cee50d4b28", "61b6dd9a49e1ba2bbbb38735e6227c34642f606603cf41999cd99be24a1fa011", "src/gateway/server-methods/question.test.ts", "100644"],
  // Question URL-rejection fixture: native matching stops at the hyphen; bind the full source line.
  [17, "URI", "PLAIN", "056ba31f89867351c82b216a148b00bc322977c7da7a4aec9e0a1c222d239b50", "a62b014a9aedc9b5b538eed1f6fc5825be583d195348a11ff94076b4a6b4f55b", "87861ba38fa50d5190bf1b03c8fb631cf929f99b16bd73b786933aa1a1c40add", "ui/src/app/question-prompt.test.ts", "100644"],
  [17, "URI", "HTML", "056ba31f89867351c82b216a148b00bc322977c7da7a4aec9e0a1c222d239b50", "a62b014a9aedc9b5b538eed1f6fc5825be583d195348a11ff94076b4a6b4f55b", "87861ba38fa50d5190bf1b03c8fb631cf929f99b16bd73b786933aa1a1c40add", "ui/src/app/question-prompt.test.ts", "100644"],
  // Additional native PLAIN variants in the same reviewed negative-test source.
  [17, "URI", "PLAIN", "2d082b79ad4da55704d07af5754a91f9a677bfbbdc626d93a58291f11edf53c5", "2d082b79ad4da55704d07af5754a91f9a677bfbbdc626d93a58291f11edf53c5", "cb345a378aff388d79a0457d58f542b96eac6a985ec45b3427f6ed796686330d", "skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  [17, "URI", "PLAIN", "b12f4f7ee1e8ec1c544b81f14b0252734d816bd79ced79d342dbca650c4f6c31", "b12f4f7ee1e8ec1c544b81f14b0252734d816bd79ced79d342dbca650c4f6c31", "fd0e2849810c912b53dafd71eb60b4a9e2a3bb25bbd7d2dbd67136b207393d9b", "skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  [17, "URI", "PLAIN", "2d082b79ad4da55704d07af5754a91f9a677bfbbdc626d93a58291f11edf53c5", "2d082b79ad4da55704d07af5754a91f9a677bfbbdc626d93a58291f11edf53c5", "cb345a378aff388d79a0457d58f542b96eac6a985ec45b3427f6ed796686330d", ".agents/skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  [17, "URI", "PLAIN", "b12f4f7ee1e8ec1c544b81f14b0252734d816bd79ced79d342dbca650c4f6c31", "b12f4f7ee1e8ec1c544b81f14b0252734d816bd79ced79d342dbca650c4f6c31", "fd0e2849810c912b53dafd71eb60b4a9e2a3bb25bbd7d2dbd67136b207393d9b", ".agents/skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  // Maintainer-reviewed autoreview hardening fixtures from agent-skills a7e91e188fa0.
  [17, "URI", "PLAIN", "662a886a0fd7447dad0acda3aeccc9eb539fc90438b453de7e2f523ca7ee6c83", "662a886a0fd7447dad0acda3aeccc9eb539fc90438b453de7e2f523ca7ee6c83", "1a0920c31a227ead081fd2e6582572dfee060995e266a5520f66021acaa918c9", "skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  [17, "URI", "HTML", "662a886a0fd7447dad0acda3aeccc9eb539fc90438b453de7e2f523ca7ee6c83", "662a886a0fd7447dad0acda3aeccc9eb539fc90438b453de7e2f523ca7ee6c83", "1a0920c31a227ead081fd2e6582572dfee060995e266a5520f66021acaa918c9", "skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  [17, "URI", "PLAIN", "05ac498c28c2d5ac33d1623fa344fa9dfc5e74ac56fef091df3ab4886ad44de1", "05ac498c28c2d5ac33d1623fa344fa9dfc5e74ac56fef091df3ab4886ad44de1", "05a6e4a950742dd959c778c15c81c9c6a12a24c76bc77349d8779ea4d0c3b71e", "skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  [17, "URI", "HTML", "05ac498c28c2d5ac33d1623fa344fa9dfc5e74ac56fef091df3ab4886ad44de1", "05ac498c28c2d5ac33d1623fa344fa9dfc5e74ac56fef091df3ab4886ad44de1", "05a6e4a950742dd959c778c15c81c9c6a12a24c76bc77349d8779ea4d0c3b71e", "skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  [17, "URI", "PLAIN", "80842079cf4e73add753d25a74646356617b39c399e77d38b34bb21818e303d2", "80842079cf4e73add753d25a74646356617b39c399e77d38b34bb21818e303d2", "3099aae4bfd434977aa185a0b73674b3238305b0c94b9f36255cf1ad9d9a66ac", "skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  [17, "URI", "HTML", "80842079cf4e73add753d25a74646356617b39c399e77d38b34bb21818e303d2", "80842079cf4e73add753d25a74646356617b39c399e77d38b34bb21818e303d2", "3099aae4bfd434977aa185a0b73674b3238305b0c94b9f36255cf1ad9d9a66ac", "skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  [17, "URI", "PLAIN", "fe36092bead3bd47192a05374917c4614ce7642137dc83b9685ab6b5a37d8736", "fe36092bead3bd47192a05374917c4614ce7642137dc83b9685ab6b5a37d8736", "fd0e2849810c912b53dafd71eb60b4a9e2a3bb25bbd7d2dbd67136b207393d9b", "skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  [17, "URI", "HTML", "fe36092bead3bd47192a05374917c4614ce7642137dc83b9685ab6b5a37d8736", "fe36092bead3bd47192a05374917c4614ce7642137dc83b9685ab6b5a37d8736", "fd0e2849810c912b53dafd71eb60b4a9e2a3bb25bbd7d2dbd67136b207393d9b", "skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  [17, "URI", "PLAIN", "662a886a0fd7447dad0acda3aeccc9eb539fc90438b453de7e2f523ca7ee6c83", "662a886a0fd7447dad0acda3aeccc9eb539fc90438b453de7e2f523ca7ee6c83", "1a0920c31a227ead081fd2e6582572dfee060995e266a5520f66021acaa918c9", ".agents/skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  [17, "URI", "HTML", "662a886a0fd7447dad0acda3aeccc9eb539fc90438b453de7e2f523ca7ee6c83", "662a886a0fd7447dad0acda3aeccc9eb539fc90438b453de7e2f523ca7ee6c83", "1a0920c31a227ead081fd2e6582572dfee060995e266a5520f66021acaa918c9", ".agents/skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  [17, "URI", "PLAIN", "05ac498c28c2d5ac33d1623fa344fa9dfc5e74ac56fef091df3ab4886ad44de1", "05ac498c28c2d5ac33d1623fa344fa9dfc5e74ac56fef091df3ab4886ad44de1", "05a6e4a950742dd959c778c15c81c9c6a12a24c76bc77349d8779ea4d0c3b71e", ".agents/skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  [17, "URI", "HTML", "05ac498c28c2d5ac33d1623fa344fa9dfc5e74ac56fef091df3ab4886ad44de1", "05ac498c28c2d5ac33d1623fa344fa9dfc5e74ac56fef091df3ab4886ad44de1", "05a6e4a950742dd959c778c15c81c9c6a12a24c76bc77349d8779ea4d0c3b71e", ".agents/skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  [17, "URI", "PLAIN", "80842079cf4e73add753d25a74646356617b39c399e77d38b34bb21818e303d2", "80842079cf4e73add753d25a74646356617b39c399e77d38b34bb21818e303d2", "3099aae4bfd434977aa185a0b73674b3238305b0c94b9f36255cf1ad9d9a66ac", ".agents/skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  [17, "URI", "HTML", "80842079cf4e73add753d25a74646356617b39c399e77d38b34bb21818e303d2", "80842079cf4e73add753d25a74646356617b39c399e77d38b34bb21818e303d2", "3099aae4bfd434977aa185a0b73674b3238305b0c94b9f36255cf1ad9d9a66ac", ".agents/skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  [17, "URI", "PLAIN", "fe36092bead3bd47192a05374917c4614ce7642137dc83b9685ab6b5a37d8736", "fe36092bead3bd47192a05374917c4614ce7642137dc83b9685ab6b5a37d8736", "fd0e2849810c912b53dafd71eb60b4a9e2a3bb25bbd7d2dbd67136b207393d9b", ".agents/skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  [17, "URI", "HTML", "fe36092bead3bd47192a05374917c4614ce7642137dc83b9685ab6b5a37d8736", "fe36092bead3bd47192a05374917c4614ce7642137dc83b9685ab6b5a37d8736", "fd0e2849810c912b53dafd71eb60b4a9e2a3bb25bbd7d2dbd67136b207393d9b", ".agents/skills/autoreview/tests/test_autoreview_hardening.py", "100644"],
  // The listing fixture repeats the approved feed URL in live and snapshot metadata.
  [17, "URI", "PLAIN", "a9bdc2ad7ded74870594f1addb8c4f86a5a075516bc840235ed7cc74ed306959", "838f16c9fef468c069583811edaac840bd0378ff46b59008793c552bfbf1c77b", ["6b9804d61dcc7c7c1f9220403787eb71b340645797a7a7926297db085f36c4d5", "6cebd78792a012243cedb635efb44b01181cbd474fd135ebc5112f260284ee43"], "src/cli/plugins-cli.marketplace-entries.test.ts", "100644"],
  [17, "URI", "HTML", "a9bdc2ad7ded74870594f1addb8c4f86a5a075516bc840235ed7cc74ed306959", "838f16c9fef468c069583811edaac840bd0378ff46b59008793c552bfbf1c77b", ["6b9804d61dcc7c7c1f9220403787eb71b340645797a7a7926297db085f36c4d5", "6cebd78792a012243cedb635efb44b01181cbd474fd135ebc5112f260284ee43"], "src/cli/plugins-cli.marketplace-entries.test.ts", "100644"],
  // Plugin-help redaction fixtures: bind every literal occurrence, including object keys and the unsaved URL query.
  [17, "URI", "PLAIN", "1e2c0641bc640f9f57706e40d1c3852f130e85266ba6c13d05e6ca66525d59bd", "1e2c0641bc640f9f57706e40d1c3852f130e85266ba6c13d05e6ca66525d59bd", ["3835950cbb9c584ba2c052e76ba31ac1c83cf48ec422c588fd00605dfec4b082", "0452c2176a2ce671ae67942c523f65774d9fbaa672ac973968844d00fcf44852"], "ui/src/pages/custodian/custodian-session-store.test.ts", "100644"],
  [17, "URI", "HTML", "1e2c0641bc640f9f57706e40d1c3852f130e85266ba6c13d05e6ca66525d59bd", "1e2c0641bc640f9f57706e40d1c3852f130e85266ba6c13d05e6ca66525d59bd", ["3835950cbb9c584ba2c052e76ba31ac1c83cf48ec422c588fd00605dfec4b082", "0452c2176a2ce671ae67942c523f65774d9fbaa672ac973968844d00fcf44852"], "ui/src/pages/custodian/custodian-session-store.test.ts", "100644"],
  [17, "URI", "PLAIN", "1e2c0641bc640f9f57706e40d1c3852f130e85266ba6c13d05e6ca66525d59bd", "1e2c0641bc640f9f57706e40d1c3852f130e85266ba6c13d05e6ca66525d59bd", "bd8755761c1bc3e97de6db5abbb63b57bd89237423154144de2bc16c03dd96a7", "ui/src/e2e/plugins-help.e2e.test.ts", "100644"],
  [17, "URI", "HTML", "1e2c0641bc640f9f57706e40d1c3852f130e85266ba6c13d05e6ca66525d59bd", "1e2c0641bc640f9f57706e40d1c3852f130e85266ba6c13d05e6ca66525d59bd", "bd8755761c1bc3e97de6db5abbb63b57bd89237423154144de2bc16c03dd96a7", "ui/src/e2e/plugins-help.e2e.test.ts", "100644"],
  // Existing browser URL-port fixtures from OpenClaw #83707; repeated input/assertion lines form one exact witness.
  [17, "URI", "PLAIN", "fe30fb721f4e8b1d50f281ae338da254a0e34dba6804776c231b8666d5856055", "3d66d0da353b12cda6548577a624bbb7803b9110255d998a07e5e772dfc5781e", "484aa826bff427f81ddc9e65a3c931d198fee4ca469b51f2a1bec72d669aa7bf", "extensions/browser/src/browser/config.test.ts", "100644"],
  [17, "URI", "HTML", "fe30fb721f4e8b1d50f281ae338da254a0e34dba6804776c231b8666d5856055", "3d66d0da353b12cda6548577a624bbb7803b9110255d998a07e5e772dfc5781e", "484aa826bff427f81ddc9e65a3c931d198fee4ca469b51f2a1bec72d669aa7bf", "extensions/browser/src/browser/config.test.ts", "100644"],
  [17, "URI", "PLAIN", "f5accb521ff7c6ffce0ecd2fb4cb9c05475a832e44c8ac4d336c3cab8e79cfa2", "c81f3e0d5d8aae13f7084e4f5cee483b12b08fb7a4e91f2f7d21072c51b7baa8", ["c016f2251f34393b8dd84f20652f89c4acf457015d6fbc92aa440d6fa1854854", "c753a0542e4bdec89fdd79181e0efa82120253a4c56de4cf0b4365d3f3cb1d76"], "extensions/browser/src/browser/config.test.ts", "100644"],
  [17, "URI", "HTML", "f5accb521ff7c6ffce0ecd2fb4cb9c05475a832e44c8ac4d336c3cab8e79cfa2", "c81f3e0d5d8aae13f7084e4f5cee483b12b08fb7a4e91f2f7d21072c51b7baa8", ["c016f2251f34393b8dd84f20652f89c4acf457015d6fbc92aa440d6fa1854854", "c753a0542e4bdec89fdd79181e0efa82120253a4c56de4cf0b4365d3f3cb1d76"], "extensions/browser/src/browser/config.test.ts", "100644"],
  [17, "URI", "PLAIN", "e34573089185e607a0cf66ed5635da4375033afb255217b6a0999973c96edf6d", "714a0731adfb5b5f3c8c54d5432adaef98a11bccd8d78695cd7c51a9df33eb15", "1ac5194292c5dd0ac2ffb35da904e610bfa6253bd87b233ed147ca1c8cc6d528", "extensions/browser/src/browser/config.test.ts", "100644"],
  [17, "URI", "HTML", "e34573089185e607a0cf66ed5635da4375033afb255217b6a0999973c96edf6d", "714a0731adfb5b5f3c8c54d5432adaef98a11bccd8d78695cd7c51a9df33eb15", "1ac5194292c5dd0ac2ffb35da904e610bfa6253bd87b233ed147ca1c8cc6d528", "extensions/browser/src/browser/config.test.ts", "100644"],
  // Existing OpenClaw create-profile redaction fixture; native PLAIN/HTML findings in PR #149354.
  [17, "URI", "PLAIN", "9052f1f4f392d163174d33f5069883336c7a9da094f773f83b719685f4b9a239", "9052f1f4f392d163174d33f5069883336c7a9da094f773f83b719685f4b9a239", "160d09c72a4cc728dde5d883acd48d170878bbb79d05c06e533517c2afe64138", "extensions/browser/src/browser/profiles-service.test.ts", "100644"],
  [17, "URI", "HTML", "9052f1f4f392d163174d33f5069883336c7a9da094f773f83b719685f4b9a239", "9052f1f4f392d163174d33f5069883336c7a9da094f773f83b719685f4b9a239", "160d09c72a4cc728dde5d883acd48d170878bbb79d05c06e533517c2afe64138", "extensions/browser/src/browser/profiles-service.test.ts", "100644"],
  [17, "URI", "PLAIN", "e26b2ccf9953c3e0e675998528577649327e1d3e1072233ff86cad586ca5c05d", "e26b2ccf9953c3e0e675998528577649327e1d3e1072233ff86cad586ca5c05d", "04e4f717532e6f38582816622367e020b28d8db6ced6e714667328853a422484", "extensions/matrix/src/matrix/client.test.ts", "100644"],
  [17, "URI", "HTML", "e26b2ccf9953c3e0e675998528577649327e1d3e1072233ff86cad586ca5c05d", "e26b2ccf9953c3e0e675998528577649327e1d3e1072233ff86cad586ca5c05d", "04e4f717532e6f38582816622367e020b28d8db6ced6e714667328853a422484", "extensions/matrix/src/matrix/client.test.ts", "100644"],
  [17, "URI", "ESCAPED_UNICODE", "31ff9f3ec446cbcc27e6fc08f3cd96b5d95d8b436b4144f3a098d7c524a863f7", "0d9e27039ed24044fe06ab5145d7b04569ced32d3ff6fe8eb9acf04a75663919", "47171b920ebd0800ac107a92ad80b7279677f0096fad5a367f82fe3b1955c790", "src/logging/redact.test.ts", "100644"],
  [17, "URI", "ESCAPED_UNICODE", "a460200b4a488bc178d0dac30bc5fe027ff86d9c7c94554f5c9d915580bc4239", "839b16fa1dd892daf47ab10d50f7c1957a16ace282fe9e6df67fefc40f7f06ff", "232cce5bf0c7b495e2f008fdc45cbd2bd9afc5394906576e4466411f6841d260", "src/logging/redact.test.ts", "100644"],
  [17, "URI", "ESCAPED_UNICODE", "de7dcbd8612764d80691e85407d899f6e3686afd9ab40964943c3874ffe9571c", "198d323e34c2a045b86adbc72b8cd54bb8f9582175c5c25e6c68b4e374d8873f", "8ff8c788b296b7eb81abaf7f2f48bb4be717f6e8bef76200e7c842dbeea8a15c", "src/logging/redact.test.ts", "100644"],
  [17, "URI", "PLAIN", "31ff9f3ec446cbcc27e6fc08f3cd96b5d95d8b436b4144f3a098d7c524a863f7", "0d9e27039ed24044fe06ab5145d7b04569ced32d3ff6fe8eb9acf04a75663919", "47171b920ebd0800ac107a92ad80b7279677f0096fad5a367f82fe3b1955c790", "src/logging/redact.test.ts", "100644"],
  [17, "URI", "PLAIN", "a460200b4a488bc178d0dac30bc5fe027ff86d9c7c94554f5c9d915580bc4239", "839b16fa1dd892daf47ab10d50f7c1957a16ace282fe9e6df67fefc40f7f06ff", "232cce5bf0c7b495e2f008fdc45cbd2bd9afc5394906576e4466411f6841d260", "src/logging/redact.test.ts", "100644"],
  [17, "URI", "PLAIN", "de7dcbd8612764d80691e85407d899f6e3686afd9ab40964943c3874ffe9571c", "198d323e34c2a045b86adbc72b8cd54bb8f9582175c5c25e6c68b4e374d8873f", "8ff8c788b296b7eb81abaf7f2f48bb4be717f6e8bef76200e7c842dbeea8a15c", "src/logging/redact.test.ts", "100644"],
  [895, "MongoDB", "ESCAPED_UNICODE", "087c10edd5d21290a4a8695083ff8c42554fc1d1a1becea9053b11c4790b859c", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "0aeba0d1b540784464c2a230b589a48d3f062d0dbbb2d9669450ff4ee2176218", "src/logging/redact.test.ts", "100644"],
  [895, "MongoDB", "PLAIN", "087c10edd5d21290a4a8695083ff8c42554fc1d1a1becea9053b11c4790b859c", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "0aeba0d1b540784464c2a230b589a48d3f062d0dbbb2d9669450ff4ee2176218", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "ESCAPED_UNICODE", "050c1ddf61dd8b806e1a75cbe572669f8fa546e4ba36d03454377ba7a2c05d66", "050c1ddf61dd8b806e1a75cbe572669f8fa546e4ba36d03454377ba7a2c05d66", "6dc3c292a8c87dd8c203af74bf1fa03f3eb64ae12bafc23dadfff9c3f63c23e6", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "ESCAPED_UNICODE", "39a0315176e45802aaa3c5c40c2a717e2fde14e99567c38b5640fe16138710fa", "39a0315176e45802aaa3c5c40c2a717e2fde14e99567c38b5640fe16138710fa", "4b03f485ba97fd1aea07f64e978e9a961179dbbb766828f20fc8a2401812a858", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "ESCAPED_UNICODE", "4734d8b7c6e9bf96ae464bfc45b1482e00caaedea951cb96b9e88a92ba37a00f", "4734d8b7c6e9bf96ae464bfc45b1482e00caaedea951cb96b9e88a92ba37a00f", "252d197820142c40bc8701a8b1400f28a3224f305f37fd65cd2e6bfbe48d9fb1", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "ESCAPED_UNICODE", "8be6f6c2f1e50f070e97e4b46fce7e7ad499a6bc0c145e8bdd4fc0a6ee4b5565", "8be6f6c2f1e50f070e97e4b46fce7e7ad499a6bc0c145e8bdd4fc0a6ee4b5565", "6a9d1339c87f11af0ba4e7ef89a77ea8eb8e7f7ac48fdec0abb19d9138821d18", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "ESCAPED_UNICODE", "f2e76a2fe75ea0d64265b2a61462f1d8026a2286e3030077b4f3972fc0df3b70", "f2e76a2fe75ea0d64265b2a61462f1d8026a2286e3030077b4f3972fc0df3b70", "2020783f7b14c74d2d6960efca4ca82727980494ddef883f15ae9980141662ec", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "PLAIN", "050c1ddf61dd8b806e1a75cbe572669f8fa546e4ba36d03454377ba7a2c05d66", "050c1ddf61dd8b806e1a75cbe572669f8fa546e4ba36d03454377ba7a2c05d66", "6dc3c292a8c87dd8c203af74bf1fa03f3eb64ae12bafc23dadfff9c3f63c23e6", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "PLAIN", "39a0315176e45802aaa3c5c40c2a717e2fde14e99567c38b5640fe16138710fa", "39a0315176e45802aaa3c5c40c2a717e2fde14e99567c38b5640fe16138710fa", "4b03f485ba97fd1aea07f64e978e9a961179dbbb766828f20fc8a2401812a858", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "PLAIN", "4734d8b7c6e9bf96ae464bfc45b1482e00caaedea951cb96b9e88a92ba37a00f", "4734d8b7c6e9bf96ae464bfc45b1482e00caaedea951cb96b9e88a92ba37a00f", "252d197820142c40bc8701a8b1400f28a3224f305f37fd65cd2e6bfbe48d9fb1", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "PLAIN", "8be6f6c2f1e50f070e97e4b46fce7e7ad499a6bc0c145e8bdd4fc0a6ee4b5565", "8be6f6c2f1e50f070e97e4b46fce7e7ad499a6bc0c145e8bdd4fc0a6ee4b5565", "6a9d1339c87f11af0ba4e7ef89a77ea8eb8e7f7ac48fdec0abb19d9138821d18", "src/logging/redact.test.ts", "100644"],
  [968, "Postgres", "PLAIN", "f2e76a2fe75ea0d64265b2a61462f1d8026a2286e3030077b4f3972fc0df3b70", "f2e76a2fe75ea0d64265b2a61462f1d8026a2286e3030077b4f3972fc0df3b70", "2020783f7b14c74d2d6960efca4ca82727980494ddef883f15ae9980141662ec", "src/logging/redact.test.ts", "100644"],
  // Maintainer-qualified Git-remote rejection fixtures; only observed native PLAIN tuples.
  [17, "URI", "PLAIN", "609f5f8c987b35e0d48b35e8463574db63b84c087e79d4189ef6fea5979f7609", "8074e19d513f3bdb60156065af46081e407232026590b37476c5b7745db3d776", ["f0144dec37814ca30e23745ffff253f710c20e51e4ac2fbdf3ae4b82afb17e10", "b59f02752a9188dc4d89ebf86442a3af3c2c49a64a217614fb29e9d0d1b88f88"], "internal/cli/repo_test.go", "100644"],
  [17, "URI", "PLAIN", "4b113e9ace3e5b41991d62d947eb1bb8251c904aded634c011eac87f7011c518", "4b113e9ace3e5b41991d62d947eb1bb8251c904aded634c011eac87f7011c518", ["f0144dec37814ca30e23745ffff253f710c20e51e4ac2fbdf3ae4b82afb17e10", "b59f02752a9188dc4d89ebf86442a3af3c2c49a64a217614fb29e9d0d1b88f88"], "internal/cli/repo_test.go", "100644"],
  [17, "URI", "PLAIN", "609f5f8c987b35e0d48b35e8463574db63b84c087e79d4189ef6fea5979f7609", "8074e19d513f3bdb60156065af46081e407232026590b37476c5b7745db3d776", "35f038c31f598ead2d83273f87972633d956fd55395644cf722d963121a0f999", "internal/cli/ssh_test.go", "100644"],
  // Scanner regression/proof controls: exact owned source lines, including the deliberate rejection case.
  [17, "URI", "PLAIN", "dab81a433bea3f155bdd2e6568380c6e21c4a629096e29443c949fcab4ab8adc", "dab81a433bea3f155bdd2e6568380c6e21c4a629096e29443c949fcab4ab8adc", ["e7173a8ac7ee26ee3846d6487ea01f33027e226087f561866b009f60dc34178e", "508ded3f91728edcc7d4ee16d478fae1afd678604e85a9c1f5b701faead11057"], "test/agent-input-scan-git-metadata.test.ts", "100644"],
  [17, "URI", "PLAIN", "1e2c0641bc640f9f57706e40d1c3852f130e85266ba6c13d05e6ca66525d59bd", "1e2c0641bc640f9f57706e40d1c3852f130e85266ba6c13d05e6ca66525d59bd", "3cd99e06be80f0f01f21d20433c9e1fa20245f0fac149007b0e45b1738f4a327", "test/agent-input-scan-git-metadata.test.ts", "100644"],
  [17, "URI", "HTML", "1e2c0641bc640f9f57706e40d1c3852f130e85266ba6c13d05e6ca66525d59bd", "1e2c0641bc640f9f57706e40d1c3852f130e85266ba6c13d05e6ca66525d59bd", "3cd99e06be80f0f01f21d20433c9e1fa20245f0fac149007b0e45b1738f4a327", "test/agent-input-scan-git-metadata.test.ts", "100644"],
  [17, "URI", "HTML", "dab81a433bea3f155bdd2e6568380c6e21c4a629096e29443c949fcab4ab8adc", "dab81a433bea3f155bdd2e6568380c6e21c4a629096e29443c949fcab4ab8adc", ["e7173a8ac7ee26ee3846d6487ea01f33027e226087f561866b009f60dc34178e", "508ded3f91728edcc7d4ee16d478fae1afd678604e85a9c1f5b701faead11057"], "test/agent-input-scan-git-metadata.test.ts", "100644"],
  [17, "URI", "PLAIN", "1e2c0641bc640f9f57706e40d1c3852f130e85266ba6c13d05e6ca66525d59bd", "1e2c0641bc640f9f57706e40d1c3852f130e85266ba6c13d05e6ca66525d59bd", "a271d1f3d9e105af4a08d27cb5372f891021a0e254241ee23ea257863300a9fd", "docs/proof/agent-input-scan-git-metadata/run-shared-oid-proof.mjs", "100644"],
  [17, "URI", "HTML", "1e2c0641bc640f9f57706e40d1c3852f130e85266ba6c13d05e6ca66525d59bd", "1e2c0641bc640f9f57706e40d1c3852f130e85266ba6c13d05e6ca66525d59bd", "a271d1f3d9e105af4a08d27cb5372f891021a0e254241ee23ea257863300a9fd", "docs/proof/agent-input-scan-git-metadata/run-shared-oid-proof.mjs", "100644"],
  ...CRABBOX_POSTGRES_DOC_ATTRIBUTIONS,
];

const sha256Pattern = /^[0-9a-f]{64}$/;
const detectorNames = { 17: "URI", 895: "MongoDB", 968: "Postgres" } as const;

function validateReviewedAttributions(rows: readonly ReviewedAttribution[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const [detectorType, detectorName, decoder, raw, rawV2, line, source, mode] = row;
    const lines = typeof line === "string" ? [line] : line;
    if (
      row.length !== 8 ||
      detectorNames[detectorType] !== detectorName ||
      !Array.isArray(lines) ||
      !lines.length ||
      new Set(lines).size !== lines.length ||
      ![raw, rawV2, ...lines].every((digest) => sha256Pattern.test(digest)) ||
      !(
        (source === "src/logging/redact.test.ts" &&
          (decoder === "PLAIN" || decoder === "ESCAPED_UNICODE")) ||
        (source === "src/cli/plugins-cli.marketplace-entries.test.ts" &&
          detectorType === 17 &&
          detectorName === "URI" &&
          (decoder === "PLAIN" || decoder === "HTML")) ||
        (source === "extensions/matrix/src/matrix/client.test.ts" &&
          detectorType === 17 &&
          detectorName === "URI" &&
          (decoder === "PLAIN" || decoder === "HTML")) ||
        ((source === "extensions/browser/src/browser/profiles-service.test.ts" ||
          source === "extensions/typesafe/src/local.transport.test.ts" ||
          source === "extensions/browser/src/browser/config.test.ts" ||
          source === "extensions/browser/src/browser/pw-session.connections.test.ts" ||
          source === "extensions/github/src/detail-checks.test.ts" ||
          source === "ui/src/pages/custodian/custodian-session-store.test.ts" ||
          source === "ui/src/e2e/plugins-help.e2e.test.ts" ||
          source === "ui/src/app/question-prompt.test.ts" ||
          source === "src/gateway/server-methods/question.test.ts" ||
          source === "test/helpers/openclaw-test-instance.test.ts" ||
          source === "skills/autoreview/tests/test_autoreview_hardening.py" ||
          source === ".agents/skills/autoreview/tests/test_autoreview_hardening.py") &&
          detectorType === 17 &&
          detectorName === "URI" &&
          (decoder === "PLAIN" || decoder === "HTML")) ||
        ((source === "internal/cli/repo_test.go" || source === "internal/cli/ssh_test.go") &&
          detectorType === 17 &&
          detectorName === "URI" &&
          decoder === "PLAIN") ||
        ((source === "test/agent-input-scan-git-metadata.test.ts" ||
          source === "docs/proof/agent-input-scan-git-metadata/run-shared-oid-proof.mjs") &&
          detectorType === 17 &&
          detectorName === "URI" &&
          (decoder === "PLAIN" || decoder === "HTML")) ||
        (source === "docs/operations.md" &&
          detectorType === 968 &&
          detectorName === "Postgres" &&
          (decoder === "PLAIN" || decoder === "HTML"))
      ) ||
      mode !== "100644"
    ) {
      throw new Error("invalid reviewed attribution policy");
    }
    const key = row.join("\0");
    if (seen.has(key)) throw new Error("duplicate reviewed attribution policy");
    seen.add(key);
  }
}

validateReviewedAttributions(REVIEWED_ATTRIBUTIONS);

export function serializeReviewContext(
  context: object,
  sourcePatchRecords: readonly unknown[] = [],
): string {
  const sourceRecords = new Set(sourcePatchRecords);
  return JSON.stringify(
    context,
    function (this: unknown, key: string, value: unknown) {
      // Source patches are scanned with their committed provenance. Copying them
      // into prompt text loses that attribution; retain their identities instead.
      if (sourceRecords.has(this) && (key === "patch" || key === "patchComplete")) return undefined;
      return typeof value === "string" ? omitReviewedFixtureReferences(value) : value;
    },
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
      decoder: "PLAIN" | "HTML" | "ESCAPED_UNICODE" | "OTHER";
      verified: boolean | null;
      scannerLine: number | null;
      material?: ScanMaterialDiagnostic;
    };

export interface ReviewedFixtureNotice {
  classification?: "git_object_id";
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

type ClassifiedScan =
  | { kind: "classified"; notices: ReviewedFixtureNotice[] }
  | {
      kind: "git_metadata_proof_required";
      notices: ReviewedFixtureNotice[];
      proofPatches: ReadonlyMap<string, Buffer>;
    };

interface ClassifiedFinding {
  blob: string;
  scannerLine: number;
  literalLine: number;
  decoder: string;
  occurrences: number;
  role?: ScanSourceRole;
  patch?: { from: string; to: string; sourceBlob: string; sourceLine: number };
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
): ClassifiedScan | RefusedScan {
  validateReviewedAttributions(reviewedAttributions);
  const nativeFailure = (
    reason: Extract<ScanRefusalDiagnostic, { kind: "native_contract" }>["reason"],
  ): RefusedScan => ({
    kind: "refused",
    reason: "scanner_failed",
    diagnostic: { kind: "native_contract", reason },
  });
  if (status !== 183 && (status !== 0 || stdout.length)) return nativeFailure("unexpected_exit");
  const findings = records(stdout);
  if (!findings || (status === 183 && !findings.length)) return nativeFailure("invalid_stdout");
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
    completion.trufflehog_version !== TRUFFLEHOG_VERSION ||
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

  return classifyReviewedFindings(findings, inputs, reviewedAttributions);
}

function nativeUriParts(value: string) {
  const uri = new URL(value);
  // TruffleHog's Go URL host retains explicit default ports and original spelling.
  const authority = /^[^:]+:\/\/([^/?#]*)/.exec(value)?.[1];
  return {
    host: authority?.slice(authority.lastIndexOf("@") + 1),
    username: uri.username,
    password: uri.password,
  };
}

function classifyReviewedFindings(
  findings: Record<string, unknown>[],
  inputs: ReadonlyMap<string, StagedScanInput>,
  reviewedAttributions: readonly ReviewedAttribution[],
  literalLines = new Map<string, number>(),
): ClassifiedScan | RefusedScan {
  const patchWitnesses = new Map<string, NonNullable<ReturnType<typeof resolvePatchWitnesses>>>();
  const objectWitnesses = new Map<
    string,
    NonNullable<ReturnType<typeof resolveGitObjectMetadata>>
  >();
  const proofPatches = new Map<string, Buffer>();
  const classified = new Map<
    string,
    {
      classification?: "git_object_id";
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
          finding.DecoderName === "PLAIN" ||
          finding.DecoderName === "HTML" ||
          finding.DecoderName === "ESCAPED_UNICODE"
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
            ([, , , expectedRaw, expectedRawV2]) =>
              expectedRaw === rawDigest && expectedRawV2 === rawV2Digest,
          );
    const fixture = REVIEWED_FIXTURES.find(
      (entry) =>
        entry.fixtureSha256 === rawV2Digest &&
        (entry.rawSha256 ?? entry.fixtureSha256) === rawDigest,
    );
    // Shared fixture values must not replace another source's existing policy.
    // Mixed references still take the exact path and must all qualify there.
    const usesExactPolicy = (input: StagedScanInput | undefined) =>
      exactCandidates.length > 0 &&
      (input?.kind !== "blob" ||
        !fixture ||
        input.references.length === 0 ||
        input.references.some(({ source }) =>
          exactCandidates.some((candidate) => candidate[6] === source),
        ) ||
        input.references.some(({ source }) => !fixture.sources.includes(source)));
    if (staged?.kind === "patch") {
      if (typeof file !== "string" || scannerLine === null) return refuse("metadata_mismatch");
      if (finding.DetectorType === 58) {
        const parts = object(finding.SecretParts);
        if (
          finding.DetectorName !== "CloudflareGlobalApiKey" ||
          finding.SourceType !== 15 ||
          finding.Verified !== false ||
          typeof finding.VerificationError !== "string" ||
          !finding.VerificationError ||
          (finding.DecoderName !== "PLAIN" && finding.DecoderName !== "HTML") ||
          finding.ExtraData !== null ||
          finding.StructuredData !== null ||
          !raw ||
          !rawDigest ||
          !exactStringRecord(parts, ["key", "email"]) ||
          parts?.key !== raw ||
          rawV2 !== raw + parts.email ||
          finding.Redacted !== parts.email
        )
          return refuse("metadata_mismatch");
        const witnessKey = `${file}:${rawDigest}`;
        const witnesses =
          objectWitnesses.get(witnessKey) ?? resolveGitObjectMetadata(staged, raw, inputs);
        if (!witnesses) return refuse("material_not_reviewed");
        objectWitnesses.set(witnessKey, witnesses);
        // Only independently proven metadata fields change in this second input.
        // The original complete patch remains part of the primary native scan.
        const proof = proofPatches.get(file) ?? Buffer.from(staged.bytes!);
        const literal = Buffer.from(raw);
        for (
          let offset = proof.indexOf(literal);
          offset !== -1;
          offset = proof.indexOf(literal, offset + literal.length)
        )
          proof.fill("_", offset, offset + literal.length);
        proofPatches.set(file, proof);
        for (const witness of witnesses) {
          const key = `git-object:${rawDigest}:${witness.source}`;
          const group = classified.get(key) ?? {
            classification: "git_object_id" as const,
            fixtureSha256: rawDigest,
            source: witness.source,
            detector: "CloudflareGlobalApiKey",
            findings: new Map<string, ClassifiedFinding>(),
          };
          const findingKey = `${staged.id}:${scannerLine}:${finding.DecoderName}:${witness.patchLine}`;
          const previous = group.findings.get(findingKey);
          group.findings.set(findingKey, {
            blob: staged.id,
            scannerLine,
            literalLine: witness.patchLine,
            decoder: finding.DecoderName,
            occurrences: (previous?.occurrences ?? 0) + 1,
          });
          classified.set(key, group);
        }
        continue;
      }
      if (
        finding.DetectorType !== 17 ||
        !rawV2 ||
        (finding.DecoderName !== "PLAIN" && finding.DecoderName !== "HTML")
      )
        return refuse("material_not_reviewed");
      const witnessKey = `${file}:${rawV2Digest}`;
      const witnesses =
        patchWitnesses.get(witnessKey) ?? resolvePatchWitnesses(staged, rawV2, inputs);
      if (!witnesses) return refuse("material_not_reviewed");
      patchWitnesses.set(witnessKey, witnesses);
      if (witnesses.some((witness) => usesExactPolicy(inputs.get(witness.file)))) {
        const key = [
          file,
          scannerLine,
          finding.DetectorType,
          finding.DetectorName,
          finding.DecoderName,
          rawDigest,
          rawV2Digest,
        ].join("\0");
        if (exactFindings.has(key)) return refuse("duplicate_finding");
        exactFindings.add(key);
      }
      for (const witness of witnesses) {
        // Changed lines need exact full-line policy; legacy URI rows remain
        // context-only even when their value and source path are reviewed.
        if (witness.kind !== "context" && !usesExactPolicy(inputs.get(witness.file)))
          return refuse("material_not_reviewed");
        // Reuse source policy against the original full blob and every logical
        // reference. This derived attribution never replaces scanned patch bytes.
        const result = classifyReviewedFindings(
          [
            {
              ...finding,
              SourceMetadata: {
                Data: { Filesystem: { file: witness.file, line: witness.sourceLine } },
              },
            },
          ],
          inputs,
          reviewedAttributions,
          literalLines,
        );
        if (result.kind !== "classified")
          return refuse(
            result.kind === "refused" && result.diagnostic.kind === "unclassified_finding"
              ? result.diagnostic.reason
              : "finding_not_reviewed",
          );
        for (const notice of result.notices) {
          const key = `patch:${notice.fixtureSha256}:${notice.source}`;
          const group = classified.get(key) ?? {
            ...notice,
            findings: new Map<string, ClassifiedFinding>(),
          };
          for (const attributed of notice.findings) {
            const findingKey = `${staged.id}:${scannerLine}:${finding.DecoderName}:${witness.patchLine}:${attributed.blob}:${attributed.role ?? ""}`;
            const previous = group.findings.get(findingKey);
            group.findings.set(findingKey, {
              ...attributed,
              occurrences: (previous?.occurrences ?? 0) + attributed.occurrences,
              blob: staged.id,
              scannerLine,
              literalLine: witness.patchLine,
              patch: {
                from: staged.from,
                to: staged.to,
                sourceBlob: attributed.blob,
                sourceLine: witness.sourceLine,
              },
            });
          }
          classified.set(key, group);
        }
      }
      continue;
    }
    if (usesExactPolicy(staged)) {
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
        let uri: ReturnType<typeof nativeUriParts>;
        try {
          uri = nativeUriParts(rawV2);
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
      let witnessLineNumber: number | undefined;
      const witnessDigests: string[] = [];
      const expectedDigests = matchingMetadata.map(([, , , , , line]) =>
        typeof line === "string" ? [line] : line,
      );
      const maxOccurrences = Math.max(...expectedDigests.map((lines) => lines.length));
      while (lineStart <= text.length) {
        const newline = text.indexOf("\n", lineStart);
        const lineEnd = newline === -1 ? text.length : newline;
        const line = text.slice(lineStart, lineEnd);
        if (detectorType === 17 && line.includes(rawV2)) {
          let occurrence = line.indexOf(rawV2);
          while (occurrence !== -1) {
            if (witnessDigests.length >= maxOccurrences) return refuse("literal_mismatch");
            witnessDigests.push(createHash("sha256").update(line).digest("hex"));
            occurrence = line.indexOf(rawV2, occurrence + rawV2.length);
          }
          witnessLineNumber ??= lineNumber;
        } else if (detectorType !== 17 && lineNumber === scannerLine) {
          witnessDigests.push(createHash("sha256").update(line).digest("hex"));
          witnessLineNumber = lineNumber;
        }
        if (newline === -1) break;
        lineStart = newline + 1;
        lineNumber++;
      }
      const matchesWitness = (lines: readonly string[]) =>
        lines.length === witnessDigests.length &&
        lines.every((digest, index) => digest === witnessDigests[index]);
      if (witnessLineNumber === undefined || !expectedDigests.some(matchesWitness))
        return refuse("literal_mismatch");
      if (
        !staged.references.length ||
        staged.references.some(
          ({ source, mode, role }) =>
            (role !== "base" && role !== "head") ||
            matchingMetadata.every(
              ([, , , , , , expectedSource, expectedMode], index) =>
                !matchesWitness(expectedDigests[index]!) ||
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
    const uri = nativeUriParts(finding.RawV2);
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
  const notices = [...classified.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => ({
      ...(group.classification ? { classification: group.classification } : {}),
      fixtureSha256: group.fixtureSha256,
      source: group.source,
      detector: group.detector,
      findings: [...group.findings.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, value]) => value),
    }));
  return proofPatches.size
    ? { kind: "git_metadata_proof_required", notices, proofPatches }
    : { kind: "classified", notices };
}
