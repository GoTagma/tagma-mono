export interface RequirementsVerification {
  readonly platform: string | null;
  readonly command: string;
}

/** Read both existing unlabelled hints and portable per-platform verification. */
export function parseRequirementsVerification(section: string): RequirementsVerification[] {
  return [...section.matchAll(/^Verify(?: \(([^\r\n)]+)\))?:[ \t]+`([^`\r\n]+)`/gm)].map(
    (match) => ({ platform: match[1]?.trim() ?? null, command: match[2]! }),
  );
}
