declare module "gltf-validator" {
	export interface ValidationReport {
		issues: {
			numErrors: number;
			numWarnings: number;
			numInfos: number;
			messages: unknown[];
		};
		info?: unknown;
	}
	export function validateBytes(
		bytes: Uint8Array,
		options?: { maxIssues?: number },
	): Promise<ValidationReport>;
}
