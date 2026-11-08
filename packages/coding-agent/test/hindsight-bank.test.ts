import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { computeBankScope, declaredProjectLabel, ensureBankExists } from "@oh-my-pi/pi-coding-agent/hindsight/bank";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// Isolate `git` invocations in this file from the host's global config —
// `~/.gitconfig` commit signing or template hooks would otherwise turn the
// worktree fixture's `git init`/`git commit`/`git worktree add` into a flaky
// dance. Mirrors the isolation in `test/tools/gh.test.ts`.

function runGit(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: "true",
			XDG_CONFIG_HOME: undefined,
			GIT_AUTHOR_NAME: "Test User",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test User",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
	if (result.exitCode !== 0) {
		const stderr = new TextDecoder().decode(result.stderr).trim();
		const stdout = new TextDecoder().decode(result.stdout).trim();
		throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout || `exit ${result.exitCode}`}`);
	}
	return new TextDecoder().decode(result.stdout).trim();
}

const baseConfig = (overrides: Partial<HindsightConfig> = {}): HindsightConfig => ({
	hindsightApiUrl: "http://localhost:8888",
	hindsightApiToken: null,
	bankId: null,
	bankIdPrefix: "",
	scopeTags: [],
	provenanceTags: [],
	scoping: "global",
	globalScope: false,
	bankMission: "",
	retainMission: null,
	autoRecall: true,
	autoRetain: true,
	retainMode: "full-session",
	retainEveryNTurns: 3,
	retainOverlapTurns: 2,
	retainContext: "omp",
	retainUpdateMode: "replace",
	retainStrategy: null,
	recallBudget: "default",
	recallMaxTokens: 1024,
	recallTypes: ["world", "experience"],
	recallContextTurns: 1,
	recallMaxQueryChars: 800,
	recallPromptPreamble: "preamble",
	recallPreferObservations: true,
	recallPrune: true,
	recallDedup: true,
	recallCadence: "boundary",
	decisionModelUrl: null,
	decisionModelApiKey: null,
	decisionModelThreshold: 0.25,
	debug: false,
	requestTimeoutMs: 30_000,
	reflectTimeoutMs: 120_000,
	recallTimeoutMs: 30_000,
	retainTimeoutMs: 60_000,
	mentalModelsEnabled: false,
	mentalModelAutoSeed: false,
	mentalModelMaxRenderChars: 16_000,
	...overrides,
});

describe("computeBankScope", () => {
	describe("scoping=global", () => {
		it("returns the configured bank id verbatim", () => {
			expect(computeBankScope(baseConfig({ bankId: "team-a" }), "/work/proj")).toEqual({
				bankId: "team-a",
			});
		});

		it("falls back to the default bank name when bankId is unset", () => {
			expect(computeBankScope(baseConfig(), "/whatever")).toEqual({ bankId: "omp" });
		});

		it("applies the configured prefix", () => {
			expect(computeBankScope(baseConfig({ bankId: "team", bankIdPrefix: "prod" }), "/cwd")).toEqual({
				bankId: "prod-team",
			});
		});

		it("does not surface tag fields", () => {
			const scope = computeBankScope(baseConfig(), "/work/proj");
			expect(scope.retainTags).toBeUndefined();
			expect(scope.recallTags).toBeUndefined();
			expect(scope.recallTagsMatch).toBeUndefined();
		});

		it("applies configured personal scope tags with all_strict retrieval", () => {
			expect(
				computeBankScope(baseConfig({ bankId: "personal", scopeTags: ["scope:personal"] }), "/work/proj"),
			).toEqual({
				bankId: "personal",
				resolvedTags: ["scope:personal"],
				retainTags: ["scope:personal"],
				recallTags: ["scope:personal"],
				recallTagsMatch: "all_strict",
				observationScopes: [["scope:personal"]],
			});
		});
	});

	describe("scoping=per-project", () => {
		it("appends the cwd basename to the base bank id", () => {
			expect(computeBankScope(baseConfig({ scoping: "per-project" }), "/work/proj")).toEqual({
				bankId: "omp-proj",
			});
		});

		it("appends `unknown` for an empty cwd", () => {
			expect(computeBankScope(baseConfig({ scoping: "per-project" }), "")).toEqual({
				bankId: "omp-unknown",
			});
		});

		it("lowercases the project segment so one checkout maps to one bank", () => {
			expect(computeBankScope(baseConfig({ scoping: "per-project" }), "/work/General")).toEqual({
				bankId: "omp-general",
			});
		});

		it("composes prefix + bankId + project", () => {
			const scope = computeBankScope(
				baseConfig({ scoping: "per-project", bankId: "team", bankIdPrefix: "prod" }),
				"/work/cool-app",
			);
			expect(scope.bankId).toBe("prod-team-cool-app");
		});
	});

	describe("scoping=per-project-tagged", () => {
		it("keeps unbound coding actors project-neutral for retain, recall and observation scopes", () => {
			expect(
				computeBankScope(baseConfig({ scoping: "per-project-tagged", scopeTags: ["scope:coding"] }), "/work/proj"),
			).toEqual({
				bankId: "omp",
				resolvedTags: ["scope:coding"],
				retainTags: ["scope:coding"],
				recallTags: ["scope:coding"],
				recallTagsMatch: "all_strict",
				observationScopes: [["scope:coding"]],
			});
		});

		it("does not invent a project for an empty cwd or an unbound directory", () => {
			expect(declaredProjectLabel("")).toBeNull();
			expect(declaredProjectLabel("/work/proj")).toBeNull();
			expect(computeBankScope(baseConfig({ scoping: "per-project-tagged" }), "")).toEqual({ bankId: "omp" });
		});
	});

	// Regression for #2232: linked git worktrees used to silo memory into
	// distinct `project:<basename>` tags. The fix resolves the primary
	// checkout root via `git.repo.primaryRootSync`, so every worktree of one
	// repo collapses to the same tag (and the same per-project bank id).
	describe("git worktree handling", () => {
		let baseDir: string;
		let primaryRoot: string;
		let worktreeRoot: string;
		let bareRepoRoot: string;
		let bareWorktreeA: string;
		let bareWorktreeB: string;

		beforeAll(async () => {
			baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "hindsight-bank-worktree-"));
			primaryRoot = path.join(baseDir, "myrepo");
			worktreeRoot = path.join(baseDir, "myrepo-feature-x");
			await fs.mkdir(primaryRoot, { recursive: true });
			runGit(primaryRoot, ["-c", "init.defaultBranch=main", "init"]);
			runGit(primaryRoot, ["config", "user.email", "tester@example.com"]);
			runGit(primaryRoot, ["config", "user.name", "Tester"]);
			await fs.writeFile(path.join(primaryRoot, "README.md"), "hi\n");
			runGit(primaryRoot, ["add", "-A"]);
			runGit(primaryRoot, ["commit", "-m", "base"]);
			runGit(primaryRoot, ["worktree", "add", worktreeRoot, "-b", "feature-x"]);
			bareRepoRoot = path.join(baseDir, "bare-repo.git");
			bareWorktreeA = path.join(baseDir, "bare-a");
			bareWorktreeB = path.join(baseDir, "bare-b");
			runGit(baseDir, ["init", "--bare", bareRepoRoot]);
			runGit(primaryRoot, ["remote", "add", "bare", bareRepoRoot]);
			runGit(primaryRoot, ["push", "bare", "main"]);
			runGit(baseDir, ["--git-dir", bareRepoRoot, "worktree", "add", bareWorktreeA, "-b", "bare-a", "main"]);
			runGit(baseDir, ["--git-dir", bareRepoRoot, "worktree", "add", bareWorktreeB, "-b", "bare-b", "main"]);
			await Bun.write(path.join(primaryRoot, ".systemd-ops", "scope.toml"), '[scope]\nid = "myrepo"\n');
			await Bun.write(path.join(bareRepoRoot, ".systemd-ops", "scope.toml"), '[scope]\nid = "bare-project"\n');
		});

		afterAll(async () => {
			if (baseDir) await removeWithRetries(baseDir);
		});

		it("emits the same project tag from the primary checkout and a linked worktree", () => {
			const fromPrimary = computeBankScope(baseConfig({ scoping: "per-project-tagged" }), primaryRoot);
			const fromWorktree = computeBankScope(baseConfig({ scoping: "per-project-tagged" }), worktreeRoot);
			expect(fromPrimary.retainTags).toEqual(["project:myrepo"]);
			expect(fromWorktree.retainTags).toEqual(["project:myrepo"]);
			expect(fromWorktree).toEqual(fromPrimary);
		});

		it("uses the primary root basename for the per-project bank id from a worktree", () => {
			expect(computeBankScope(baseConfig({ scoping: "per-project" }), worktreeRoot)).toEqual({
				bankId: "omp-myrepo",
			});
		});

		it("emits one shared project label across worktrees attached to a bare repository", () => {
			const fromA = computeBankScope(baseConfig({ scoping: "per-project-tagged" }), bareWorktreeA);
			const fromB = computeBankScope(baseConfig({ scoping: "per-project-tagged" }), bareWorktreeB);
			expect(fromA.retainTags).toEqual(["project:bare-project"]);
			expect(fromB).toEqual(fromA);
			expect(computeBankScope(baseConfig({ scoping: "per-project" }), bareWorktreeB)).toEqual({
				bankId: "omp-bare-project",
			});
		});

		it("does not tag an unbound parent merely because it contains managed repositories", () => {
			expect(declaredProjectLabel(baseDir)).toBeNull();
			expect(computeBankScope(baseConfig({ scoping: "per-project-tagged" }), baseDir).retainTags).toBeUndefined();
		});
	});

	// Casing is the second fragmentation source, and it survives the #2232
	// worktree fix: the label becomes a tag, Hindsight matches tags literally,
	// so `project:General` and `project:general` are two disjoint scopes over
	// one repository. Fold the case after the primary root is resolved.
	describe("project label case folding", () => {
		let baseDir: string;
		let primaryRoot: string;
		let worktreeRoot: string;

		beforeAll(async () => {
			baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "hindsight-bank-case-"));
			primaryRoot = path.join(baseDir, "CasedRepo");
			worktreeRoot = path.join(baseDir, "CasedRepo-Feature");
			await fs.mkdir(primaryRoot, { recursive: true });
			runGit(primaryRoot, ["-c", "init.defaultBranch=main", "init"]);
			runGit(primaryRoot, ["config", "user.email", "tester@example.com"]);
			runGit(primaryRoot, ["config", "user.name", "Tester"]);
			await fs.writeFile(path.join(primaryRoot, "README.md"), "hi\n");
			runGit(primaryRoot, ["add", "-A"]);
			runGit(primaryRoot, ["commit", "-m", "base"]);
			runGit(primaryRoot, ["worktree", "add", worktreeRoot, "-b", "Feature"]);
			await Bun.write(path.join(primaryRoot, ".systemd-ops", "scope.toml"), '[scope]\nid = "CasedRepo"\n');
		});

		afterAll(async () => {
			if (baseDir) await removeWithRetries(baseDir);
		});

		it("folds a mixed-case checkout root to a lowercase tag", () => {
			const scope = computeBankScope(baseConfig({ scoping: "per-project-tagged" }), primaryRoot);
			expect(scope.retainTags).toEqual(["project:casedrepo"]);
			expect(scope.recallTags).toEqual(["project:casedrepo"]);
		});

		it("folds the label a linked worktree inherits from a mixed-case primary root", () => {
			expect(computeBankScope(baseConfig({ scoping: "per-project-tagged" }), worktreeRoot).retainTags).toEqual([
				"project:casedrepo",
			]);
		});
	});

	// The operator's project identity lives in `.systemd-ops/scope.toml`
	// (`[scope].id`), which is not always the directory basename: `cpa-farm`
	// declares `cpa`. Reading it keeps OMP memory in the same project scope the
	// rest of the estate writes, instead of inventing a checkout-name tag.
	describe("scope manifest labels", () => {
		let baseDir: string;

		const writeManifest = async (root: string, body: string): Promise<void> => {
			await fs.mkdir(path.join(root, ".systemd-ops"), { recursive: true });
			await fs.writeFile(path.join(root, ".systemd-ops", "scope.toml"), body);
		};

		const writeLegacyManifest = async (root: string, body: string): Promise<void> => {
			await fs.mkdir(root, { recursive: true });
			await fs.writeFile(path.join(root, ".systemd-ops.toml"), body);
		};

		const scopedLabel = (directory: string): string | undefined =>
			computeBankScope(baseConfig({ scoping: "per-project-tagged" }), directory).retainTags?.[0];

		beforeAll(async () => {
			baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "hindsight-bank-scope-"));
		});

		afterAll(async () => {
			if (baseDir) await removeWithRetries(baseDir);
		});

		const fixtures = [
			{ directory: "hindsight", id: "memory" },
			{ directory: "deepseek-harness", id: "exocortex" },
			{ directory: "dji-flip", id: "drone-ops" },
			{ directory: "cpa-farm", id: "cpa" },
			{ directory: "oh-my-pi", id: "oh-my-pi" },
		];

		for (const fixture of fixtures) {
			it(`labels ${fixture.directory} as ${fixture.id} from its scope manifest`, async () => {
				const root = path.join(baseDir, fixture.directory);
				await writeManifest(root, `[scope]\nid = "${fixture.id}"\n`);
				expect(scopedLabel(path.join(root, "packages", "app"))).toBe(`project:${fixture.id}`);
			});
		}

		it("accepts the legacy .systemd-ops.toml manifest", async () => {
			const root = path.join(baseDir, "legacy");
			await writeLegacyManifest(root, '[scope]\nid = "legacy-project"\n');
			expect(scopedLabel(root)).toBe("project:legacy-project");
		});

		it("normalizes the scope id into a lowercase slug", async () => {
			const root = path.join(baseDir, "normalized");
			await writeManifest(root, '[scope]\nid = "  Drone Ops / Fleet  "\n');
			expect(scopedLabel(root)).toBe("project:drone-ops-fleet");
			expect(
				computeBankScope(baseConfig({ scoping: "per-project-tagged", scopeTags: ["scope:coding"] }), root)
					.retainTags,
			).toEqual(["scope:coding", "project:drone-ops-fleet"]);
		});

		const workspaceFixtures = [
			{
				name: "prefers and normalizes workspace identity over a scope section in the same manifest",
				workspace: '[workspace]\nid = "  Workspace / Identity  "\n[scope]\nid = "ignored"\n',
				expected: "workspace-identity",
			},
			{
				name: "accepts a scope section in workspace.toml when workspace identity is absent",
				workspace: '[scope]\nid = "scope-fallback"\n',
				expected: "scope-fallback",
			},
			{
				name: "keeps workspace identity alongside a matching preferred scope",
				workspace: '[workspace]\nid = "shared"\n',
				preferred: '[scope]\nid = "shared"\n',
				expected: "shared",
			},
			{
				name: "keeps workspace identity alongside coordination-only metadata",
				workspace: '[workspace]\nid = "workspace-only"\n',
				preferred: '[coordination]\nlead = "hcom:lead"\n',
				expected: "workspace-only",
			},
			{
				name: "refuses conflicting workspace and preferred scope identities",
				workspace: '[workspace]\nid = "workspace"\n',
				preferred: '[scope]\nid = "different"\n',
				expected: null,
			},
			{
				name: "refuses conflicting workspace and legacy scope identities",
				workspace: '[workspace]\nid = "workspace"\n',
				legacy: '[scope]\nid = "different"\n',
				expected: null,
			},
			{
				name: "preserves dual-scope ambiguity even when workspace identity matches",
				workspace: '[workspace]\nid = "shared"\n',
				preferred: '[scope]\nid = "shared"\n',
				legacy: '[scope]\nid = "shared"\n',
				expected: null,
			},
			{
				name: "falls back to preferred scope when workspace.toml is malformed",
				workspace: "[workspace\nid =\n",
				preferred: '[scope]\nid = "usable-scope"\n',
				expected: "usable-scope",
			},
			{
				name: "falls back to a scope section when workspace identity is not a string",
				workspace: '[workspace]\nid = 42\n[scope]\nid = "typed-fallback"\n',
				expected: "typed-fallback",
			},
		];
		for (const [index, fixture] of workspaceFixtures.entries()) {
			it(fixture.name, async () => {
				const root = path.join(baseDir, `workspace-${index}`);
				await Bun.write(path.join(root, "workspace.toml"), fixture.workspace);
				if (fixture.preferred) await writeManifest(root, fixture.preferred);
				if (fixture.legacy) await writeLegacyManifest(root, fixture.legacy);
				expect(declaredProjectLabel(path.join(root, "packages", "app"))).toBe(fixture.expected);
				expect(
					computeBankScope(baseConfig({ scoping: "per-project-tagged", scopeTags: ["scope:coding"] }), root)
						.retainTags,
				).toEqual(fixture.expected ? ["scope:coding", `project:${fixture.expected}`] : ["scope:coding"]);
			});
		}

		it("keeps dual-manifest ambiguity when scope paths are directories", async () => {
			const root = path.join(baseDir, "workspace-with-directory-manifests");
			await Bun.write(path.join(root, "workspace.toml"), '[workspace]\nid = "must-not-win"\n');
			await fs.mkdir(path.join(root, ".systemd-ops", "scope.toml"), { recursive: true });
			await fs.mkdir(path.join(root, ".systemd-ops.toml"));
			expect(declaredProjectLabel(root)).toBeNull();
			expect(scopedLabel(root)).toBeUndefined();
		});

		it("leaves an undeclared project unbound", async () => {
			const root = path.join(baseDir, "unscoped");
			await fs.mkdir(root, { recursive: true });
			expect(scopedLabel(root)).toBeUndefined();
		});

		it("ignores a directory holding both manifest flavours", async () => {
			const root = path.join(baseDir, "ambiguous");
			await writeManifest(root, '[scope]\nid = "guessed"\n');
			await writeLegacyManifest(root, '[scope]\nid = "guessed-legacy"\n');
			expect(scopedLabel(root)).toBeUndefined();
		});

		it("keeps walking past an ambiguous directory", async () => {
			const root = path.join(baseDir, "ambiguous-ancestor");
			await writeManifest(root, '[scope]\nid = "outer-scope"\n');
			const child = path.join(root, "inner");
			await writeManifest(child, '[scope]\nid = "guessed"\n');
			await writeLegacyManifest(child, '[scope]\nid = "guessed-legacy"\n');
			expect(scopedLabel(child)).toBe("project:outer-scope");
		});

		it("ignores an empty scope id", async () => {
			const root = path.join(baseDir, "empty-id");
			await writeManifest(root, '[scope]\nid = ""\n');
			expect(scopedLabel(root)).toBeUndefined();
		});

		it("ignores a manifest without a [scope] section", async () => {
			const root = path.join(baseDir, "no-scope-section");
			await writeManifest(root, '[coordination]\nlead = "hcom:lead"\n');
			expect(scopedLabel(root)).toBeUndefined();
		});

		it("ignores a malformed manifest", async () => {
			const root = path.join(baseDir, "malformed");
			await writeManifest(root, "[scope\nid =\n");
			expect(scopedLabel(root)).toBeUndefined();
		});
	});

	describe("scope manifests and git worktrees", () => {
		let baseDir: string;
		let primaryRoot: string;
		let worktreeRoot: string;

		beforeAll(async () => {
			baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "hindsight-bank-scope-worktree-"));
			primaryRoot = path.join(baseDir, "primary-checkout");
			worktreeRoot = path.join(baseDir, "primary-checkout-feature");
			await fs.mkdir(primaryRoot, { recursive: true });
			runGit(primaryRoot, ["-c", "init.defaultBranch=main", "init"]);
			runGit(primaryRoot, ["config", "user.email", "tester@example.com"]);
			runGit(primaryRoot, ["config", "user.name", "Tester"]);
			await fs.writeFile(path.join(primaryRoot, "README.md"), "hi\n");
			runGit(primaryRoot, ["add", "-A"]);
			runGit(primaryRoot, ["commit", "-m", "base"]);
			await fs.mkdir(path.join(primaryRoot, ".systemd-ops"), { recursive: true });
			await fs.writeFile(path.join(primaryRoot, ".systemd-ops", "scope.toml"), '[scope]\nid = "shared-scope"\n');
			runGit(primaryRoot, ["worktree", "add", worktreeRoot, "-b", "feature"]);
		});

		afterAll(async () => {
			if (baseDir) await removeWithRetries(baseDir);
		});

		it("resolves a linked worktree to the primary checkout's scope id", () => {
			expect(computeBankScope(baseConfig({ scoping: "per-project-tagged" }), primaryRoot).retainTags).toEqual([
				"project:shared-scope",
			]);
			expect(computeBankScope(baseConfig({ scoping: "per-project-tagged" }), worktreeRoot).retainTags).toEqual([
				"project:shared-scope",
			]);
			expect(computeBankScope(baseConfig({ scoping: "per-project" }), worktreeRoot)).toEqual({
				bankId: "omp-shared-scope",
			});
		});

		it("inherits workspace.toml identity from a linked worktree's primary checkout", async () => {
			const primary = path.join(baseDir, "workspace-primary");
			const linked = path.join(baseDir, "workspace-linked");
			await fs.mkdir(primary, { recursive: true });
			runGit(primary, ["-c", "init.defaultBranch=main", "init"]);
			await Bun.write(path.join(primary, "README.md"), "workspace fixture\n");
			runGit(primary, ["add", "README.md"]);
			runGit(primary, ["-c", "core.hooksPath=/dev/null", "commit", "-m", "base"]);
			runGit(primary, ["worktree", "add", linked, "-b", "workspace-feature"]);
			await Bun.write(path.join(primary, "workspace.toml"), '[workspace]\nid = "  Shared Workspace  "\n');
			expect(declaredProjectLabel(primary)).toBe("shared-workspace");
			expect(declaredProjectLabel(linked)).toBe("shared-workspace");
			expect(computeBankScope(baseConfig({ scoping: "per-project-tagged" }), linked).retainTags).toEqual([
				"project:shared-workspace",
			]);
			await Bun.write(path.join(primary, ".systemd-ops", "scope.toml"), '[scope]\nid = "conflict"\n');
			expect(declaredProjectLabel(linked)).toBeNull();
		});
	});
});

describe("ensureBankExists", () => {
	let client: HindsightApi;
	let createSpy: Mock<HindsightApi["createBank"]> | undefined;

	beforeEach(() => {
		client = new HindsightApi({ baseUrl: "http://localhost:8888" });
	});

	afterEach(() => {
		createSpy?.mockRestore();
	});

	it("calls createBank exactly once per bank id and forwards the mission body", async () => {
		createSpy = vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const seen = new Set<string>();
		const config = baseConfig({ bankMission: "remember everything", retainMission: "extract facts" });

		await ensureBankExists(client, "bank-a", config, seen);
		await ensureBankExists(client, "bank-a", config, seen);
		await ensureBankExists(client, "bank-b", config, seen);

		expect(createSpy).toHaveBeenCalledTimes(2);
		expect(createSpy).toHaveBeenCalledWith(
			"bank-a",
			expect.objectContaining({ reflectMission: "remember everything", retainMission: "extract facts" }),
		);
		expect(createSpy).toHaveBeenCalledWith("bank-b", expect.any(Object));
		expect(seen.has("bank-a")).toBe(true);
		expect(seen.has("bank-b")).toBe(true);
	});

	// Regression: mental-model auto-seed used to POST `createMentalModel` against
	// a never-created bank when `bankMission` was blank, because the old
	// `ensureBankMission` skipped creation entirely without a mission.
	it("still PUTs the bank when no mission is configured (so the bank gets created)", async () => {
		createSpy = vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const seen = new Set<string>();

		await ensureBankExists(client, "bank", baseConfig({ bankMission: "" }), seen);
		await ensureBankExists(client, "bank", baseConfig({ bankMission: "   " }), seen);

		expect(createSpy).toHaveBeenCalledTimes(1);
		expect(createSpy).toHaveBeenCalledWith(
			"bank",
			expect.objectContaining({ reflectMission: undefined, retainMission: undefined }),
		);
		expect(seen.has("bank")).toBe(true);
	});

	it("swallows API failures and does not mark the bank as initialised", async () => {
		createSpy = vi.spyOn(HindsightApi.prototype, "createBank").mockRejectedValue(new Error("HTTP 500"));
		const seen = new Set<string>();
		const config = baseConfig({ bankMission: "do the thing" });

		await expect(ensureBankExists(client, "bank-x", config, seen)).resolves.toBeUndefined();
		expect(seen.has("bank-x")).toBe(false);
	});
});
