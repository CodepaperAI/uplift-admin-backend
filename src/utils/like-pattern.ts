/**
 * Escapes a user-supplied search term for use with Prisma `contains`.
 *
 * `contains` compiles to `ILIKE '%' || $1 || '%'`, and Prisma passes the value
 * through without escaping, so LIKE's own metacharacters stay live: `_` matches
 * any single character and `%` matches any run of them. Measured on production —
 * searching the user list for `sa_a` returned 51 people, none of whom had "sa_a"
 * in their name or address, and a search for `%` alone matches every row.
 *
 * Backslash is PostgreSQL's default LIKE escape character, so prefixing each
 * metacharacter with one makes it literal. Backslash itself is escaped first,
 * otherwise escaping `_` would turn a user's literal `\` into an escape for the
 * character after it.
 *
 * A caller that *wants* wildcards should build its own pattern; this is for
 * turning what someone typed into a search box into a literal substring match.
 */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}
