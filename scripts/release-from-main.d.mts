export function isReleaseCommitSubject(subject: string): boolean;
export function chooseReleaseBump(
  subjects: string[],
  currentVersion?: string,
): "patch" | "minor" | null;
export function nextVersion(current: string, bump: "patch" | "minor" | "major"): string;
export function commitSubjectsSince(fromRef: string | undefined, cwd?: string): string[];
export function writePackageVersion(root: string, version: string): void;
export function writeLockfileVersion(root: string, version: string): void;
export function publishRelease(options?: {
  root?: string;
  fromRef?: string;
  subjects?: string[];
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
}): { skipped: boolean; version: string; bump?: string };
