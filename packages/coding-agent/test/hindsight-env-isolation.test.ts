import { describe, expect, it } from "bun:test";
import { restoreEnvValue } from "./helpers/settings-test-state";
import { isolateHindsightEnv } from "./helpers/hindsight-env";

const PRE_EXISTING = "HINDSIGHT_TEST_ISOLATION_PRE_EXISTING";
const ADDED_LATER = "HINDSIGHT_TEST_ISOLATION_ADDED_LATER";

describe("isolateHindsightEnv", () => {
	it("clears ambient Hindsight variables and restores exactly the pre-existing ones", () => {
		restoreEnvValue(PRE_EXISTING, "false");
		restoreEnvValue(ADDED_LATER, undefined);
		try {
			const restore = isolateHindsightEnv();
			expect(Bun.env[PRE_EXISTING]).toBeUndefined();

			// A variable the isolation never saw must not survive the restore.
			restoreEnvValue(ADDED_LATER, "1");
			restore();

			expect(Bun.env[PRE_EXISTING]).toBe("false");
			expect(Bun.env[ADDED_LATER]).toBeUndefined();
		} finally {
			restoreEnvValue(PRE_EXISTING, undefined);
			restoreEnvValue(ADDED_LATER, undefined);
		}
	});
});
