# Local security backport — picomatch 4.0.7+jrc.1

This is a local fork, **not an upstream release**. MIT license, author,
repository attribution and original manifest are retained in LICENSE and
UPSTREAM-PACKAGE.json. Original registry tarball integrity:
`sha512-qcJu88Q2IWqJsDD529JKMdwGm/dvInW4HvQnRwiH9JtihJvzGOscDtHE3x1pBKeUOTysQ8kVmLnJ2kJu7yhcGA==`.

Source: https://github.com/micromatch/picomatch/tree/4.0.7
Advisory: https://github.com/advisories/GHSA-fc5q-39xc-vjpf

On 2026-11-17 the registry latest is 4.0.7 and the advisory lists no patched
version. PR 194 explicitly leaves +(*a) vulnerable and is not adopted here.

## Change and behavioral limit

The only runtime source delta is lib/parse.js: after the existing safe
single-character flattening logic, repeated extglobs with an unescaped star
outside character classes enter the existing risky-pattern literal fallback.
This also catches a star in a nested group inside a repeated extglob. Ordinary
globs and fixed-width extglobs remain supported. Risky repeated wildcard
patterns now match literally; their former ambiguous matching is intentionally
not preserved. The upstream explicit maxExtglobRecursion=false opt-out remains
unchanged; project build/test configuration must not disable that guard.

The distribution manifest identifies the local patch with build metadata and
omits upstream development tools/scripts; the full original manifest is kept
separately. Root devDependency plus npm override forces consumers to this local
directory. Docker copies it before npm ci. No production dependency is added.

## Evidence and maintenance

tests/picomatch-repeated-extglob.test.mjs exercises five previously timing-out
cases in isolated child processes, escaped input, ordinary glob semantics and
safe flattened repeated extglobs. The initial baseline had five timeout
failures; one unrelated expectation about +(?) was corrected to an existing
supported fixed-width pattern before changing the library. All seven security
regression tests passed after the patch, together with 18 audio tests.

Full repository CI remains required. npm audit scans registry packages; a
local fork is not upstream vulnerability certification. Keep this explicit
regression and attribution until replacing the fork with an officially patched
release. No audit advisory suppression or weakened severity threshold is used.
