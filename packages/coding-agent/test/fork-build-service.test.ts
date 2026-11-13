import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type BuildHost, type BuildProduct, fetchBuild, OMP_BUILD } from "../src/cli/build-service";
import { ABKIT_BUILD } from "../src/tools/browser/webkit/install";

const host: BuildHost = { target: "linux-x86_64", asset: "linux-x64", windows: false };
let previousUrl: string | undefined;

beforeEach(() => {
	previousUrl = process.env.PI_BUILD_URL;
	delete process.env.PI_BUILD_URL;
});

afterEach(() => {
	if (previousUrl === undefined) delete process.env.PI_BUILD_URL;
	else process.env.PI_BUILD_URL = previousUrl;
});

async function requestedUrl(product?: BuildProduct): Promise<string> {
	let url = "";
	await fetchBuild(
		{ channel: "stable" },
		{
			product,
			host,
			fetchImpl: async input => {
				url = String(input);
				return Response.json({
					build: { version: "1.2.3" },
					file: {
						name: (product ?? OMP_BUILD).fileName(host, "1.2.3"),
						size: 1,
						sha256: Bun.SHA256.hash("x", "hex"),
					},
					download: "https://download.test/build",
				});
			},
		},
	);
	return url;
}

describe("fork build service routing", () => {
	it("checks for omp updates on the fork index by default", async () => {
		expect(await requestedUrl()).toBe(
			"https://raw.githubusercontent.com/Grosser-Kurfuerst/oh-my-pi/build-index/api/products/omp/latest/linux-x86_64?channel=stable",
		);
	});

	it("asks upstream for ABKit instead of the omp-only fork index", async () => {
		expect(await requestedUrl(ABKIT_BUILD)).toBe(
			"https://build.stencil.so/api/products/abkit/latest/linux-x86_64?channel=stable",
		);
	});

	it.each([OMP_BUILD, ABKIT_BUILD])("honors an explicit upstream origin for $id", async product => {
		process.env.PI_BUILD_URL = " https://build.stencil.so/// ";
		expect(await requestedUrl(product)).toBe(
			`https://build.stencil.so/api/products/${product.id}/latest/linux-x86_64?channel=stable`,
		);
	});
});
