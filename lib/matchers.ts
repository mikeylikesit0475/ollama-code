// Pure, side-effect-free matching engines extracted from cli.ts so they can
// be unit-tested without booting the agent harness.

/**
 * Translate a glob pattern into a RegExp source string.
 *
 * Supported syntax:
 *   *   — any run of non-separator characters
 *   **  — any run of characters including separators (recursive)
 *   **\/ — recursive, with the trailing separator optional (zero dirs OK)
 *   ?   — exactly one non-separator character
 *
 * Everything else is matched literally (regex metacharacters are escaped).
 */
export function globToRegexSource(pattern: string): string {
  const regexParts: string[] = [];
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        regexParts.push(".*");
        i += 2;
        if (pattern[i] === "/") {
          regexParts.push("/?");
          i++;
        }
      } else {
        regexParts.push("[^/]*");
        i++;
      }
    } else if (char === "?") {
      regexParts.push("[^/]");
      i++;
    } else if ([".", "+", "^", "$", "(", ")", "[", "]", "{", "}", "|", "\\"].includes(char)) {
      regexParts.push("\\" + char);
      i++;
    } else {
      regexParts.push(char);
      i++;
    }
  }
  return "^" + regexParts.join("") + "$";
}

export function globToRegex(pattern: string): RegExp {
  return new RegExp(globToRegexSource(pattern));
}

/**
 * Find target inside content, tolerating whitespace differences
 * (any run of whitespace in the target matches any run of whitespace in
 * the content). Returns the match range only when exactly one match
 * exists — ambiguous or absent matches return null.
 */
export function findFuzzyMatch(
  content: string,
  target: string
): { start: number; end: number } | null {
  const escaped = target.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
  const normalizedPattern = escaped
    .replace(/\s+/g, "\\s+")
    .replace(/(?:\\s\+)+/g, "\\s+");

  try {
    const regex = new RegExp(normalizedPattern, "g");
    const matches = [...content.matchAll(regex)];
    if (matches.length === 1) {
      const m = matches[0];
      return { start: m.index!, end: m.index! + m[0].length };
    }
  } catch {
    // regex compile error
  }
  return null;
}
