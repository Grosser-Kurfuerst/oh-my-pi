const FORK_BUILD_URL = "https://raw.githubusercontent.com/Grosser-Kurfuerst/oh-my-pi/build-index";

/** Only omp is published on the fork index; other products stay on the upstream service. */
export function forkBuildServiceDefault(productId: string, upstreamDefault: string): string {
	return productId === "omp" ? FORK_BUILD_URL : upstreamDefault;
}
