export declare const REQUIRED_FILES_FIELD: readonly string[];
export declare const REQUIRED_TRACKED_FILES: readonly string[];
export declare const REQUIRED_ARTIFACT_FILES: readonly string[];
export declare const FORBIDDEN_TARBALL_PREFIXES: readonly string[];
export declare const TRUSTED_REPOSITORY_URL: string;
export declare const POSTINSTALL_SCRIPT: string;

export interface PackCheckOptions {
  requireArtifacts?: boolean;
}

export declare function loadPackageJson(root: string): Record<string, unknown>;
export declare function checkPackageManifest(pkg: Record<string, unknown>): string[];
export declare function checkTrackedFiles(root: string): string[];
export declare function checkArtifactFiles(root: string): string[];
export declare function checkTarballListing(names: string[]): string[];
export declare function checkPack(root: string, opts?: PackCheckOptions): string[];
