// Exact synthetic values migrated from the reviewed policy at
// 8ba1ab445ed086863bbd9749237cfcb7096bae7a, without file/line/content hashes.
// Postgres is excluded: its normalized native values can omit a query password.
// Hostnames never establish that a credential is synthetic. See
// https://github.com/openclaw/clawsweeper/pull/2201 for the policy change.
export type ApprovedSyntheticValue = readonly [
  detectorType: number,
  detectorName: string,
  decoders: readonly string[],
  rawSha256: string,
  rawV2Sha256: string,
];

// oxfmt-ignore
export const APPROVED_SYNTHETIC_VALUES: readonly ApprovedSyntheticValue[] = [
  // tests/integration/configuration-controller.test.mjs
  [10,"JDBC",["PLAIN"],"7f73c5b7c4cb379bbcc944971cff2c6a15ac0b0398b4c66ded6c8fb5db2c1833","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  // extensions/mattermost/src/mattermost/slash-http.test.ts
  [17,"URI",["HTML","PLAIN"],"014a5653f93da5c53f9a09313e7aa32753fbdf0de02314af39a65af9a1dde664","0c2d147cb7b70169ceb0302b40bceaa60abc15263c4dcfb7f1746cc93e3c87d3"],
  // extensions/mattermost/src/mattermost/slash-http.test.ts
  [17,"URI",["HTML","PLAIN"],"014a5653f93da5c53f9a09313e7aa32753fbdf0de02314af39a65af9a1dde664","fd79d243a5d942979882ca621cfa8bd240a2fce9ca400cdd6b2b1bfab4c5cf6a"],
  // ui/src/lib/board/widgets/website.test.ts
  [17,"URI",["PLAIN"],"040dc8c3fadea20ff28b67c13648a45e001f231c496b404a17de54426060d03d","040dc8c3fadea20ff28b67c13648a45e001f231c496b404a17de54426060d03d"],
  // ui/src/app/question-prompt.test.ts
  [17,"URI",["HTML","PLAIN"],"056ba31f89867351c82b216a148b00bc322977c7da7a4aec9e0a1c222d239b50","a62b014a9aedc9b5b538eed1f6fc5825be583d195348a11ff94076b4a6b4f55b"],
  // skills/autoreview/tests/test_autoreview_hardening.py
  [17,"URI",["HTML","PLAIN"],"05ac498c28c2d5ac33d1623fa344fa9dfc5e74ac56fef091df3ab4886ad44de1","05ac498c28c2d5ac33d1623fa344fa9dfc5e74ac56fef091df3ab4886ad44de1"],
  // internal/providers/all/command_routing_test.go
  [17,"URI",["PLAIN"],"074f22e4df02459f0d76314ba50dace1f636490fe1c46c529b5937af3e7b132a","feb035cc8ff180121b5b0c9632560ea099625ff64cad056624cefaa345493304"],
  // internal/providers/all/command_routing_test.go
  [17,"URI",["PLAIN"],"07968c00c423fd77a0ee19bd8a05e59e9365a48342e66818eee4b34b1c3ee087","bbc496f1b46b968ed3dc0e1e794c3ab7e65f59720270b2a3c2cccc74d7374953"],
  // src/cli/proxy-cli.runtime.test.ts
  [17,"URI",["HTML","PLAIN"],"0ef0207595a31168bf8da47767ebd6cd1df772894fad34d7c415c3a54bc9682a","0ef0207595a31168bf8da47767ebd6cd1df772894fad34d7c415c3a54bc9682a"],
  // extensions/github/src/detail-checks.test.ts
  [17,"URI",["HTML","PLAIN"],"148db1b794aa55e895c253fc95230148dd8cf58b8f97bac16c3db0147df7f457","e10c3a5ca351377dab596260b30d87d26337a91bb3bb7b8f8d1fecda7285a125"],
  // internal/providers/azuredynamicsessions/client_test.go
  [17,"URI",["PLAIN"],"18b8a05caad228f56cfded41e0ce2f513f859be0da13c3a688b169ded93637d1","18b8a05caad228f56cfded41e0ce2f513f859be0da13c3a688b169ded93637d1"],
  // tests/conformance/kubernetes-compute.test.mjs
  [17,"URI",["PLAIN"],"18e186031a746783f43d3002e63b775b6e28acef5d60825a82c418ad3e603b5b","18e186031a746783f43d3002e63b775b6e28acef5d60825a82c418ad3e603b5b"],
  // extensions/github/src/detail.test.ts
  [17,"URI",["HTML","PLAIN"],"1aa166a254353a56288ad1942fdac6d92342f9ca53ca6690247bae6cc0ac3738","99c6ba8a9fbc40225ed3839f4cadf69924aa66ca191aa2bc647d0a18aaabe731"],
  // src/infra/update-failure-report-config.test.ts
  [17,"URI",["HTML","PLAIN"],"1b950d6c665b182a7aa7a553add23364cedb3ea08771873aea9547b3fd3dcb11","a844b0f4456fddf3bf5e3d3e62391e29458c00c54fadd3ea087242f09889fae9"],
  // extensions/browser/src/browser/routes/basic.existing-session.test.ts
  [17,"URI",["PLAIN"],"1d71159c56ca84a71d1b34c10e8d645f3ced3c75a5ac818104338ff58bb95993","1d71159c56ca84a71d1b34c10e8d645f3ced3c75a5ac818104338ff58bb95993"],
  // ui/src/pages/custodian/custodian-session-store.test.ts
  [17,"URI",["HTML","PLAIN"],"1e2c0641bc640f9f57706e40d1c3852f130e85266ba6c13d05e6ca66525d59bd","1e2c0641bc640f9f57706e40d1c3852f130e85266ba6c13d05e6ca66525d59bd"],
  // src/infra/git-source.test.ts
  [17,"URI",["ESCAPED_UNICODE","HTML","PLAIN"],"1e2c0641bc640f9f57706e40d1c3852f130e85266ba6c13d05e6ca66525d59bd","38f7c5f5260b58730c16187c5777da1ed97c72a836f6213c4ea3b376fa96fa57"],
  // src/gateway/server-methods/question.test.ts
  [17,"URI",["HTML","PLAIN"],"2c45f25f2626ac90554ac699f6b285846faf497f796f3d1c05acb7fef231d0a9","c914cd0ca5fb29af5f36f2e92ac43bf9fa59e1a729049dcbdd5b09cee50d4b28"],
  // skills/autoreview/tests/test_autoreview_hardening.py
  [17,"URI",["PLAIN"],"2d082b79ad4da55704d07af5754a91f9a677bfbbdc626d93a58291f11edf53c5","2d082b79ad4da55704d07af5754a91f9a677bfbbdc626d93a58291f11edf53c5"],
  // src/logging/redact.test.ts
  [17,"URI",["ESCAPED_UNICODE","PLAIN"],"31ff9f3ec446cbcc27e6fc08f3cd96b5d95d8b436b4144f3a098d7c524a863f7","0d9e27039ed24044fe06ab5145d7b04569ced32d3ff6fe8eb9acf04a75663919"],
  // src/config/config-misc.test.ts
  [17,"URI",["ESCAPED_UNICODE","HTML","PLAIN"],"354e44c28981412829c4cd79588c7c5385d55221eb1f5d0014e96421d35e76a4","354e44c28981412829c4cd79588c7c5385d55221eb1f5d0014e96421d35e76a4"],
  // src/gateway/server.config-patch.test.ts
  [17,"URI",["HTML","PLAIN"],"3699f73147f6969e1a3273a5809e2dd7886b95fad51315008b75bb20c4c9832f","3699f73147f6969e1a3273a5809e2dd7886b95fad51315008b75bb20c4c9832f"],
  // src/worker/native-runtime.test.ts
  [17,"URI",["HTML","PLAIN"],"3ba4b9eb95fbafcb38a3dd4bc9886809ca70168cc4a8e552ed23d894cbb07df3","3ba4b9eb95fbafcb38a3dd4bc9886809ca70168cc4a8e552ed23d894cbb07df3"],
  // apps/macos/Tests/OpenClawIPCTests/DashboardWindowSmokeTests.swift
  [17,"URI",["HTML","PLAIN"],"43690a8c13d4028ed731bc4dfeb37f83adaa4e5849d2e0fa13f746843adec333","97c60d02f5114db97718cfe1c3686c0a36fb5138840611c8793c7abbd9c64f71"],
  // internal/cli/repo_test.go
  [17,"URI",["PLAIN"],"4b113e9ace3e5b41991d62d947eb1bb8251c904aded634c011eac87f7011c518","4b113e9ace3e5b41991d62d947eb1bb8251c904aded634c011eac87f7011c518"],
  // extensions/browser/src/browser/chrome-mcp.test.ts
  [17,"URI",["HTML","PLAIN"],"5246f92cf855756f5fd7d561ea1b3679cd4957183af46ffb4a5d43968ba25254","5246f92cf855756f5fd7d561ea1b3679cd4957183af46ffb4a5d43968ba25254"],
  // extensions/crabbox/src/crabbox-model-run.test.ts
  [17,"URI",["HTML","PLAIN"],"5657f4461d80dbe503e3d0574f255ceb19be6b2c247df97467bd352c3a02d871","5657f4461d80dbe503e3d0574f255ceb19be6b2c247df97467bd352c3a02d871"],
  // src/plugins/catalog-icon-registry.test.ts
  [17,"URI",["HTML","PLAIN"],"580f7a7c0ff4d88005bb0a7ad56ab18f84dc6ba38060fd35914e020e8b581a6a","02fcb6434869afdf5b29773aad1295172012f6445975eba685b873c79e4567b9"],
  // extensions/browser/src/browser/pw-session.connections.test.ts
  [17,"URI",["HTML","PLAIN"],"58e5399334d925e239b1b4777a226340f84778101809699897154e2a3c750a42","a2b7cdba4afae496b99e64423837887e56340606268f28b7edef5a33e22cdc0f"],
  // internal/providers/all/claim_scope_test.go
  [17,"URI",["PLAIN"],"59357e59c291991c90b270b631c211824c280da20067aab43514642be03e9638","5cb65d249cba9bb31b78f257134608da51cbe7adef0236dc641a9ce33e7f6fb3"],
  // src/gateway/server-methods/config-custom-endpoint.test.ts
  [17,"URI",["HTML","PLAIN"],"597eab0f9f33f6ee623768b183c5e349f6b5e94f4760d5e846c2e77fd193f977","7efab902442b7a5718ca6037293710b1651a072ea24f11da9c6a9a5cadfb5fc3"],
  // extensions/browser/src/browser/chrome.test.ts, extensions/browser/src/browser/server-context.ensure-browser-available.waits-for-cdp-ready.test.ts
  [17,"URI",["HTML","PLAIN"],"60267342b1ab046bd8c42e2226fdfce2aa081e7f18e17c35c9c013d7b1de5720","60267342b1ab046bd8c42e2226fdfce2aa081e7f18e17c35c9c013d7b1de5720"],
  // internal/cli/repo_test.go
  [17,"URI",["PLAIN"],"609f5f8c987b35e0d48b35e8463574db63b84c087e79d4189ef6fea5979f7609","8074e19d513f3bdb60156065af46081e407232026590b37476c5b7745db3d776"],
  // test/helpers/openclaw-test-instance.test.ts
  [17,"URI",["HTML","PLAIN"],"630affa5ad9abd80845b370cfee593f079ea56cf2907e2e0135d154bb7d30fcb","630affa5ad9abd80845b370cfee593f079ea56cf2907e2e0135d154bb7d30fcb"],
  // skills/autoreview/tests/test_autoreview_hardening.py, .agents/skills/autoreview/tests/test_autoreview_hardening.py
  [17,"URI",["BASE64","HTML","PLAIN"],"662a886a0fd7447dad0acda3aeccc9eb539fc90438b453de7e2f523ca7ee6c83","662a886a0fd7447dad0acda3aeccc9eb539fc90438b453de7e2f523ca7ee6c83"],
  // internal/cli/webvnc_test.go
  [17,"URI",["PLAIN"],"6a160b5adb896b7ae8e5347258bce211ebcb35f422aa9fc0931d2406403e72ae","5f63e971f3b95e10c500e2c40cfaf423b47c60e1bbb3c1dad9633cef0aa1a10f"],
  // internal/cli/config_test.go
  [17,"URI",["PLAIN"],"6b167ea4a777545dcca0e4d425aafccd750a6c6fca8a5b2b370f16491f3a8a4d","0ff6fd85d257fff2c1caed69eb7aae2c67aed01380cb46e34d557984e27fa54c"],
  // src/config/redact-snapshot.restore.test.ts, src/config/redact-snapshot.test.ts
  [17,"URI",["HTML","PLAIN"],"6b167ea4a777545dcca0e4d425aafccd750a6c6fca8a5b2b370f16491f3a8a4d","a2e43ebb989e154a5cfde0e9f67d0e7465adffdba2c8be60394f35e7797149a3"],
  // src/secrets/model-egress.test.ts
  [17,"URI",["HTML","PLAIN"],"6b67867fb8dd166b1fd7dcadb0a415a1453b3d4f9206e19d9a13fed21d6fa902","beed93909cda1de00e65435a362281e7e8924bcc82cda6605699a451a80606ff"],
  // .agents/skills/autoreview/tests/test_autoreview_hardening.py
  [17,"URI",["PLAIN"],"6c529e5b9845e7f41a5406cea40dc9dc98bfc8da6a330c3cdb34554f2dc0317f","eebab8ec3df3ff0426c28021cce68ab7d2391e32d3040b128210e9df7ad3e092"],
  // extensions/browser/src/browser/cdp.helpers.internal.test.ts
  [17,"URI",["HTML","PLAIN"],"6eff40b9b295cc8f78a2a7762888d6884610d3399a676b6c648fd1f8a71c1d58","c10384849acffcfd5e4a8c5c7e368a9822425fbd631b1b51e74e48fd974b76d0"],
  // src/secrets/model-egress.test.ts
  [17,"URI",["HTML","PLAIN"],"7291e1dd92191deb23a9d7852746d0d0666812f209be34fca14125096404deae","7291e1dd92191deb23a9d7852746d0d0666812f209be34fca14125096404deae"],
  // extensions/signal/src/client-container.test.ts
  [17,"URI",["HTML","PLAIN"],"7849c0ac39a4f42a5cd5cb1b029c7132193f270454865f2f4a49a83da3444665","7849c0ac39a4f42a5cd5cb1b029c7132193f270454865f2f4a49a83da3444665"],
  // skills/autoreview/tests/test_autoreview_hardening.py
  [17,"URI",["PLAIN"],"7b8ee01b06a7e5b375164f2c45249bb258c75726a60b27e20a0ba6e42d5d0b27","7b8ee01b06a7e5b375164f2c45249bb258c75726a60b27e20a0ba6e42d5d0b27"],
  // extensions/mattermost/src/mattermost/slash-http.test.ts
  [17,"URI",["HTML","PLAIN"],"7d765bfa6e81c336a916aaf71eab28f5c0c4ae47a359ec3adf2d4f175645456d","14947662dc4356637571038e47cd3f37a8911d37d41688a2f6c6b2b54c209c41"],
  // extensions/mattermost/src/mattermost/slash-http.test.ts
  [17,"URI",["HTML","PLAIN"],"7d765bfa6e81c336a916aaf71eab28f5c0c4ae47a359ec3adf2d4f175645456d","f2c5cfd2b711577ed9048f9bd0e6c97ae88097b8eba8c1ff37deb33ed910f5a7"],
  // tests/integration/sign-in-chart-parity.test.mjs
  [17,"URI",["ESCAPED_UNICODE","PLAIN"],"80604187b394765a0db26f0ce735ae373dcd6e40f275a1f6492bccd3988fe925","80604187b394765a0db26f0ce735ae373dcd6e40f275a1f6492bccd3988fe925"],
  // skills/autoreview/tests/test_autoreview_hardening.py
  [17,"URI",["HTML","PLAIN"],"80842079cf4e73add753d25a74646356617b39c399e77d38b34bb21818e303d2","80842079cf4e73add753d25a74646356617b39c399e77d38b34bb21818e303d2"],
  // tests/integration/sign-in-chart-parity.test.mjs
  [17,"URI",["ESCAPED_UNICODE","PLAIN"],"80867135981e495d05f129ebfdc5b945fe8f6d532000571afaf68371867b8b5b","80867135981e495d05f129ebfdc5b945fe8f6d532000571afaf68371867b8b5b"],
  // internal/providers/all/command_routing_test.go
  [17,"URI",["PLAIN"],"843c5932c66afbc53056c0249de449e9b24bc4ce8a289d88ff1e0505c95a43b2","e3904bc450ae63f438013ea8c33377e09f2cecc8135fcb8c23eb61f27bc44f07"],
  // src/plugin-sdk/browser-subpaths.test.ts
  [17,"URI",["PLAIN"],"87c268ea768beeb60885ffe0d9168e807d77c7f512aea8823703046c734cbdbf","87c268ea768beeb60885ffe0d9168e807d77c7f512aea8823703046c734cbdbf"],
  // extensions/browser/src/browser/cdp.helpers.test.ts
  [17,"URI",["BASE64","HTML","PLAIN"],"886f9c4f784d3bccb1899db732a298b1d10db8ffdb2b88f76435ea346956e83f","973f5bd82def987cc78ac1211ce5f32debb1284687fc325aa3b9101879c19228"],
  // extensions/browser/src/browser-tool.test.ts
  [17,"URI",["HTML","PLAIN"],"8d3331ee208c72c30fba199e4e2b8a65d69a5034e49875a2f20dbea3a4f2f976","d8996b8fdec57910e379c720611bc37f9433f1cb7027b6f6262d785f1506e9ff"],
  // extensions/github/src/detail.test.ts
  [17,"URI",["HTML","PLAIN"],"902e57fd9767d172abc419455669b173ffe3b1d1e06b45dd190c86b8082a1b2e","237992038e2f8635133fc70c6372f4fd2cbb8a6d01433d243a3056670966ca43"],
  // extensions/github/src/detail.test.ts
  [17,"URI",["HTML","PLAIN"],"902e57fd9767d172abc419455669b173ffe3b1d1e06b45dd190c86b8082a1b2e","a9ff2e4d2ef22693a1505cfa8939988fed4a345e9c86a3df3a5a2cbd53cddf47"],
  // extensions/browser/src/browser/profiles-service.test.ts
  [17,"URI",["HTML","PLAIN"],"9052f1f4f392d163174d33f5069883336c7a9da094f773f83b719685f4b9a239","9052f1f4f392d163174d33f5069883336c7a9da094f773f83b719685f4b9a239"],
  // extensions/typesafe/src/local.transport.test.ts
  [17,"URI",["HTML","PLAIN"],"923d03ede473d23a81840727f6af65897692c61133596ca2a59d52d88fd6775f","923d03ede473d23a81840727f6af65897692c61133596ca2a59d52d88fd6775f"],
  // extensions/browser/src/browser/cdp.test.ts
  [17,"URI",["HTML","PLAIN"],"996b19a5512866475ab05efe0308921cadf916d8a506b76ea1a4204ad1e1193c","996b19a5512866475ab05efe0308921cadf916d8a506b76ea1a4204ad1e1193c"],
  // src/logging/redact.test.ts
  [17,"URI",["ESCAPED_UNICODE","HTML","PLAIN"],"a460200b4a488bc178d0dac30bc5fe027ff86d9c7c94554f5c9d915580bc4239","839b16fa1dd892daf47ab10d50f7c1957a16ace282fe9e6df67fefc40f7f06ff"],
  // test/action-ledger-runtime.test.ts
  [17,"URI",["HTML","PLAIN"],"a728de5dbbef23b8aa5ef2d99060835f4f2fb5a0fa2abb9fe249d08aa09bd09e","a728de5dbbef23b8aa5ef2d99060835f4f2fb5a0fa2abb9fe249d08aa09bd09e"],
  // internal/providers/all/command_routing_test.go
  [17,"URI",["PLAIN"],"a89628da8274772f7fa0afe708243ae49b6791bdedb1750677427cc9d5a5a000","14c716479d52c028b8fb328b96101ede45e16dd037240e7c47a81ec43090ab9e"],
  // extensions/browser/src/browser/chrome-mcp.test.ts
  [17,"URI",["HTML","PLAIN"],"a89a1a50188bbcb017bc52d1d2683ea0c06d8805919c89d4813fc3ee0050061b","1723ec81bae6840c6acfb126d527fa9cd7727764c93846424fc6136fa5dbb860"],
  // src/cli/plugins-cli.marketplace-refresh.test.ts, src/cli/plugins-cli.marketplace-entries.test.ts
  [17,"URI",["HTML","PLAIN"],"a9bdc2ad7ded74870594f1addb8c4f86a5a075516bc840235ed7cc74ed306959","838f16c9fef468c069583811edaac840bd0378ff46b59008793c552bfbf1c77b"],
  // skills/autoreview/tests/test_autoreview_hardening.py
  [17,"URI",["PLAIN"],"b12f4f7ee1e8ec1c544b81f14b0252734d816bd79ced79d342dbca650c4f6c31","b12f4f7ee1e8ec1c544b81f14b0252734d816bd79ced79d342dbca650c4f6c31"],
  // extensions/signal/src/client.test.ts
  [17,"URI",["HTML","PLAIN"],"c9c820a05b2d035eb65422d1a50e58c5fa52e4d7a087ad3791de23bdd4efeabd","c9c820a05b2d035eb65422d1a50e58c5fa52e4d7a087ad3791de23bdd4efeabd"],
  // src/config/redact-snapshot.test.ts
  [17,"URI",["HTML","PLAIN"],"cee9438f4c98a2b27c3aa4bab25b071a4fa9511252ffce86ebf38f302c151e5b","cee9438f4c98a2b27c3aa4bab25b071a4fa9511252ffce86ebf38f302c151e5b"],
  // extensions/browser/src/browser/cdp.helpers.test.ts
  [17,"URI",["BASE64","HTML","PLAIN"],"d15184614e748450d49a726f84955ca7745b87d0728afbd6bb6b50d84cce4fe0","24bd2ee9856630ff773868d946a3b3159e1bb04b297adf4d42b916218a0195d7"],
  // extensions/browser/src/browser/server-context.list-profiles.test.ts, extensions/browser/src/browser/server-context.existing-session.test.ts
  [17,"URI",["HTML","PLAIN"],"d15184614e748450d49a726f84955ca7745b87d0728afbd6bb6b50d84cce4fe0","d15184614e748450d49a726f84955ca7745b87d0728afbd6bb6b50d84cce4fe0"],
  // ui/src/components/app-sidebar-catalog-menu.test.ts
  [17,"URI",["HTML","PLAIN"],"d64fb4dbdd415057a5e18c16c1e7883ea0d4c0daf3bdfcde04df6412565f4738","a5998ca156abbebcd91afd8e3b66dd07dc510a0e5c2bc37660f72572e7e1d08d"],
  // extensions/session-share/src/session-catalog.test.ts
  [17,"URI",["HTML","PLAIN"],"d64fb4dbdd415057a5e18c16c1e7883ea0d4c0daf3bdfcde04df6412565f4738","d64fb4dbdd415057a5e18c16c1e7883ea0d4c0daf3bdfcde04df6412565f4738"],
  // extensions/browser/src/browser/chrome.test.ts
  [17,"URI",["HTML","PLAIN"],"d69d650dc6c312f3e1071f8613df780323fadd01b8c40e6edd02715cd731ae60","d69d650dc6c312f3e1071f8613df780323fadd01b8c40e6edd02715cd731ae60"],
  // internal/cli/webvnc_test.go
  [17,"URI",["PLAIN"],"d72aa985328cd8b6b8d13182b028f5e5c06e574b9acfddc31dc5ab0655896050","18cd62c666a4b48f9968cacc2acc34a27c1f15682219d4f45bfb903cfb3d60fc"],
  // src/cli/proxy-cli.runtime.test.ts
  [17,"URI",["HTML","PLAIN"],"d73af422596b1963c65ae6c2639fd088da3b9196ad1676465d4da43812708fba","d73af422596b1963c65ae6c2639fd088da3b9196ad1676465d4da43812708fba"],
  // src/plugin-sdk/browser-subpaths.test.ts
  [17,"URI",["PLAIN"],"d85938093727ccf6959e1199023569dcfaa302bf5e86a28aa3ea9e011b7c1224","069a918f1609e9f5c0f688d50e234f9b021eae193b573c2312355703eb2fa414"],
  // test/agent-input-scan-git-metadata.test.ts
  [17,"URI",["HTML","PLAIN"],"dab81a433bea3f155bdd2e6568380c6e21c4a629096e29443c949fcab4ab8adc","dab81a433bea3f155bdd2e6568380c6e21c4a629096e29443c949fcab4ab8adc"],
  // src/logging/redact.test.ts
  [17,"URI",["ESCAPED_UNICODE","HTML","PLAIN"],"de7dcbd8612764d80691e85407d899f6e3686afd9ab40964943c3874ffe9571c","198d323e34c2a045b86adbc72b8cd54bb8f9582175c5c25e6c68b4e374d8873f"],
  // tests/conformance/openshell-harness-status.test.mjs
  [17,"URI",["BASE64","PLAIN"],"df5d0c0b6699181dcdecf0b5d53d60b7bc18ad36a9d306faa058306242584253","df5d0c0b6699181dcdecf0b5d53d60b7bc18ad36a9d306faa058306242584253"],
  // src/gateway/server-methods/projects-identity.test.ts
  [17,"URI",["PLAIN"],"e26a1ab8bea9e595632020487f494a373085d4ece58f72dcb9c9d72aae3c1353","91f8a02c4831296a6adc1d02eaf52ebaa563e1593b759677c284a23c4874e948"],
  // extensions/matrix/src/matrix/client.test.ts
  [17,"URI",["HTML","PLAIN"],"e26b2ccf9953c3e0e675998528577649327e1d3e1072233ff86cad586ca5c05d","e26b2ccf9953c3e0e675998528577649327e1d3e1072233ff86cad586ca5c05d"],
  // extensions/browser/src/browser/config.test.ts
  [17,"URI",["HTML","PLAIN"],"e34573089185e607a0cf66ed5635da4375033afb255217b6a0999973c96edf6d","714a0731adfb5b5f3c8c54d5432adaef98a11bccd8d78695cd7c51a9df33eb15"],
  // docs/tools/browser.md, docs/tools/browser/remote.md
  [17,"URI",["HTML","PLAIN"],"e6907dddaccdec944b0f02e14fe9186293e2d513ff753db0a95b3460aa5dc1d9","e6907dddaccdec944b0f02e14fe9186293e2d513ff753db0a95b3460aa5dc1d9"],
  // src/config/redact-snapshot.test.ts
  [17,"URI",["HTML","PLAIN"],"f11c92a245b2308a02f08759cdc5952b4ebe9af5225923807769267fce35f464","f11c92a245b2308a02f08759cdc5952b4ebe9af5225923807769267fce35f464"],
  // extensions/browser/src/browser/config.test.ts
  [17,"URI",["HTML","PLAIN"],"f5accb521ff7c6ffce0ecd2fb4cb9c05475a832e44c8ac4d336c3cab8e79cfa2","c81f3e0d5d8aae13f7084e4f5cee483b12b08fb7a4e91f2f7d21072c51b7baa8"],
  // src/worker/native-runtime-transport.test.ts
  [17,"URI",["HTML","PLAIN"],"f6729932bd0216a9ced489911667e48ede49c4c0c9886343567e8abee5e4a2b6","245d7408cf9309f13d71c800c1bea998316a44557319d3d9e25c27af5d1286b6"],
  // tests/conformance/kubernetes-compute.test.mjs
  [17,"URI",["PLAIN"],"fde443718383531e2fc52a8324fc644f1c45c1c766afd11da028368831e0f457","fde443718383531e2fc52a8324fc644f1c45c1c766afd11da028368831e0f457"],
  // extensions/browser/src/browser/config.test.ts
  [17,"URI",["HTML","PLAIN"],"fe30fb721f4e8b1d50f281ae338da254a0e34dba6804776c231b8666d5856055","3d66d0da353b12cda6548577a624bbb7803b9110255d998a07e5e772dfc5781e"],
  // extensions/firecrawl/src/firecrawl-client.test.ts
  [17,"URI",["HTML","PLAIN"],"fe30fb721f4e8b1d50f281ae338da254a0e34dba6804776c231b8666d5856055","fe30fb721f4e8b1d50f281ae338da254a0e34dba6804776c231b8666d5856055"],
  // skills/autoreview/tests/test_autoreview_hardening.py
  [17,"URI",["HTML","PLAIN"],"fe36092bead3bd47192a05374917c4614ce7642137dc83b9685ab6b5a37d8736","fe36092bead3bd47192a05374917c4614ce7642137dc83b9685ab6b5a37d8736"],
  // worker/test/fleet.test.ts
  [17,"URI",["HTML","PLAIN"],"feadf36b48cb372414d8668b56c965d97d8e34d206d323b3790e863ac233f675","feadf36b48cb372414d8668b56c965d97d8e34d206d323b3790e863ac233f675"],
  // src/logging/redact.test.ts
  [895,"MongoDB",["ESCAPED_UNICODE","HTML","PLAIN"],"087c10edd5d21290a4a8695083ff8c42554fc1d1a1becea9053b11c4790b859c","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  // src/gateway/server-cron-notifications.test.ts
  [899,"FTP",["HTML","PLAIN"],"927664cc6f3d082fb8acb9e01b47942d21d8043ddf150a6d833b5660bc240e07","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  // .grilltrack/events.jsonl
  [938,"Privacy",["PLAIN"],"6e31751daf97832583d6877d6f79a17eb9b74188d3916d1668d136af36a9ea45","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
];
